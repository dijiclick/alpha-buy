import { spawn } from 'child_process';
import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getAllOpenEvents, getEventsByPolymarketIds, updateEventLastChecked, upsertEdgePrediction, insertTrade, updateTradeStatus } from '../db/supabase.js';
import { executeTrade, isTradingReady } from '../trading/executor.js';
const log = createLogger('agent');

// ─── Bridge pool (one process per session token) ───

const _bridges = [];
const DEFAULT_HOT_LOOP_INTERVAL_MS = 60_000;
const DEFAULT_HOT_LOOKBACK_MS = 20 * 60_000;

function readMsEnv(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const HOT_LOOP_INTERVAL_MS = readMsEnv('HOT_LOOP_INTERVAL_MS', DEFAULT_HOT_LOOP_INTERVAL_MS);
const HOT_LOOKBACK_MS = readMsEnv('HOT_LOOKBACK_MS', DEFAULT_HOT_LOOKBACK_MS);

function spawnBridge(token, index) {
    log.info(`Spawning bridge #${index}...`);

    // uv uses `uv run --script bridge.py --server`, others use `python3 bridge.py --server`
    const args = config.PYTHON_CMD === 'uv'
        ? ['run', '--script', config.PERPLEXITY_BRIDGE_PATH, '--server']
        : [config.PERPLEXITY_BRIDGE_PATH, '--server'];

    const child = spawn(config.PYTHON_CMD,
        args,
        {
            env: { ...process.env, PERPLEXITY_SESSION_TOKEN: token },
            stdio: ['pipe', 'pipe', 'pipe'],
        }
    );

    let buffer = '';
    const waiters = [];

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            const entry = waiters.shift();
            if (entry) {
                entry.resolve(line);
            }
        }
    });

    child.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (!msg) return;
        if (/RATE_LIMITED|SESSION_ERR|ERROR|FAILED/i.test(msg)) {
            log.warn(`Bridge#${index}: ${msg.slice(0, 500)}`);
        }
        // Skip verbose REQ/OK/STATS lines from bridge stderr
    });

    const b = {
        child,
        dead: false,
        index,

        query(input) {
            return new Promise((resolve, reject) => {
                if (this.dead) return reject(new Error(`Bridge#${index} is dead`));

                const entry = { done: false };

                entry.timer = setTimeout(() => {
                    if (entry.done) return;
                    entry.done = true;
                    const idx = waiters.indexOf(entry);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(`Bridge#${index} timeout (90s)`));
                }, 90_000);

                entry.resolve = (line) => {
                    if (entry.done) return;
                    entry.done = true;
                    clearTimeout(entry.timer);
                    resolve(line);
                };

                entry.reject = (err) => {
                    if (entry.done) return;
                    entry.done = true;
                    clearTimeout(entry.timer);
                    reject(err);
                };

                waiters.push(entry);
                child.stdin.write(JSON.stringify(input) + '\n');
            });
        },

        kill() {
            this.dead = true;
            child.kill();
        }
    };

    child.on('close', (code) => {
        log.warn(`Bridge#${index} exited (code ${code})`);
        b.dead = true;
        while (waiters.length) {
            const entry = waiters.shift();
            if (!entry.done) {
                entry.done = true;
                clearTimeout(entry.timer);
                entry.reject(new Error(`Bridge#${index} died (code ${code})`));
            }
        }
    });

    child.on('error', (e) => {
        log.warn(`Bridge#${index} spawn error: ${e.message}`);
        b.dead = true;
    });

    return b;
}

function getBridge(slotIndex) {
    const slot = _bridges[slotIndex];
    if (slot && slot.bridge && !slot.bridge.dead) return slot.bridge;

    const token = config.PERPLEXITY_SESSION_TOKENS[slotIndex];
    if (!token) return null;

    const bridge = spawnBridge(token, slotIndex);
    _bridges[slotIndex] = { bridge, token, index: slotIndex };
    return bridge;
}

// ─── Public entry points ───

export function startEdgeAgent(state) {
    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;
    log.info(`Edge agent started (cycle=${config.DETECTION_INTERVAL / 1000}s, hot=${HOT_LOOP_INTERVAL_MS / 1000}s, edge=${config.EDGE_THRESHOLD * 100}%, trade=$${config.TRADE_AMOUNT}, trading=${config.TRADING_ENABLED ? 'LIVE' : 'DRY RUN'}, ${concurrency} bridges)`);

    // Full scan cycle (hourly)
    let cycleRunning = false;
    const run = async () => {
        if (cycleRunning) {
            log.warn('Agent cycle still running, skipping this tick');
            return;
        }
        cycleRunning = true;
        try {
            await runAgentCycle(state);
        }
        catch (e) {
            log.error('Agent cycle failed', e.message);
        }
        finally {
            cycleRunning = false;
        }
    };
    run();
    setInterval(run, config.DETECTION_INTERVAL);

    // Hot loop: rechecks tracked events approaching end
    let hotRunning = false;
    const hot = async () => {
        if (hotRunning) return;
        hotRunning = true;
        try {
            await runHotLoop(state);
        } catch (e) {
            log.error('Hot loop failed', e.message);
        } finally {
            hotRunning = false;
        }
    };
    setTimeout(hot, Math.min(30_000, HOT_LOOP_INTERVAL_MS));
    setInterval(hot, HOT_LOOP_INTERVAL_MS);

    // Discovery scan: find events entering 24h horizon
    const DISCOVERY_INTERVAL = 15 * 60_000;
    const discover = async () => {
        try { await runDiscoveryScan(state); }
        catch (e) { log.error('Discovery scan failed', e.message); }
    };
    setTimeout(discover, 60_000);
    setInterval(discover, DISCOVERY_INTERVAL);
}

// Keep backward compat export name
export const startResolutionAgent = startEdgeAgent;

// Exported so websocket.js can trigger immediate checks
export async function checkAndProcessEvent(event, state) {
    return processEvent(event, state.trackedEvents.get(event.polymarket_event_id), 0, state, _counters);
}

const _counters = { newTracked: 0, rechecked: 0, edgesFound: 0 };

function sanitizeDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        const fixed = iso.replace(/02-29/, '02-28');
        const d2 = new Date(fixed);
        if (!isNaN(d2.getTime())) return fixed;
        return null;
    }
    return iso;
}

function toFiniteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function getYesPrice(market) {
    const directCandidates = [
        market.best_ask,
        market.last_trade_price,
        market.bestAsk,
        market.lastTradePrice,
        market.yes_price,
        market.yesPrice,
        market.yes,
    ];
    for (const val of directCandidates) {
        const n = toFiniteNumber(val);
        if (n !== null) return n;
    }

    let prices = market.outcome_prices;
    if (typeof prices === 'string') {
        try {
            prices = JSON.parse(prices);
        } catch {
            prices = null;
        }
    }

    if (Array.isArray(prices) && prices.length > 0) {
        const yesIdx = Array.isArray(market.outcomes)
            ? market.outcomes.findIndex(o => String(o).toLowerCase() === 'yes')
            : -1;
        const idx = yesIdx >= 0 ? yesIdx : 0;
        const n = toFiniteNumber(prices[idx]);
        if (n !== null) return n;
    }

    return null;
}

// ─── Agent cycle: scan all events ending within 24h ───

async function runAgentCycle(state) {
    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;

    const events = await getAllOpenEvents();

    const queue = [];
    let skippedResolved = 0;
    let skippedFuture = 0;
    let skippedNoEnd = 0;
    const now = Date.now();
    const horizon = config.END_DATE_HORIZON;

    for (const event of events) {
        if (event.closed || !event.markets || event.markets.length === 0)
            continue;

        const eventId = event.polymarket_event_id;

        if (state.resolvedEventIds.has(eventId)) {
            skippedResolved++;
            continue;
        }

        // Must have an end_date within 24h to be scanned
        if (!event.end_date) {
            skippedNoEnd++;
            continue;
        }
        const endTime = new Date(event.end_date).getTime();
        if (isNaN(endTime) || endTime - now > horizon) {
            skippedFuture++;
            continue;
        }

        const tracked = state.trackedEvents.get(eventId);

        if (!tracked) {
            // No price gate — all events within 24h are candidates
            queue.push({ event, tracked: null });
        }
        else if (now >= tracked.nextCheckAt) {
            queue.push({ event, tracked });
        }
    }

    if (queue.length === 0) {
        if (skippedFuture > 0 || skippedResolved > 0) {
            log.info(`Agent: nothing to check. ${skippedResolved} resolved, ${skippedFuture} future (>${Math.round(horizon / 3_600_000)}h), ${skippedNoEnd} no end_date`);
        }
        return;
    }

    // Priority sort: soonest-ending first
    queue.sort((a, b) => {
        const aEnd = a.event.end_date ? new Date(a.event.end_date).getTime() : Infinity;
        const bEnd = b.event.end_date ? new Date(b.event.end_date).getTime() : Infinity;
        return aEnd - bEnd;
    });

    // Batch Gamma pre-flight: filter out already-closed events
    const gammaResults = new Map();
    const GAMMA_BATCH = 20;
    for (let i = 0; i < queue.length; i += GAMMA_BATCH) {
        const batch = queue.slice(i, i + GAMMA_BATCH);
        const results = await Promise.allSettled(batch.map(async ({ event }) => {
            const mkt = event.markets?.[0];
            if (!mkt?.polymarket_market_id) return { id: event.polymarket_event_id, closed: false };
            try {
                const res = await fetch(`${config.GAMMA_BASE}/markets/${mkt.polymarket_market_id}`);
                if (res.ok) {
                    const live = await res.json();
                    return { id: event.polymarket_event_id, closed: !!live.closed };
                }
                return { id: event.polymarket_event_id, closed: null };
            } catch {
                return { id: event.polymarket_event_id, closed: null };
            }
        }));
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                gammaResults.set(r.value.id, r.value.closed);
            }
        }
    }

    let gammaFiltered = 0;
    const filteredQueue = queue.filter(({ event }) => {
        const closed = gammaResults.get(event.polymarket_event_id);
        if (closed === true) {
            state.resolvedEventIds.set(event.polymarket_event_id, Date.now());
            gammaFiltered++;
            return false;
        }
        return true;
    });
    queue.length = 0;
    queue.push(...filteredQueue);

    log.info(`Agent: ${queue.length} to check (${gammaFiltered} pre-filtered closed), ${skippedResolved} resolved, ${skippedFuture} future, ${concurrency} bridges`);

    const counters = { newTracked: 0, rechecked: 0, edgesFound: 0 };

    // Reserve slot 0 for WebSocket triggers; agent workers use slots 1+
    const reserveSlotForWS = concurrency >= 2;
    const workerStart = reserveSlotForWS ? 1 : 0;
    const workerCount = reserveSlotForWS ? concurrency - 1 : concurrency;

    async function worker(slotIndex) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            try {
                await processEvent(item.event, item.tracked, slotIndex, state, counters, { skipGammaPreflight: true });
            } catch (e) {
                log.error(`Worker#${slotIndex} processEvent error: ${e.message}`);
            }
        }
        log.info(`Worker#${slotIndex} finished (queue empty)`);
    }

    await Promise.all(
        Array.from({ length: Math.min(workerCount, queue.length) }, (_, i) => worker(i + workerStart))
    );

    const total = state.trackedEvents.size;
    if (total > 0 || counters.edgesFound > 0 || counters.newTracked > 0) {
        log.info(`Agent: ${counters.newTracked} new, ${counters.rechecked} re-checked, ${counters.edgesFound} edges found, ${total} tracking`);
    }
}

// ─── Hot loop: recheck tracked events approaching/past end ───

async function runHotLoop(state) {
    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;
    const now = Date.now();

    const hotEventIds = [];
    for (const [eventId, tracked] of state.trackedEvents) {
        if (!tracked.estimatedEndMin) continue;
        const endTime = new Date(tracked.estimatedEndMin).getTime();
        if (isNaN(endTime)) continue;
        const nextCheckAt = Number.isFinite(Number(tracked.nextCheckAt))
            ? Number(tracked.nextCheckAt)
            : now;
        if (now < nextCheckAt) continue;
        const elapsed = now - endTime;
        if (elapsed > 0 && elapsed <= HOT_LOOKBACK_MS) {
            hotEventIds.push(eventId);
        }
    }

    if (hotEventIds.length === 0) return;

    const events = await getEventsByPolymarketIds(hotEventIds);
    const eventMap = new Map(events.map(e => [e.polymarket_event_id, e]));

    const queue = [];
    for (const eventId of hotEventIds) {
        const event = eventMap.get(eventId);
        if (!event || !event.markets?.length) continue;
        if (state.resolvedEventIds.has(eventId)) continue;
        const tracked = state.trackedEvents.get(eventId);
        queue.push({ event, tracked });
    }

    if (queue.length === 0) return;

    queue.sort((a, b) => {
        const aEnd = new Date(a.tracked.estimatedEndMin).getTime();
        const bEnd = new Date(b.tracked.estimatedEndMin).getTime();
        return bEnd - aEnd;
    });

    log.info(`Hot: ${queue.length} events near/past end (rechecking for edge)`);

    const counters = { newTracked: 0, rechecked: 0, edgesFound: 0 };

    const reserveSlotForWS = concurrency >= 2;
    const workerStart = reserveSlotForWS ? 1 : 0;
    const workerCount = reserveSlotForWS ? concurrency - 1 : concurrency;

    async function worker(slotIndex) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            try {
                await processEvent(item.event, item.tracked, slotIndex, state, counters);
            } catch (e) {
                log.error(`Hot#${slotIndex} error: ${e.message}`);
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(workerCount, queue.length) }, (_, i) => worker(i + workerStart))
    );

    if (counters.edgesFound > 0 || counters.rechecked > 0) {
        log.info(`Hot: ${counters.rechecked} re-checked, ${counters.edgesFound} edges found`);
    }
}

// ─── Discovery scan: track events entering 24h horizon ───

async function runDiscoveryScan(state) {
    const events = await getAllOpenEvents();
    const now = Date.now();
    const horizon = config.END_DATE_HORIZON;
    const newEvents = [];

    for (const event of events) {
        if (event.closed || !event.markets?.length) continue;
        const eventId = event.polymarket_event_id;
        if (state.resolvedEventIds.has(eventId)) continue;
        if (state.trackedEvents.has(eventId)) continue;

        if (!event.end_date) continue;
        const endTime = new Date(event.end_date).getTime();
        if (isNaN(endTime) || endTime - now > horizon) continue;

        state.trackedEvents.set(eventId, {
            eventId,
            title: event.title,
            marketCount: event.markets.length,
            estimatedEndMin: event.end_date,
            estimatedEndMax: null,
            lastChecked: 0,
            checkCount: 0,
            postEndCheckCount: 0,
            nextCheckAt: calculateNextCheck(event.end_date, 0),
        });
        newEvents.push(event);
    }

    if (newEvents.length === 0) return;

    log.info(`Discovery: ${newEvents.length} new events entering 24h horizon (${state.trackedEvents.size} total tracked)`);

    newEvents.sort((a, b) => {
        const aEnd = new Date(a.end_date).getTime();
        const bEnd = new Date(b.end_date).getTime();
        return aEnd - bEnd;
    });

    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;
    const reserveSlotForWS = concurrency >= 2;
    const workerStart = reserveSlotForWS ? 1 : 0;
    const workerCount = reserveSlotForWS ? concurrency - 1 : concurrency;

    if (workerCount <= 0) {
        log.warn('Discovery: no bridge slots available (all reserved for WS)');
        return;
    }

    const queue = newEvents.map(event => ({
        event,
        tracked: state.trackedEvents.get(event.polymarket_event_id),
    }));

    const counters = { newTracked: 0, rechecked: 0, edgesFound: 0 };

    async function worker(slotIndex) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            try {
                await processEvent(item.event, item.tracked, slotIndex, state, counters);
            } catch (e) {
                log.error(`Discovery#${slotIndex} error: ${e.message}`);
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(workerCount, queue.length) }, (_, i) => worker(i + workerStart))
    );

    if (counters.edgesFound > 0 || counters.rechecked > 0) {
        log.info(`Discovery: ${counters.rechecked} checked, ${counters.edgesFound} edges found`);
    }
}

// ─── Event processing: probability estimation + edge detection ───

async function processEvent(event, tracked, slotIndex, state, counters, { skipGammaPreflight = false } = {}) {
    const eventId = event.polymarket_event_id;

    // Pre-flight: skip if already closed on Polymarket
    if (!skipGammaPreflight) {
        const firstMarket = event.markets?.[0];
        if (firstMarket?.polymarket_market_id) {
            try {
                const gmRes = await fetch(`${config.GAMMA_BASE}/markets/${firstMarket.polymarket_market_id}`);
                if (gmRes.ok) {
                    const live = await gmRes.json();
                    if (live.closed) {
                        log.info(`SKIP (closed on PM): "${event.title.slice(0, 60)}"`);
                        state.resolvedEventIds.set(eventId, Date.now());
                        return;
                    }
                } else {
                    log.warn(`Gamma API ${gmRes.status} for "${event.title.slice(0, 60)}", skipping`);
                    return;
                }
            } catch (e) {
                log.warn(`Gamma pre-flight failed for "${event.title.slice(0, 60)}": ${e.message}, skipping`);
                return;
            }
        }
    }

    const result = await checkEventWithPerplexity(event, slotIndex);
    if (!result) return;

    await updateEventLastChecked(eventId);

    // If event is already resolved, mark it and skip edge detection
    if (result.resolved) {
        state.resolvedEventIds.set(eventId, Date.now());
        state.trackedEvents.delete(eventId);
        log.info(`RESOLVED: "${event.title.slice(0, 60)}" — ${result.reasoning}`);
        return;
    }

    // Edge detection for each market
    for (const mktResult of result.markets) {
        const market = event.markets[mktResult.index];
        if (!market) continue;

        const yesPrice = getYesPrice(market);
        if (yesPrice === null || yesPrice <= 0 || yesPrice >= 1) continue;

        const noPrice = 1 - yesPrice;
        const aiProbYes = mktResult.probabilityYes / 100;
        const aiProbNo = 1 - aiProbYes;

        // Check both sides for edge
        const yesEdge = aiProbYes - yesPrice;   // positive = YES is underpriced
        const noEdge = aiProbNo - noPrice;       // positive = NO is underpriced

        // Store prediction in DB regardless of edge
        try {
            await upsertEdgePrediction({
                event_id: eventId,
                event_title: event.title,
                event_slug: event.slug,
                event_end_date: event.end_date,
                market_id: market.polymarket_market_id,
                market_question: market.question,
                predicted_outcome: aiProbYes >= 0.5 ? 'yes' : 'no',
                probability: mktResult.probabilityYes,
                reasoning: result.reasoning,
                yes_price: yesPrice,
                no_price: noPrice,
                divergence: Math.max(yesEdge, noEdge),
            });
        } catch (e) {
            log.warn(`Failed to upsert edge prediction: ${e.message}`);
        }

        // Check for actionable edge
        if (yesEdge >= config.EDGE_THRESHOLD && mktResult.confidence >= config.MIN_CONFIDENCE) {
            await handleEdgeTrade(event, market, 'YES', yesPrice, aiProbYes, yesEdge, mktResult, result, state);
            counters.edgesFound++;
        } else if (noEdge >= config.EDGE_THRESHOLD && mktResult.confidence >= config.MIN_CONFIDENCE) {
            await handleEdgeTrade(event, market, 'NO', noPrice, aiProbNo, noEdge, mktResult, result, state);
            counters.edgesFound++;
        }
    }

    // Update tracking
    const endDateISO = event.end_date;
    const checkCount = tracked ? tracked.checkCount + 1 : 1;

    if (!tracked) {
        const nextCheck = calculateNextCheck(endDateISO, 0);
        state.trackedEvents.set(eventId, {
            eventId,
            title: event.title,
            marketCount: event.markets.length,
            estimatedEndMin: endDateISO,
            estimatedEndMax: null,
            lastChecked: Date.now(),
            checkCount: 1,
            postEndCheckCount: 0,
            nextCheckAt: nextCheck,
        });
        counters.newTracked++;
    } else {
        tracked.lastChecked = Date.now();
        tracked.checkCount = checkCount;
        const endTime = tracked.estimatedEndMin ? new Date(tracked.estimatedEndMin).getTime() : NaN;
        if (!isNaN(endTime) && endTime <= Date.now()) {
            tracked.postEndCheckCount = (tracked.postEndCheckCount || 0) + 1;
        } else {
            tracked.postEndCheckCount = 0;
        }
        tracked.nextCheckAt = calculateNextCheck(tracked.estimatedEndMin, tracked.postEndCheckCount || 0);
        counters.rechecked++;
    }
}

// ─── Edge trade handler ───

async function handleEdgeTrade(event, market, side, buyPrice, aiProb, edge, mktResult, result, state) {
    const tradeAmount = config.TRADE_AMOUNT;
    const shares = tradeAmount / buyPrice;

    log.info(`EDGE FOUND: "${market.question.slice(0, 60)}" → ${side} @ ${buyPrice.toFixed(3)}, AI=${(aiProb * 100).toFixed(0)}%, edge=${(edge * 100).toFixed(1)}%, conf=${mktResult.confidence}%`);

    // Check if we already have an open trade on this market+side
    // (avoid duplicate buys on rechecks)
    const existingKey = `${market.polymarket_market_id}_${side}`;
    if (state.activePositions?.has(existingKey)) {
        log.info(`SKIP TRADE (already have position): ${existingKey}`);
        return;
    }

    // Determine token ID
    let tokenIds = market.clob_token_ids;
    if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = []; }
    }
    const tokenId = side === 'YES' ? tokenIds?.[0] : tokenIds?.[1];

    // Record trade intent in DB
    let tradeRecord;
    try {
        tradeRecord = await insertTrade({
            event_id: event.polymarket_event_id,
            market_id: market.polymarket_market_id,
            market_question: market.question,
            side,
            token_id: tokenId || null,
            buy_price: buyPrice,
            shares,
            amount_usd: tradeAmount,
            ai_probability: aiProb,
            edge_pct: edge * 100,
            confidence: mktResult.confidence,
            reasoning: result.reasoning,
            status: 'pending',
        });
    } catch (e) {
        log.error(`Failed to record trade: ${e.message}`);
        return;
    }

    const tradeId = tradeRecord?.id || tradeRecord?.[0]?.id;

    // Execute trade or dry-run
    if (isTradingReady()) {
        try {
            const orderResult = await executeTrade(market, side, tradeAmount, buyPrice);
            if (tradeId) await updateTradeStatus(tradeId, 'filled', { order_id: orderResult?.orderID, fill_price: buyPrice });

            // Track position for auto-redeem
            if (state.activePositions) {
                state.activePositions.set(existingKey, { side, shares, buyPrice, tradeId, eventId: event.polymarket_event_id });
            }

            await sendTradeNotification(event, market, side, buyPrice, aiProb, edge, shares, 'EXECUTED', result.reasoning);
        } catch (e) {
            log.error(`Trade execution failed: ${e.message}`);
            if (tradeId) await updateTradeStatus(tradeId, 'failed', { reasoning: e.message });
            await sendTradeNotification(event, market, side, buyPrice, aiProb, edge, shares, 'FAILED', e.message);
        }
    } else {
        if (tradeId) await updateTradeStatus(tradeId, 'dry_run', {});
        await sendTradeNotification(event, market, side, buyPrice, aiProb, edge, shares, 'DRY RUN', result.reasoning);
    }
}

// ─── Scheduling ───

function calculateNextCheck(estimatedEndISO, postEndCheckCount = 0) {
    if (!estimatedEndISO) return Date.now() + config.DETECTION_INTERVAL;

    const endTime = new Date(estimatedEndISO).getTime();
    const now = Date.now();
    const remaining = endTime - now;

    if (remaining > 0) {
        if (remaining > 12 * 3600000) return now + 4 * 3600000;    // >12h: every 4h
        if (remaining > 6 * 3600000) return now + 2 * 3600000;     // 6-12h: every 2h
        if (remaining > 2 * 3600000) return now + 1 * 3600000;     // 2-6h: every 1h
        if (remaining > 30 * 60000) return now + 30 * 60000;       // 30min-2h: every 30min
        return now + 15 * 60000;                                     // <30min: every 15min
    }

    // Past end: escalating backoff then stop
    const POST_INTERVALS = [5 * 60000, 15 * 60000, 60 * 60000];
    const idx = Math.min(Math.max(postEndCheckCount - 1, 0), POST_INTERVALS.length - 1);
    return now + POST_INTERVALS[idx];
}

// ─── Perplexity bridge ───

async function checkEventWithPerplexity(event, slotIndex) {
    const bridge = getBridge(slotIndex);
    if (!bridge) {
        log.warn(`No bridge available for slot ${slotIndex}`);
        return null;
    }

    try {
        const MAX_MARKETS = 15;
        const markets = event.markets.length > MAX_MARKETS
            ? event.markets.slice(0, MAX_MARKETS)
            : event.markets;
        const input = {
            mode: 'event',
            event_title: event.title,
            event_description: (event.description || '').slice(0, 500),
            end_date: event.end_date || '',
            market_questions: markets.map(m => m.question),
            market_descriptions: markets.map(m => (m.description || '').slice(0, 200)),
            market_prices: markets.map(m => getYesPrice(m)),
        };

        const line = await bridge.query(input);
        const parsed = JSON.parse(line);

        if (parsed.error) {
            log.warn(`Perplexity error (bridge#${slotIndex}): ${parsed.error}`);
            return null;
        }

        const marketResults = Array.isArray(parsed.markets)
            ? parsed.markets.map(m => ({
                index: (m.market || 1) - 1,
                probabilityYes: Number(m.probability_yes) || 50,
                confidence: Number(m.confidence) || 0,
            }))
            : [];

        return {
            resolved: parsed.resolved === true,
            markets: marketResults,
            reasoning: parsed.reasoning || '',
            source: 'perplexity',
        };
    }
    catch (e) {
        log.warn(`Perplexity check failed (bridge#${slotIndex}) for "${event.title.slice(0, 60)}"`, e.message);
        if (_bridges[slotIndex]?.bridge?.dead) _bridges[slotIndex] = null;
        return null;
    }
}

// ─── Prices ───

function parseTokenIds(market) {
    const raw = typeof market.clob_token_ids === 'string'
        ? JSON.parse(market.clob_token_ids)
        : market.clob_token_ids || [];
    return raw.length >= 2 ? raw : null;
}

export async function fetchPrices(market) {
    try {
        let bookResult = null;
        const tokenIds = parseTokenIds(market);

        if (tokenIds) {
            const [yesBook, noBook] = await Promise.all([
                fetch(`${config.CLOB_BASE}/book?token_id=${tokenIds[0]}`).then(r => r.json()),
                fetch(`${config.CLOB_BASE}/book?token_id=${tokenIds[1]}`).then(r => r.json()),
            ]);
            const yesBid = yesBook.bids?.[0]?.price;
            const yesAsk = yesBook.asks?.[0]?.price;
            if (yesBid || yesAsk) {
                const bid = parseFloat(yesBid) || 0;
                const ask = parseFloat(yesAsk) || 1;
                const spread = ask - bid;
                if (spread < 0.20) {
                    return {
                        type: 'book',
                        yesBid: yesBid || '—', yesAsk: yesAsk || '—',
                        noBid: noBook.bids?.[0]?.price || '—', noAsk: noBook.asks?.[0]?.price || '—',
                    };
                }
                bookResult = {
                    type: 'book',
                    yesBid: yesBid || '—', yesAsk: yesAsk || '—',
                    noBid: noBook.bids?.[0]?.price || '—', noAsk: noBook.asks?.[0]?.price || '—',
                };
            }
        }

        if (market.polymarket_market_id) {
            const res = await fetch(`${config.GAMMA_BASE}/markets/${market.polymarket_market_id}`);
            if (res.ok) {
                const gm = await res.json();
                const op = typeof gm.outcomePrices === 'string' ? JSON.parse(gm.outcomePrices) : gm.outcomePrices;
                if (op?.length >= 2) {
                    return { type: 'price', yes: Number(op[0]).toFixed(2), no: Number(op[1]).toFixed(2) };
                }
            }
        }

        if (bookResult) return bookResult;

        const stored = typeof market.outcome_prices === 'string'
            ? JSON.parse(market.outcome_prices) : market.outcome_prices;
        if (stored?.length >= 2) {
            return { type: 'stored', yes: Number(stored[0]).toFixed(2), no: Number(stored[1]).toFixed(2) };
        }

        return null;
    } catch (e) {
        log.warn(`Failed to fetch prices for "${market.question?.slice(0, 40)}"`, e.message);
        return null;
    }
}

// ─── Telegram notifications ───

function formatDate(iso) {
    if (!iso) return null;
    try {
        const d = new Date(iso);
        if (isNaN(d)) return iso;
        const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'America/New_York' });
        const day = d.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/New_York' });
        const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
        return `${mon} ${day}, ${time} ET`;
    } catch { return iso; }
}

async function sendTradeNotification(event, market, side, buyPrice, aiProb, edge, shares, status, detail) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

    const icon = status === 'EXECUTED' ? '💰' : status === 'DRY RUN' ? '👀' : '❌';
    const eventUrl = `https://polymarket.com/event/${event.slug || ''}`;
    const marketUrl = `https://polymarket.com/event/${event.slug || ''}/${market.slug || ''}`;

    const lines = [
        `${icon} <b>EDGE ${status}</b>`,
        '',
        `<b>${event.title}</b>`,
        `${market.question?.slice(0, 80)}`,
        '',
        `📊 Buy <b>${side}</b> @ ${buyPrice.toFixed(3)}`,
        `🤖 AI Probability: ${(aiProb * 100).toFixed(0)}%`,
        `📈 Edge: ${(edge * 100).toFixed(1)}%`,
        `💵 ${shares.toFixed(1)} shares ($${config.TRADE_AMOUNT})`,
    ];

    if (event.end_date) {
        const fDate = formatDate(event.end_date);
        if (fDate) lines.push(`📅 Ends: ${fDate}`);
    }

    if (detail) {
        lines.push(`💡 <i>${String(detail).slice(0, 100)}</i>`);
    }

    lines.push('');
    lines.push(`<a href="${eventUrl}">Event</a>  ·  <a href="${marketUrl}">Market</a>`);

    try {
        const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.TELEGRAM_CHAT_ID,
                text: lines.join('\n'),
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            log.warn(`Telegram send failed: ${res.status} ${body.slice(0, 200)}`);
        }
    } catch (e) {
        log.warn('Telegram send error', e.message);
    }
}

export async function sendRedeemNotification(event, market, side, won, pnl) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

    const icon = won ? '🏆' : '📉';
    const lines = [
        `${icon} <b>SETTLED: ${won ? 'WIN' : 'LOSS'}</b>`,
        '',
        `<b>${event?.title || 'Unknown event'}</b>`,
        `${market?.question?.slice(0, 80) || ''}`,
        '',
        `Side: <b>${side}</b>`,
        `P&L: <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</b>`,
    ];

    try {
        await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.TELEGRAM_CHAT_ID,
                text: lines.join('\n'),
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });
    } catch (e) {
        log.warn('Telegram redeem notification error', e.message);
    }
}
