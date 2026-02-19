import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createLogger } from './util/logger.js';
const log = createLogger('state');
const STATE_FILE = 'state.json';
export class State {
    hotMarkets = new Map();
    knownEventIds = new Set();
    knownMarketIds = new Set();
    marketsByQuestion = new Map(); // normalizedQuestion → marketId
    backfillComplete = false;
    load() {
        if (!existsSync(STATE_FILE)) {
            log.info('No state.json found, starting fresh');
            return;
        }
        try {
            const raw = readFileSync(STATE_FILE, 'utf-8');
            const data = JSON.parse(raw);
            this.backfillComplete = data.backfillComplete || false;
            for (const id of data.knownEventIds || [])
                this.knownEventIds.add(id);
            for (const id of data.knownMarketIds || [])
                this.knownMarketIds.add(id);
            for (const [q, id] of data.marketsByQuestion || [])
                this.marketsByQuestion.set(q, id);
            log.info(`State loaded: ${this.knownEventIds.size} events, ${this.knownMarketIds.size} markets, backfill=${this.backfillComplete}`);
        }
        catch (e) {
            log.error('Failed to load state.json', e.message);
        }
    }
    persist() {
        try {
            const data = {
                backfillComplete: this.backfillComplete,
                knownEventIds: [...this.knownEventIds],
                knownMarketIds: [...this.knownMarketIds],
                marketsByQuestion: [...this.marketsByQuestion.entries()],
            };
            writeFileSync(STATE_FILE, JSON.stringify(data));
            log.debug(`State persisted: ${this.knownEventIds.size} events, ${this.knownMarketIds.size} markets`);
        }
        catch (e) {
            log.error('Failed to persist state', e.message);
        }
    }
    stats() {
        return {
            events: this.knownEventIds.size,
            markets: this.knownMarketIds.size,
            hotMarkets: this.hotMarkets.size,
        };
    }
}
