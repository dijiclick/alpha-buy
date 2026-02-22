import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { normalize } from '../util/normalize.js';
import { upsertEventsBatch, upsertMarketsBatch, closeStaleEvents } from '../db/supabase.js';
const log = createLogger('syncer');

export async function startEventSyncer(state) {
    log.info(`Event syncer started (full every ${config.SYNC_INTERVAL / 1000}s, quick every ${config.QUICK_SYNC_INTERVAL / 1000}s)`);

    // Full sync: paginate ALL events, close stale ones
    const runFull = async () => {
        try {
            await syncEvents(state, false);
        }
        catch (e) {
            log.error('Full sync cycle failed', e.message);
        }
    };

    // Quick sync: newest 50 events only (fast, no stale detection)
    const runQuick = async () => {
        try {
            await syncEvents(state, true);
        }
        catch (e) {
            log.error('Quick sync cycle failed', e.message);
        }
    };

    // Await first full sync so DB has fresh closed flags before agent starts
    await runFull();
    setInterval(runFull, config.SYNC_INTERVAL);
    // Quick sync every 5 min (offset by 30s to avoid collision with full)
    setTimeout(() => setInterval(runQuick, config.QUICK_SYNC_INTERVAL), 30_000);
}

async function syncEvents(state, quickMode) {
    const allGammaEventIds = new Set();
    let offset = 0;
    let newEvents = 0;
    let newMarkets = 0;
    let updatedMarkets = 0;
    let page = 0;
    let paginationComplete = false;
    const t0 = Date.now();

    while (true) {
        page++;
        // Quick mode: newest 200, one page only
        const limit = quickMode ? 200 : config.GAMMA_PAGE_SIZE;
        const orderParam = quickMode ? '&order=id&ascending=false' : '';
        const url = `${config.GAMMA_BASE}/events?exclude_tag_id=${config.CRYPTO_TAG_ID}&limit=${limit}&offset=${offset}&active=true&closed=false${orderParam}`;

        let events;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                log.warn(`Gamma API ${res.status} during sync (page ${page})`);
                break;
            }
            events = await res.json();
        }
        catch (e) {
            log.warn(`Gamma fetch failed (page ${page})`, e.message);
            break;
        }
        if (!events || events.length === 0) {
            paginationComplete = true;
            break;
        }

        // Batch: collect event rows and market rows per page
        const eventRows = [];
        const eventIdToMarkets = new Map(); // polymarket_event_id → [marketRow, ...]

        for (const event of events) {
            allGammaEventIds.add(event.id);

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
                    _eventPolymarketId: event.id, // temp: to assign event_id after batch upsert
                    _marketPolymarketId: mkt.id,   // temp: to track new/updated
                    _questionNorm: qNorm,           // temp: for state update
                });
            }
            eventIdToMarkets.set(event.id, marketRows);
        }

        // Batch upsert events → get DB IDs
        const eventIdMap = await upsertEventsBatch(eventRows);

        // Assign event_id FK to market rows, collect all for batch upsert
        const allMarketRows = [];
        for (const [polyEventId, marketRows] of eventIdToMarkets) {
            const dbEventId = eventIdMap.get(polyEventId);
            if (!dbEventId) continue;
            for (const mr of marketRows) {
                mr.event_id = dbEventId;
                // Remove temp fields before DB insert
                const { _eventPolymarketId, _marketPolymarketId, _questionNorm, ...clean } = mr;
                allMarketRows.push(clean);
            }
        }

        // Batch upsert markets
        await upsertMarketsBatch(allMarketRows);

        // Update in-memory state
        for (const event of events) {
            const isNew = !state.knownEventIds.has(event.id);
            if (isNew) {
                state.knownEventIds.add(event.id);
                newEvents++;
                log.info(`NEW EVENT: "${event.title}" (${event.markets?.length || 0} markets)`);
            }

            for (const mkt of event.markets || []) {
                const isNewMarket = !state.knownMarketIds.has(mkt.id);
                const qNorm = normalize(mkt.question);
                if (isNewMarket) {
                    state.knownMarketIds.add(mkt.id);
                    state.marketsByQuestion.set(qNorm, mkt.id);
                    newMarkets++;
                } else {
                    state.marketsByQuestion.set(qNorm, mkt.id);
                    updatedMarkets++;
                }

                // Build token→event cache for WebSocket
                const tokenIds = parseJsonSafe(mkt.clobTokenIds, null);
                if (Array.isArray(tokenIds) && tokenIds[0] && state.tokenToEventId) {
                    state.tokenToEventId.set(tokenIds[0], event.id);
                }
            }
        }

        // Quick mode: one page only
        if (quickMode) {
            paginationComplete = false; // don't close stale on quick sync
            break;
        }

        offset += events.length;
        if (events.length < config.GAMMA_PAGE_SIZE) {
            paginationComplete = true;
            break;
        }
        await sleep(200); // small delay between pages (reduced from 500ms)
    }

    // Only close stale events if we got ALL pages (avoid false positives on partial fetch)
    let closedCount = 0;
    if (!quickMode && paginationComplete && allGammaEventIds.size > 0) {
        closedCount = await closeStaleEvents(allGammaEventIds);
    }

    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const mode = quickMode ? 'Quick' : 'Full';
    if (newEvents > 0 || newMarkets > 0 || closedCount > 0 || !quickMode) {
        log.info(`${mode} sync: ${newEvents} new events, ${newMarkets} new markets, ${updatedMarkets} updated, ${closedCount} closed (${dur}s)`);
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
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
