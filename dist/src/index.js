import { config } from './util/config.js';
import { createLogger, setLogLevel } from './util/logger.js';
import { State } from './state.js';
import { getDb } from './db/supabase.js';
import { backfill } from './ingestion/backfill.js';
import { startEventSyncer } from './ingestion/syncer.js';
import { startEdgeAgent } from './detection/agent.js';
import { startPriceStream, stopPriceStream } from './detection/websocket.js';
import { initTrading } from './trading/executor.js';
import { startRedeemMonitor } from './trading/redeemer.js';
const log = createLogger('main');
async function main() {
    log.info('Edge Scanner starting...');
    log.info(`Config: edge=${config.EDGE_THRESHOLD * 100}% confidence=${config.MIN_CONFIDENCE} trade=$${config.TRADE_AMOUNT} trading=${config.TRADING_ENABLED ? 'LIVE' : 'DRY RUN'}`);
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
    // Phase 2: Start polling loops (await first full sync to clean stale events)
    await startEventSyncer(state);
    // Phase 3a: Initialize trading client (optional, graceful if credentials missing)
    await initTrading();
    // Phase 3b: Start edge detection agent
    startEdgeAgent(state);
    // Phase 3c: Start real-time WebSocket (for settlement detection)
    startPriceStream(state);
    // Phase 3d: Start auto-redeem monitor
    startRedeemMonitor(state);
    // Phase 4: Periodic state persistence
    setInterval(() => state.persist(), config.STATE_PERSIST_INTERVAL);
    // Phase 5: Status reporting
    setInterval(() => {
        const s = state.stats();
        log.info(`STATUS: events=${s.events} markets=${s.markets} tracked=${s.tracked} resolved=${s.resolved} positions=${state.activePositions.size}`);
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
    log.info('Edge Scanner running. All loops started.');
}
main().catch(err => {
    log.error('Fatal error', err);
    process.exit(1);
});
