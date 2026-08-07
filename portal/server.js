'use strict';

// This server does almost nothing on purpose: it serves the static portal
// files and exposes ONE dynamic endpoint (/env.js) that injects the
// Supabase URL and ANON key into the page. There is no /api/* here — reads
// go browser -> Supabase directly (see public/app.js), scoped by RLS.
// The anon key is safe to ship to the browser: it identifies the project,
// it does not grant any access RLS doesn't already allow.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

app.get('/env.js', (req, res) => {
  res.type('application/javascript').send(
    `window.__ENV__ = ${JSON.stringify({ SUPABASE_URL, SUPABASE_ANON_KEY })};`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`[portal] serving static UI on :${PORT} (Supabase: ${SUPABASE_URL})`);
});
