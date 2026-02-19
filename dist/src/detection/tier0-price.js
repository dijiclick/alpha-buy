import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getActiveMarkets } from '../db/supabase.js';
import { checkPerplexity } from './tier2-perplexity.js';
import { processDetectedOutcome } from '../monitoring/opportunity.js';
const log = createLogger('tier0');
// Track markets we've already attempted detection on (avoid re-querying)
const detectionAttempted = new Map(); // marketId → lastAttemptTs
const RETRY_INTERVAL = 5 * 60 * 1000; // retry every 5 min
export function startTier0Detector(state) {
    log.info(`Tier 0 price detector started (every ${config.DETECTION_INTERVAL / 1000}s)`);
    setInterval(async () => {
        try {
            await detectOutcomes(state);
        }
        catch (e) {
            log.error('Detection cycle failed', e.message);
        }
    }, config.DETECTION_INTERVAL);
}
async function detectOutcomes(state) {
    const markets = await getActiveMarkets();
    let watchlist = 0;
    let triggered = 0;
    for (const mkt of markets) {
        // Skip if already have outcome detected
        if (state.hotMarkets.has(mkt.polymarket_market_id))
            continue;
        // Skip if already resolved/closed
        if (mkt.closed)
            continue;
        // Parse prices
        const prices = (mkt.outcome_prices || []).map(Number).filter((n) => !isNaN(n));
        if (prices.length === 0)
            continue;
        const maxPrice = Math.max(...prices);
        if (maxPrice < config.PRICE_WATCHLIST)
            continue;
        watchlist++;
        // Check if recently attempted
        const lastAttempt = detectionAttempted.get(mkt.polymarket_market_id) || 0;
        if (Date.now() - lastAttempt < RETRY_INTERVAL)
            continue;
        if (maxPrice >= config.PRICE_TRIGGER) {
            triggered++;
            detectionAttempted.set(mkt.polymarket_market_id, Date.now());
            const result = await tryPerplexity(mkt);
            if (result && result.resolved && result.confidence >= config.MIN_CONFIDENCE) {
                log.info(`DETECTED: "${mkt.question.slice(0, 80)}" → ${result.outcome} (${result.confidence}%) via ${result.source} price=$${maxPrice}`);
                await processDetectedOutcome(state, mkt, {
                    outcome: result.outcome,
                    confidence: result.confidence,
                    tier: 'tier2',
                    source: result.source,
                    rawData: null,
                });
            }
        }
    }
    if (watchlist > 0) {
        log.debug(`Detection: ${watchlist} on watchlist (>=${config.PRICE_WATCHLIST}), ${triggered} triggered (>=${config.PRICE_TRIGGER})`);
    }
}
async function tryPerplexity(mkt) {
    if (!config.PERPLEXITY_API_KEY)
        return null;
    try {
        return await checkPerplexity(mkt.question, mkt.description || '');
    }
    catch (e) {
        log.warn(`Perplexity check failed for "${mkt.question.slice(0, 60)}"`, e.message);
        return null;
    }
}
