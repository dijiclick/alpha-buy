import { config } from './util/config.js';
import { createLogger, setLogLevel } from './util/logger.js';
import { State } from './state.js';
import { getDb } from './db/supabase.js';
import { backfill } from './ingestion/backfill.js';
import { startEventSyncer } from './ingestion/syncer.js';
import { startResolutionAgent } from './detection/agent.js';
import { startPriceStream, stopPriceStream } from './detection/websocket.js';
const log = createLogger('main');
async function main() {
    log.info('Alpha Scanner starting...');
    log.info(`Config: confidence=${config.MIN_CONFIDENCE}`);
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
    // Phase 3: Start resolution agent
    startResolutionAgent(state);
    // Phase 3b: Start real-time price stream (WebSocket)
    startPriceStream(state);
    // Phase 4: Periodic state persistence
    setInterval(() => state.persist(), config.STATE_PERSIST_INTERVAL);
    // Phase 5: Status reporting
    setInterval(() => {
        const s = state.stats();
        log.info(`STATUS: events=${s.events} markets=${s.markets} tracked=${s.tracked}`);
        if (state.trackedEvents.size > 0) {
            for (const [, t] of state.trackedEvents) {
                const next = t.nextCheckAt ? new Date(t.nextCheckAt).toISOString() : 'unknown';
                log.info(`  TRACKING: "${t.title.slice(0, 70)}" (${t.marketCount} mkts) checks=${t.checkCount} next=${next}`);
            }
        }
    }, config.STATUS_REPORT_INTERVAL);
    // Graceful shutdown
    const shutdown = () => {
        log.info('Shutting down...');
        stopPriceStream();
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
