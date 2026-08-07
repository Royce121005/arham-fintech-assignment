# Likely questions in the technical discussion, and how to answer them

The brief says shortlisted candidates walk the reviewer through their
design. This doc is for you, not the submission — practice saying these
out loud, don't just read them.

**"Why did you decide to poll BSE? Isn't that inefficient?"**
Because BSE has no push mechanism — it's plain request/response REST, so
there's nothing to subscribe to. The real design choice wasn't polling vs.
not polling, it was naive polling (re-fetch everything every cycle) vs.
incremental polling (fetch only what changed, using the client/date filter
BSE already exposes) plus a slower reconciliation sweep to catch anything
incremental misses. That's what keeps sync cost proportional to what
changed rather than total data volume as it grows.

**"What if two sync cycles overlap?"**
Per-resource in-process lock — a new cycle for `trades` is skipped if one
is already running. Combined with idempotent upserts (`ON CONFLICT DO
UPDATE` keyed by primary id), even if a lock were somehow bypassed, two
writers hitting the same row can't produce a torn or duplicated record —
worst case is a harmless double-write of identical data.

**"What if the worker crashes mid-pull?"**
Nothing already committed is lost — each page is upserted into Postgres as
it arrives, not buffered until the full pull finishes. `sync_state.status`
would show `failed`/stale `last_success_at`, and the next scheduled cycle
picks up from the watermark, not from scratch.

**"Why enforce 'My Clients' with Row Level Security instead of filtering in
the API layer?"**
Because an app-level `if (employeeId === req.query.employeeId)` check is a
convention — any future route, any bug, any forgotten filter clause breaks
it silently. An RLS policy is enforced by Postgres itself on every query
through that connection, regardless of which code path issued it. It also
means there effectively is no API layer to get wrong for reads at all — the
browser queries Postgres directly and the database decides what comes back.

**"The brief doesn't mention login — why is there an auth.uid() at all?"**
Because Realtime's RLS check runs against the connection's real
authenticated identity, not arbitrary request state. If I'd scoped access
using something like a custom header, REST reads would be correctly scoped
but Realtime pushes wouldn't be — they'd either leak across identities or
silently fail to fire, which defeats the "screens update live" requirement
for exactly the users it matters most for (an RM's own client list). Using
Supabase's anonymous sign-in gets a real `auth.uid()` with zero password/
signup UI, so one identity mechanism correctly scopes both read paths. I'd
say plainly that the "claim an unclaimed identity" mechanism is a
demo-grade stand-in for login, not something I'd ship to production as-is.

**"How does this scale to 100×?"**
Incremental sync already absorbs most of it — cycle cost tracks what
changed, not total rows. What doesn't scale for free: the reconciliation
sweep (fix: shard by date/client-id range, parallelize with per-shard
locks), the incentives view if it's doing a live join over 400k trades (fix:
materialized view or an incrementally-maintained running total), and
Realtime/worker fan-out if you ever run more than one instance of either
(fix: DB-level advisory locks instead of in-process locks; Realtime already
scales independently of the app tier since it's a separate service reading
the WAL).

**"Why Supabase specifically, and not just Postgres + your own API?"**
Two things Supabase gives for free that I'd otherwise hand-build and have
to defend the correctness of separately: RLS-enforced Realtime (tailing the
WAL instead of a hand-rolled broadcast-on-write call I'd have to keep in
sync with every write path), and PostgREST as a reviewed, battle-tested
read layer instead of an API layer I'd write and could get subtly wrong.
The tradeoff I'd name unprompted: Supabase Edge Functions have an execution
timeout well under BSE's worst-case 10-minute pull, so the ingestion worker
has to be a normal long-running process, not a Function — I didn't try to
force everything into "the Supabase way."

**"What would you NOT do again / what's still rough?"**
The identity-claim mechanism only works for a single concurrent demo
session per employee — it's fine for a take-home, not for a real multi-user
rollout, and I'd replace it with real login before shipping. I'd also want
`EXPLAIN ANALYZE` on the RLS-scoped queries at real 100× volume rather than
assuming the indexes are sufficient.
