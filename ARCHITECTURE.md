# Architecture

## Diagram

```
┌─────────────────────┐         paginated pulls          ┌──────────────────────┐
│  Part A: Mock BSE    │ <──────────────────────────────  │  Poller (background) │
│  /clients (paged)    │   30s timeout, ~20% mid-pull      │  - 1 lock per        │
│  /trades  (paged)    │   failure, retry w/ backoff       │    resource          │
│  /employees (fast)   │ ────────────────────────────────>│  - upserts per page  │
│  /employee-mappings  │       page data (JSON)            │  - broadcasts SSE    │
└─────────────────────┘                                    └───────────┬──────────┘
                                                                         │ upsert
                                                                         ▼
                                                             ┌──────────────────────┐
                                                             │  Local Cache (Store)  │
                                                             │  Map<id, record>      │
                                                             │  per entity, keyed by │
                                                             │  primary id           │
                                                             └───────────┬──────────┘
                                                                         │ read-only
                                                                         ▼
                                                             ┌──────────────────────┐
                                        SSE (push) ────────  │  Portal API + Web UI  │
                                                             │  /api/clients         │
                                                             │  /api/trades          │
                                                             │  /api/my-clients      │
                                                             │  /api/employees       │
                                                             │  /api/incentives      │
                                                             │  /api/events (SSE)    │
                                                             └──────────────────────┘
                                                                         ▲
                                                                         │ browser tabs
                                                                  (auto-refresh views)
```

## Reasoning

**Cache-then-serve, never serve-live.** BSE can take 5–10 minutes for a full
pull and the network kills any single request after 30s, so a live call from
the UI is a non-starter — it would neither meet the <1s load requirement nor
even complete. Instead, a background poller continuously pulls BSE into a
local cache, and every API route the portal exposes reads *only* from that
cache. This is what makes "loads in <1s even if BSE is down" trivially true:
BSE's health has zero effect on the read path, only on how fresh the cache
is.

**Pagination is mandatory, not optional.** Because one request can't outlive
30s but a full pull needs 5–10 minutes, the mock API paginates `/clients`
and `/trades`, and the poller walks pages sequentially, upserting each page
into the cache *as it arrives* rather than buffering the whole pull. Two
consequences: (1) a 10-minute full pull still shows progressively fresher
data throughout, instead of the UI staring at stale data for 10 minutes and
then jumping all at once; (2) if the process crashes mid-pull, the cache
still holds everything pulled so far — no all-or-nothing loss.

**Retry absorbs the 20% failure rate at the page level, not the pull
level.** Retrying an entire multi-minute pull after a single page failure
would be wasteful and would let the fresh/stale gap grow unbounded. Instead
each page fetch gets its own retry loop with exponential backoff (default 5
attempts). Only if a page permanently fails does that pull cycle abort —
the cache simply keeps last-known-good data and the next scheduled pull
cycle retries.

**Correctness under overlapping refreshes.** Each resource (`clients`,
`trades`) has its own in-process lock; a new pull for a resource is skipped
if the previous one is still running. Combined with idempotent upserts keyed
by primary id (`clientId` / `tradeId`) — where "write" is a single `Map.set`
— two pulls can never interleave into a torn or duplicated record, and
retried pages simply overwrite themselves harmlessly.

**Live updates via SSE, not polling or WebSockets.** Updates only flow
server→client here (the browser never needs to push anything back over this
channel), so SSE is the simplest correct choice: built-in browser
reconnect, plain HTTP, no extra infrastructure. The poller broadcasts an
event after each committed page; open tabs re-fetch just the view that's
currently visible, so the update is cheap and the UI never shows a
half-updated table.

**Storage choice.** For this exercise the cache is in-memory `Map`s with a
debounced JSON snapshot to disk (so a restart doesn't start cold). This is
enough to prove the design's correctness properties (idempotency, locking,
progressive freshness) without adding a DB dependency to a same-day
take-home. The one seam that would need to change for production is the
`store.js` module — see below.

## Running at 100× the data volume

At 100×: ~30,000 clients, ~400,000 trades, and BSE pulls that are
proportionally larger (and likely still capped at 30s/request, so far more
pages).

1. **Replace the in-memory Map store with a real database** (Postgres).
   `store.js` is already the single seam all reads/writes go through, so
   this is a swap behind the same function signatures — upserts become
   `INSERT ... ON CONFLICT (id) DO UPDATE`, which preserves the same
   idempotency property at DB scale, transactionally. Add indexes on
   `trades(clientId)`, `trades(tradeDate)`, and `mappings(employeeId)` since
   those are the actual query patterns (My Clients, Trades filters,
   Incentives).
2. **Increase page size and parallelize pulls across independent
   partitions**, not across the same resource. E.g. shard trade pulls by
   date range or client-id range and run a small pool of workers (still
   respecting one-lock-per-partition, not one-lock-per-resource) so total
   pull wall-clock time doesn't scale linearly with record count.
3. **Move incentive computation out of request-time aggregation.**
   Currently `getIncentives()` scans all trades on each call — fine at
   4,000 trades, not at 400,000 read repeatedly. Maintain a running
   per-client brokerage total updated incrementally on each trade upsert
   (or a materialized view refreshed on a schedule), so incentives reads
   stay O(employees) instead of O(trades).
4. **Move SSE to a pub/sub-backed fan-out** (e.g. Redis pub/sub) if the
   portal runs as more than one process/instance, since the current
   in-process `Set` of SSE connections only reaches clients connected to
   that specific instance.
5. **Snapshot → durable persistence.** The debounced JSON-file snapshot
   approach doesn't scale to hundreds of thousands of records; with a real
   DB this concern disappears entirely (item 1 already covers it).
6. **Cache the paginated trade/client list responses on the portal API**
   per filter combination for a few seconds, since Trades/My Clients are
   likely to be requested repeatedly by many concurrent users within a
   short window and the underlying cache changes only once per pull cycle.

None of these change the core design — cache-then-serve, page-level retry,
per-resource locking, idempotent upserts, SSE fan-out — they just replace
the storage/compute primitives underneath it with ones that scale further.
