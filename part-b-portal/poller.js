'use strict';

const store = require('./store');
const { broadcast } = require('./sse');

const BSE_BASE_URL = process.env.BSE_BASE_URL || 'http://localhost:4000';
const PAGE_SIZE = Number(process.env.PULL_PAGE_SIZE || 50);
const MAX_RETRIES_PER_PAGE = Number(process.env.PULL_MAX_RETRIES || 5);
const RETRY_BASE_DELAY_MS = Number(process.env.PULL_RETRY_BASE_DELAY_MS || 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.PULL_REQUEST_TIMEOUT_MS || 28000); // just under BSE's 30s network kill
const FULL_PULL_INTERVAL_MS = Number(process.env.FULL_PULL_INTERVAL_MS || 60000); // how often to re-sync clients/trades
const FAST_POLL_INTERVAL_MS = Number(process.env.FAST_POLL_INTERVAL_MS || 15000); // employees/mappings

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Lock per resource so a slow pull (up to ~10 min against real BSE) can
// never overlap with a second pull of the *same* resource starting on top
// of it. This is what keeps concurrent-refresh scenarios from producing
// torn/contradictory data - at most one writer per resource, ever.
const locks = { clients: false, trades: false };

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a single page with retry + exponential backoff. This is what
// absorbs BSE's ~20% mid-pull failure rate: a dropped page is just retried,
// it never aborts the whole pull.
async function fetchPageWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES_PER_PAGE; attempt++) {
    try {
      return await fetchWithTimeout(url);
    } catch (err) {
      lastErr = err;
      const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[poller] page fetch failed (attempt ${attempt}/${MAX_RETRIES_PER_PAGE}): ${err.message}. Retrying in ${backoff}ms. url=${url}`);
      await sleep(backoff);
    }
  }
  throw new Error(`Page permanently failed after ${MAX_RETRIES_PER_PAGE} attempts: ${lastErr && lastErr.message}`);
}

// Generic paginated puller. Upserts each page into the cache AS IT ARRIVES
// (not buffered until the whole pull finishes) so a 10-minute full pull
// still shows progressively fresher data throughout, rather than the UI
// staring at fully stale data for 10 minutes and then jumping.
async function pullPaginated({ resource, path, upsert, onPageCommitted }) {
  if (locks[resource]) {
    console.log(`[poller] skip ${resource} pull - previous pull still in progress`);
    return;
  }
  locks[resource] = true;
  const startedAt = Date.now();
  try {
    let page = 1;
    let totalPages = 1;
    let totalRecords = 0;
    do {
      const url = `${BSE_BASE_URL}${path}?page=${page}&pageSize=${PAGE_SIZE}`;
      const result = await fetchPageWithRetry(url);
      upsert(result.data);
      totalPages = result.totalPages;
      totalRecords = result.totalRecords;
      if (onPageCommitted) onPageCommitted(page, totalPages);
      // Push a live update after every committed page - open tabs reflect
      // partial progress on the current sync, not just the final result.
      broadcast(`${resource}-updated`, { page, totalPages, totalRecords });
      page++;
    } while (page <= totalPages);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[poller] ${resource} pull complete: ${totalRecords} records, ${totalPages} pages, ${secs}s`);
  } catch (err) {
    console.error(`[poller] ${resource} pull aborted: ${err.message}. Cache keeps last-known-good data; will retry next cycle.`);
  } finally {
    locks[resource] = false;
  }
}

async function pullClients() {
  await pullPaginated({
    resource: 'clients',
    path: '/clients',
    upsert: store.upsertClients
  });
  store._state.meta.clientsInitialLoadComplete = true;
}

async function pullTrades() {
  await pullPaginated({
    resource: 'trades',
    path: '/trades',
    upsert: store.upsertTrades
  });
  store._state.meta.tradesInitialLoadComplete = true;
}

// Employees/mappings come from the "internal application" source - fast
// and reliable per the brief, so a simple single-shot fetch (no pagination,
// no retry machinery needed) on a short interval is sufficient.
async function pullEmployeesAndMappings() {
  try {
    const [employeesRes, mappingsRes] = await Promise.all([
      fetchWithTimeout(`${BSE_BASE_URL}/employees`),
      fetchWithTimeout(`${BSE_BASE_URL}/employee-mappings`)
    ]);
    store.upsertEmployees(employeesRes.data);
    store.upsertMappings(mappingsRes.data);
    broadcast('employees-updated', { totalRecords: employeesRes.totalRecords });
  } catch (err) {
    console.error(`[poller] employees/mappings pull failed: ${err.message}`);
  }
}

function start() {
  console.log(`[poller] starting. BSE_BASE_URL=${BSE_BASE_URL} pageSize=${PAGE_SIZE} fullPullInterval=${FULL_PULL_INTERVAL_MS}ms`);

  // Kick off an immediate pull of everything on boot so the cache isn't
  // empty, then settle into the recurring schedule.
  pullEmployeesAndMappings();
  pullClients();
  pullTrades();

  setInterval(pullEmployeesAndMappings, FAST_POLL_INTERVAL_MS);
  setInterval(pullClients, FULL_PULL_INTERVAL_MS);
  setInterval(pullTrades, FULL_PULL_INTERVAL_MS);
}

module.exports = { start, pullClients, pullTrades, pullEmployeesAndMappings };
