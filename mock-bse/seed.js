'use strict';

// Deterministic PRNG (mulberry32) so the same seed always produces the same
// dataset -> makes local dev and grading reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);

const FIRST_NAMES = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan',
  'Diya', 'Ananya', 'Saanvi', 'Aadhya', 'Kiara', 'Myra', 'Anika', 'Navya', 'Riya', 'Sara'];
const LAST_NAMES = ['Sharma', 'Verma', 'Gupta', 'Patel', 'Iyer', 'Reddy', 'Nair', 'Rao', 'Mehta', 'Kapoor',
  'Joshi', 'Chatterjee', 'Bose', 'Malhotra', 'Agarwal', 'Desai', 'Pillai', 'Menon', 'Trivedi', 'Bhatt'];
const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Chennai', 'Hyderabad', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Surat'];
const SYMBOLS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'SBIN', 'BHARTIARTL', 'ITC',
  'KOTAKBANK', 'LT', 'AXISBANK', 'BAJFINANCE', 'MARUTI', 'ASIANPAINT', 'WIPRO', 'ONGC', 'TITAN', 'ADANIENT', 'NTPC'];
const DEPARTMENTS = ['Equity Broking', 'Derivatives Desk', 'Wealth Management', 'Institutional Sales'];

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

function buildEmployees(count) {
  const employees = [];
  for (let i = 1; i <= count; i++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    employees.push({
      employeeId: `EMP${pad(i, 4)}`,
      name: `${first} ${last}`,
      email: `${first}.${last}.${i}@arhamfintech.ai`.toLowerCase(),
      department: pick(DEPARTMENTS),
      role: i === 1 ? 'management' : 'relationship_manager',
      incentiveRate: 0.10 // 10% of brokerage on mapped clients' trades
    });
  }
  return employees;
}

function buildClients(count) {
  const clients = [];
  const SEGMENTS = ['Retail', 'HNI', 'Institutional', 'Corporate'];
  for (let i = 1; i <= count; i++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const createdDaysAgo = Math.floor(rand() * 900);
    const created = new Date(Date.now() - createdDaysAgo * 86400000);
    clients.push({
      clientId: `CLI${pad(i, 5)}`,
      name: `${first} ${last}`,
      segment: pick(SEGMENTS),
      city: pick(CITIES),
      pan: `${pad(Math.floor(rand() * 9999), 4)}${last.slice(0, 3).toUpperCase()}P`,
      demat: `IN30${pad(Math.floor(rand() * 99999999), 8)}`,
      accountOpenedOn: created.toISOString().slice(0, 10),
      kycStatus: rand() > 0.05 ? 'verified' : 'pending'
    });
  }
  return clients;
}

function buildMappings(employees, clients) {
  // relationship managers only (skip index 0 = management)
  const rms = employees.filter(e => e.role === 'relationship_manager');
  const mappings = [];
  for (const client of clients) {
    const rm = pick(rms);
    mappings.push({ clientId: client.clientId, employeeId: rm.employeeId });
  }
  return mappings;
}

function buildTrades(count, clients) {
  const trades = [];
  const now = Date.now();
  for (let i = 1; i <= count; i++) {
    const client = pick(clients);
    const daysAgo = Math.floor(rand() * 365);
    const tradeDate = new Date(now - daysAgo * 86400000);
    const qty = Math.floor(rand() * 500) + 1;
    const price = +(rand() * 3000 + 50).toFixed(2);
    const value = +(qty * price).toFixed(2);
    // brokerage ~ 0.03% - 0.05% of trade value, a realistic broking rate
    const brokerage = +(value * (0.0003 + rand() * 0.0002)).toFixed(2);
    trades.push({
      tradeId: `TRD${pad(i, 7)}`,
      clientId: client.clientId,
      symbol: pick(SYMBOLS),
      side: rand() > 0.5 ? 'BUY' : 'SELL',
      quantity: qty,
      price,
      value,
      brokerage,
      tradeDate: tradeDate.toISOString().slice(0, 10),
      tradeTimestamp: tradeDate.toISOString()
    });
  }
  // Keep stable order by id for deterministic pagination
  trades.sort((a, b) => a.tradeId.localeCompare(b.tradeId));
  return trades;
}

const EMPLOYEES = buildEmployees(20);
const CLIENTS = buildClients(300);
const MAPPINGS = buildMappings(EMPLOYEES, CLIENTS);
const TRADES = buildTrades(4000, CLIENTS);

// ---- Live trade generation (opt-in, for demoing incremental sync) --------
// Everything above is generated once at boot with a fixed seed and then sits
// static. This appends new trades to the in-memory TRADES array over time,
// so an incremental sync pointed at this mock can observe "new trade shows
// up -> gets picked up" instead of just re-matching the same 4000 forever.
// Continues the tradeId sequence from wherever the seeded set left off.
let liveTradeCounter = TRADES.length;

function createLiveTrade() {
  const client = pick(CLIENTS);
  const now = new Date();
  const qty = Math.floor(rand() * 500) + 1;
  const price = +(rand() * 3000 + 50).toFixed(2);
  const value = +(qty * price).toFixed(2);
  const brokerage = +(value * (0.0003 + rand() * 0.0002)).toFixed(2);

  liveTradeCounter += 1;
  const trade = {
    tradeId: `TRD${pad(liveTradeCounter, 7)}`,
    clientId: client.clientId,
    symbol: pick(SYMBOLS),
    side: rand() > 0.5 ? 'BUY' : 'SELL',
    quantity: qty,
    price,
    value,
    brokerage,
    tradeDate: now.toISOString().slice(0, 10),
    tradeTimestamp: now.toISOString()
  };
  TRADES.push(trade);
  return trade;
}

module.exports = { EMPLOYEES, CLIENTS, MAPPINGS, TRADES, createLiveTrade };
