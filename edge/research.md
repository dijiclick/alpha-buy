# Research Basis For The Method

## What Was Researched

1. Polymarket pricing and binary interpretation
- Price is interpreted as market-implied probability in binary contracts.
- Source: https://docs.polymarket.com/polymarket-learn/trading/how-are-prices-calculated

2. CLOB execution and fee-aware trading context
- Orderbook-based execution, taker/maker mechanics, fees.
- Sources:
  - https://docs.polymarket.com/developers/CLOB/introduction
  - https://docs.polymarket.com/developers/CLOB/orders/orders

3. Resolution and official-confirmation requirement
- Settlement depends on finalized resolution process, not forecasts.
- Source: https://docs.polymarket.com/polymarket-learn/resolution

4. Negative-risk / grouped market structure
- Relevant for constrained sets and conversion logic.
- Source: https://docs.polymarket.com/developers/neg-risk/overview

5. Constraint-based pricing literature
- Combinatorial and logical consistency ideas in prediction markets.
- Sources:
  - https://arxiv.org/abs/1202.3379
  - https://arxiv.org/abs/1211.1402

## Constraint Formulas Used

Let `pA`, `pB` be YES prices for markets A, B.

### A) Mutually exclusive (`A` and `B` cannot both be true)

Portfolio: `NO(A) + NO(B)`

- Cost: `(1 - pA) + (1 - pB) = 2 - (pA + pB)`
- Worst-case payout: `1`
- Gross edge: `(pA + pB) - 1`

Signal condition (before fee buffer): `pA + pB > 1`

### B) Mutually exclusive and exhaustive (exactly one true)

Portfolio: `YES(A) + YES(B)`

- Cost: `pA + pB`
- Guaranteed payout: `1`
- Gross edge: `1 - (pA + pB)`

Signal condition: `pA + pB < 1`

### C) Implication (`A => B`)

No-arbitrage consistency requires `P(A) <= P(B)` ideally.

Portfolio when violated (`pA > pB`): `NO(A) + YES(B)`

- Cost: `(1 - pA) + pB = 1 + pB - pA`
- Worst-case payout: `1`
- Gross edge: `pA - pB`

### D) Equivalence (`A <=> B`)

Equivalent propositions should price similarly.

If `pA > pB`, use `NO(A) + YES(B)` with gross edge `pA - pB`.
If `pB > pA`, mirror legs.

### E) Impossible outcome (YES already dead)

If YES is impossible now:

Portfolio: `NO`

- Cost: `1 - p`
- Payout: `1`
- Gross edge: `p`

## Why Pre-End Analysis Is Useful

Some outcomes become impossible before official market settlement due to official real-world facts (elimination, disqualification, expired path).  
Markets can remain stale temporarily, which creates edge windows if execution is fast and fee-aware.

## Practical Safeguards Added

- Pair prefiltering to reduce Perplexity calls under rate limits
- Confidence thresholds for relation and impossible flags
- Fee/slippage buffers before emitting opportunities
- Cached relation results to avoid redundant calls
- Standalone design (does not alter existing live scanner)

