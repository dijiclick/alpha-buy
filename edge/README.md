# Standalone Logic-Edge Scanner

This module is isolated from your existing runtime.  
It does not import or modify `dist/src/index.js` loops.

## Goal

Find pre-resolution edge opportunities from:

- Logical contradictions between markets
- Broken implication/equivalence constraints
- Outcomes already impossible before official settlement

## Files

- `edge/edge_scanner.mjs`: main scanner
- `edge/constraint_bridge.py`: Perplexity logical-analysis bridge
- `edge/live_recheck.mjs`: live Gamma + CLOB pre-alert recheck
- `edge/telegram.mjs`: Telegram sender
- `edge/alert_state.mjs`: alert dedupe cache manager
- `edge/research.md`: method + formulas + references
- `edge/cache/relation_cache.json`: local relation cache
- `edge/cache/alert_state.json`: sent-alert dedupe state
- `edge/reports/latest.json`: machine-readable output
- `edge/reports/latest.md`: readable report

## Required Env Vars

Uses the same credentials you already have:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `PERPLEXITY_SESSION_TOKEN`

Optional:

- `PERPLEXITY_SESSION_TOKEN_2..10` for more parallel bridges
- `PYTHON_CMD` (`uv` default, or `python`)
- `CONSTRAINT_BRIDGE_PATH` custom path for bridge script
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for alerts
- `EDGE_CLOB_BASE` (default `https://clob.polymarket.com`)

## Run

```bash
node edge/edge_scanner.mjs
```

## Key Tunables

- `EDGE_HORIZON_HOURS` (default `72`)
- `EDGE_MAX_PAIR_CHECKS` (default `120`)
- `EDGE_RELATION_MIN_CONFIDENCE` (default `78`)
- `EDGE_IMPOSSIBLE_MIN_CONFIDENCE` (default `88`)
- `EDGE_FEE_BUFFER_TWO_LEG` (default `0.03`)
- `EDGE_FEE_BUFFER_SINGLE_LEG` (default `0.015`)
- `EDGE_MIN_NET_EDGE` (default `0.02`)
- `EDGE_CACHE_TTL_HOURS` (default `6`)
- `EDGE_TELEGRAM_ENABLED` (default `true`)
- `EDGE_ALERT_MIN_NET_EDGE` (default `0.03`)
- `EDGE_ALERT_MIN_CONFIDENCE` (default `85`)
- `EDGE_ALERT_DEDUPE_HOURS` (default `6`)
- `EDGE_ALERT_TOP_N` (default `5`)
- `EDGE_LIVE_RECHECK_TIMEOUT_MS` (default `8000`)
- `EDGE_LIVE_RECHECK_MAX_PRICE_DRIFT` (default `0.05`, applies to live portfolio `total_cost` drift)
- `EDGE_CLOB_BASE` (default `https://clob.polymarket.com`)

## Perplexity Flow

1. Scanner loads open near-end events from Supabase snapshot.
2. It builds pair candidates with lightweight prefilters to reduce query volume.
3. Candidate pairs are sent to `constraint_bridge.py` through JSON lines.
4. Bridge prompts Perplexity for strict JSON:
   - relation (`equivalent`, `mutually_exclusive`, `a_implies_b`, `b_implies_a`, `unrelated`)
   - `exhaustive`
   - `impossible_yes`
   - confidence + short reason + evidence URLs/dates
5. Scanner converts that relation to strategy opportunities with fee buffers.
6. Relation responses are cached in `edge/cache/relation_cache.json`.
7. Alert path then applies threshold + dedupe + live executable recheck.

## Output Interpretation

Main opportunity types:

- `mutex_no_no`: for mutually exclusive YES outcomes with `pA + pB > 1`
- `mutex_yes_yes_exhaustive`: for exhaustive exclusive pair with `pA + pB < 1`
- `equiv_spread`: for equivalent markets with spread
- `implication_violation`: when implied probability ordering is violated
- `impossible_yes`: when YES is already impossible and priced above near-zero

`net_edge` already subtracts configurable fee/slippage buffers.

Report and alert behavior are intentionally different:

- Reports can still show theoretical opportunities from snapshot pricing.
- Telegram alerts are stricter and require live executable leg prices (CLOB-first).

## Safety

- Always manually confirm market resolution rules before executing.
- Start with small size and verify live book depth/fees.
- Treat impossible-outcome flags as high-priority alerts, not auto-trade guarantees.
