import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { normalize } from '../util/normalize.js';
import { upsertEventsBatch, upsertMarketsBatch } from '../db/supabase.js';
const log = createLogger('backfill');
export async function backfill(state) {
    log.info('Starting backfill of all non-crypto events...');
    let offset = 0;
    let totalEvents = 0;
    let totalMarkets = 0;
    let page = 0;
    while (true) {
        page++;
        const url = `${config.GAMMA_BASE}/events?exclude_tag_id=${config.CRYPTO_TAG_ID}&limit=${config.GAMMA_PAGE_SIZE}&offset=${offset}&active=true&closed=false`;
        let events;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                log.error(`Gamma API ${res.status} at offset ${offset}`);
                break;
            }
            events = await res.json();
        }
        catch (e) {
            log.error(`Gamma fetch failed at offset ${offset}`, e.message);
            break;
        }
        if (!events || events.length === 0) {
            log.info(`Backfill page ${page}: empty response, done.`);
            break;
        }
        log.info(`Backfill page ${page}: ${events.length} events (offset ${offset})`);
        // Collect event rows and market rows per page (same pattern as syncer)
        const eventRows = [];
        const eventIdToMarkets = new Map();
        for (const event of events) {
            // Skip blocked tag categories (e.g. soccer)
            const tags = event.tags || [];
            if (tags.some(t => config.BLOCKED_TAG_SLUGS.has(t.slug))) continue;

            eventRows.push({
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
            });
            const marketRows = [];
            for (const mkt of event.markets || []) {
                const qNorm = normalize(mkt.question);
                marketRows.push({
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
                    active: mkt.active ?? true,
                    closed: mkt.closed ?? false,
                    accepting_orders: mkt.acceptingOrders ?? true,
                    neg_risk: mkt.negRisk ?? false,
                });
            }
            eventIdToMarkets.set(event.id, marketRows);
        }
        // Batch upsert events → get DB IDs
        const eventIdMap = await upsertEventsBatch(eventRows);
        // Assign event_id FK to market rows
        const allMarketRows = [];
        for (const [polyEventId, marketRows] of eventIdToMarkets) {
            const dbEventId = eventIdMap.get(polyEventId);
            if (!dbEventId) continue;
            for (const mr of marketRows) {
                mr.event_id = dbEventId;
                allMarketRows.push(mr);
            }
        }
        // Batch upsert markets
        await upsertMarketsBatch(allMarketRows);
        // Update in-memory state
        for (const event of events) {
            if ((event.tags || []).some(t => config.BLOCKED_TAG_SLUGS.has(t.slug))) continue;
            state.knownEventIds.add(event.id);
            totalEvents++;
            for (const mkt of event.markets || []) {
                const qNorm = normalize(mkt.question);
                state.knownMarketIds.add(mkt.id);
                state.marketsByQuestion.set(qNorm, mkt.id);
                totalMarkets++;
                // Build token→event cache for WebSocket
                const tokenIds = parseJsonSafe(mkt.clobTokenIds, null);
                if (Array.isArray(tokenIds) && tokenIds[0] && state.tokenToEventId) {
                    state.tokenToEventId.set(tokenIds[0], event.id);
                }
            }
        }
        offset += events.length;
        await sleep(200);
    }
    state.backfillComplete = true;
    state.persist();
    log.info(`Backfill complete: ${totalEvents} events, ${totalMarkets} markets, ${state.tokenToEventId?.size || 0} tokens cached`);
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
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
//# sourceMappingURL=backfill.js.map