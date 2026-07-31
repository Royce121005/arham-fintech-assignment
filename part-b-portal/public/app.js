'use strict';

let currentView = 'clients';
let employees = [];

function currentUser() {
  const sel = document.getElementById('userSelect');
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return { employeeId: null, role: 'relationship_manager' };
  return { employeeId: opt.value, role: opt.dataset.role };
}

function renderTable(containerId, rows, columns) {
  const el = document.getElementById(containerId);
  if (!rows || rows.length === 0) {
    el.innerHTML = '<div class="empty">No records.</div>';
    return;
  }
  const head = columns.map(c => `<th>${c.label}</th>`).join('');
  const body = rows.map(r => `<tr>${columns.map(c => `<td>${r[c.key] ?? ''}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function loadClients() {
  const res = await fetch('/api/clients');
  const { data } = await res.json();
  renderTable('clientsTable', data, [
    { key: 'clientId', label: 'Client ID' },
    { key: 'name', label: 'Name' },
    { key: 'city', label: 'City' },
    { key: 'kycStatus', label: 'KYC' },
    { key: 'accountOpenedOn', label: 'Opened On' },
    { key: 'demat', label: 'Demat A/C' }
  ]);
}

async function loadTrades() {
  const clientId = document.getElementById('tradeClientFilter').value.trim();
  const from = document.getElementById('tradeFromFilter').value;
  const to = document.getElementById('tradeToFilter').value;
  const params = new URLSearchParams();
  if (clientId) params.set('clientId', clientId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const res = await fetch(`/api/trades?${params.toString()}`);
  const { data } = await res.json();
  renderTable('tradesTable', data.slice(0, 500), [
    { key: 'tradeId', label: 'Trade ID' },
    { key: 'clientId', label: 'Client' },
    { key: 'symbol', label: 'Symbol' },
    { key: 'side', label: 'Side' },
    { key: 'quantity', label: 'Qty' },
    { key: 'price', label: 'Price' },
    { key: 'value', label: 'Value' },
    { key: 'brokerage', label: 'Brokerage' },
    { key: 'tradeDate', label: 'Date' }
  ]);
}

async function loadMyClients() {
  const { employeeId } = currentUser();
  if (!employeeId) return renderTable('myClientsTable', [], []);
  const res = await fetch(`/api/my-clients?employeeId=${employeeId}`);
  const { data } = await res.json();
  renderTable('myClientsTable', data, [
    { key: 'clientId', label: 'Client ID' },
    { key: 'name', label: 'Name' },
    { key: 'city', label: 'City' },
    { key: 'kycStatus', label: 'KYC' }
  ]);
}

async function loadEmployees() {
  const res = await fetch('/api/employees');
  const { data } = await res.json();
  renderTable('employeesTable', data, [
    { key: 'employeeId', label: 'Employee ID' },
    { key: 'name', label: 'Name' },
    { key: 'department', label: 'Department' },
    { key: 'role', label: 'Role' },
    { key: 'email', label: 'Email' }
  ]);
}

async function loadIncentives() {
  const { employeeId, role } = currentUser();
  const params = new URLSearchParams({ employeeId: employeeId || '', role });
  const res = await fetch(`/api/incentives?${params.toString()}`);
  const { data } = await res.json();
  renderTable('incentivesTable', data, [
    { key: 'employeeId', label: 'Employee ID' },
    { key: 'name', label: 'Name' },
    { key: 'mappedClientCount', label: 'Clients' },
    { key: 'tradeCount', label: 'Trades' },
    { key: 'totalBrokerage', label: 'Total Brokerage' },
    { key: 'incentiveRate', label: 'Rate' },
    { key: 'incentive', label: 'Incentive (₹)' }
  ]);
}

const loaders = {
  clients: loadClients,
  trades: loadTrades,
  myClients: loadMyClients,
  employees: loadEmployees,
  incentives: loadIncentives
};

function switchView(view) {
  currentView = view;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  loaders[view]();
}

async function loadUserOptions() {
  const res = await fetch('/api/employees');
  const { data } = await res.json();
  employees = data;
  const sel = document.getElementById('userSelect');
  sel.innerHTML = '';
  const mgmtOpt = document.createElement('option');
  const mgr = data.find(e => e.role === 'management');
  if (mgr) {
    mgmtOpt.value = mgr.employeeId;
    mgmtOpt.dataset.role = 'management';
    mgmtOpt.textContent = `${mgr.name} (Management)`;
    sel.appendChild(mgmtOpt);
  }
  data.filter(e => e.role === 'relationship_manager').forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.employeeId;
    opt.dataset.role = e.role;
    opt.textContent = `${e.name} (RM)`;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    if (currentView === 'myClients' || currentView === 'incentives') loaders[currentView]();
  });
}

function setupSSE() {
  const badge = document.getElementById('syncBadge');
  const es = new EventSource('/api/events');
  const markFresh = label => {
    badge.textContent = label;
    badge.classList.add('fresh');
    setTimeout(() => badge.classList.remove('fresh'), 1200);
  };

  es.addEventListener('clients-updated', e => {
    const d = JSON.parse(e.data);
    markFresh(`clients synced (page ${d.page}/${d.totalPages})`);
    if (currentView === 'clients' || currentView === 'myClients') loaders[currentView]();
  });
  es.addEventListener('trades-updated', e => {
    const d = JSON.parse(e.data);
    markFresh(`trades synced (page ${d.page}/${d.totalPages})`);
    if (currentView === 'trades' || currentView === 'incentives') loaders[currentView]();
  });
  es.addEventListener('employees-updated', () => {
    markFresh('employees synced');
    if (currentView === 'employees') loaders[currentView]();
  });
  es.onerror = () => {
    badge.textContent = 'reconnecting…';
  };
}

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.getElementById('tradeFilterBtn').addEventListener('click', loadTrades);

(async function init() {
  await loadUserOptions();
  switchView('clients');
  setupSSE();
})();
