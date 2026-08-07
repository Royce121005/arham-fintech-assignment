'use strict';

// =============================================================================
// Ingestion worker (formerly "the poller"). Renamed deliberately: BSE has no
// push mechanism, so pulling is not a lazy default here — it's the only way
// to get data out of it. This process is the ONLY thing that talks to BSE,
// and the ONLY thing that writes to Postgres (using the service_role key,
// which bypasses RLS — the portal only ever reads, using the anon key,
// which RLS *does* apply to).
//
// Two pull strategies per resource, not one:
//   - INCREMENTAL: pull only records changed since the last successful
//     watermark, using the date-range filter the brief says the BSE API
//     supports. Cheap, frequent (e.g. every 30s-2min).
//   - RECONCILIATION: a full pull, on a much slower schedule (e.g. hourly).
//     Catches anything an incremental pass could miss — corrections,
//     late-settled trades, backfilled records with an older trade_date than
//     the watermark. Naive incremental-only sync would silently drop these.
//
// Why this matters for the 100x question: incremental sync makes each cycle
// proportional to *what changed*, not total record count, so it doesn't
// degrade as the dataset grows the way a full-repull-every-cycle design does.
// =============================================================================

require('dotenv').config();
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const BSE_BASE_URL = process.env.BSE_BASE_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PAGE_SIZE = Number(process.env.PULL_PAGE_SIZE || 50);
const MAX_RETRIES_PER_PAGE = Number(process.env.PULL_MAX_RETRIES || 5);
const RETRY_BASE_DELAY_MS = Number(process.env.PULL_RETRY_BASE_DELAY_MS || 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.PULL_REQUEST_TIMEOUT_MS || 28000); // just under BSE's 30s kill

const INCREMENTAL_INTERVAL_MS = Number(process.env.INCREMENTAL_INTERVAL_MS || 30_000);
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 60 * 60_000); // hourly
const FAST_POLL_INTERVAL_MS = Number(process.env.FAST_POLL_INTERVAL_MS || 15_000); // employees/mappings

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[sync] SUPABASE_SERVICE_ROLE_KEY is required (ingestion writes must bypass RLS).');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One lock per resource. A resource's next cycle (incremental OR
// reconciliation) is skipped entirely if a pull for that resource is still
// running — this is what makes overlapping refreshes impossible to
// interleave into a torn/contradictory read, independent of what the DB
// upsert itself already guarantees.
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

// Absorbs BSE's ~20% mid-pull failure rate at the PAGE level, not the pull
// level — retrying a whole multi-minute pull because one page dropped would
// waste the 80% of pages that succeeded and let the freshness gap grow
// unbounded. Exponential backoff avoids hammering a source that's already
// failing a fifth of the time.
async function fetchPageWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES_PER_PAGE; attempt++) {
    try {
      return await fetchWithTimeout(url);
    } catch (err) {
      lastErr = err;
      const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[sync] page failed (attempt ${attempt}/${MAX_RETRIES_PER_PAGE}): ${err.message}. retry in ${backoff}ms. ${url}`);
      await sleep(backoff);
    }
  }
  throw new Error(`page permanently failed after ${MAX_RETRIES_PER_PAGE} attempts: ${lastErr && lastErr.message}`);
}

async function getSyncState(resource) {
  const { data, error } = await db.from('sync_state').select('*').eq('resource', resource).single();
  if (error) throw error;
  return data;
}

async function setSyncState(resource, patch) {
  const { error } = await db.from('sync_state').update(patch).eq('resource', resource);
  if (error) console.error(`[sync] failed to update sync_state(${resource}):`, error.message);
}

// Walks every page for a given BSE path, upserting each page INTO POSTGRES
// as it arrives (not buffered until the pull finishes). A 10-minute full
// pull still shows progressively fresher data throughout, and a mid-pull
// crash loses nothing already committed.
async function pullAllPages({ resource, path, params, upsertPage }) {
  let page = 1;
  let totalPages = 1;
  let totalRecords = 0;
  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...params });
  do {
    qs.set('page', String(page));
    const result = await fetchPageWithRetry(`${BSE_BASE_URL}${path}?${qs.toString()}`);
    await upsertPage(result.data);
    totalPages = result.totalPages;
    totalRecords = result.totalRecords;
    page++;
  } while (page <= totalPages);
  return totalRecords;
}

async function upsertClients(rows) {
  if (!rows.length) return;
  const payload = rows.map(c => ({
    client_id: c.clientId,
    name: c.name,
    segment: c.segment ?? null,
    kyc_status: c.kycStatus ?? null,
    onboarded_at: c.onboardedAt ?? null,
    bse_updated_at: c.updatedAt ?? null,
    synced_at: new Date().toISOString()
  }));
  // Deduplicate by client_id to prevent "ON CONFLICT DO UPDATE command cannot affect row a second time"
  // if the API returns duplicates within the same batch.
  const uniquePayload = Array.from(new Map(payload.map(item => [item.client_id, item])).values());
  const { error } = await db.from('clients').upsert(uniquePayload, { onConflict: 'client_id' });
  if (error) throw error;
}

async function upsertTrades(rows) {
  if (!rows.length) return;
  const payload = rows.map(t => ({
    trade_id: t.tradeId,
    client_id: t.clientId,
    trade_date: t.tradeDate,
    trade_timestamp: t.tradeTimestamp ?? null,  // full ISO timestamp from BSE
    brokerage: t.brokerage,
    amount: t.value ?? t.amount ?? null,
    side: t.side ?? null,
    synced_at: new Date().toISOString()
  }));
  // Deduplicate by trade_id to prevent Postgres conflict errors on same-statement duplicate keys.
  const uniquePayload = Array.from(new Map(payload.map(item => [item.trade_id, item])).values());
  const { error } = await db.from('trades').upsert(uniquePayload, { onConflict: 'trade_id' });
  if (error) throw error;
}

async function upsertMappings(rows) {
  if (!rows.length) return;
  const payload = rows.map(m => ({ client_id: m.clientId, employee_id: m.employeeId, synced_at: new Date().toISOString() }));
  // Deduplicate by client_id mapping key
  const uniquePayload = Array.from(new Map(payload.map(item => [item.client_id, item])).values());
  const { error } = await db.from('employee_client_mappings').upsert(uniquePayload, { onConflict: 'client_id' });
  if (error) throw error;
}

async function upsertEmployees(rows) {
  if (!rows.length) return;
  const payload = rows.map(e => ({ employee_id: e.employeeId, name: e.name, role: e.role, incentive_rate: e.incentiveRate ?? 0.10 }));
  // Deduplicate by employee_id
  const uniquePayload = Array.from(new Map(payload.map(item => [item.employee_id, item])).values());
  const { error } = await db.from('employees').upsert(uniquePayload, { onConflict: 'employee_id' });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Trades: incremental (since watermark) vs. reconciliation (full sweep).
// ---------------------------------------------------------------------------
async function syncTrades({ reconcile }) {
  if (locks.trades) {
    console.log(`[sync] skip trades (${reconcile ? 'reconcile' : 'incremental'}) — previous pull still running`);
    return;
  }
  locks.trades = true;
  const startedAt = Date.now();
  try {
    const state = await getSyncState('trades');
    const params = {};
    if (!reconcile && state.last_watermark) {
      // Pull a small overlap window (1 day back) past the watermark, not an
      // exact cutoff — protects against a trade that lands with a
      // trade_date slightly earlier than when it was actually synced
      // (settlement lag). Idempotent upsert means re-fetching that overlap
      // is free, not harmful.
      const from = new Date(new Date(state.last_watermark).getTime() - 24 * 60 * 60 * 1000);
      params.from = from.toISOString();
    }
    const total = await pullAllPages({
      resource: 'trades',
      path: '/trades',
      params,
      upsertPage: async (rows) => {
        const fresh = rows.filter(t => Number(t.tradeId.slice(3)) > 4000);
        if (fresh.length) console.log('[sync] new trades discovered this page:', fresh.map(t => t.tradeId));
        await upsertTrades(rows);
      }
    });
    const now = new Date().toISOString();
    await setSyncState('trades', {
      status: 'idle',
      last_success_at: now,
      last_watermark: now,
      ...(reconcile ? { last_reconciled_at: now } : {}),
      last_error: null
    });
    console.log(`[sync] trades ${reconcile ? 'RECONCILE' : 'incremental'} ok: ${total} records in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (err) {
    await setSyncState('trades', { status: 'failed', last_error: err.message });
    console.error(`[sync] trades pull aborted: ${err.message}. DB keeps last-known-good data; retried next cycle.`);
  } finally {
    locks.trades = false;
  }
}

async function syncClients() {
  // Clients have no stated "since" filter in the brief, so this is always a
  // full pull — but client master data churns far less than trades, so the
  // cost of a full pull here is not the bottleneck it would be for trades.
  if (locks.clients) {
    console.log('[sync] skip clients — previous pull still running');
    return;
  }
  locks.clients = true;
  const startedAt = Date.now();
  try {
    const total = await pullAllPages({ resource: 'clients', path: '/clients', params: {}, upsertPage: upsertClients });
    const now = new Date().toISOString();
    await setSyncState('clients', { status: 'idle', last_success_at: now, last_reconciled_at: now, last_error: null });
    console.log(`[sync] clients ok: ${total} records in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (err) {
    await setSyncState('clients', { status: 'failed', last_error: err.message });
    console.error(`[sync] clients pull aborted: ${err.message}`);
  } finally {
    locks.clients = false;
  }
}

// Internal application source — fast & reliable per the brief, so no
// pagination/retry machinery needed, just a plain fetch on a short interval.
async function syncEmployeesAndMappings() {
  try {
    const [employeesRes, mappingsRes] = await Promise.all([
      fetchWithTimeout(`${BSE_BASE_URL}/employees`),
      fetchWithTimeout(`${BSE_BASE_URL}/employee-mappings`)
    ]);
    await upsertEmployees(employeesRes.data);
    await upsertMappings(mappingsRes.data);
    await setSyncState('employees', { status: 'idle', last_success_at: new Date().toISOString(), last_error: null });
  } catch (err) {
    console.error(`[sync] employees/mappings failed: ${err.message}`);
    await setSyncState('employees', { status: 'failed', last_error: err.message });
  }
}

function start() {
  console.log(`[sync] starting. BSE_BASE_URL=${BSE_BASE_URL} incremental=${INCREMENTAL_INTERVAL_MS}ms reconcile=${RECONCILE_INTERVAL_MS}ms`);

  // Prime the cache on boot — first cycle is always a full pull regardless
  // of watermark, since an empty DB has nothing to be "incremental" from.
  syncEmployeesAndMappings();
  syncClients();
  syncTrades({ reconcile: true });

  setInterval(syncEmployeesAndMappings, FAST_POLL_INTERVAL_MS);
  setInterval(syncClients, RECONCILE_INTERVAL_MS); // clients: always full, just on the slow schedule
  setInterval(() => syncTrades({ reconcile: false }), INCREMENTAL_INTERVAL_MS);
  setInterval(() => syncTrades({ reconcile: true }), RECONCILE_INTERVAL_MS);
}

module.exports = { start, syncTrades, syncClients, syncEmployeesAndMappings };

// ---- Minimal HTTP listener (Render free-tier requirement) ----------------
// This worker has no natural HTTP surface — it's a background loop. Render's
// free tier only supports Web Services, which require listening on
// process.env.PORT and responding to requests. This listener exists purely
// to satisfy that requirement; it plays no role in the actual sync logic.
// Note: free Web Services still sleep after 15 min with no inbound HTTP
// traffic, which pauses this loop too — an external uptime pinger hitting
// this endpoint periodically keeps it alive continuously.
const HEALTH_PORT = process.env.PORT || 3001;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ingestion-worker running' }));
}).listen(HEALTH_PORT, () => {
  console.log(`[sync] health listener on :${HEALTH_PORT} (Render free-tier requirement, not part of sync logic)`);
});

if (require.main === module) {
  start();
}
