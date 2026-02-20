import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from './config.js';
import { createLogger, setLogLevel } from './logger.js';
import { computeEventStatus, computeMarketStatus, isSettled } from './status.js';
import { upsertEvent, upsertMarket, verifyConnection, getCounts } from './db.js';
const log = createLogger('main');
const STATE_FILE = 'sync-state.json';
function loadState() {
    if (!existsSync(STATE_FILE))
        return { backfillComplete: false, backfillOffset: 0, lastSyncedEventId: null };
    try {
        const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        return { ...s, lastSyncedEventId: s.lastSyncedEventId || null };
    }
    catch {
        return { backfillComplete: false, backfillOffset: 0, lastSyncedEventId: null };
    }
}
function saveState(state) {
    writeFileSync(STATE_FILE, JSON.stringify(state));
}
// --- Helpers ---
function parseJson(str, fallback) {
    if (!str)
        return fallback;
    try {
        return JSON.parse(str);
    }
    catch {
        return fallback;
    }
}
function normalize(text) {
    return text.toLowerCase().replace(/[\u2018\u2019\u201C\u201D]/g, "'").replace(/\s+/g, ' ').replace(/[^\w\s'.\-]/g, '').trim();
}
function categoryFromTags(tags) {
    if (!tags || tags.length === 0)
        return 'other';
    const slugs = tags.map(t => t.slug || '');
    if (slugs.some(s => ['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'mma', 'tennis', 'sports'].includes(s)))
        return 'sports';
    if (slugs.some(s => ['politics', 'elections'].includes(s)))
        return 'politics';
    return tags[0]?.label?.toLowerCase() || 'other';
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
// --- Process Events ---
async function processEvents(events) {
    let newEvents = 0, newMarkets = 0, skippedSettled = 0;
    for (const event of events) {
        const eventRow = {
            polymarket_event_id: event.id,
            title: event.title,
            description: event.description,
            slug: event.slug,
            category: categoryFromTags(event.tags),
            tags: event.tags || [],
            image: event.image,
            start_date: event.startDate || null,
            end_date: event.endDate || null,
            status: computeEventStatus(event),
            active: event.active ?? true,
            closed: event.closed ?? false,
            neg_risk: event.negRisk || false,
            neg_risk_market_id: event.negRiskMarketID || null,
            markets_count: event.markets?.length || 0,
            total_volume: event.volume || 0,
        };
        const eventDbId = await upsertEvent(eventRow);
        if (!eventDbId)
            continue;
        newEvents++;
        for (const mkt of event.markets || []) {
            if (isSettled(mkt)) {
                skippedSettled++;
                continue;
            }
            const marketRow = {
                event_id: eventDbId,
                polymarket_market_id: mkt.id,
                condition_id: mkt.conditionId,
                question_id: mkt.questionID,
                question: mkt.question,
                question_normalized: normalize(mkt.question),
                description: mkt.description,
                slug: mkt.slug,
                outcomes: parseJson(mkt.outcomes, ['Yes', 'No']),
                outcome_prices: parseJson(mkt.outcomePrices, null),
                clob_token_ids: parseJson(mkt.clobTokenIds, null),
                best_ask: mkt.bestAsk,
                last_trade_price: mkt.lastTradePrice,
                spread: mkt.spread,
                volume: mkt.volume || 0,
                volume_1d: mkt.volume24hr || 0,
                one_day_price_change: mkt.oneDayPriceChange,
                end_date: mkt.endDate || null,
                resolution_source: mkt.resolutionSource,
                custom_liveness: mkt.customLiveness || 7200,
                uma_resolution_statuses: mkt.umaResolutionStatuses || [],
                resolved_by: mkt.resolvedBy,
                status: computeMarketStatus(mkt),
                active: mkt.active ?? true,
                closed: mkt.closed ?? false,
                accepting_orders: mkt.acceptingOrders ?? true,
                neg_risk: mkt.negRisk ?? false,
                automatically_resolved: mkt.automaticallyResolved ?? false,
            };
            const marketDbId = await upsertMarket(marketRow);
            if (marketDbId)
                newMarkets++;
        }
    }
    return { newEvents, newMarkets, skippedSettled };
}
// --- Backfill (one-time, only if never done) ---
async function backfill(state) {
    log.info(`Starting backfill from offset ${state.backfillOffset}...`);
    let offset = state.backfillOffset;
    let page = 0;
    let totalEvents = 0, totalMarkets = 0;
    let maxEventId = null;
    while (true) {
        page++;
        const url = `${config.GAMMA_BASE}/events?exclude_tag_id=${config.CRYPTO_TAG_ID}&closed=false&limit=${config.PAGE_SIZE}&offset=${offset}`;
        let events;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                log.error(`Gamma ${res.status} at offset ${offset}`);
                break;
            }
            events = await res.json();
        }
        catch (e) {
            log.error(`Gamma fetch failed at offset ${offset}`, e.message);
            break;
        }
        if (!events || events.length === 0) {
            log.info(`Backfill done at page ${page} (empty response)`);
            break;
        }
        for (const e of events) {
            if (!maxEventId || parseInt(e.id) > parseInt(maxEventId)) {
                maxEventId = e.id;
            }
        }
        const result = await processEvents(events);
        totalEvents += result.newEvents;
        totalMarkets += result.newMarkets;
        log.info(`Backfill page ${page}: ${events.length} events -> ${result.newEvents} upserted, ${result.newMarkets} markets, ${result.skippedSettled} settled skipped (offset ${offset})`);
        offset += events.length;
        state.backfillOffset = offset;
        saveState(state);
        await sleep(config.BACKFILL_DELAY);
    }
    state.backfillComplete = true;
    if (maxEventId) {
        state.lastSyncedEventId = maxEventId;
        log.info(`Watermark set from backfill: ${maxEventId}`);
    }
    saveState(state);
    log.info(`Backfill complete: ${totalEvents} events, ${totalMarkets} markets`);
}
// --- Incremental Sync (only fetches NEW events with closed=false) ---
async function syncRecent(state) {
    const watermark = state.lastSyncedEventId;
    if (!watermark) {
        log.warn('No watermark set, skipping sync (run backfill first)');
        return;
    }
    let offset = 0;
    let newMaxId = watermark;
    let totalResult = { newEvents: 0, newMarkets: 0, skippedSettled: 0 };
    let pages = 0;

    while (true) {
        pages++;
        const url = `${config.GAMMA_BASE}/events?exclude_tag_id=${config.CRYPTO_TAG_ID}&closed=false&order=id&ascending=false&limit=100&offset=${offset}`;
        let events;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                log.warn(`Gamma ${res.status} during sync`);
                break;
            }
            events = await res.json();
        }
        catch (e) {
            log.error('Sync fetch failed', e.message);
            break;
        }
        if (!events || events.length === 0) break;

        // Track highest ID seen
        for (const e of events) {
            if (parseInt(e.id) > parseInt(newMaxId)) {
                newMaxId = e.id;
            }
        }

        // Only process events newer than watermark
        const newEvents = events.filter(e => parseInt(e.id) > parseInt(watermark));
        if (newEvents.length > 0) {
            const result = await processEvents(newEvents);
            totalResult.newEvents += result.newEvents;
            totalResult.newMarkets += result.newMarkets;
            totalResult.skippedSettled += result.skippedSettled;
        }

        // If oldest event on this page is at or below watermark, we caught up
        const oldestId = parseInt(events[events.length - 1].id);
        if (oldestId <= parseInt(watermark)) {
            break;
        }

        offset += events.length;
        await sleep(500);

        // Safety: max 50 pages (5000 events) per sync
        if (pages >= 50) {
            log.warn(`Sync hit 50-page safety limit at offset ${offset}`);
            break;
        }
    }

    // Update watermark
    if (parseInt(newMaxId) > parseInt(watermark)) {
        state.lastSyncedEventId = newMaxId;
        saveState(state);
    }

    log.info(`Sync done: ${totalResult.newEvents} new events, ${totalResult.newMarkets} new markets (${pages} pages, watermark: ${state.lastSyncedEventId})`);
}
// --- Main ---
async function main() {
    log.info('Metadata Syncer starting...');
    if (process.env.LOG_LEVEL)
        setLogLevel(process.env.LOG_LEVEL);
    const existingCount = await verifyConnection();
    log.info(`Supabase connected. Existing events: ${existingCount}`);
    const state = loadState();
    log.info(`State: backfill=${state.backfillComplete}, watermark=${state.lastSyncedEventId}`);
    // Backfill if never done
    if (!state.backfillComplete) {
        await backfill(state);
    }
    else {
        log.info('Backfill already complete, skipping');
    }
    // Start sync loop — only fetches NEW open events every 3 hours
    log.info(`Sync every ${config.SYNC_INTERVAL / 1000 / 60 / 60}h (watermark: ${state.lastSyncedEventId})`);
    setInterval(() => syncRecent(state), config.SYNC_INTERVAL);
    // Status report every minute
    setInterval(async () => {
        const counts = await getCounts();
        log.info(`STATUS: events=${counts.events} markets=${counts.markets} watermark=${state.lastSyncedEventId}`);
    }, config.REPORT_INTERVAL);
    // State persistence every minute
    setInterval(() => saveState(state), config.PERSIST_INTERVAL);
    // Graceful shutdown
    const shutdown = () => {
        log.info('Shutting down...');
        saveState(state);
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // Run first sync immediately to catch anything since last run
    syncRecent(state);
    log.info('Metadata Syncer running.');
}
main().catch(err => {
    log.error('Fatal error', err);
    process.exit(1);
});
