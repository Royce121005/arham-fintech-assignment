'use strict';

const express = require('express');
const path = require('path');
const store = require('./store');
const { handleSSE } = require('./sse');
const poller = require('./poller');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Every route below reads ONLY from the local cache (store.js). None of
// them ever call out to BSE live - that's what guarantees the "<1s load,
// even if BSE is down" hard requirement: BSE being down just means the
// poller's background pulls fail and get retried; the API layer here is
// completely unaffected and keeps serving last-known-good data.

app.get('/api/meta', (req, res) => {
  res.json(store.getMeta());
});

app.get('/api/clients', (req, res) => {
  res.json({ data: store.getClients() });
});

app.get('/api/trades', (req, res) => {
  const { clientId, from, to } = req.query;
  res.json({ data: store.getTrades({ clientId, from, to }) });
});

app.get('/api/employees', (req, res) => {
  res.json({ data: store.getEmployees() });
});

// "My Clients" - employee sees only clients mapped to them
app.get('/api/my-clients', (req, res) => {
  const { employeeId } = req.query;
  if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
  const clientIds = new Set(store.getClientIdsForEmployee(employeeId));
  const data = store.getClients().filter(c => clientIds.has(c.clientId));
  res.json({ data });
});

// Incentives - employee sees only their own row; management sees all
app.get('/api/incentives', (req, res) => {
  const { employeeId, role } = req.query;
  const all = store.getIncentives();
  if (role === 'management') {
    return res.json({ data: all });
  }
  if (!employeeId) return res.status(400).json({ error: 'employeeId required for non-management view' });
  res.json({ data: all.filter(row => row.employeeId === employeeId) });
});

// Live-update channel - browser tabs subscribe here and refetch the
// relevant view whenever the poller commits fresh data.
app.get('/api/events', handleSSE);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`[portal] listening on :${PORT}`);
  poller.start();
});
