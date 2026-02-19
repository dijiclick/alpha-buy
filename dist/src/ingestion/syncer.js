import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { normalize } from '../util/normalize.js';
import { upsertEvent, upsertMarket } from '../db/supabase.js';
const log = createLogger('syncer');
export function startEventSyncer(state) {
    log.info(`Event syncer started (every ${config.SYNC_INTERVAL / 1000}s)`);
    const run = async () => {
        try {
            await syncEvents(state);
        }
        catch (e) {
            log.error('Sync cycle failed', e.message);
        }
    };
    // Run immediately, then on interval
    run();
    setInterval(run, config.SYNC_INTERVAL);
}
async function syncEvents(state) {
    // Fetch newest events (sorted by id desc, latest first)
    const url = `${config.GAMMA_BASE}/events?exclude_tag_id=${config.CRYPTO_TAG_ID}&order=id&ascending=false&limit=100&active=true&closed=false`;
    const res = await fetch(url);
    if (!res.ok) {
        log.warn(`Gamma API ${res.status} during sync`);
        return;
    }
    const events = await res.json();
    if (!events || events.length === 0)
        return;
    let newEvents = 0;
    let newMarkets = 0;
    let updatedMarkets = 0;
    for (const event of events) {
        const isNew = !state.knownEventIds.has(event.id);
        const eventRow = {
            polymarket_event_id: event.id,
            title: event.title,
            description: event.description,
            slug: event.slug,
            tags: event.tags || [],
            image: event.image,
            start_date: event.startDate || null,
            end_date: event.endDate || null,
            neg_risk: event.negRisk || false,
            neg_risk_market_id: event.negRiskMarketID || null,
            active: event.active ?? true,
            closed: event.closed ?? false,
            markets_count: event.markets?.length || 0,
            total_volume: event.volume || 0,
        };
        const eventDbId = await upsertEvent(eventRow);
        if (!eventDbId)
            continue;
        if (isNew) {
            state.knownEventIds.add(event.id);
            newEvents++;
            log.info(`NEW EVENT: "${event.title}" (${event.markets?.length || 0} markets)`);
        }
        for (const mkt of event.markets || []) {
            const isNewMarket = !state.knownMarketIds.has(mkt.id);
            const qNorm = normalize(mkt.question);
            const marketRow = {
                event_id: eventDbId,
                polymarket_market_id: mkt.id,
                condition_id: mkt.conditionId,
                question_id: mkt.questionID,
                question: mkt.question,
                question_normalized: qNorm,
                description: mkt.description,
                slug: mkt.slug,
                outcomes: parseJsonSafe(mkt.outcomes, ['Yes', 'No']),
                outcome_prices: parseJsonSafe(mkt.outcomePrices, null),
                clob_token_ids: parseJsonSafe(mkt.clobTokenIds, null),
                best_ask: mkt.bestAsk,
                last_trade_price: mkt.lastTradePrice,
                spread: mkt.spread,
                volume: mkt.volume || 0,
                volume_clob: mkt.volumeClob || 0,
                volume_1d: mkt.volume24hr || 0,
                volume_1wk: mkt.volume1wk || 0,
                volume_1mo: mkt.volume1mo || 0,
                one_day_price_change: mkt.oneDayPriceChange,
                end_date: mkt.endDate || null,
                resolution_source: mkt.resolutionSource,
                resolved_by: mkt.resolvedBy,
                active: mkt.active ?? true,
                closed: mkt.closed ?? false,
                accepting_orders: mkt.acceptingOrders ?? true,
                neg_risk: mkt.negRisk ?? false,
                automatically_resolved: mkt.automaticallyResolved ?? false,
            };
            await upsertMarket(marketRow);
            if (isNewMarket) {
                state.knownMarketIds.add(mkt.id);
                state.marketsByQuestion.set(qNorm, mkt.id);
                newMarkets++;
                log.info(`  NEW MARKET: "${mkt.question.slice(0, 100)}"`);
            }
            else {
                state.marketsByQuestion.set(qNorm, mkt.id);
                updatedMarkets++;
            }
        }
    }
    if (newEvents > 0 || newMarkets > 0) {
        log.info(`Sync: ${newEvents} new events, ${newMarkets} new markets, ${updatedMarkets} updated`);
    }
}
function parseJsonSafe(str, fallback) {
    if (!str)
        return fallback;
    try {
        return JSON.parse(str);
    }
    catch {
        return fallback;
    }
}
//# sourceMappingURL=syncer.js.map