# Alpha Buy — System Design Document

## 1. Overview

Alpha Buy is an automated system that monitors Polymarket prediction markets to detect early resolution signals. The goal is to identify markets where real-world events have already resolved but Polymarket hasn't officially settled them yet — creating a window for profitable trades.

The system runs as a **single unified process** (`dist/src/index.js`) that handles everything: event ingestion, real-time price monitoring, resolution detection via Perplexity AI, and Telegram alerting.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    POLYMARKET GAMMA API                          │
│              https://gamma-api.polymarket.com                    │
└──────────┬──────────────────┬──────────────────┬───────────────┘
           │                  │                  │
      (backfill)        (full sync)        (quick sync)
      one-time only      every 1h          every 5m
      batch upserts      all pages         200 newest
           │                  │                  │
           ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EVENT SYNCER                                   │
│   dist/src/ingestion/syncer.js + backfill.js                     │
│                                                                  │
│   - Batch upserts (upsertEventsBatch, upsertMarketsBatch)       │
│   - Builds tokenToEventId cache for WebSocket O(1) lookups      │
│   - Closes stale events (closed=true, data retained)            │
│   - Excludes crypto events (tag_id=21)                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SUPABASE (PostgreSQL)                          │
│                                                                  │
│   events          markets           outcomes                     │
│   - polymarket_   - polymarket_     - market_id (FK)            │
│     event_id        market_id       - detected_outcome          │
│   - title         - question        - confidence                │
│   - closed        - outcome_prices  - estimated_end_min/max     │
│   - end_date      - clob_token_ids  - is_resolved               │
│                   - best_ask        - profit_pct                │
│                   - closed                                      │
│                                                                  │
│   Data retention: closed events are NEVER deleted,              │
│   only flagged closed=true                                      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌──────────────────────┐  ┌──────────────────────────────────────┐
│   CLOB WEBSOCKET     │  │   RESOLUTION AGENT                    │
│   Real-time prices   │  │   dist/src/detection/agent.js         │
│                      │  │                                       │
│ - Subscribe to ALL   │  │   Three detection loops:              │
│   YES token prices   │  │                                       │
│ - In-memory cache:   │  │   1. Hourly cycle                    │
│   tokenToEventId     │  │      price >= 0.85 filter            │
│   (O(1) lookups)     │  │      end_date <= 24h horizon         │
│                      │  │      5 parallel workers               │
│ - Price spike:       │  │                                       │
│   >= 0.85 triggers   │  │   2. Hot loop (every 2 min)          │
│   immediate check    │  │      events past estimatedEndMin     │
│                      │  │      20min lookback window            │
│ - market_resolved:   │  │                                       │
│   instant alert      │  │   3. WebSocket-triggered             │
│                      │  │      price spike or resolution        │
│ - Round-robin slot   │  │      round-robin bridge slots         │
│   for bridge queries │  │                                       │
└──────────────────────┘  └──────────┬───────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              PERPLEXITY BRIDGE POOL (Python)                     │
│              scripts/perplexity_bridge.py --server                │
│                                                                  │
│   5 persistent child processes (one per session token)           │
│   - perplexity-webui-scraper (browser session emulation)        │
│   - JSON line protocol via stdin/stdout                         │
│   - 90s timeout per query, auto-reconnects dead bridges         │
│   - Session tokens are IP-bound (NextAuth JWE cookies)          │
│   - Round-robin slot assignment for WS-triggered checks         │
│   - Auto client recreation on session/rate errors               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              ALERT FLOW                                           │
│                                                                  │
│   1. Pre-flight: check Gamma API if market already closed       │
│      → If closed: skip (no opportunity)                         │
│   2. Query Perplexity for resolution status                     │
│   3. If resolved (confidence >= 80%):                           │
│      → Fetch real prices from CLOB order book                   │
│      → Calculate profit_pct = (1.00 - buyPrice) / buyPrice     │
│      → Store profit_pct in outcomes table                       │
│      → Send Telegram alert with prices + market links           │
│   4. If not resolved:                                           │
│      → Track event with estimatedEndMin/Max                     │
│      → Schedule smart recheck (never before end time)           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Source

### Polymarket Gamma API

- **Base URL**: `https://gamma-api.polymarket.com`
- **Endpoint**: `/events` — returns events with nested `markets[]` array
- **Pagination**: `offset` + `limit` (no total count in response)
- **Filtering**: `exclude_tag_id=21` removes crypto events
- **Sorting**: `order=id&ascending=false` for newest-first

**Note**: The `active` flag is meaningless — 99.98% of events have `active=true` even after closing. The real filter is `closed=false`.

### CLOB WebSocket

- **URL**: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **Features**: `custom_feature_enabled: true` unlocks `market_resolved` events
- **Subscription**: All YES token IDs (batched in groups of 500)
- **PING**: Every 10s to keep alive
- **Auto-reconnect**: 5s backoff on disconnect

---

## 4. Concurrency Model

### Bridge Pool

Each Perplexity session token gets its own persistent Python bridge process:

```
.env:
  PERPLEXITY_SESSION_TOKEN    → Bridge #0
  PERPLEXITY_SESSION_TOKEN_2  → Bridge #1
  PERPLEXITY_SESSION_TOKEN_3  → Bridge #2
  PERPLEXITY_SESSION_TOKEN_4  → Bridge #3
  PERPLEXITY_SESSION_TOKEN_5  → Bridge #4
```

- Supports up to 10 tokens (`_2` through `_10`)
- Bridges spawned lazily on first use, kept alive in server mode
- Dead bridges auto-respawn on next query
- `PYTHON_CMD=uv` uses `uv run --script`, `PYTHON_CMD=python3` uses direct invocation

### Worker Distribution

- **Hourly cycle**: N workers (one per token) pull from shared event queue
- **Hot loop**: Same worker pool, shared queue
- **WebSocket-triggered**: Round-robin across all slots (`_wsSlot++ % concurrency`)

---

## 5. Detection Loops

### Loop 1: Hourly Cycle (every 3600s)

1. Query DB for events with any market priced >= 0.85 (price-first filter)
2. Skip events already in `resolvedEventIds`
3. Skip events with `end_date` > 24h away (`END_DATE_HORIZON`)
4. Skip tracked events whose `nextCheckAt` hasn't arrived
5. Distribute remaining events across N worker bridges
6. Each worker: pre-flight Gamma check → Perplexity query → write results

### Loop 2: Hot Loop (every 2 min)

Checks events whose Perplexity-estimated end time has **already passed**:

1. Scan `trackedEvents` for those with `estimatedEndMin` in the past (0-20min ago)
2. Fetch full event data from DB
3. Sort by urgency (most recently ended first)
4. Process through worker pool

**Key**: Never queries BEFORE `estimatedEndMin` — only checks after the event should have ended.

### Loop 3: WebSocket-Triggered

Real-time reactions to price spikes and resolution events:

- **Price spike**: YES price jumps to >= 0.85 → immediate Perplexity check
- **market_resolved**: Polymarket confirms resolution → instant alert
- Uses in-memory `tokenToEventId` cache for O(1) token-to-event lookup (no DB scan)

---

## 6. Smart Scheduling

`calculateNextCheck(estimatedEndISO, checkCount)`:

| Time until estimated end | Action |
|---|---|
| > 3 days | Sleep until 24h before end |
| 1-3 days | Check every 6 hours |
| 4-24 hours | Check every 2 hours |
| < 4 hours | **Wait until endTime + 1 min** (never before) |
| Already ended (post-end) | Escalating: 1m → 2m → 5m → 10m |
| No estimate | Default cycle (1 hour) |

**Example**: Event ends Feb 28 at 8pm ET:
```
Feb 10: Initial check → estimatedEndMin = Feb 28 8pm → sleep until Feb 27 8pm
Feb 27 8pm: Recheck → still 24h away → check in 6h
Feb 28 2am: Recheck → 18h away → check in 6h
Feb 28 2pm: Recheck → 6h away → check in 2h
Feb 28 4pm: Recheck → 4h away → wait until 8:01pm
Feb 28 8:01pm: Hot loop picks it up → check every 1m escalating
Total queries: ~6 instead of ~430
```

---

## 7. State Management

In-memory state class (`State`) persisted to `state.json` every 60s:

| Field | Type | Description |
|---|---|---|
| `trackedEvents` | Map | Events being monitored: eventId → {estimatedEndMin, nextCheckAt, checkCount, ...} |
| `knownEventIds` | Set | All synced event IDs |
| `knownMarketIds` | Set | All synced market IDs |
| `marketsByQuestion` | Map | Question text → market ID |
| `tokenToEventId` | Map | CLOB token ID → polymarket event ID (for WS O(1) lookups) |
| `resolvedEventIds` | Map | Event ID → resolved timestamp (auto-prune after 7 days) |
| `backfillComplete` | boolean | Skip backfill on restart |

All Maps/Sets serialize as arrays of entries in JSON. State survives restarts.

---

## 8. Database Schema

### `events`

| Column | Type | Description |
|---|---|---|
| `id` | bigint (auto) | Internal PK |
| `polymarket_event_id` | text (unique) | Polymarket event ID |
| `title` | text | Event title |
| `description` | text | Event description |
| `slug` | text | URL slug |
| `tags` | jsonb | Raw tag array from API |
| `image` | text | Event image URL |
| `start_date` | timestamptz | Event start |
| `end_date` | timestamptz | Event end |
| `active` | boolean | Always true (meaningless) |
| `closed` | boolean | True = resolved/settled (data retained) |
| `neg_risk` | boolean | Negative risk market |
| `neg_risk_market_id` | text | Associated neg risk market |
| `markets_count` | int | Number of sub-markets |
| `total_volume` | numeric | Total trading volume |
| `updated_at` | timestamptz | Last upsert time |

### `markets`

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
| `volume_clob` | numeric | CLOB volume |
| `volume_1d` | numeric | 24-hour volume |
| `volume_1wk` | numeric | 7-day volume |
| `volume_1mo` | numeric | 30-day volume |
| `one_day_price_change` | numeric | 24h price change |
| `end_date` | timestamptz | Market end date |
| `active` | boolean | Is active |
| `closed` | boolean | Is closed (data retained) |
| `accepting_orders` | boolean | Accepting trades |
| `neg_risk` | boolean | Negative risk |
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
| `estimated_end_min` | timestamptz | Earliest expected end (from Perplexity) |
| `estimated_end_max` | timestamptz | Latest expected end (from Perplexity) |
| `is_resolved` | boolean | Final resolution detected |
| `profit_pct` | numeric | Calculated profit: (1 - buyPrice) / buyPrice * 100 |
| `updated_at` | timestamptz | Last update |

---

## 9. Configuration

| Key | Default | Description |
|---|---|---|
| `SUPABASE_URL` | (required) | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | (required) | Supabase service role key |
| `PERPLEXITY_SESSION_TOKEN` | (required) | Primary Perplexity session cookie |
| `PERPLEXITY_SESSION_TOKEN_2..10` | (optional) | Additional concurrent tokens |
| `TELEGRAM_BOT_TOKEN` | (optional) | Telegram bot for alerts |
| `TELEGRAM_CHAT_ID` | (optional) | Telegram chat for alerts |
| `PYTHON_CMD` | `uv` | Python runner (`uv` or `python3`) |
| `PERPLEXITY_BRIDGE_PATH` | `scripts/perplexity_bridge.py` | Bridge script path |
| `PRICE_SPIKE_THRESHOLD` | `0.85` | Min price to trigger detection |
| `END_DATE_HORIZON_HOURS` | `24` | Skip events ending beyond this |
| `MIN_CONFIDENCE` | `80` | Min confidence for resolution alerts |

### Intervals

| Interval | Value | Description |
|---|---|---|
| `SYNC_INTERVAL` | 1 hour | Full sync (all pages) |
| `QUICK_SYNC_INTERVAL` | 5 min | Quick sync (200 newest) |
| `DETECTION_INTERVAL` | 1 hour | Agent hourly cycle |
| Hot loop | 2 min | Near-ending event checks |
| `STATE_PERSIST_INTERVAL` | 60s | Save state.json |
| `STATUS_REPORT_INTERVAL` | 30s | Log status line |
| WebSocket PING | 10s | Keep WS alive |

---

## 10. Data Flow Summary

```
Startup:
  Backfill (one-time) → batch upsert all events/markets → build token cache
       ↓
  Start all loops concurrently:

Every 5 min (quick sync):
  Gamma API (200 newest) → batch upsert → update token cache

Every 1 hour (full sync):
  Gamma API (all pages) → batch upsert → close stale events (flag only)

Every 1 hour (agent):
  DB query (price >= 0.85, end < 24h) → 5 workers × Perplexity bridges
  → outcomes table + Telegram alerts

Every 2 min (hot loop):
  Scan trackedEvents for past estimatedEndMin → Perplexity → alerts

Real-time (WebSocket):
  Price spike >= 0.85 → O(1) token lookup → Perplexity → alert
  market_resolved → instant alert
```

### Data Retention
- **Stored**: All non-crypto events and their markets
- **Never deleted**: Closed events are flagged `closed=true`, data stays in DB
- **Updated**: Prices, volumes, status upserted on every sync cycle
- **Pruned**: Only `resolvedEventIds` in-memory (7-day TTL to prevent unbounded growth)

---

## 11. Perplexity Bridge Details

### Session Tokens
- Format: JWE (JSON Web Encryption) — `__Secure-next-auth.session-token` cookies
- **IP-bound**: Tokens only work from the IP where they were generated
- **~30 day expiry**: Rolling sessions extend on use
- **No programmatic refresh**: Must manually extract from browser on token expiry

### Bridge Protocol
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
    │     markets: [{market:1, ...}],       │
    │     estimated_end_min: "ISO",         │
    │     estimated_end_max: "ISO",         │
    │     confidence: 95 }                  │
```

### Error Handling
- Session errors (401, 403, expired) → client recreation with same token
- Rate limit errors (429, quota) → client recreation + backoff
- Bridge death (exit code) → auto-respawn on next query
- 90s timeout per query → reject promise, mark bridge dead

---

## 12. Known Limitations

1. **Perplexity session tokens are IP-bound** — cannot use tokens generated locally on a different VPS
2. **No token auto-refresh** — session cookies must be manually extracted from browser
3. **Web scraper dependency** — `perplexity-webui-scraper` may break if Perplexity changes their UI
4. **Query latency** — 10-30s per Perplexity query (web scraping, not API)
5. **No automated trading** — alerts only, manual execution required
