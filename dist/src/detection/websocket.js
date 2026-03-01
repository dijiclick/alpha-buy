import WebSocket from 'ws';
import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getAllActiveTokenIds, getEventsByPolymarketIds } from '../db/supabase.js';
import { checkAndProcessEvent } from './agent.js';
import { handleMarketResolution } from '../trading/redeemer.js';
const log = createLogger('ws');

let _ws = null;
let _pingInterval = null;
let _refreshInterval = null;
let _subscribedIds = new Set();
let _recentChecks = new Map();  // tokenId → timestamp of last check
const CHECK_COOLDOWN = 5 * 60 * 1000;  // Don't re-check same market within 5 min

export function startPriceStream(state) {
    log.info('Starting CLOB WebSocket price stream...');
    connect(state);

    // Refresh subscriptions every 10 min (new markets may have been synced)
    _refreshInterval = setInterval(() => refreshSubscriptions(), 10 * 60 * 1000);
}

function connect(state) {
    if (_ws) {
        try { _ws.close(); } catch {}
    }

    _ws = new WebSocket(config.CLOB_WS);

    _ws.on('open', async () => {
        log.info('WebSocket connected');
        await subscribeAll();
        // PING every 10s to keep alive
        _pingInterval = setInterval(() => {
            if (_ws?.readyState === WebSocket.OPEN) {
                _ws.send('PING');
            }
        }, 10_000);
    });

    _ws.on('message', (raw) => {
        const msg = raw.toString();
        if (msg === 'PONG') return;

        try {
            const data = JSON.parse(msg);
            handleMessage(data, state);
        } catch {
            // Ignore unparseable messages
        }
    });

    _ws.on('close', (code) => {
        log.warn(`WebSocket closed (code ${code}), reconnecting in 5s...`);
        cleanup();
        setTimeout(() => connect(state), 5_000);
    });

    _ws.on('error', (e) => {
        log.warn(`WebSocket error: ${e.message}`);
    });
}

function cleanup() {
    if (_pingInterval) {
        clearInterval(_pingInterval);
        _pingInterval = null;
    }
}

async function subscribeAll() {
    const tokenIds = await getAllActiveTokenIds();
    if (tokenIds.length === 0) {
        log.info('No active token IDs to subscribe to');
        return;
    }

    // WebSocket might have limits on subscription size, batch in chunks
    const batchSize = 500;
    for (let i = 0; i < tokenIds.length; i += batchSize) {
        const batch = tokenIds.slice(i, i + batchSize);
        const sub = {
            assets_ids: batch,
            type: 'market',
            custom_feature_enabled: true,
        };
        if (_ws?.readyState === WebSocket.OPEN) {
            _ws.send(JSON.stringify(sub));
        }
        batch.forEach(id => _subscribedIds.add(id));
    }

    log.info(`Subscribed to ${tokenIds.length} YES tokens (${Math.ceil(tokenIds.length / batchSize)} batches)`);
}

async function refreshSubscriptions() {
    const tokenIds = await getAllActiveTokenIds();
    const newIds = tokenIds.filter(id => !_subscribedIds.has(id));
    if (newIds.length === 0) return;

    const batchSize = 500;
    for (let i = 0; i < newIds.length; i += batchSize) {
        const batch = newIds.slice(i, i + batchSize);
        const sub = {
            assets_ids: batch,
            type: 'market',
            custom_feature_enabled: true,
        };
        if (_ws?.readyState === WebSocket.OPEN) {
            _ws.send(JSON.stringify(sub));
        }
        batch.forEach(id => _subscribedIds.add(id));
    }

    log.info(`Subscribed to ${newIds.length} new tokens`);
}

async function handleMessage(data, state) {
    const eventType = data.event_type;

    if (eventType === 'market_resolved') {
        log.info(`WS RESOLVED: "${data.question?.slice(0, 60)}" → ${data.winning_outcome}`);

        // Trigger auto-redeem for any open positions on this market
        try {
            await handleMarketResolution(data, state);
        } catch (e) {
            log.warn(`WS auto-redeem failed: ${e.message}`);
        }

        // Also trigger edge check (market may still be tradable briefly)
        await triggerCheck(data.assets_ids?.[0], state, 'resolved');
        return;
    }

    // Price changes are handled by the scheduled scanner — no spike triggers needed
}

async function triggerCheck(tokenId, state, reason) {
    if (!tokenId) return;

    // Bypass cooldown for market_resolved — most authoritative signal
    const isResolved = reason === 'resolved';
    if (!isResolved) {
        const lastCheck = _recentChecks.get(tokenId);
        if (lastCheck && Date.now() - lastCheck < CHECK_COOLDOWN) return;
    }
    _recentChecks.set(tokenId, Date.now());

    // Clean old entries from cooldown map
    if (_recentChecks.size > 10000) {
        const cutoff = Date.now() - CHECK_COOLDOWN;
        for (const [k, v] of _recentChecks) {
            if (v < cutoff) _recentChecks.delete(k);
        }
    }

    try {
        // Fast path: in-memory cache (O(1) vs DB LIKE scan)
        const eventId = state.tokenToEventId?.get(tokenId);
        if (!eventId) return;

        const events = await getEventsByPolymarketIds([eventId]);
        const event = events[0];
        if (!event || !event.markets || event.markets.length === 0) return;

        log.info(`WS TRIGGER [${reason}]: "${event.title.slice(0, 60)}" — checking with Perplexity`);
        await checkAndProcessEvent(event, state);
    } catch (e) {
        log.warn(`WS trigger check failed: ${e.message}`);
    }
}

export function stopPriceStream() {
    if (_refreshInterval) {
        clearInterval(_refreshInterval);
        _refreshInterval = null;
    }
    cleanup();
    if (_ws) {
        try { _ws.close(); } catch {}
        _ws = null;
    }
    log.info('WebSocket stopped');
}
