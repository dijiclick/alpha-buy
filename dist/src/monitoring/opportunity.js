import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { normalize } from '../util/normalize.js';
import { upsertOutcome, getMarketDbId } from '../db/supabase.js';
const log = createLogger('opportunity');
export async function processDetectedOutcome(state, market, result) {
    const marketId = market.polymarket_market_id;
    const dbId = market.id || await getMarketDbId(marketId);
    if (!dbId) {
        log.error(`Cannot find DB id for market ${marketId}`);
        return;
    }
    const winningPrice = getWinningPrice(market, result.outcome);
    const profitPct = winningPrice < 1 ? ((1 - winningPrice) / winningPrice) * 100 : 0;
    const isActionable = checkActionability(market);
    // Write to outcomes
    await upsertOutcome({
        market_id: dbId,
        detected_outcome: result.outcome,
        confidence: result.confidence,
        detection_tier: result.tier,
        detection_source: result.source,
        detection_data: result.rawData,
        detected_at: new Date().toISOString(),
        winning_price_at_detection: winningPrice,
        potential_profit_pct: profitPct,
        is_opportunity: true,
        is_actionable: isActionable,
    });
    // Get winning token ID for CLOB price tracking
    const clobTokenId = getWinningTokenId(market, result.outcome);
    // Add to hot markets
    state.hotMarkets.set(marketId, {
        marketId,
        question: market.question,
        questionNorm: normalize(market.question),
        detectedOutcome: result.outcome,
        confidence: result.confidence,
        detectedAt: Date.now(),
        winningPrice,
        currentPrice: winningPrice,
        profitPct,
        isActionable,
        eventId: market.event_id?.toString() || '',
        clobTokenId: clobTokenId || '',
    });
    log.info(`OPPORTUNITY: "${market.question.slice(0, 80)}" → ${result.outcome} (${result.confidence}%) price=$${winningPrice.toFixed(3)} profit=${profitPct.toFixed(1)}% actionable=${isActionable}`);
}
function checkActionability(market) {
    return ((market.volume_1d || 0) > config.MIN_DAILY_VOLUME &&
        (market.best_ask || 1) < config.MAX_BEST_ASK &&
        (market.spread || 1) < config.MAX_SPREAD &&
        market.accepting_orders !== false);
}
function getWinningPrice(market, outcome) {
    const prices = (market.outcome_prices || []).map(Number);
    const outcomes = market.outcomes || ['Yes', 'No'];
    // Find index of winning outcome
    const idx = outcomes.findIndex((o) => o.toLowerCase() === outcome.toLowerCase());
    if (idx >= 0 && idx < prices.length)
        return prices[idx];
    // Fallback: return the highest price
    return Math.max(...prices.filter((n) => !isNaN(n)), 0);
}
function getWinningTokenId(market, outcome) {
    const tokenIds = market.clob_token_ids || [];
    const outcomes = market.outcomes || ['Yes', 'No'];
    const idx = outcomes.findIndex((o) => o.toLowerCase() === outcome.toLowerCase());
    if (idx >= 0 && idx < tokenIds.length)
        return tokenIds[idx];
    return tokenIds[0] || null;
}
