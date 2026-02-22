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
- `edge/research.md`: method + formulas + references
- `edge/cache/relation_cache.json`: local relation cache
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

## Output Interpretation

Main opportunity types:

- `mutex_no_no`: for mutually exclusive YES outcomes with `pA + pB > 1`
- `mutex_yes_yes_exhaustive`: for exhaustive exclusive pair with `pA + pB < 1`
- `equiv_spread`: for equivalent markets with spread
- `implication_violation`: when implied probability ordering is violated
- `impossible_yes`: when YES is already impossible and priced above near-zero

`net_edge` already subtracts configurable fee/slippage buffers.

## Safety

- Always manually confirm market resolution rules before executing.
- Start with small size and verify live book depth/fees.
- Treat impossible-outcome flags as high-priority alerts, not auto-trade guarantees.
