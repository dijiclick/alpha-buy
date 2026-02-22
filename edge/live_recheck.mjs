const DEFAULT_GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_BASE = 'https://clob.polymarket.com';

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isPrice(n) {
  return n != null && Number.isFinite(n) && n >= 0 && n <= 1;
}

function parseJsonMaybe(v, fallback) {
  if (v == null) return fallback;
  if (Array.isArray(v) || typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function clampPrice(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return Number(n.toFixed(6));
}

function sortedBestBid(book) {
  if (!book || !Array.isArray(book.bids)) return null;
  let best = null;
  for (const b of book.bids) {
    const p = toNum(b?.price);
    if (!isPrice(p)) continue;
    if (best == null || p > best) best = p;
  }
  return best;
}

function sortedBestAsk(book) {
  if (!book || !Array.isArray(book.asks)) return null;
  let best = null;
  for (const a of book.asks) {
    const p = toNum(a?.price);
    if (!isPrice(p)) continue;
    if (best == null || p < best) best = p;
  }
  return best;
}

function parseTokenIds(raw) {
  const ids = parseJsonMaybe(raw, null);
  if (!Array.isArray(ids)) return [];
  return ids.map(x => String(x || '').trim()).filter(Boolean).slice(0, 2);
}

function fallbackQuotesFromGamma(market) {
  const yesAsk = toNum(market?.bestAsk ?? market?.best_ask);
  const yesBid = toNum(market?.bestBid ?? market?.best_bid);
  const noAsk = isPrice(yesBid) ? clampPrice(1 - yesBid) : null;
  const noBid = isPrice(yesAsk) ? clampPrice(1 - yesAsk) : null;
  return {
    yesAsk: isPrice(yesAsk) ? clampPrice(yesAsk) : null,
    yesBid: isPrice(yesBid) ? clampPrice(yesBid) : null,
    noAsk,
    noBid,
  };
}

async function fetchJsonWithTimeout(url, timeoutMs, fetchFn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, error: `status_${res.status}` };
    }
    const json = await res.json();
    return { ok: true, json };
  } catch (e) {
    if (String(e?.name || '').toLowerCase() === 'aborterror') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: `fetch_${String(e?.message || e).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGammaMarket(gammaBase, marketId, timeoutMs, fetchFn) {
  const out = await fetchJsonWithTimeout(`${gammaBase}/markets/${marketId}`, timeoutMs, fetchFn);
  if (!out.ok) return { ok: false, error: `gamma_${out.error}` };
  return { ok: true, market: out.json };
}

async function fetchBook(clobBase, tokenId, timeoutMs, fetchFn) {
  const out = await fetchJsonWithTimeout(`${clobBase}/book?token_id=${tokenId}`, timeoutMs, fetchFn);
  if (!out.ok) return { ok: false, error: `clob_${out.error}` };
  return {
    ok: true,
    quote: {
      bestBid: sortedBestBid(out.json),
      bestAsk: sortedBestAsk(out.json),
    },
  };
}

function chooseYesTokenIndex(gammaYesAsk, q0, q1) {
  const a0 = q0?.bestAsk;
  const a1 = q1?.bestAsk;
  if (isPrice(gammaYesAsk)) {
    const d0 = isPrice(a0) ? Math.abs(a0 - gammaYesAsk) : Infinity;
    const d1 = isPrice(a1) ? Math.abs(a1 - gammaYesAsk) : Infinity;
    if (d0 < d1) return 0;
    if (d1 < d0) return 1;
  }
  return 0;
}

function mergeQuotes(clobQuotes, fallbackQuotes) {
  const fields = ['yesAsk', 'yesBid', 'noAsk', 'noBid'];
  const merged = {};
  let usedClob = 0;
  let usedFallback = 0;
  for (const f of fields) {
    const c = isPrice(clobQuotes?.[f]) ? clampPrice(clobQuotes[f]) : null;
    const g = isPrice(fallbackQuotes?.[f]) ? clampPrice(fallbackQuotes[f]) : null;
    if (c != null) {
      merged[f] = c;
      usedClob++;
    } else if (g != null) {
      merged[f] = g;
      usedFallback++;
    } else {
      merged[f] = null;
    }
  }

  let source = 'none';
  if (usedClob > 0 && usedFallback === 0) source = 'clob';
  else if (usedClob === 0 && usedFallback > 0) source = 'gamma_fallback';
  else if (usedClob > 0 && usedFallback > 0) source = 'mixed';

  return { quotes: merged, source };
}

async function buildExecutableQuotes(market, options) {
  const timeoutMs = options.timeoutMs;
  const fetchFn = options.fetchFn;
  const clobBase = options.clobBase;
  const fallback = fallbackQuotesFromGamma(market);
  const tokenIds = parseTokenIds(market?.clobTokenIds ?? market?.clob_token_ids);

  let q0 = { bestBid: null, bestAsk: null };
  let q1 = { bestBid: null, bestAsk: null };
  let book0Ok = false;
  let book1Ok = false;

  if (tokenIds.length >= 2) {
    const [r0, r1] = await Promise.all([
      fetchBook(clobBase, tokenIds[0], timeoutMs, fetchFn),
      fetchBook(clobBase, tokenIds[1], timeoutMs, fetchFn),
    ]);
    if (r0.ok) {
      q0 = r0.quote;
      book0Ok = true;
    }
    if (r1.ok) {
      q1 = r1.quote;
      book1Ok = true;
    }
  }

  const yesIdx = chooseYesTokenIndex(fallback.yesAsk, q0, q1);
  const noIdx = yesIdx === 0 ? 1 : 0;
  const yesQ = yesIdx === 0 ? q0 : q1;
  const noQ = noIdx === 0 ? q0 : q1;

  const clobQuotes = {
    yesAsk: yesQ.bestAsk,
    yesBid: yesQ.bestBid,
    noAsk: noQ.bestAsk,
    noBid: noQ.bestBid,
  };
  const merged = mergeQuotes(clobQuotes, fallback);
  if (merged.source === 'none') {
    return { ok: false, reason: 'clob_and_fallback_unavailable' };
  }

  return {
    ok: true,
    quotes: merged.quotes,
    source: merged.source,
    mapping: {
      yes_token_index: yesIdx,
      no_token_index: noIdx,
      token_ids: tokenIds,
      clob_book_0_ok: book0Ok,
      clob_book_1_ok: book1Ok,
    },
    gamma: {
      bestAsk: fallback.yesAsk,
      bestBid: fallback.yesBid,
    },
  };
}

function selectLegPrice(op, quotesA, quotesB) {
  if (op.type === 'mutex_no_no') {
    if (!isPrice(quotesA.noAsk) || !isPrice(quotesB.noAsk)) {
      return { ok: false, reason: 'missing_required_leg_quotes', missing: ['A_NO_ASK', 'B_NO_ASK'].filter(x => (x === 'A_NO_ASK' && !isPrice(quotesA.noAsk)) || (x === 'B_NO_ASK' && !isPrice(quotesB.noAsk))) };
    }
    const totalCost = quotesA.noAsk + quotesB.noAsk;
    return { ok: true, totalCost, requiredLegs: ['A_NO_ASK', 'B_NO_ASK'] };
  }

  if (op.type === 'mutex_yes_yes_exhaustive') {
    if (!isPrice(quotesA.yesAsk) || !isPrice(quotesB.yesAsk)) {
      return { ok: false, reason: 'missing_required_leg_quotes', missing: ['A_YES_ASK', 'B_YES_ASK'].filter(x => (x === 'A_YES_ASK' && !isPrice(quotesA.yesAsk)) || (x === 'B_YES_ASK' && !isPrice(quotesB.yesAsk))) };
    }
    const totalCost = quotesA.yesAsk + quotesB.yesAsk;
    return { ok: true, totalCost, requiredLegs: ['A_YES_ASK', 'B_YES_ASK'] };
  }

  if (op.type === 'equiv_spread' || op.type === 'implication_violation') {
    const s = String(op.strategy || '');
    if (s.includes('YES(B) + Buy NO(A)')) {
      if (!isPrice(quotesB.yesAsk) || !isPrice(quotesA.noAsk)) {
        return { ok: false, reason: 'missing_required_leg_quotes', missing: ['B_YES_ASK', 'A_NO_ASK'].filter(x => (x === 'B_YES_ASK' && !isPrice(quotesB.yesAsk)) || (x === 'A_NO_ASK' && !isPrice(quotesA.noAsk))) };
      }
      const totalCost = quotesB.yesAsk + quotesA.noAsk;
      return { ok: true, totalCost, requiredLegs: ['B_YES_ASK', 'A_NO_ASK'] };
    }
    if (s.includes('YES(A) + Buy NO(B)')) {
      if (!isPrice(quotesA.yesAsk) || !isPrice(quotesB.noAsk)) {
        return { ok: false, reason: 'missing_required_leg_quotes', missing: ['A_YES_ASK', 'B_NO_ASK'].filter(x => (x === 'A_YES_ASK' && !isPrice(quotesA.yesAsk)) || (x === 'B_NO_ASK' && !isPrice(quotesB.noAsk))) };
      }
      const totalCost = quotesA.yesAsk + quotesB.noAsk;
      return { ok: true, totalCost, requiredLegs: ['A_YES_ASK', 'B_NO_ASK'] };
    }
    return { ok: false, reason: 'unsupported_strategy_type' };
  }

  if (op.type === 'impossible_yes') {
    const s = String(op.strategy || '');
    if (s.includes('NO(A)')) {
      if (!isPrice(quotesA.noAsk)) return { ok: false, reason: 'missing_required_leg_quotes', missing: ['A_NO_ASK'] };
      return { ok: true, totalCost: quotesA.noAsk, requiredLegs: ['A_NO_ASK'] };
    }
    if (s.includes('NO(B)')) {
      if (!isPrice(quotesB.noAsk)) return { ok: false, reason: 'missing_required_leg_quotes', missing: ['B_NO_ASK'] };
      return { ok: true, totalCost: quotesB.noAsk, requiredLegs: ['B_NO_ASK'] };
    }
    return { ok: false, reason: 'unsupported_strategy_type' };
  }

  return { ok: false, reason: 'unsupported_strategy_type' };
}

function sourceAcrossMarkets(sourceA, sourceB) {
  if (sourceA === 'clob' && sourceB === 'clob') return 'clob';
  if (sourceA === 'gamma_fallback' && sourceB === 'gamma_fallback') return 'gamma_fallback';
  return 'mixed';
}

export async function recheckOpportunityLive(opportunity, options = {}) {
  const gammaBase = options.gammaBase || DEFAULT_GAMMA_BASE;
  const clobBase = options.clobBase || DEFAULT_CLOB_BASE;
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 8000);
  const maxPriceDrift = Number(options.maxPriceDrift) || 0.05;
  const feeTwoLeg = Number(options.feeBufferTwoLeg) || 0.03;
  const feeSingleLeg = Number(options.feeBufferSingleLeg) || 0.015;
  const minNetEdge = Number(options.minNetEdge) || 0.03;
  const fetchFn = options.fetchFn || fetch;

  const [aRes, bRes] = await Promise.all([
    fetchGammaMarket(gammaBase, opportunity.market_a_id, timeoutMs, fetchFn),
    fetchGammaMarket(gammaBase, opportunity.market_b_id, timeoutMs, fetchFn),
  ]);

  if (!aRes.ok) return { eligible: false, reason: `market_a_${aRes.error}` };
  if (!bRes.ok) return { eligible: false, reason: `market_b_${bRes.error}` };

  const a = aRes.market;
  const b = bRes.market;
  if (a?.closed === true || b?.closed === true) {
    return { eligible: false, reason: 'market_closed_on_gamma' };
  }

  const [quotesARes, quotesBRes] = await Promise.all([
    buildExecutableQuotes(a, { clobBase, timeoutMs, fetchFn }),
    buildExecutableQuotes(b, { clobBase, timeoutMs, fetchFn }),
  ]);

  if (!quotesARes.ok) return { eligible: false, reason: quotesARes.reason || 'clob_and_fallback_unavailable' };
  if (!quotesBRes.ok) return { eligible: false, reason: quotesBRes.reason || 'clob_and_fallback_unavailable' };

  const leg = selectLegPrice(opportunity, quotesARes.quotes, quotesBRes.quotes);
  if (!leg.ok) return { eligible: false, reason: leg.reason || 'missing_required_leg_quotes', missing: leg.missing || [] };

  const totalCost = leg.totalCost;
  const grossEdge = 1 - totalCost;
  const isSingleLeg = opportunity.type === 'impossible_yes';
  const netEdge = grossEdge - (isSingleLeg ? feeSingleLeg : feeTwoLeg);

  const snapshotCost = toNum(opportunity.total_cost);
  const costDrift = Number.isFinite(snapshotCost) ? Math.abs(totalCost - snapshotCost) : null;
  if (costDrift != null && costDrift > maxPriceDrift) {
    return { eligible: false, reason: `cost_drift_${costDrift.toFixed(4)}` };
  }

  if (netEdge < minNetEdge) {
    return { eligible: false, reason: 'edge_below_threshold_after_recheck' };
  }

  const liveYesA = quotesARes.quotes.yesAsk;
  const liveYesB = quotesBRes.quotes.yesAsk;
  const dbA = toNum(opportunity.market_a_yes);
  const dbB = toNum(opportunity.market_b_yes);
  const driftA = isPrice(liveYesA) && Number.isFinite(dbA) ? Math.abs(liveYesA - dbA) : 0;
  const driftB = isPrice(liveYesB) && Number.isFinite(dbB) ? Math.abs(liveYesB - dbB) : 0;
  const maxYesDrift = Math.max(driftA, driftB);

  const liveOpportunity = {
    ...opportunity,
    market_a_yes: isPrice(liveYesA) ? liveYesA : opportunity.market_a_yes,
    market_b_yes: isPrice(liveYesB) ? liveYesB : opportunity.market_b_yes,
    gross_edge: Number(grossEdge.toFixed(6)),
    net_edge: Number(netEdge.toFixed(6)),
    total_cost: Number(totalCost.toFixed(6)),
    live_total_cost: Number(totalCost.toFixed(6)),
    live_quote_source: sourceAcrossMarkets(quotesARes.source, quotesBRes.source),
    live_quotes: {
      market_a: {
        yesAsk: quotesARes.quotes.yesAsk,
        yesBid: quotesARes.quotes.yesBid,
        noAsk: quotesARes.quotes.noAsk,
        noBid: quotesARes.quotes.noBid,
        source: quotesARes.source,
      },
      market_b: {
        yesAsk: quotesBRes.quotes.yesAsk,
        yesBid: quotesBRes.quotes.yesBid,
        noAsk: quotesBRes.quotes.noAsk,
        noBid: quotesBRes.quotes.noBid,
        source: quotesBRes.source,
      },
    },
    live_required_legs: leg.requiredLegs || [],
    live_cost_drift: costDrift != null ? Number(costDrift.toFixed(6)) : null,
    live_recheck_at: new Date().toISOString(),
    live_price_drift_max: Number(maxYesDrift.toFixed(6)),
  };

  return { eligible: true, reason: 'ok', liveOpportunity };
}
