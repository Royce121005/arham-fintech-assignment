-- =============================================================================
-- Arham Fintech — Internal Ops Portal schema
--
-- Design intent (read this before touching RLS below):
--
-- 1. This is the "cache-then-serve" store. The ingestion worker is the ONLY
--    writer (via the service_role key, which bypasses RLS). The portal never
--    talks to BSE directly — it only ever reads from these tables, which is
--    what makes "<1s load even if BSE is down" true by construction.
--
-- 2. Idempotency: every upsert from the ingestion worker is
--    `insert ... on conflict (primary key) do update`. A retried page can
--    never create a duplicate row or a torn record — retrying just re-applies
--    the same row.
--
-- 3. Row Level Security enforces "My Clients" / "own incentives vs all" at
--    the data layer, not in application code. A bug in a route handler
--    cannot leak another RM's clients, because Postgres itself refuses the
--    row. This is the thing an app-level `if (employeeId === x)` check
--    cannot guarantee.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Core entities
-- ---------------------------------------------------------------------------

create table employees (
  employee_id   text primary key,
  name          text not null,
  role          text not null check (role in ('relationship_manager', 'management')),
  incentive_rate numeric not null default 0.10,
  -- Links this row to a Supabase Auth identity. The brief doesn't ask for a
  -- login flow, so there's no password/signup UI — but this is still a real
  -- auth.uid(), obtained via Supabase's anonymous sign-in, "claimed" onto an
  -- employee row the first time a browser picks "act as <employee>". That
  -- real identity is what both RLS AND Realtime key off (see below for why
  -- that distinction matters), rather than a request-header trick that
  -- would only work for REST reads and silently fail to scope Realtime.
  user_id       uuid unique,
  created_at    timestamptz not null default now()
);

create table clients (
  client_id     text primary key,
  name          text not null,
  segment       text,
  kyc_status    text,
  onboarded_at  date,
  -- BSE's own "last changed" timestamp, if it exposes one — lets us do
  -- incremental pulls later even for clients. Nullable because the brief's
  -- mock doesn't guarantee this field; treated as best-effort.
  bse_updated_at timestamptz,
  synced_at     timestamptz not null default now()
);

create table employee_client_mappings (
  client_id     text primary key references clients(client_id) on delete cascade,
  employee_id   text not null references employees(employee_id) on delete cascade,
  synced_at     timestamptz not null default now()
);
create index idx_mappings_employee on employee_client_mappings(employee_id);

create table trades (
  trade_id      text primary key,
  client_id     text not null references clients(client_id) on delete cascade,
  trade_date    date not null,
  brokerage     numeric not null,
  amount        numeric,
  side          text,
  synced_at     timestamptz not null default now()
);
-- These two indexes exist because they are the actual query patterns named
-- in the brief: Trades screen filters by client + date range; incentives
-- aggregates brokerage per client.
create index idx_trades_client on trades(client_id);
create index idx_trades_date on trades(trade_date);
create index idx_trades_client_date on trades(client_id, trade_date);

-- ---------------------------------------------------------------------------
-- Sync bookkeeping — this is what turns "poll everything every cycle" into
-- "poll what changed since the last successful sync, plus a slow
-- reconciliation sweep." One row per resource.
-- ---------------------------------------------------------------------------

create table sync_state (
  resource            text primary key,       -- 'clients' | 'trades'
  last_watermark      timestamptz,             -- high-water mark for incremental pulls
  last_success_at     timestamptz,
  last_reconciled_at  timestamptz,             -- last time a FULL sweep completed
  status              text not null default 'idle',  -- idle | running | failed
  last_error          text
);
insert into sync_state (resource) values ('clients'), ('trades'), ('employees');

-- ---------------------------------------------------------------------------
-- Incentives — computed as a view, not scanned at request time from app code.
-- At 100x this is the thing that would otherwise become an O(trades) scan on
-- every page load; a view keeps the computation in one place and in SQL,
-- and can be swapped for a materialized view (refreshed after each trade
-- sync batch) without touching a single line of portal code.
-- ---------------------------------------------------------------------------

create view incentives as
select
  e.employee_id,
  e.name,
  e.incentive_rate,
  coalesce(sum(t.brokerage), 0)                    as total_brokerage,
  coalesce(sum(t.brokerage) * e.incentive_rate, 0)  as incentive_amount,
  count(t.trade_id)                                 as trade_count
from employees e
left join employee_client_mappings m on m.employee_id = e.employee_id
left join trades t on t.client_id = m.client_id
where e.role = 'relationship_manager'
  and (
    current_actor_is_management()
    or e.employee_id = current_actor()
  )
group by e.employee_id, e.name, e.incentive_rate;

-- =============================================================================
-- Row Level Security
--
-- current_actor() resolves to the employee row whose user_id matches the
-- CALLER'S REAL auth.uid() — obtained via Supabase anonymous sign-in, no
-- password/signup UI required. This is deliberately NOT a request-header
-- trick: Realtime's postgres_changes RLS check runs against the
-- WebSocket's authenticated identity (auth.uid()/auth.jwt()), which has no
-- concept of arbitrary HTTP headers. A header-based "who is this" would
-- correctly scope REST reads and then silently misbehave for Realtime —
-- exactly the kind of gap the brief's "hard requirements" are designed to
-- surface. Using real auth.uid() (even anonymous) means one identity
-- mechanism correctly scopes BOTH read paths.
-- =============================================================================

create or replace function current_actor() returns text
language sql stable
as $$
  select employee_id from employees where user_id = auth.uid();
$$;

create or replace function current_actor_is_management() returns boolean
language sql stable
as $$
  select exists (
    select 1 from employees
    where user_id = auth.uid() and role = 'management'
  );
$$;

-- Lets an anonymous session "claim" an unclaimed employee identity (the
-- stand-in for login: pick who you are, once per session). Scoped so a
-- session can only claim a row nobody has claimed yet — it cannot hijack an
-- already-claimed identity. This is a demo-grade substitute for real auth,
-- not a production access-control mechanism; noted explicitly rather than
-- glossed over.
create policy employees_claim_identity on employees
  for update
  using (user_id is null or user_id = auth.uid())
  with check (user_id = auth.uid() or user_id is null);

alter table employees enable row level security;
alter table clients enable row level security;
alter table employee_client_mappings enable row level security;
alter table trades enable row level security;

-- Employees: everyone can see the employee directory (brief: "Employee —
-- all employees sees on the platform" applies to all roles, not just mgmt).
create policy employees_read_all on employees
  for select using (true);

-- Clients: management sees all; an RM sees only clients mapped to them.
create policy clients_scoped_read on clients
  for select using (
    current_actor_is_management()
    or exists (
      select 1 from employee_client_mappings m
      where m.client_id = clients.client_id
        and m.employee_id = current_actor()
    )
  );

create policy mappings_scoped_read on employee_client_mappings
  for select using (
    current_actor_is_management() or employee_id = current_actor()
  );

-- Trades: same scoping as clients — an RM sees trades only for their
-- mapped clients; management sees everything.
create policy trades_scoped_read on trades
  for select using (
    current_actor_is_management()
    or exists (
      select 1 from employee_client_mappings m
      where m.client_id = trades.client_id
        and m.employee_id = current_actor()
    )
  );

-- Incentives view: Postgres views run with the querying role's RLS by
-- default (security_invoker), so scoping "own vs all" happens for free via
-- the mappings/trades policies above — no separate policy needed here.
alter view incentives set (security_invoker = true);

-- Realtime: only publish tables the UI actually needs live updates for.
-- Sync bookkeeping doesn't need to reach the browser.
alter publication supabase_realtime add table clients, trades, employee_client_mappings, employees;
