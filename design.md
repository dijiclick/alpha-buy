# Alpha Buy — System Design Document

## 1. Overview

Alpha Buy is an automated edge-detection and trading system for Polymarket prediction markets. It uses AI (Perplexity) to independently estimate outcome probabilities, compares them against market prices to find mispricings ("edges"), and can automatically execute trades when the edge exceeds a threshold.

The system runs as a **single unified process** (`dist/src/index.js`) that handles: event ingestion, real-time price monitoring, AI probability estimation via Perplexity, edge detection, automated trading (optional), position tracking, auto-settlement, and Telegram alerting.

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
│   - Excludes crypto events (tag_id=21) + blocked sports          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SUPABASE (PostgreSQL)                          │
│                                                                  │
│   events          markets          outcomes        edge_         │
│   - polymarket_   - polymarket_    - market_id     predictions   │
│     event_id        market_id      - detected_     - event_id    │
│   - title         - question         outcome       - market_id   │
│   - closed        - outcome_       - confidence    - probability │
│   - end_date        prices         - is_resolved   - divergence  │
│                   - clob_token_    - profit_pct    - yes/no_price│
│                     ids                                          │
│                   - closed         trades                        │
│                                    - market_id                   │
│   Data retention: closed events    - side (YES/NO)               │
│   are NEVER deleted, only          - buy_price                   │
│   flagged closed=true              - status                      │
│                                    - pnl                         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌──────────────────────┐  ┌──────────────────────────────────────┐
│   CLOB WEBSOCKET     │  │   EDGE AGENT                          │
│   Real-time prices   │  │   dist/src/detection/agent.js         │
│                      │  │                                       │
│ - Subscribe to ALL   │  │   Four detection loops:               │
│   YES token prices   │  │                                       │
│ - In-memory cache:   │  │   1. Hourly cycle                    │
│   tokenToEventId     │  │      price >= 0.85 filter            │
│   (O(1) lookups)     │  │      end_date <= 24h horizon         │
│                      │  │      N parallel workers               │
│ - Bidirectional:     │  │                                       │
│   YES >= 0.85 or     │  │   2. Hot loop (every 2 min)          │
│   NO  >= 0.85        │  │      events past estimatedEndMin     │
│   both trigger       │  │      20min lookback window            │
│   immediate check    │  │                                       │
│                      │  │   3. Discovery scan (every 15 min)   │
│ - market_resolved:   │  │      events entering 24h horizon     │
│   instant settlement │  │      lightweight initial tracking     │
│                      │  │                                       │
│ - Round-robin slot   │  │   4. WebSocket-triggered             │
│   for bridge queries │  │      price spike or resolution        │
│ - 5-min cooldown     │  │      round-robin bridge slots         │
│   per token          │  │                                       │
└──────────────────────┘  └──────────┬───────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              PERPLEXITY BRIDGE POOL                               │
│                                                                  │
│   Backend 1: Python bridge (Pro/Max accounts)                    │
│     scripts/perplexity_bridge.py --server                        │
│     - perplexity-webui-scraper >= 0.5.0                          │
│     - ~2.8s per query                                            │
│                                                                  │
│   Backend 2: Rust MCP binary (free accounts)                     │
│     scripts/perplexity-web-api-mcp.exe                           │
│     - perplexity-web-api-mcp v0.4.0                              │
│     - JSON-RPC (MCP protocol) via stdin/stdout                   │
│     - ~4-5s per query                                            │
│                                                                  │
│   6 concurrent session tokens (up to 10 supported)               │
│   - JSON line protocol via stdin/stdout                          │
│   - 90s timeout per query, auto-reconnects dead bridges          │
│   - CSRF tokens stored alongside session tokens                  │
│   - Round-robin slot assignment for WS-triggered checks          │
│   - Slot 0 reserved for WebSocket (prevents starvation)          │
│   - Auto client recreation on session/rate errors                │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              EDGE DETECTION + TRADING FLOW                       │
│                                                                  │
│   1. Pre-flight: batch check Gamma API if markets closed        │
│      → If closed: skip (no opportunity)                         │
│   2. Query Perplexity for probability estimate                  │
│      → AI returns probability_yes (0-100) per market            │
│   3. Calculate edge:                                            │
│      yesEdge = AI_prob - market_price                           │
│      noEdge  = (1 - AI_prob) - (1 - market_price)              │
│   4. Store prediction in edge_predictions table                 │
│   5. If edge >= EDGE_THRESHOLD (15%) + confidence >= 80%:       │
│      → Record trade in trades table (status=pending)            │
│      → If TRADING_ENABLED: execute FOK order via CLOB API      │
│      → Otherwise: log as DRY_RUN                                │
│      → Send Telegram notification                               │
│   6. Track event with smart scheduling for rechecks             │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              SETTLEMENT + REDEMPTION                             │
│   dist/src/trading/redeemer.js                                   │
│                                                                  │
│   Every 5 min: check open positions via Gamma API               │
│   - If market.closed: determine winner from outcomePrices       │
│   - Calculate P&L: win = (1 - buyPrice) * shares               │
│   - Update trades table with settled_outcome + pnl              │
│   - If REDEEM_ENABLED: call CTF contract on Polygon             │
│   - Send Telegram notification (WIN/LOSS + P&L)                 │
│                                                                  │
│   WebSocket fast path:                                           │
│   - market_resolved event → immediate settlement check          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Sources

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

### CLOB REST API

- **Base URL**: `https://clob.polymarket.com`
- **Used for**: Fetching real-time order book (bid/ask), placing trades
- **Auth**: Derived from Ethereum wallet private key (API key + secret + passphrase)

---

## 4. Concurrency Model

### Bridge Pool

Each Perplexity session token gets its own persistent Python bridge process:

```
.env:
  PERPLEXITY_SESSION_TOKEN    → Bridge #0  (reserved for WebSocket if 2+ bridges)
  PERPLEXITY_SESSION_TOKEN_2  → Bridge #1
  PERPLEXITY_SESSION_TOKEN_3  → Bridge #2
  PERPLEXITY_SESSION_TOKEN_4  → Bridge #3
  PERPLEXITY_SESSION_TOKEN_5  → Bridge #4
  PERPLEXITY_SESSION_TOKEN_6  → Bridge #5
  ...up to _10
```

- Currently 6 active tokens (1 Pro + 5 free accounts)
- Bridges spawned lazily on first use, kept alive in server mode
- Dead bridges auto-respawn on next query
- `PYTHON_CMD=uv` uses `uv run --script`, `PYTHON_CMD=python3` uses direct invocation

### Worker Distribution

- **Slot 0**: Reserved for WebSocket-triggered checks (if 2+ bridges)
- **Slots 1+**: Used by hourly cycle, hot loop, and discovery scan workers
- **WebSocket-triggered**: Round-robin across all slots (`_wsSlot++ % concurrency`)

---

## 5. Detection Loops

### Loop 1: Hourly Cycle (every 3600s)

1. Query DB for events with any market priced >= 0.85 (price-first filter)
2. Skip events already in `resolvedEventIds`
3. Skip events with `end_date` > 24h away (`END_DATE_HORIZON`)
4. Skip tracked events whose `nextCheckAt` hasn't arrived
5. Batch Gamma pre-flight check (20 events per batch) — skip markets already closed on Polymarket
6. Distribute remaining events across N worker bridges
7. Each worker: Perplexity query → calculate edge → store prediction → trade if edge found

### Loop 2: Hot Loop (every 2 min)

Checks events whose Perplexity-estimated end time has **already passed**:

1. Scan `trackedEvents` for those with `estimatedEndMin` in the past (0-20min ago)
2. Fetch full event data from DB
3. Sort by urgency (most recently ended first)
4. Process through worker pool

**Key**: Never queries BEFORE `estimatedEndMin` — only checks after the event should have ended.

### Loop 3: Discovery Scan (every 15 min)

Catches events entering the detection window:

1. Query events entering the 24h horizon that aren't already tracked
2. Lightweight initial tracking (no Perplexity query in discovery phase)
3. Immediately process newly discovered events with Perplexity
4. Sort soonest-ending first for priority processing

### Loop 4: WebSocket-Triggered (real-time)

Real-time reactions to price spikes and resolution events:

- **YES spike**: YES price >= 0.85 → immediate Perplexity check
- **NO spike**: YES price <= 0.15 (NO side >= 0.85) → immediate check (bidirectional)
- **market_resolved**: Polymarket confirms resolution → instant settlement check
- Uses in-memory `tokenToEventId` cache for O(1) token-to-event lookup (no DB scan)
- 5-minute cooldown per token to prevent spam (bypassed for `market_resolved`)

---

## 6. Smart Scheduling

`calculateNextCheck(estimatedEndISO, checkCount)`:

| Time until estimated end | Action |
|---|---|
| > 3 days | Sleep until 24h before end |
| 1-3 days | Check every 6 hours |
| 4-24 hours | Check every 2 hours |
| < 4 hours | **Wait until endTime + 75-90s** (never before) |
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

## 7. Edge Detection Logic

The core innovation: instead of just detecting resolution, the system estimates **probabilities** and finds **mispricings**.

### Flow per market

1. Perplexity returns `probability_yes` (0-100) for each market
2. Calculate edges:
   - `yesEdge = aiProbYes - marketYesPrice` (positive = YES underpriced)
   - `noEdge = aiProbNo - marketNoPrice` (positive = NO underpriced)
3. Store prediction in `edge_predictions` table (always, regardless of edge)
4. If `max(yesEdge, noEdge) >= EDGE_THRESHOLD` (15%) and `confidence >= 80%`:
   - Determine best side (YES or NO)
   - Record trade in `trades` table
   - Execute or dry-run

### Price Fetching (Three-tier fallback)

1. **CLOB Order Book** — real-time bid/ask (most accurate)
   - Skip if spread > 20¢ (thin book)
2. **Gamma API** — mid-market price (UI-displayed price)
3. **Stored prices** — DB cache from last sync (fallback)

---

## 8. Trading System

### Trade Execution (`dist/src/trading/executor.js`)

- **Client**: `@polymarket/clob-client` on Polygon (chain ID 137)
- **Order type**: Fill-or-Kill (FOK) market order
- **Slippage**: 5¢ above current price
- **Auth**: Ethereum wallet private key → derived API credentials
- **Amount**: Configurable per trade (default: $1)

### Trade Lifecycle

```
pending → filled (or failed/dry_run)
              ↓
         (market settles)
              ↓
         settled (win/loss, P&L calculated)
              ↓
         redeemed (on-chain CTF redemption)
```

### Auto-Settlement (`dist/src/trading/redeemer.js`)

Every 5 minutes:
1. Query `trades` table for open positions (`settled=false, status=filled`)
2. Check each market via Gamma API for closure
3. If `market.closed`: determine winner from `outcomePrices` ([1,0] or [0,1])
4. Calculate P&L:
   - Win: `(1 - buyPrice) * shares`
   - Loss: `-amountUsd`
5. Update trade record with `settled_outcome`, `pnl`
6. Optionally redeem on-chain via CTF contract
7. Send Telegram WIN/LOSS notification

### WebSocket Fast Settlement

When `market_resolved` event received via WebSocket:
- Immediately checks if we have an open position on that market
- Settles and notifies without waiting for the 5-minute poll

---

## 9. State Management

In-memory state class (`State`) persisted to `state.json` every 60s:

| Field | Type | Description |
|---|---|---|
| `trackedEvents` | Map | Events being monitored: eventId → {estimatedEndMin, nextCheckAt, checkCount, ...} |
| `knownEventIds` | Set | All synced event IDs |
| `knownMarketIds` | Set | All synced market IDs |
| `marketsByQuestion` | Map | Question text → market ID |
| `tokenToEventId` | Map | CLOB token ID → polymarket event ID (for WS O(1) lookups) |
| `resolvedEventIds` | Map | Event ID → resolved timestamp (auto-prune after 7 days) |
| `activePositions` | Map | `{marketId}_{side}` → {side, shares, buyPrice, tradeId, eventId} |
| `backfillComplete` | boolean | Skip backfill on restart |

All Maps/Sets serialize as arrays of entries in JSON. State survives restarts.

---

## 10. Database Schema

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
| `last_checked_at` | timestamptz | Last Perplexity check |

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
| `description` | text | Market description / resolution rules |
| `slug` | text | URL slug |
| `outcomes` | jsonb | e.g., `["Yes","No"]` |
| `outcome_prices` | jsonb | e.g., `["0.85","0.15"]` |
| `clob_token_ids` | jsonb | CLOB trading token IDs `[YES_ID, NO_ID]` |
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

### `edge_predictions`

| Column | Type | Description |
|---|---|---|
| `id` | bigint (auto) | Internal PK |
| `event_id` | text | Polymarket event ID |
| `event_title` | text | Event title |
| `event_slug` | text | Event URL slug |
| `event_end_date` | timestamptz | Event end date |
| `market_id` | text | Polymarket market ID |
| `market_question` | text | Market question text |
| `predicted_outcome` | text | "yes" or "no" (AI's pick) |
| `probability` | int | AI probability_yes (0-100) |
| `reasoning` | text | AI reasoning (cited evidence) |
| `ai_summary` | text | Summary text |
| `yes_price` | numeric(6,4) | Market YES price at time of prediction |
| `no_price` | numeric(6,4) | Market NO price at time of prediction |
| `best_ask` | numeric(6,4) | Best ask from order book |
| `best_bid` | numeric(6,4) | Best bid from order book |
| `divergence` | numeric(6,4) | max(yesEdge, noEdge) |
| `profit_pct` | numeric(8,4) | Potential profit percentage |
| `alert_sent` | boolean | Whether Telegram alert was sent |
| `alert_sent_at` | timestamptz | When alert was sent |
| `actual_outcome` | text | Actual resolved outcome (backfilled) |
| `was_correct` | boolean | Whether AI prediction was correct |
| `resolved_at` | timestamptz | When market actually resolved |
| `final_yes_price` | numeric(6,4) | Final YES price at resolution |
| `final_no_price` | numeric(6,4) | Final NO price at resolution |
| `resolution_source` | text | Source of resolution data |
| `detected_at` | timestamptz | When prediction was made |
| `updated_at` | timestamptz | Last update |
| | | **UNIQUE(event_id, market_id)** |

### `trades`

| Column | Type | Description |
|---|---|---|
| `id` | bigint (auto) | Internal PK |
| `event_id` | text | Polymarket event ID |
| `market_id` | text | Polymarket market ID |
| `market_question` | text | Market question |
| `side` | text | "YES" or "NO" |
| `token_id` | text | CLOB token ID used |
| `buy_price` | numeric(6,4) | Entry price |
| `shares` | numeric(12,4) | Number of shares |
| `amount_usd` | numeric(8,4) | USD amount invested |
| `ai_probability` | numeric(6,4) | AI probability at time of trade |
| `edge_pct` | numeric(6,4) | Edge percentage at time of trade |
| `confidence` | int | AI confidence (0-100) |
| `reasoning` | text | AI reasoning |
| `status` | text | pending / filled / failed / dry_run |
| `order_id` | text | CLOB order ID |
| `fill_price` | numeric(6,4) | Actual fill price |
| `settled` | boolean | Whether position is settled |
| `settled_outcome` | text | "YES" or "NO" |
| `settled_at` | timestamptz | Settlement timestamp |
| `pnl` | numeric(8,4) | Profit/loss in USD |
| `redeemed` | boolean | Whether on-chain redemption completed |
| `redeemed_at` | timestamptz | Redemption timestamp |
| `created_at` | timestamptz | Trade creation time |
| `updated_at` | timestamptz | Last update |

**Indexes**: `idx_trades_status`, `idx_trades_market`, `idx_trades_open` (partial: settled=false AND status=filled)

---

## 11. Perplexity Bridge Details

### Dual Backend Architecture

**Backend 1: Python Bridge** (`scripts/perplexity_bridge.py`)
- Library: `perplexity-webui-scraper >= 0.5.0`
- Requires: **Pro/Max** Perplexity accounts
- Speed: ~2.8s per query
- Protocol: JSON lines via stdin/stdout
- Mode: Persistent server (`--server` flag)

**Backend 2: Rust MCP Binary** (`scripts/perplexity-web-api-mcp.exe`)
- Binary: `perplexity-web-api-mcp` v0.4.0 (Windows x86_64)
- Requires: **Free** Perplexity accounts (works with Sonar model)
- Speed: ~4-5s per query
- Protocol: JSON-RPC (MCP) via stdin/stdout
- Auth: Both `PERPLEXITY_SESSION_TOKEN` and `PERPLEXITY_CSRF_TOKEN` required

### Session Tokens
- Format: JWE (JSON Web Encryption) — `__Secure-next-auth.session-token` cookies
- CSRF: `next-auth.csrf-token` cookies (required for Rust MCP backend)
- **IP-bound**: Tokens only work from the IP where they were generated
- **~30 day expiry**: Rolling sessions extend on use

### Automated Token Refresh (`scripts/login_perplexity.py`)

Fully automated login to multiple Perplexity accounts via Mail.tm temporary email:

1. Login to Mail.tm via API (POST /token → JWT)
2. Pre-scan existing inbox messages (to skip stale magic links)
3. Trigger Perplexity email verification (POST /api/auth/signin/email)
4. Poll Mail.tm inbox for new verification email
5. Extract magic link or 6-digit OTP from email HTML
6. Complete Perplexity login and extract cookies
7. Write all session + CSRF tokens to `.env`

```
Run: uv run --script scripts/login_perplexity.py
```

Current accounts: 6 (1 Pro + 5 free @dollicons.com via Mail.tm)

### Bridge Protocol (Probability Mode)
```
Node.js agent                          Python bridge (--server)
    │                                       │
    │── JSON line via stdin ──────────────→ │
    │   { mode:"event",                     │ readline()
    │     event_title: "...",               │ query Perplexity
    │     market_questions: [...],          │ parse response
    │     market_prices: [0.85, ...] }      │
    │                                       │
    │←── JSON line via stdout ─────────────│
    │   { resolved: false,                  │ print(json, flush)
    │     markets: [{market:1,              │
    │       probability_yes: 92,            │
    │       confidence: 85}],               │
    │     reasoning: "Reuters..." }         │
```

### Error Handling
- Session errors (401, 403, expired) → client recreation with same token
- Rate limit errors (429, quota) → exponential backoff (30s base → 300s max)
- Bridge death (exit code) → auto-respawn on next query
- 90s timeout per query → reject promise, mark bridge dead

---

## 12. Configuration

| Key | Default | Description |
|---|---|---|
| `SUPABASE_URL` | (required) | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | (required) | Supabase service role key |
| `PERPLEXITY_SESSION_TOKEN` | (required) | Primary Perplexity session cookie |
| `PERPLEXITY_SESSION_TOKEN_2..10` | (optional) | Additional concurrent tokens |
| `PERPLEXITY_CSRF_TOKEN` | (optional) | CSRF token for Rust MCP backend |
| `PERPLEXITY_CSRF_TOKEN_2..10` | (optional) | Additional CSRF tokens |
| `TELEGRAM_BOT_TOKEN` | (optional) | Telegram bot for alerts |
| `TELEGRAM_CHAT_ID` | (optional) | Telegram chat for alerts |
| `PYTHON_CMD` | `uv` | Python runner (`uv` or `python3`) |
| `PERPLEXITY_BRIDGE_PATH` | `scripts/perplexity_bridge.py` | Bridge script path |
| `PERPLEXITY_MCP_PATH` | `scripts/perplexity-web-api-mcp.exe` | Rust MCP binary path |
| `PRICE_SPIKE_THRESHOLD` | `0.85` | Min price to trigger detection |
| `END_DATE_HORIZON_HOURS` | `24` | Skip events ending beyond this |
| `MIN_CONFIDENCE` | `80` | Min AI confidence for edge trades |
| `EDGE_THRESHOLD` | `0.15` | Min edge (15%) to trigger buy |
| `TRADING_ENABLED` | `false` | Enable live trading (else dry run) |
| `TRADE_AMOUNT` | `1` | USD per trade |
| `POLYMARKET_PRIVATE_KEY` | (optional) | Ethereum wallet for trading |
| `POLYMARKET_API_KEY` | (optional) | CLOB API key (derived from wallet if unset) |
| `POLYMARKET_API_SECRET` | (optional) | CLOB API secret |
| `POLYMARKET_API_PASSPHRASE` | (optional) | CLOB API passphrase |
| `POLYMARKET_FUNDER` | (optional) | Funder address (defaults to wallet) |
| `REDEEM_ENABLED` | `false` | Auto-redeem winning positions on-chain |

### Intervals

| Interval | Value | Description |
|---|---|---|
| `SYNC_INTERVAL` | 1 hour | Full sync (all pages) |
| `QUICK_SYNC_INTERVAL` | 5 min | Quick sync (200 newest) |
| `DETECTION_INTERVAL` | 1 hour | Agent hourly cycle |
| Hot loop | 2 min | Near-ending event checks |
| Discovery scan | 15 min | New events entering horizon |
| Redeem check | 5 min | Settlement monitoring |
| `STATE_PERSIST_INTERVAL` | 60s | Save state.json |
| `STATUS_REPORT_INTERVAL` | 30s | Log status line |
| WebSocket PING | 10s | Keep WS alive |
| WS cooldown | 5 min | Per-token check cooldown |

---

## 13. Data Flow Summary

```
Startup:
  1. Load state.json
  2. Backfill (one-time) → batch upsert all events/markets → build token cache
  3. Start event syncer (await first full sync)
  4. Initialize trading client (optional)
  5. Start all loops concurrently:

Every 5 min (quick sync):
  Gamma API (200 newest) → batch upsert → update token cache

Every 1 hour (full sync):
  Gamma API (all pages) → batch upsert → close stale events (flag only)

Every 1 hour (agent cycle):
  DB query (price >= 0.85, end < 24h) → batch Gamma pre-flight
  → N workers × Perplexity bridges → edge detection → trades + alerts

Every 2 min (hot loop):
  Scan trackedEvents for past estimatedEndMin → Perplexity → edge → trades

Every 15 min (discovery):
  Events entering 24h horizon → track → Perplexity → edge → trades

Real-time (WebSocket):
  YES >= 0.85 or NO >= 0.85 → O(1) lookup → Perplexity → edge → trade
  market_resolved → immediate settlement check

Every 5 min (redeemer):
  Open positions → Gamma API → settled? → P&L → redeem → notify
```

### Data Retention
- **Stored**: All non-crypto events and their markets
- **Never deleted**: Closed events are flagged `closed=true`, data stays in DB
- **Updated**: Prices, volumes, status upserted on every sync cycle
- **Pruned**: Only `resolvedEventIds` in-memory (7-day TTL to prevent unbounded growth)
- **Predictions**: All edge predictions stored permanently for accuracy tracking

---

## 14. File Structure

```
polyedge/
├── design.md                           # This document
├── schema.sql                          # Database schema
├── .env                                # Configuration (tokens, keys)
├── scripts/
│   ├── perplexity_bridge.py            # Python Perplexity bridge (Pro accounts)
│   ├── perplexity-web-api-mcp.exe      # Rust MCP binary (free accounts)
│   ├── login_perplexity.py             # Automated token refresh via Mail.tm
│   ├── test_tokens.py                  # Token validation script
│   └── test_mcp_tokens.py             # MCP backend validation script
├── alpha buy/
│   ├── dist/src/
│   │   ├── index.js                    # Entry point: startup sequence
│   │   ├── state.js                    # In-memory state + persistence
│   │   ├── db/
│   │   │   └── supabase.js             # Database interface (all queries)
│   │   ├── detection/
│   │   │   ├── agent.js                # Edge agent: 4 loops + bridge pool
│   │   │   └── websocket.js            # CLOB real-time price stream
│   │   ├── ingestion/
│   │   │   ├── syncer.js               # Full/quick sync from Gamma API
│   │   │   └── backfill.js             # One-time data population
│   │   ├── trading/
│   │   │   ├── executor.js             # CLOB trade execution
│   │   │   └── redeemer.js             # Auto-settlement + on-chain redemption
│   │   └── util/
│   │       ├── config.js               # Configuration loading
│   │       ├── logger.js               # Daily log files + console
│   │       └── normalize.js            # Text normalization
│   ├── state.json                      # Persisted state
│   └── logs/                           # Daily log files
└── data.txt                            # Misc data
```

---

## 15. Known Limitations

1. **Perplexity session tokens are IP-bound** — cannot use tokens generated locally on a different VPS
2. **Python bridge requires Pro/Max accounts** — free accounts only work with Rust MCP backend
3. **Web scraper dependency** — `perplexity-webui-scraper` may break if Perplexity changes their UI
4. **Query latency** — 2.8-5s per Perplexity query depending on backend and account tier
5. **Mail.tm accounts expire** — temporary email accounts may get deleted, requiring re-registration
6. **No partial fills** — FOK orders either fill completely or fail
7. **Single-process architecture** — no horizontal scaling (runs on one machine)
8. **Polygon gas costs** — on-chain redemption requires MATIC for gas
