import { spawn } from 'child_process';
import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getAllOpenEvents, getEventsByPolymarketIds, updateEventLastChecked, upsertEdgePrediction, insertTrade, updateTradeStatus } from '../db/supabase.js';
import { executeTrade, isTradingReady } from '../trading/executor.js';
const log = createLogger('agent');

// ─── MCP Bridge (single Rust perplexity-web-api-mcp process) ───

let _mcpBridge = null;
const DEFAULT_HOT_LOOP_INTERVAL_MS = 60_000;
const DEFAULT_HOT_LOOKBACK_MS = 20 * 60_000;

function readMsEnv(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const HOT_LOOP_INTERVAL_MS = readMsEnv('HOT_LOOP_INTERVAL_MS', DEFAULT_HOT_LOOP_INTERVAL_MS);
const HOT_LOOKBACK_MS = readMsEnv('HOT_LOOKBACK_MS', DEFAULT_HOT_LOOKBACK_MS);

function spawnMcpBridge() {
    log.info('Spawning MCP Perplexity bridge...');

    const child = spawn(config.PERPLEXITY_MCP_PATH, [], {
        env: {
            ...process.env,
            PERPLEXITY_SESSION_TOKEN: config.PERPLEXITY_SESSION_TOKENS[0],
            PERPLEXITY_CSRF_TOKEN: config.PERPLEXITY_CSRF_TOKENS[0] || '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    const pending = new Map(); // id → { resolve, reject, timer }
    let nextId = 1;
    let initialized = false;
    let initResolve = null;
    const initPromise = new Promise(r => { initResolve = r; });

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id != null && pending.has(msg.id)) {
                    const entry = pending.get(msg.id);
                    pending.delete(msg.id);
                    clearTimeout(entry.timer);
                    if (msg.error) {
                        entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    } else {
                        entry.resolve(msg.result);
                    }
                }
            } catch (e) {
                log.warn(`MCP bridge: failed to parse response: ${line.slice(0, 200)}`);
            }
        }
    });

    child.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (!msg) return;
        if (/error|warn|fail/i.test(msg)) {
            log.warn(`MCP bridge: ${msg.slice(0, 500)}`);
        }
    });

    const bridge = {
        child,
        dead: false,
        ready: initPromise,

        _send(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                if (this.dead) return reject(new Error('MCP bridge is dead'));
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`MCP bridge timeout (120s) for ${method}`));
                }, 120_000);
                pending.set(id, { resolve, reject, timer });
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
        },

        _notify(method, params = {}) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
        },

        async callTool(name, args) {
            await this.ready;
            const result = await this._send('tools/call', { name, arguments: args });
            // MCP tool results have content array: [{type: "text", text: "..."}]
            if (result?.content) {
                return result.content.map(c => c.text || '').join('\n');
            }
            return typeof result === 'string' ? result : JSON.stringify(result);
        },

        kill() {
            this.dead = true;
            for (const [id, entry] of pending) {
                clearTimeout(entry.timer);
                entry.reject(new Error('MCP bridge killed'));
            }
            pending.clear();
            child.kill();
        }
    };

    child.on('close', (code) => {
        log.warn(`MCP bridge exited (code ${code})`);
        bridge.dead = true;
        for (const [id, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`MCP bridge died (code ${code})`));
        }
        pending.clear();
        if (_mcpBridge === bridge) _mcpBridge = null;
    });

    child.on('error', (e) => {
        log.warn(`MCP bridge spawn error: ${e.message}`);
        bridge.dead = true;
        if (_mcpBridge === bridge) _mcpBridge = null;
    });

    // MCP handshake
    bridge._send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'polyedge', version: '1.0' },
    }).then(() => {
        bridge._notify('notifications/initialized');
        initialized = true;
        initResolve();
        log.info('MCP bridge initialized');
    }).catch(e => {
        log.error(`MCP bridge init failed: ${e.message}`);
        bridge.dead = true;
        initResolve(); // unblock waiters so they fail on dead check
    });

    return bridge;
}

function getBridge() {
    if (_mcpBridge && !_mcpBridge.dead) return _mcpBridge;
    _mcpBridge = spawnMcpBridge();
    return _mcpBridge;
}

// ─── Public entry points ───

export function startEdgeAgent(state) {
    log.info(`Edge agent started (cycle=${config.DETECTION_INTERVAL / 1000}s, hot=${HOT_LOOP_INTERVAL_MS / 1000}s, edge=${config.EDGE_THRESHOLD * 100}%, trade=$${config.TRADE_AMOUNT}, trading=${config.TRADING_ENABLED ? 'LIVE' : 'DRY RUN'}, MCP bridge)`);

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
    return processEvent(event, state.trackedEvents.get(event.polymarket_event_id), state, _counters);
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

    log.info(`Agent: ${queue.length} to check (${gammaFiltered} pre-filtered closed), ${skippedResolved} resolved, ${skippedFuture} future`);

    const counters = { newTracked: 0, rechecked: 0, edgesFound: 0 };

    // Use a single bridge (slot 0) — Perplexity limits concurrent sessions per account
    for (const item of queue) {
        try {
            await processEvent(item.event, item.tracked, state, counters, { skipGammaPreflight: true });
        } catch (e) {
            log.error(`processEvent error: ${e.message}`);
        }
    }
    log.info(`Worker finished (${queue.length} processed)`);

    const total = state.trackedEvents.size;
    if (total > 0 || counters.edgesFound > 0 || counters.newTracked > 0) {
        log.info(`Agent: ${counters.newTracked} new, ${counters.rechecked} re-checked, ${counters.edgesFound} edges found, ${total} tracking`);
    }
}

// ─── Hot loop: recheck tracked events approaching/past end ───

async function runHotLoop(state) {
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

    for (const item of queue) {
        try {
            await processEvent(item.event, item.tracked, state, counters);
        } catch (e) {
            log.error(`Hot error: ${e.message}`);
        }
    }

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

    const counters = { newTracked: 0, rechecked: 0, edgesFound: 0 };

    for (const event of newEvents) {
        const tracked = state.trackedEvents.get(event.polymarket_event_id);
        try {
            await processEvent(event, tracked, state, counters);
        } catch (e) {
            log.error(`Discovery error: ${e.message}`);
        }
    }

    if (counters.edgesFound > 0 || counters.rechecked > 0) {
        log.info(`Discovery: ${counters.rechecked} checked, ${counters.edgesFound} edges found`);
    }
}

// ─── Event processing: probability estimation + edge detection ───

async function processEvent(event, tracked, state, counters, { skipGammaPreflight = false } = {}) {
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

    const result = await checkEventWithPerplexity(event);
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

// ─── Perplexity MCP bridge ───

function buildEventPrompt(event, markets) {
    const today = new Date().toISOString().slice(0, 10);
    const title = event.title || '';
    const desc = (event.description || '').slice(0, 500);
    const endDate = event.end_date || '';

    const mqLines = markets.map((m, i) => {
        const price = getYesPrice(m);
        const priceInfo = price != null ? ` [Current market YES price: ${price}]` : '';
        let line = `  ${i + 1}. ${m.question}${priceInfo}`;
        if (m.description) line += `\n     Resolution rules: ${m.description.slice(0, 500)}`;
        return line;
    }).join('\n');

    return `Today is ${today}.

I need you to estimate the PROBABILITY of each market outcome based on current real-world evidence. This is for a prediction market event ending soon.

Event: ${title}
Description: ${desc || '(none)'}
Scheduled end: ${endDate || '(none)'}

Markets:
${mqLines}

Search for the LATEST news, official statements, data, polls, expert analysis, and any relevant information about this event.

Rules:
- For EACH market, estimate probability_yes (0-100): the percentage chance that YES wins.
- Base your estimate on CONCRETE evidence: official statements, polls, expert analysis, historical patterns, recent developments.
- Be well-calibrated: 50 = true toss-up, 80+ = strong evidence, 95+ = near-certain.
- If the event is ALREADY officially resolved, set resolved=true and probability_yes to 100 (YES won) or 0 (NO won).
- confidence (0-100) = how confident you are in your probability estimate. High confidence means strong evidence exists.
- DO NOT simply echo the market price. Form your OWN independent estimate from the evidence you find.

CRITICAL formatting rules:
- reasoning: cite SPECIFIC evidence (max 30 words). E.g. "Reuters reports bill passed Senate 52-48" or "Latest polls show 65% support, committee approved unanimously"

Respond with ONLY raw JSON, no markdown fences:
{"resolved":false,"markets":[{"market":1,"probability_yes":0-100,"confidence":0-100},...], "reasoning":"cite specific evidence, max 30 words"}`;
}

function parsePerplexityResponse(text) {
    // MCP bridge returns JSON with { answer, web_results, ... }
    // The answer field contains our actual response (possibly with [1][2] citation markers)
    let answer = text;
    try {
        const outer = JSON.parse(text);
        if (outer.answer) answer = outer.answer;
    } catch {
        // Not wrapped JSON — use text directly
    }

    // Strip markdown fences
    if (answer.includes('```json')) answer = answer.split('```json')[1];
    if (answer.includes('```')) answer = answer.split('```')[0];
    answer = answer.trim();

    // Find the first { and last } to extract JSON (ignoring trailing citation markers like [1][2])
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in response');
    return JSON.parse(answer.slice(start, end + 1));
}

async function checkEventWithPerplexity(event) {
    const bridge = getBridge();
    if (!bridge || bridge.dead) {
        log.warn('No MCP bridge available');
        return null;
    }

    try {
        const MAX_MARKETS = 15;
        const markets = event.markets.length > MAX_MARKETS
            ? event.markets.slice(0, MAX_MARKETS)
            : event.markets;

        const prompt = buildEventPrompt(event, markets);

        const responseText = await bridge.callTool('perplexity_search', { query: prompt });
        const parsed = parsePerplexityResponse(responseText);

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
        log.warn(`Perplexity check failed for "${event.title.slice(0, 60)}": ${e.message}`);
        if (bridge.dead) _mcpBridge = null;
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
