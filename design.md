# Alpha Buy — System Design Document

## 1. Overview

Alpha Buy is an automated system that monitors Polymarket prediction markets to detect early resolution signals. The goal is to identify markets where real-world events have already resolved but Polymarket hasn't officially settled them yet — creating a window for profitable trades.

The system has two deployments:
- **Metadata Syncer** (VPS) — continuously ingests events and markets from Polymarket into Supabase
- **Alpha Scanner** (local) — runs a resolution detection agent using Perplexity AI to find actionable opportunities, sends Telegram alerts with order book data

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    POLYMARKET GAMMA API                  │
│          https://gamma-api.polymarket.com                │
└──────────────┬──────────────────────┬───────────────────┘
               │                      │
          (backfill)            (every 3 hours)
          one-time only         watermark sync
               │                      │
               ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│              VPS: METADATA SYNCER                        │
│              46.224.70.178 (polymoney)                    │
│              /opt/polymarket/metadata-syncer              │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │ backfill │  │syncRecent│  │  status   │               │
│  │(one-time)│  │(3h loop) │  │ (1m log)  │               │
│  └────┬─────┘  └────┬─────┘  └──────────┘               │
│       │              │                                   │
│       ▼              ▼                                   │
│  ┌─────────────────────────┐                             │
│  │    processEvents()      │                             │
│  │  - upsert events        │                             │
│  │  - upsert markets       │                             │
│  │  - skip settled markets │                             │
│  │  - categorize by tags   │                             │
│  └───────────┬─────────────┘                             │
│              │                                           │
│              ▼                                           │
│  ┌─────────────────────────┐   ┌────────────────────┐    │
│  │     sync-state.json     │   │     .env           │    │
│  │  - backfillComplete     │   │  SUPABASE_URL      │    │
│  │  - backfillOffset       │   │  SUPABASE_KEY      │    │
│  │  - lastSyncedEventId    │   └────────────────────┘    │
│  └─────────────────────────┘                             │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    SUPABASE (PostgreSQL)                  │
│                                                          │
│  ┌────────────────────┐  ┌─────────────────────┐        │
│  │ alphafinder_events │  │ alphafinder_markets  │        │
│  │  polymarket_event_ │  │  polymarket_market_  │        │
│  │  id (unique)       │  │  id (unique)         │        │
│  │  title, slug       │  │  question            │        │
│  │  category, tags    │  │  outcome_prices      │        │
│  │  status, active    │  │  volume, best_ask    │        │
│  │  total_volume      │  │  status, active      │        │
│  └────────────────────┘  └─────────────────────┘        │
│                                                          │
│  ┌────────────────────┐                                  │
│  │    outcomes         │  (used by Alpha Scanner)        │
│  │  market_id (FK)    │                                  │
│  │  detected_outcome  │  per-market: yes/no/unknown      │
│  │  confidence        │  per-market confidence 0-100     │
│  │  estimated_end     │                                  │
│  │  is_resolved       │                                  │
│  └────────────────────┘                                  │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│            LOCAL: ALPHA SCANNER (dev machine)             │
│            dist/src/index.js                             │
│                                                          │
│  ┌──────────────────────────────────────────────┐        │
│  │         Resolution Agent (1h cycle)           │        │
│  │                                               │        │
│  │  1. Load active events+markets from Supabase  │        │
│  │  2. For each untracked event:                 │        │
│  │     → Query Perplexity for ALL markets        │        │
│  │     → If resolved + conf >= 80%:              │        │
│  │       write per-market outcomes, alert         │        │
│  │     → If not resolved:                         │        │
│  │       track, schedule smart recheck            │        │
│  │  3. For tracked events:                        │        │
│  │     → Sleep until near estimated_end           │        │
│  │     → Ramp up frequency as end approaches      │        │
│  │     → Perplexity tells us recheck_in_minutes   │        │
│  └──────────────┬───────────────────────────────┘        │
│                 │                                         │
│                 ▼                                         │
│  ┌──────────────────────────────────────────────┐        │
│  │    Persistent Perplexity Bridge (Python)      │        │
│  │    scripts/perplexity_bridge.py --server      │        │
│  │                                               │        │
│  │  - Long-running child process (stdin/stdout)  │        │
│  │  - Perplexity session created once, reused    │        │
│  │  - JSON line protocol: write query, read resp │        │
│  │  - Auto-recreates client on session errors    │        │
│  │  - Built-in stats: request count, timing,     │        │
│  │    rate limit detection, error classification │        │
│  │  - Logs to stderr (surfaced in Node.js logs)  │        │
│  └──────────────────────────────────────────────┘        │
│                                                          │
│  ┌──────────────────────────────────────────────┐        │
│  │         Telegram Alerts + Order Book          │        │
│  │                                               │        │
│  │  On resolution detected:                      │        │
│  │  1. Fetch YES/NO order book from CLOB API     │        │
│  │  2. Send alert with outcome, reasoning,       │        │
│  │     bid/ask prices, and market links           │        │
│  └──────────────────────────────────────────────┘        │
│                                                          │
│  ┌──────────────────────────────────────────────┐        │
│  │              In-Memory State                  │        │
│  │  - trackedEvents (Map)                        │        │
│  │  - knownEventIds (Set)                        │        │
│  │  - knownMarketIds (Set)                       │        │
│  │  Persisted to state.json every 60s            │        │
│  └──────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Data Source

### Polymarket Gamma API

- **Base URL**: `https://gamma-api.polymarket.com`
- **Endpoint**: `/events` — returns events with nested `markets[]` array
- **Pagination**: `offset` + `limit` (no total count in response)
- **Filtering**: `exclude_tag_id=21` removes crypto events
- **Sorting**: `order=id&ascending=false` for newest-first

### Key API Numbers

| Metric | Count |
|---|---|
| Total non-crypto events (all time) | ~71,211 |
| Active + not-closed (currently open) | ~5,404 |
| Total non-crypto markets (all time) | ~331,400 |
| Average markets per event | ~4.7 |

**Note**: The `active` flag is meaningless — 99.98% of events have `active=true` even after closing. The real filter is `closed=false`.

---

## 4. VPS Metadata Syncer (Production)

### Location
- **Server**: `46.224.70.178` (Hetzner, hostname: `polymoney`)
- **Path**: `/opt/polymarket/metadata-syncer/`
- **Process**: pm2 `metadata-syncer` (ID 7)

### How It Works

#### Phase 1: Backfill (one-time)
Paginates through ALL active non-crypto events from the Gamma API (500 per page, 500ms between pages). Upserts every event and market into Supabase. Sets `lastSyncedEventId` to the highest event ID seen. Saves progress to `sync-state.json` after every page so it can resume if interrupted.

#### Phase 2: Incremental Sync (every 3 hours)
Uses an **ID watermark** strategy:
1. Read `lastSyncedEventId` from state (e.g., `903799`)
2. Fetch events sorted by ID descending (newest first), 100 per page
3. **Only process** events with `id > watermark`
4. Stop paginating when the oldest event on a page has `id <= watermark`
5. Update watermark to the new highest ID
6. Usually completes in **1 API call** (~0-50 new events per 3 hours)

This guarantees **zero missed events** regardless of volume.

#### Market Status Logic
```
isSettled(market):
  → automaticallyResolved = true → settled (skip)
  → umaResolutionStatuses contains "settled" → settled (skip)

computeMarketStatus(market):
  → umaResolutionStatuses contains "proposed" → "resolution_proposed"
  → closed && !active → "closed"
  → active && !acceptingOrders → "paused"
  → default → "open"
```

#### Category Assignment
Derived from event tags:
- `nba, nfl, mlb, nhl, soccer, mma, tennis, sports` → `"sports"`
- `politics, elections` → `"politics"`
- Otherwise → first tag label or `"other"`

### State File: `sync-state.json`
```json
{
  "backfillComplete": true,
  "backfillOffset": 71012,
  "lastSyncedEventId": "903799"
}
```

### Configuration
| Parameter | Value | Purpose |
|---|---|---|
| `SYNC_INTERVAL` | 3 hours | New event polling frequency |
| `PERSIST_INTERVAL` | 1 min | State file save frequency |
| `REPORT_INTERVAL` | 1 min | STATUS log frequency |
| `PAGE_SIZE` | 500 | Backfill pagination size |
| `BACKFILL_DELAY` | 500ms | Rate limit between backfill pages |
| `CRYPTO_TAG_ID` | 21 | Excluded from all queries |

---

## 5. Alpha Scanner (Local)

### Purpose
Detects events that have resolved in the real world but not yet on Polymarket — the "alpha" window for profitable trades. Sends Telegram alerts with order book data so you can act immediately.

### Resolution Agent Cycle (every 1 hour)

```
Load active events+markets from Supabase
         │
         ▼
    For each event:
         │
    ┌────┴──────────┐
    │   Tracked?    │
    └────┬──────────┘
     No  │       Yes
     │   │        │
     ▼   │        ▼
  Initial │   nextCheckAt <= now?
  Perplexity    No → skip (sleeping)
  check  │   Yes → re-check
     │   │        │
     ▼   ▼        ▼
  ┌───────────────────────┐
  │  Perplexity response: │
  │  per-market outcomes   │
  │  + recheck_in_minutes  │
  │  + estimated_end (ISO) │
  └──────┬────────────────┘
         │
    ┌────┴───────┐
    │ Resolved?  │
    │ conf >= 80 │
    └──┬──────┬──┘
     Yes│      │No
       ▼      ▼
    Write    Schedule recheck:
    per-mkt  - Perplexity hint (recheck_in_minutes)
    outcomes - Or: sleep until near estimated_end
    to DB    - Ramp up as end approaches
       │
       ▼
    Telegram alert
    + order book
```

### Query Scheduling (Perplexity request optimization)

The system minimizes Perplexity queries by sleeping through the wait and only checking frequently near the decisive moment.

**Priority 1**: Perplexity's `recheck_in_minutes` hint (trusted, no ceiling):
- Perplexity knows the event context (e.g., "game in 3 hours" → `180`)
- Floor of 10 minutes to avoid spamming

**Priority 2**: Fallback based on `estimated_end` time:

| Time until estimated end | Re-check interval | Perplexity queries saved |
|---|---|---|
| > 3 days (e.g., 20 days away) | **Sleep until 24h before end** | ~19 days of zero queries |
| 1–3 days | Every 6 hours | 4-12 queries |
| 4–24 hours | Every 2 hours | — |
| 1–4 hours | Every 30 min | — |
| < 1 hour | **Every 10 min** (fastest) | — |
| Past due | **Every 10 min** (hammer) | — |
| No estimate | Default cycle (1 hour) | — |

**Example**: Event ends Feb 28. First check on Feb 10:
```
Feb 10: Initial check → estimated_end = Feb 28 8pm → sleep until Feb 27 8pm
Feb 27 8pm: Recheck → still pending, recheck_in_minutes=120 → sleep 2h
Feb 27 10pm: Recheck → still pending, <4h remaining → every 30min
Feb 28 midnight: event resolves → DETECTED, alert sent
Total Perplexity queries: ~5 instead of ~430 (checking every hour for 18 days)
```

### Perplexity Bridge

A persistent Python child process that keeps the Perplexity session alive across queries.

```
Node.js agent                          Python bridge (--server)
    │                                       │
    │── JSON line via stdin ──────────────→ │
    │   { mode:"event",                     │ readline()
    │     event_title: "...",               │ query Perplexity
    │     market_questions: [...] }         │ parse response
    │                                       │
    │←── JSON line via stdout ─────────────│
    │   { resolved: false,                  │ print(json, flush)
    │     markets: [                        │
    │       {market:1, outcome:"unknown"},  │
    │       {market:2, outcome:"yes", ...}  │
    │     ],                                │
    │     recheck_in_minutes: 180,          │
    │     estimated_end: "2026-02-22T20:00" │
    │   }                                   │
```

**Performance vs old approach**:
- Old: spawn `uv run` per query + write temp file + 2s sleep = ~5-10s overhead
- New: persistent process, stdin/stdout pipes = ~0ms overhead

**Prompt design**:
- Includes today's date for temporal context
- Asks for per-market outcomes (yes/no/unknown + confidence each)
- Asks for precise `estimated_end` with timezone (ISO datetime, not just date)
- Asks for `recheck_in_minutes` — Perplexity's hint on when the decisive moment is
- Strict "resolved=true ONLY if officially confirmed" guard against false positives

**Built-in logging** (stderr → Node.js agent logs):
- Per-request: `REQ #5 [event] "NBA Finals" → OK 17.3s conf=92`
- Rate limit detection: pattern matching on error strings (429, quota, throttle, etc.)
- Session error detection: 401, 403, expired, captcha
- Running stats every 10 requests: `reqs=10 ok=8 err=2(rate=1 sess=0 parse=1) avg=16.2s`
- Auto client recreation on session/rate errors

**Backward compatibility**: Without `--server` flag, still works as single-shot mode (for `test-perplexity.js`).

### Telegram Alerts

On resolution detection (confidence >= 80%):
1. Fetch YES/NO order book from Polymarket CLOB API
2. Send HTML alert with: event title, market question, outcome, confidence, reasoning, bid/ask prices, direct links

---

## 6. Database Schema

### `alphafinder_events` (VPS) / `events` (local)

| Column | Type | Description |
|---|---|---|
| `id` | bigint (auto) | Internal PK |
| `polymarket_event_id` | text (unique) | Polymarket event ID |
| `title` | text | Event title |
| `description` | text | Event description |
| `slug` | text | URL slug |
| `category` | text | Derived: sports, politics, other |
| `tags` | jsonb | Raw tag array from API |
| `image` | text | Event image URL |
| `start_date` | timestamptz | Event start |
| `end_date` | timestamptz | Event end |
| `status` | text | open, closed |
| `active` | boolean | Always true (meaningless) |
| `closed` | boolean | True = resolved/settled |
| `neg_risk` | boolean | Negative risk market |
| `neg_risk_market_id` | text | Associated neg risk market |
| `markets_count` | int | Number of sub-markets |
| `total_volume` | numeric | Total trading volume |
| `updated_at` | timestamptz | Last upsert time |

### `alphafinder_markets` (VPS) / `markets` (local)

| Column | Type | Description |
|---|---|---|
| `id` | bigint (auto) | Internal PK |
| `event_id` | bigint (FK) | Reference to events table |
| `polymarket_market_id` | text (unique) | Polymarket market ID |
| `condition_id` | text | On-chain condition ID |
| `question_id` | text | Question identifier |
| `question` | text | Market question text |
| `question_normalized` | text | Lowercase, cleaned question |
| `description` | text | Market description |
| `slug` | text | URL slug |
| `outcomes` | jsonb | e.g., `["Yes","No"]` |
| `outcome_prices` | jsonb | e.g., `["0.85","0.15"]` |
| `clob_token_ids` | jsonb | CLOB trading token IDs |
| `best_ask` | numeric | Best ask price |
| `last_trade_price` | numeric | Last trade price |
| `spread` | numeric | Bid-ask spread |
| `volume` | numeric | Total volume |
| `volume_1d` | numeric | 24-hour volume |
| `one_day_price_change` | numeric | 24h price change |
| `end_date` | timestamptz | Market end date |
| `resolution_source` | text | How market resolves |
| `custom_liveness` | int | UMA liveness period |
| `uma_resolution_statuses` | jsonb | UMA status array |
| `resolved_by` | text | Resolver identity |
| `status` | text | open, paused, resolution_proposed, closed |
| `active` | boolean | Is active |
| `closed` | boolean | Is closed |
| `accepting_orders` | boolean | Accepting trades |
| `neg_risk` | boolean | Negative risk |
| `automatically_resolved` | boolean | Auto-resolved by system |
| `updated_at` | timestamptz | Last upsert time |

### `outcomes`

| Column | Type | Description |
|---|---|---|
| `id` | bigint (auto) | Internal PK |
| `market_id` | bigint (unique FK) | Reference to markets table |
| `detected_outcome` | text | yes, no, unknown, pending |
| `confidence` | int | 0-100 per-market AI confidence |
| `detection_source` | text | perplexity |
| `detected_at` | timestamptz | When detection happened |
| `estimated_end` | timestamptz | When event is expected to end |
| `is_resolved` | boolean | Final resolution detected |
| `updated_at` | timestamptz | Last update |

---

## 7. State Management

### VPS (Metadata Syncer)
Simple JSON file (`sync-state.json`):
- `backfillComplete`: skip backfill on restart
- `backfillOffset`: resume backfill from last page if interrupted
- `lastSyncedEventId`: watermark for incremental sync

### Local (Alpha Scanner)
In-memory state class (`State`) persisted to `state.json` every 60s:
- `trackedEvents`: Map of events being monitored for resolution
  - `eventId`, `title`, `marketCount`
  - `estimatedEnd`: ISO datetime from Perplexity
  - `lastChecked`, `checkCount`
  - `nextCheckAt`: calculated from recheck_in_minutes or estimated_end tiers
- `knownEventIds`: Set of all event IDs
- `knownMarketIds`: Set of all market IDs
- `backfillComplete`: flag

Both are crash-recoverable — state is loaded on startup and all progress resumes.

---

## 8. Deployment

### VPS Services (pm2)

| ID | Name | Status | Purpose |
|---|---|---|---|
| 0 | `polymarket-dashboard` | online | Web dashboard |
| 1 | `trade-monitor` | online | Trade monitoring |
| 2 | `crypto-ticker` | online | Crypto price feeds |
| 7 | `metadata-syncer` | online | Event/market ingestion |

### Environment Variables

**VPS** (`.env` at `/opt/polymarket/metadata-syncer/`):
```
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

**Local** (`.env` at project root):
```
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
PERPLEXITY_SESSION_TOKEN=...
TELEGRAM_BOT_TOKEN=...     # optional
TELEGRAM_CHAT_ID=...       # optional
PYTHON_CMD=uv              # optional, defaults to uv
PERPLEXITY_BRIDGE_PATH=... # optional, defaults to scripts/
```

---

## 9. Data Flow Summary

```
Every 3 hours (VPS):
  Gamma API → syncRecent() → filter by watermark → processEvents() → Supabase

Every 1 hour (local):
  Supabase → getActiveEventsWithMarkets() → Resolution Agent
       │
       ├→ Perplexity bridge (persistent process, stdin/stdout JSON lines)
       │   → per-market outcomes + recheck timing + estimated_end
       │
       ├→ outcomes table (per-market: yes/no/unknown + confidence)
       │
       └→ Telegram alert + CLOB order book (on resolution detection)
```

### What gets stored vs skipped:
- **Stored**: All non-crypto, non-settled events and their markets
- **Skipped**: Crypto events (tag_id=21), settled markets (automaticallyResolved or UMA status=settled)
- **Updated**: Existing records are upserted (prices, volumes, status change on every sync)

---

## 10. Known Limitations & Future Work

### Current Limitations
1. **Perplexity web scraper** — session tokens expire, may break if Perplexity changes their UI. Sonar API would be faster (2-5s vs 15-30s) and more reliable.
2. **Single-process** — no horizontal scaling; both syncer and scanner are single Node.js processes
3. **~839 historical events missing** — backfill only fetched `active=true` events; closed events from before the backfill are not in the DB
4. **No price updates for existing events** — watermark sync only processes NEW events; old events don't get price/volume refreshes

### Future Possibilities
- **Perplexity Sonar API** — switch from web scraper to REST API ($1/1K queries, 2-5s response, no Python needed)
- **Automated trading** — trading modules exist at `e:\Doing\polymarket\dashboard\app\api\data\` (buy-positions.js, sell-positions.js, redeem-positions.js)
- **Price refresh loop** — periodic scan of active markets to update prices
- **Historical closed event backfill** — fill the 839 event gap
