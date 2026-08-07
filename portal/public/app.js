// =============================================================================
// This file is the entire read path of the portal. There is no Express API
// layer between this and Postgres — the browser talks to Supabase directly:
//   - `.from(table).select()` goes through PostgREST, which enforces the RLS
//     policies in supabase/migrations/0001_schema.sql.
//   - `.channel(...).on('postgres_changes', ...)` is Realtime, which tails
//     Postgres's write-ahead log and pushes committed rows to subscribed
//     browsers, RLS-scoped the same way.
// Both use the ANON key only — it has no write access to clients/trades/
// mappings (only the ingestion worker's service_role key does), so even a
// compromised browser session can't corrupt the cache, only read what RLS
// allows it to read.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = window.__ENV__?.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_ANON_KEY = window.__ENV__?.SUPABASE_ANON_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentActorId = null;
let currentActorRole = null;

// ---------------------------------------------------------------------------
// Identity: anonymous sign-in gives a real auth.uid() with zero login UI.
// The employee picker then "claims" an unclaimed employee row onto that
// uid (see the employees_claim_identity policy) so RLS + Realtime both
// scope against a real identity, not a client-side variable pretending to
// be one.
// ---------------------------------------------------------------------------
async function ensureAnonymousSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

async function loadActorBar() {
  const { data: employees, error } = await supabase.from('employees').select('employee_id, name, role, user_id');
  if (error) { console.error('failed to load employees for actor bar', error); return; }

  const select = document.getElementById('actor-select');
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select employee…';
  select.appendChild(placeholder);
  for (const e of employees) {
    const opt = document.createElement('option');
    opt.value = e.employee_id;
    opt.textContent = `${e.name} (${e.role})${e.user_id ? '' : ' — unclaimed'}`;
    select.appendChild(opt);
  }

  select.addEventListener('change', async () => {
    const employeeId = select.value;
    if (!employeeId) return;
    
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      alert('No active session found.');
      return;
    }

    // 1. Release our claim on any currently claimed employee row first.
    // This avoids violating the employees_user_id_key unique constraint.
    const { error: releaseErr } = await supabase
      .from('employees')
      .update({ user_id: null })
      .eq('user_id', user.id);
    if (releaseErr) {
      console.warn('Could not release previous claim:', releaseErr.message);
    }

    // 2. Claim the new employee row.
    const { error: claimErr } = await supabase
      .from('employees')
      .update({ user_id: user.id })
      .eq('employee_id', employeeId);
    if (claimErr) {
      alert(`Could not act as ${employeeId}: ${claimErr.message} (likely already claimed by another session in this demo)`);
      return;
    }
    currentActorId = employeeId;
    const emp = employees.find(e => e.employee_id === employeeId);
    currentActorRole = emp?.role;

    // 3. Reload the actor bar so the "— unclaimed" labels in the dropdown
    //    update to reflect the new claimed/released state.
    await loadActorBar();
    document.getElementById('actor-select').value = employeeId;

    refreshActiveView();
  });
}

// ---------------------------------------------------------------------------
// Views — every render reads only from Postgres via the RLS-scoped client.
// ---------------------------------------------------------------------------
const renderers = {
  clients: async () => {
    const { data, error } = await supabase.from('clients').select('client_id, name, segment, kyc_status').order('client_id');
    renderRows('clients-body', error ? [] : data, c => [c.client_id, c.name, c.segment ?? '—', c.kyc_status ?? '—']);
  },
  trades: async () => {
    let q = supabase.from('trades').select('trade_id, client_id, trade_date, trade_timestamp, side, amount, brokerage').order('trade_timestamp', { ascending: false }).limit(500);
    const clientId = document.getElementById('trades-client-filter').value.trim();
    const from = document.getElementById('trades-from-filter').value;
    const to = document.getElementById('trades-to-filter').value;
    if (clientId) q = q.eq('client_id', clientId);
    if (from) q = q.gte('trade_date', from);
    if (to) q = q.lte('trade_date', to);
    const { data, error } = await q;
    renderRows('trades-body', error ? [] : data, t => {
      // Show full timestamp if available, otherwise fall back to date only
      const displayTime = t.trade_timestamp
        ? new Date(t.trade_timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        : t.trade_date;
      return [t.trade_id, t.client_id, displayTime, t.side ?? '—', t.amount != null ? Number(t.amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR' }) : '—', Number(t.brokerage).toFixed(2)];
    });
  },
  'my-clients': async () => {
    // No employee_id filter here on purpose: RLS already restricts this
    // query to the acting employee's mapped clients. Filtering client-side
    // would be redundant with (and weaker than) what the DB already enforces.
    const { data, error } = await supabase.from('clients').select('client_id, name, segment').order('client_id');
    renderRows('my-clients-body', error ? [] : data, c => [c.client_id, c.name, c.segment ?? '—']);
  },
  employees: async () => {
    const { data, error } = await supabase.from('employees').select('employee_id, name, role').order('employee_id');
    renderRows('employees-body', error ? [] : data, e => [e.employee_id, e.name, e.role]);
  },
  incentives: async () => {
    const { data, error } = await supabase.from('incentives').select('*').order('incentive_amount', { ascending: false });
    renderRows('incentives-body', error ? [] : data, i => [i.name, i.trade_count, Number(i.total_brokerage).toFixed(2), Number(i.incentive_amount).toFixed(2)]);
  }
};

function renderRows(tbodyId, rows, mapFn) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="10" class="empty">No rows visible for the current actor.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = mapFn(row).map(v => `<td>${v}</td>`).join('');
    tbody.appendChild(tr);
  }
}

let activeView = 'clients';
function refreshActiveView() {
  renderers[activeView]?.();
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  activeView = btn.dataset.view;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${activeView}`));
  refreshActiveView();
});
document.getElementById('trades-filter-apply').addEventListener('click', () => renderers.trades());

// ---------------------------------------------------------------------------
// Realtime: re-render whichever view is currently open when its underlying
// table changes. This is what satisfies "open screens update without the
// user refreshing the page" — the trigger is a committed Postgres write,
// not a client-side timer.
// ---------------------------------------------------------------------------
function subscribeRealtime() {
  const channel = supabase.channel('portal-live');
  for (const table of ['clients', 'trades', 'employee_client_mappings', 'employees']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
      document.getElementById('sync-badge').textContent = `live update: ${table} @ ${new Date().toLocaleTimeString()}`;
      // Only the currently-visible view needs to re-render; other tabs will
      // re-fetch fresh data naturally when the user switches to them.
      refreshActiveView();
    });
  }
  channel.subscribe();
}

async function main() {
  await ensureAnonymousSession();
  await loadActorBar();
  subscribeRealtime();
  refreshActiveView();
}

main().catch(err => {
  console.error('portal init failed', err);
  document.body.innerHTML = `<pre style="color:red">Failed to start: ${err.message}</pre>`;
});
