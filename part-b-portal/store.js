'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------
// This is the LOCAL CACHE the portal actually reads from. It is the whole
// reason screens load in <1s regardless of BSE's health: the poller (see
// poller.js) fills this in the background, and every /api/* route below
// reads only from here - never live from BSE.
//
// Data model:
//   clients:   Map<clientId, client>
//   trades:    Map<tradeId, trade>      <- unique key makes retries idempotent
//   employees: Map<employeeId, employee>
//   mappings:  Map<clientId, employeeId>  (1 client -> 1 RM, per the brief)
//
// Using a plain in-memory Map means a page fetch upsert is just object
// assignment - naturally last-write-wins per record, so two overlapping
// pulls writing the same record can never corrupt it into a half-written
// state (unlike e.g. appending to an array). Combined with the pull lock
// in poller.js (only one pull per resource runs at a time), this rules out
// the "overlapping refresh" corruption case called out in the brief.
//
// A JSON snapshot is written periodically so a restart doesn't start from
// a cold, empty cache (screens would otherwise show nothing until the
// first pull completes, which can take up to ~10 min against real BSE).
// -----------------------------------------------------------------------

const SNAPSHOT_PATH = path.join(__dirname, '.cache-snapshot.json');

const state = {
  clients: new Map(),
  trades: new Map(),
  employees: new Map(),
  mappings: new Map(), // clientId -> employeeId
  meta: {
    lastClientsSyncAt: null,
    lastTradesSyncAt: null,
    lastEmployeesSyncAt: null,
    clientsInitialLoadComplete: false,
    tradesInitialLoadComplete: false
  }
};

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    state.clients = new Map(raw.clients || []);
    state.trades = new Map(raw.trades || []);
    state.employees = new Map(raw.employees || []);
    state.mappings = new Map(raw.mappings || []);
    state.meta = { ...state.meta, ...(raw.meta || {}) };
    console.log(`[store] restored snapshot: ${state.clients.size} clients, ${state.trades.size} trades, ${state.employees.size} employees`);
  } catch (err) {
    console.warn('[store] failed to load snapshot, starting cold:', err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = {
      clients: [...state.clients.entries()],
      trades: [...state.trades.entries()],
      employees: [...state.employees.entries()],
      mappings: [...state.mappings.entries()],
      meta: state.meta
    };
    fs.writeFile(SNAPSHOT_PATH, JSON.stringify(payload), err => {
      if (err) console.warn('[store] snapshot save failed:', err.message);
    });
  }, 2000); // debounce - avoid writing to disk on every single page upsert
}

// ---- Upserts (idempotent: keyed by primary id, safe to call repeatedly
//      with the same record, which is exactly what happens on retry) ------
function upsertClients(records) {
  for (const c of records) state.clients.set(c.clientId, c);
  state.meta.lastClientsSyncAt = new Date().toISOString();
  scheduleSave();
}

function upsertTrades(records) {
  for (const t of records) state.trades.set(t.tradeId, t);
  state.meta.lastTradesSyncAt = new Date().toISOString();
  scheduleSave();
}

function upsertEmployees(records) {
  for (const e of records) state.employees.set(e.employeeId, e);
  state.meta.lastEmployeesSyncAt = new Date().toISOString();
  scheduleSave();
}

function upsertMappings(records) {
  for (const m of records) state.mappings.set(m.clientId, m.employeeId);
  scheduleSave();
}

// ---- Reads (what the portal's API layer actually calls) ------------------
function getClients() {
  return [...state.clients.values()];
}

function getTrades({ clientId, from, to } = {}) {
  let out = [...state.trades.values()];
  if (clientId) out = out.filter(t => t.clientId === clientId);
  if (from) out = out.filter(t => t.tradeDate >= from);
  if (to) out = out.filter(t => t.tradeDate <= to);
  return out.sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));
}

function getEmployees() {
  return [...state.employees.values()];
}

function getClientIdsForEmployee(employeeId) {
  const ids = [];
  for (const [clientId, empId] of state.mappings.entries()) {
    if (empId === employeeId) ids.push(clientId);
  }
  return ids;
}

function getIncentives() {
  // incentive = incentiveRate * sum(brokerage) over trades of mapped clients
  const clientIdsByEmployee = new Map();
  for (const [clientId, employeeId] of state.mappings.entries()) {
    if (!clientIdsByEmployee.has(employeeId)) clientIdsByEmployee.set(employeeId, new Set());
    clientIdsByEmployee.get(employeeId).add(clientId);
  }
  const brokerageByClient = new Map();
  for (const trade of state.trades.values()) {
    brokerageByClient.set(trade.clientId, (brokerageByClient.get(trade.clientId) || 0) + trade.brokerage);
  }
  const results = [];
  for (const emp of state.employees.values()) {
    if (emp.role !== 'relationship_manager') continue;
    const clientIds = clientIdsByEmployee.get(emp.employeeId) || new Set();
    let totalBrokerage = 0;
    let tradeCount = 0;
    for (const cid of clientIds) {
      totalBrokerage += brokerageByClient.get(cid) || 0;
    }
    for (const trade of state.trades.values()) {
      if (clientIds.has(trade.clientId)) tradeCount++;
    }
    results.push({
      employeeId: emp.employeeId,
      name: emp.name,
      mappedClientCount: clientIds.size,
      tradeCount,
      totalBrokerage: +totalBrokerage.toFixed(2),
      incentiveRate: emp.incentiveRate,
      incentive: +(totalBrokerage * emp.incentiveRate).toFixed(2)
    });
  }
  return results.sort((a, b) => b.incentive - a.incentive);
}

function getMeta() {
  return {
    ...state.meta,
    counts: {
      clients: state.clients.size,
      trades: state.trades.size,
      employees: state.employees.size,
      mappings: state.mappings.size
    }
  };
}

loadSnapshot();

module.exports = {
  upsertClients, upsertTrades, upsertEmployees, upsertMappings,
  getClients, getTrades, getEmployees, getClientIdsForEmployee, getIncentives, getMeta,
  _state: state // exposed for poller to mark initial-load-complete flags
};
