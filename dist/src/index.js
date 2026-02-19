import { config } from './util/config.js';
import { createLogger, setLogLevel } from './util/logger.js';
import { State } from './state.js';
import { getDb } from './db/supabase.js';
import { backfill } from './ingestion/backfill.js';
import { startEventSyncer } from './ingestion/syncer.js';
import { startPriceUpdater } from './ingestion/price-updater.js';
import { startTier0Detector } from './detection/tier0-price.js';
const log = createLogger('main');
async function main() {
    log.info('Alpha Scanner starting...');
    log.info(`Config: watchlist=${config.PRICE_WATCHLIST}, trigger=${config.PRICE_TRIGGER}`);
    if (process.env.LOG_LEVEL)
        setLogLevel(process.env.LOG_LEVEL);
    // Verify DB connection
    const db = getDb();
    const { count, error } = await db.from('events').select('*', { count: 'exact', head: true });
    if (error) {
        log.error('Cannot connect to Supabase', error.message);
        process.exit(1);
    }
    log.info(`Supabase connected. Existing events: ${count ?? 0}`);
    // Load persisted state
    const state = new State();
    state.load();
    // Phase 1: Backfill if needed
    if (!state.backfillComplete) {
        await backfill(state);
    }
    else {
        log.info(`Backfill already complete. ${state.knownEventIds.size} events, ${state.knownMarketIds.size} markets in memory`);
    }
    // Phase 2: Start polling loops
    startEventSyncer(state);
    startTier0Detector(state);
    startPriceUpdater(state);
    // Phase 3: Periodic state persistence
    setInterval(() => state.persist(), config.STATE_PERSIST_INTERVAL);
    // Phase 4: Status reporting
    setInterval(() => {
        const s = state.stats();
        const hot = [...state.hotMarkets.values()];
        const actionable = hot.filter(h => h.isActionable);
        log.info(`STATUS: events=${s.events} markets=${s.markets} hot=${s.hotMarkets} actionable=${actionable.length}`);
        if (hot.length > 0) {
            for (const h of hot) {
                const age = Math.floor((Date.now() - h.detectedAt) / 1000);
                log.info(`  HOT: ${h.question.slice(0, 80)} → ${h.detectedOutcome} (${h.confidence}%) price=$${h.currentPrice.toFixed(3)} profit=${h.profitPct.toFixed(1)}% age=${age}s actionable=${h.isActionable}`);
            }
        }
    }, config.STATUS_REPORT_INTERVAL);
    // Graceful shutdown
    const shutdown = () => {
        log.info('Shutting down...');
        state.persist();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    log.info('Alpha Scanner running. All loops started.');
}
main().catch(err => {
    log.error('Fatal error', err);
    process.exit(1);
});
