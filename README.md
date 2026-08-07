# Arham Fintech — Internal Operations Portal (Coding Assignment)

## Live Deployment

- **Mock BSE API (Part A):** https://mock-bse-api-r32q.onrender.com
  - Health check: https://mock-bse.onrender.com/health
- **Injestion-Worker:** https://ingestion-worker-l97f.onrender.com/
- **Internal Portal (Part B):** https://portal-ogn0.onrender.com/

> **Note:** both are deployed on Render's free tier, which spins a service
> down after ~15 minutes of no traffic. If a service was asleep, the first
> request can take 30-60s to wake it up. If the portal shows retry/failure
> log lines right after a cold start, that's expected — it's the retry logic
> described below recovering automatically, not a bug. Everything below also
> runs identically on localhost if you'd rather run it live during review.

Two services:

- **`part-a-mock-bse/`** — mock BSE Exchange API simulator (Part A)
- **`part-b-portal/`** — internal portal that consumes it (Part B)

Requires **Node.js 18+** (uses the built-in `fetch`). No database engine or
other external service needs to be installed — everything runs with `npm
install && npm start` in each folder.

## Quick start (both services, two terminals)

```bash
# Terminal 1 — mock BSE API
cd part-a-mock-bse
npm install
npm start
# -> listening on http://localhost:4000

# Terminal 2 — portal (backend + frontend served from same process)
cd part-b-portal
npm install
npm start
# -> listening on http://localhost:5000
```

Open **http://localhost:5000** in a browser. Pick a user from the "Viewing
as" dropdown (management or a relationship manager) and click through the
tabs. A badge in the header flashes when fresh data arrives from BSE.

## Part A — Mock BSE API

```bash
cd part-a-mock-bse
npm install
npm start                 # defaults: 250ms delay/page, 20% failure rate
```

Config via env vars:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | port to listen on |
| `BSE_DELAY_MS` | `250` | simulated latency per page fetch |
| `BSE_FAILURE_RATE` | `0.2` | probability a page fetch dies mid-flight |
| `BSE_PAGE_SIZE` | `50` | default page size if caller omits `pageSize` |

Endpoints:

- `GET /clients?page=&pageSize=` — paginated, delayed, ~20% fail
- `GET /trades?page=&pageSize=&clientId=&from=&to=` — paginated, delayed, ~20% fail
- `GET /employees` — instant, reliable, full list (no pagination needed at this scale)
- `GET /employee-mappings` — instant, reliable, full list
- `GET /health`

To see how the system behaves at real-world scale, run with:

```bash
BSE_DELAY_MS=30000 BSE_FAILURE_RATE=0.2 npm start
```

At `pageSize=50` that's 80 trade pages × 30s ≈ 10 minutes for a full trade
pull — the scenario described in the brief. The portal's poller is designed
to handle this (see architecture doc).

## Part B — Internal Portal

```bash
cd part-b-portal
npm install
npm start                 # defaults: talks to BSE at http://localhost:4000
```

Config via env vars:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `5000` | port to listen on |
| `BSE_BASE_URL` | `http://localhost:4000` | where Part A is running |
| `PULL_PAGE_SIZE` | `50` | page size used when pulling clients/trades |
| `PULL_MAX_RETRIES` | `5` | retry attempts per page before giving up on that pull cycle |
| `PULL_RETRY_BASE_DELAY_MS` | `1000` | base for exponential backoff between retries |
| `PULL_REQUEST_TIMEOUT_MS` | `28000` | client-side timeout per page request (just under BSE's 30s network kill) |
| `FULL_PULL_INTERVAL_MS` | `60000` | how often to re-sync clients/trades from BSE |
| `FAST_POLL_INTERVAL_MS` | `15000` | how often to re-sync employees/mappings |

The portal keeps a local in-memory cache (with a debounced JSON snapshot on
disk, `part-b-portal/.cache-snapshot.json`, so a restart doesn't start from
zero). Every `/api/*` route reads only from that cache — never live from
BSE — so the UI stays fast and available even while BSE is slow or fully
down.

### Views

- **Clients** — full client list
- **Trades** — filterable by client ID and date range
- **My Clients** — clients mapped to the selected employee
- **Employees** — full employee list
- **Incentives** — own incentive for an employee, all employees for management

### Live updates

The portal exposes `GET /api/events` (Server-Sent Events). Whenever the
background poller commits a page of fresh data, it broadcasts an event; any
open browser tab listening re-fetches just the affected view. No manual
refresh needed.

## Running both at 10-minute BSE delay

```bash
# Terminal 1
cd part-a-mock-bse && BSE_DELAY_MS=30000 BSE_FAILURE_RATE=0.2 npm start

# Terminal 2
cd part-b-portal && BSE_BASE_URL=http://localhost:4000 npm start
```

The portal UI stays responsive throughout — it's reading the cache, which
fills in progressively, page by page, as the slow pull proceeds in the
background.

## Notes / things intentionally kept simple

- Storage is an in-memory `Map`-based store with periodic JSON snapshotting,
  not a real database — appropriate for a same-day take-home; see
  `ARCHITECTURE.md` for what changes in a production/100× setup (Postgres,
  etc.). Note this also means the live Render deployment's cache resets on
  any redeploy/restart, since Render's filesystem is ephemeral — the poller
  simply re-syncs from BSE within the first minute after a restart.
- "Login" is a plain dropdown selecting an employee — there's no auth, per
  the brief's evaluation notes (UI polish and feature count beyond the brief
  aren't evaluated).
- Employees are seeded with `EMP0001` as the sole `management` role,
  `EMP0002..EMP0020` as relationship managers.
