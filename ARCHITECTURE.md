# Architecture

## High-Level Workflow Diagram

```
BSE Exchange API (Part A) ──(Fetch)──> Ingestion Worker ──(Batch Upsert)──> PostgreSQL (Supabase) ──(Realtime WAL)──> Portal UI (Browser)
```

## Detailed Architecture Diagram

```
┌──────────────────────┐   paginated, incremental      ┌──────────────────────────┐
│ Part A: Mock BSE      │ <───────────────────────────  │ Ingestion Worker         │
│ /clients (paged)      │   30s timeout, ~20% mid-pull  │ (Node, long-running)     │
│ /trades  (paged,      │   failure, page-level retry   │ - 1 lock per resource    │
│  filterable by client │ ─────────────────────────────>│ - incremental (watermark)│
│  + date range)        │       page data (JSON)        │   + reconciliation sweep │
│ /employees, /mappings │                                │ - upsert via service_role│
│  (fast, reliable)     │                                └────────────┬─────────────┘
└──────────────────────┘                                              │ INSERT ... ON CONFLICT
                                                                        ▼ DO UPDATE (idempotent)
                                                          ┌──────────────────────────┐
                                                          │ Postgres (Supabase)       │
                                                          │ clients, trades,          │
                                                          │ employee_client_mappings, │
                                                          │ employees, sync_state     │
                                                          │ + incentives view         │
                                                          │ + Row Level Security      │
                                                          └────────────┬─────────────┘
                                                                        │ WAL
                                                       ┌────────────────┼────────────────┐
                                                       ▼                                  ▼
                                          PostgREST (reads, RLS)             Realtime (WAL tail, RLS)
                                                       │                                  │
                                                       └────────────┬─────────────────────┘
                                                                     ▼
                                                     ┌──────────────────────────┐
                                                     │ Portal (static files +   │
                                                     │ browser using            │
                                                     │ supabase-js, anon key)   │
                                                     │ - anonymous auth         │
                                                     │ - direct table reads     │
                                                     │ - postgres_changes sub   │
                                                     └──────────────────────────┘
```

There is no custom Express read-API between the browser and the data. The
only server process besides Postgres itself is the ingestion worker (write
path). Reads and live updates both go straight from the browser to Supabase.

## Reasoning

**Why pull from BSE at all — isn't polling bad?** BSE exposes only
request/response REST endpoints; nothing in the brief suggests it can push.
You cannot subscribe to a system that has no publish mechanism, so pulling
isn't a lazy default here, it's the only option. What *is* a choice is
whether the pull is naive (full re-fetch every cycle) or not — see
"incremental sync" below. This mirrors how real exchange integrations work:
NSE/BSE-style feeds are pulled by brokers, not pushed to them.

**Cache-then-serve, never serve-live.** A live call from the UI to BSE is a
non-starter: it can't finish inside the <1s budget, and single BSE requests
die after 30s anyway. The ingestion worker pulls BSE in the background and
writes into Postgres; every portal read comes only from Postgres. BSE's
health has zero effect on the read path — only on cache freshness.

**Pagination is mandatory.** BSE kills any request after 30s but a full pull
can take 5–10 minutes, so `/clients` and `/trades` are paginated and the
worker upserts each page into Postgres as it arrives — not buffered until
the whole pull finishes. A crash mid-pull loses nothing already committed.

**Incremental sync + reconciliation, not full-repull-every-cycle.** The
brief states trades are filterable by client and date range — that's a
delta mechanism, not just a UI filter. The worker tracks a watermark
(`sync_state.last_watermark`) and pulls only `trades?from=<watermark - 1
day overlap>` on a frequent interval (default 30s). A slower full sweep
(default hourly) catches anything a naive "since X" filter could miss —
corrected trades, late-settled records. This is what keeps each sync cycle
proportional to *what changed*, not total record count, which is the actual
fix for "polling doesn't scale" rather than avoiding polling altogether.
Clients have no stated date filter in the brief, so they stay a full pull —
acceptable because client master data churns far less than trades.

**Retry absorbs the 20% failure rate at the page level.** Each page fetch
has its own retry loop with exponential backoff (default 5 attempts).
Retrying an entire multi-minute pull over one dropped page would waste the
successful pages and let the freshness gap grow unbounded. If a page
permanently fails, that cycle aborts; Postgres keeps last-known-good data
and `sync_state.status` records the failure for the next cycle to retry.

**Idempotency and correctness under overlapping refreshes.** Every write is
`INSERT ... ON CONFLICT (primary key) DO UPDATE` — a retried page re-applies
the same rows, it cannot create duplicates or a torn record. A per-resource
in-process lock additionally guarantees only one pull per resource runs at a
time, so two overlapping cycles for the same resource can never interleave.

*Database Atomicity / Transactional Writes:* Page-level database writes are sent as a batch.
PostgREST translates the batch upsert array into a single Postgres SQL statement. Since Postgres
runs every statement in its own implicit transaction (or an explicit `BEGIN ... COMMIT` block),
a page is either completely written to the database or not at all (atomicity). There is no "row-by-row"
individual commit overhead, avoiding partial data states and maximizing write throughput.

**Row Level Security, not app-level filtering, for "My Clients" and
per-employee incentives.** Visibility is enforced as Postgres policies
(`clients_scoped_read`, `trades_scoped_read`, `mappings_scoped_read`) keyed
off the caller's real `auth.uid()`. A bug in a route handler cannot leak
another RM's clients, because the database itself refuses the row — this is
strictly stronger than `if (employeeId === x)` in application code. The
brief doesn't require login, so there's no password/signup flow; identity
is established via Supabase anonymous sign-in and "claimed" onto an
employee row the first time a session picks who it's acting as. That gives
a *real* `auth.uid()` with no login UI — which matters because it's what
lets one identity mechanism correctly scope both PostgREST reads and
Realtime pushes (see next point).

**Live updates via Realtime, not a hand-rolled SSE broadcast.** Realtime
tails Postgres's write-ahead log directly — when the worker's upsert
commits, that's the event; there's no separate `broadcast()` call to keep
in sync with the write path. Realtime enforces RLS the same way PostgREST
does, using the connection's `auth.uid()`. This is also why identity had to
be a real anonymous-auth `auth.uid()` rather than a request-header trick:
Realtime's RLS check runs against the authenticated WebSocket identity, not
arbitrary HTTP headers, so a header-based scheme would correctly restrict
REST reads and then silently misscope (or simply not fire) Realtime events
— exactly the kind of gap the brief's hard requirements are designed to
surface.

**Storage.** Postgres from the start, not in-memory with a JSON snapshot.
Durable across restarts, and the upsert's `ON CONFLICT` is the same
idempotency guarantee a `Map.set` gives, just transactional and durable.

## Running at 100× the data volume

At 100×: ~30,000 clients, ~400,000 trades.

1. **Incremental sync already absorbs most of this** — a 30s incremental
   cycle only pulls the last day's trades (plus overlap), not all 400,000,
   so cycle cost stays roughly constant as history grows. The hourly
   reconciliation sweep is the part that scales with total volume; it can
   be parallelized by sharding the pull across date ranges or client-id
   ranges, each with its own lock, so wall-clock time doesn't scale linearly.
2. **Increase BSE page size** and raise `PULL_PAGE_SIZE` accordingly to cut
   the number of round trips per sweep.
3. **Materialize incentives** if the `incentives` view's live join/aggregate
   becomes too slow at 400k trades: swap it for a materialized view
   refreshed after each trade sync batch, or a running per-client brokerage
   total maintained incrementally via a trigger on trade insert. The portal
   code doesn't change either way — it's still `select * from incentives`.
4. **RLS policy cost**: the `exists (... employee_client_mappings ...)`
   subquery in each policy needs the `idx_mappings_employee` index (already
   present) to stay fast as mappings grow; worth confirming with `EXPLAIN
   ANALYZE` at 100× rather than assuming.
5. **Realtime connection limits** on lower Supabase tiers become relevant
   with many concurrent portal users; a paid tier or self-hosted Realtime
   raises this ceiling. Worth stating as a known constraint rather than
   assuming infinite scale.
6. **Multiple ingestion worker instances**: the current per-resource lock is
    in-process, so it only prevents overlap within a single worker. Running
    more than one worker instance (e.g. for HA) would need a Postgres
    advisory lock (`pg_try_advisory_lock`) instead, so the mutual exclusion
    is enforced by the database, not by a single process's memory.
7. **Background Job Scheduling & Orchestration**: Instead of native Node.js
    `setInterval` loops (which run in-memory and are fragile to restarts/crashes),
    a production deployment at 100× volume should offload queue management and cron
    execution to dedicated workflow or job systems:
    - **BullMQ / Redis**: For high-performance, queue-based job distribution, retries,
      and delay setups.
    - **pg_cron**: For simple scheduled SQL operations running inside Postgres itself.
    - **Temporal**: For complex, durable sync workflows that require strong guarantees
      over multi-step retry processes and state retention.
    - **Cloud Scheduler / AWS EventBridge**: Triggering serverless/containerized sync workers
      on a regular cron schedule.

None of these change the core design — incremental-plus-reconciliation
pull, page-level retry, per-resource locking, idempotent upsert, RLS for
scoping, Realtime for push — they replace the primitives underneath it with
ones that scale further.
