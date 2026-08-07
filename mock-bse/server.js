'use strict';

const express = require('express');
const { EMPLOYEES, CLIENTS, MAPPINGS, TRADES, createLiveTrade } = require('./seed');

const app = express();
app.use(express.json());

// ---- Configurable "pain" knobs -------------------------------------------
// A real BSE full pull takes 5-10 minutes and the network kills any single
// HTTP request after 30s. That means a caller CANNOT pull everything in one
// request - it must paginate. We simulate that reality: every page fetch
// pays a fixed latency, and ~20% of page fetches die mid-flight (socket
// reset, no response at all) and must be retried by the caller.
//
// BSE_DELAY_MS       - latency per page fetch (ms). Default is small for
//                       local dev. At BSE_DELAY_MS=30000 with PAGE_SIZE=50
//                       against 300 clients / 4000 trades, a full paginated
//                       pull of trades (80 pages) takes ~10 minutes wall
//                       clock, which is the scenario we must design for.
// BSE_FAILURE_RATE   - probability [0,1] a given page request fails midway.
// BSE_PAGE_SIZE       - default page size if caller doesn't specify one.
const DELAY_MS = Number(process.env.BSE_DELAY_MS ?? 250);
const FAILURE_RATE = Number(process.env.BSE_FAILURE_RATE ?? 0.2);
const DEFAULT_PAGE_SIZE = Number(process.env.BSE_PAGE_SIZE ?? 50);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Middleware applied only to the "painful" BSE endpoints (clients, trades).
// Simulates network latency, then with probability FAILURE_RATE throws a failure.
// In production, failures are not just dropped connections (socket resets), but
// also HTTP error status codes like 500, 429, and 503. We simulate these.
async function bsePain(req, res, next) {
  await sleep(DELAY_MS);
  if (Math.random() < FAILURE_RATE) {
    const failureType = Math.random();
    if (failureType < 0.50) {
      // 50% chance: Mid-pull connection drop (socket destroy)
      req.socket.destroy();
      return;
    } else if (failureType < 0.70) {
      // 20% chance: 500 Internal Server Error
      res.status(500).json({ error: 'Internal Server Error', message: 'BSE Database connection timed out.' });
      return;
    } else if (failureType < 0.85) {
      // 15% chance: 429 Too Many Requests
      res.status(429).json({ error: 'Too Many Requests', message: 'Rate limit exceeded for client master feed.' });
      return;
    } else {
      // 15% chance: 503 Service Unavailable
      res.status(503).json({ error: 'Service Unavailable', message: 'BSE Gateway is temporarily overloaded.' });
      return;
    }
  }
  next();
}

function paginate(array, page, pageSize) {
  const start = (page - 1) * pageSize;
  const slice = array.slice(start, start + pageSize);
  
  let responseData = [...slice];
  
  // Simulate duplicate records and inconsistent page sizes (15% chance)
  // We duplicate a random record in the current page, which increases the page size by 1.
  // This validates the client's idempotent upsert (ON CONFLICT DO UPDATE).
  if (Math.random() < 0.15 && responseData.length > 0) {
    const randomIndex = Math.floor(Math.random() * responseData.length);
    const duplicateRecord = { ...responseData[randomIndex] };
    responseData.push(duplicateRecord);
  }
  
  return {
    data: responseData,
    page,
    pageSize: responseData.length, // returned page size is dynamic
    totalRecords: array.length,
    totalPages: Math.ceil(array.length / pageSize),
    hasMore: start + pageSize < array.length
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', delayMs: DELAY_MS, failureRate: FAILURE_RATE });
});

// ---- Painful BSE endpoints (client master + trades) -----------------------
app.get('/clients', bsePain, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE);
  res.json(paginate(CLIENTS, page, pageSize));
});

app.get('/trades', bsePain, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE);
  let filtered = TRADES;
  if (req.query.clientId) {
    filtered = filtered.filter(t => t.clientId === req.query.clientId);
  }
  if (req.query.from) {
    filtered = filtered.filter(t => t.tradeTimestamp >= req.query.from || t.tradeDate >= req.query.from);
  }
  if (req.query.to) {
    filtered = filtered.filter(t => t.tradeDate <= req.query.to);
  }
  res.json(paginate(filtered, page, pageSize));
});

// ---- Instant, reliable "internal application" endpoints -------------------
// No delay, no failure - represents the fast internal system per the brief.
app.get('/employees', (req, res) => {
  res.json({ data: EMPLOYEES, totalRecords: EMPLOYEES.length });
});

app.get('/employee-mappings', (req, res) => {
  res.json({ data: MAPPINGS, totalRecords: MAPPINGS.length });
});

const PORT = process.env.PORT || 4000;

// ---- Live trade generation ------------------------------------------------
// A real BSE has trading happening continuously. To reflect that, this mock
// mints one new trade every cycle, on the same cadence as the ingestion
// worker's incremental pull (30s default), so each incremental sync has
// exactly one genuinely new record to discover — not just the static seed.
// Can be disabled with BSE_LIVE_TRADES=false if a static-only run is ever
// needed (e.g. deterministic tests), but the default is on.
const LIVE_TRADES_ENABLED = String(process.env.BSE_LIVE_TRADES ?? 'true').toLowerCase() === 'true';
const LIVE_TRADE_INTERVAL_MS = Number(process.env.BSE_LIVE_TRADE_INTERVAL_MS ?? 30000);

if (LIVE_TRADES_ENABLED) {
  setInterval(() => {
    const trade = createLiveTrade();
    console.log(`[mock-bse-api] minted live trade ${trade.tradeId} (${trade.symbol}, ${trade.side}) for ${trade.clientId}`);
  }, LIVE_TRADE_INTERVAL_MS);
}
app.listen(PORT, () => {
  console.log(`[mock-bse-api] listening on :${PORT}`);
  console.log(`[mock-bse-api] BSE_DELAY_MS=${DELAY_MS} BSE_FAILURE_RATE=${FAILURE_RATE} PAGE_SIZE=${DEFAULT_PAGE_SIZE}`);
  console.log(`[mock-bse-api] seeded: ${CLIENTS.length} clients, ${TRADES.length} trades, ${EMPLOYEES.length} employees`);
});
