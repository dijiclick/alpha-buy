import { spawn } from 'child_process';
import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getHighPriceEvents, getEventsByPolymarketIds, upsertOutcome } from '../db/supabase.js';
const log = createLogger('agent');

// ─── Bridge pool (one process per session token) ───

const _bridges = [];

function spawnBridge(token, index) {
    log.info(`Spawning bridge #${index}...`);

    const child = spawn(config.PYTHON_CMD,
        ['run', '--script', config.PERPLEXITY_BRIDGE_PATH, '--server'],
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

export function startResolutionAgent(state) {
    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;
    log.info(`Resolution agent started (every ${config.DETECTION_INTERVAL / 1000}s, ${concurrency} bridges, price_threshold=${config.PRICE_SPIKE_THRESHOLD})`);

    // Full discovery scan (hourly)
    const run = async () => {
        try {
            await runAgentCycle(state);
        }
        catch (e) {
            log.error('Agent cycle failed', e.message);
        }
    };
    run();
    setInterval(run, config.DETECTION_INTERVAL);

    // Hot loop: check events ending NOW every 2 min
    let hotRunning = false;
    const hot = async () => {
        if (hotRunning) return; // skip if previous hot loop still running
        hotRunning = true;
        try {
            await runHotLoop(state);
        } catch (e) {
            log.error('Hot loop failed', e.message);
        } finally {
            hotRunning = false;
        }
    };
    setTimeout(hot, 30_000); // first hot run 30s after start
    setInterval(hot, 2 * 60_000);
}

// Exported so websocket.js can trigger immediate checks
let _wsSlot = 0;
export async function checkAndProcessEvent(event, state) {
    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;
    const slot = _wsSlot % concurrency;
    _wsSlot++;
    return processEvent(event, state.trackedEvents.get(event.polymarket_event_id), slot, state, _counters);
}

const _counters = { newTracked: 0, rechecked: 0, resolved: 0 };

async function runAgentCycle(state) {
    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;

    // Price-first filter: only events with a market priced ≥ threshold
    const events = await getHighPriceEvents(config.PRICE_SPIKE_THRESHOLD);

    // Build work queue
    const queue = [];
    let skippedResolved = 0;
    let skippedFuture = 0;
    const now = Date.now();
    const horizon = config.END_DATE_HORIZON;

    for (const event of events) {
        if (event.closed || !event.markets || event.markets.length === 0)
            continue;

        const eventId = event.polymarket_event_id;

        // Skip events we already know are resolved
        if (state.resolvedEventIds.has(eventId)) {
            skippedResolved++;
            continue;
        }

        // Skip events whose end_date is far in the future (not ending soon)
        if (event.end_date) {
            const endTime = new Date(event.end_date).getTime();
            if (!isNaN(endTime) && endTime - now > horizon) {
                skippedFuture++;
                continue;
            }
        }

        const tracked = state.trackedEvents.get(eventId);

        if (!tracked) {
            queue.push({ event, tracked: null });
        }
        else if (now >= tracked.nextCheckAt) {
            queue.push({ event, tracked });
        }
    }

    if (queue.length === 0) {
        if (skippedFuture > 0 || skippedResolved > 0) {
            log.info(`Agent: nothing to check. ${skippedResolved} resolved, ${skippedFuture} future (>${Math.round(horizon / 3_600_000)}h away)`);
        }
        return;
    }

    log.info(`Agent: ${queue.length} to check (≥${config.PRICE_SPIKE_THRESHOLD}), ${skippedResolved} resolved, ${skippedFuture} future, ${concurrency} bridges`);

    const counters = { newTracked: 0, rechecked: 0, resolved: 0 };

    // Worker function: each worker owns one bridge slot
    async function worker(slotIndex) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            try {
                await processEvent(item.event, item.tracked, slotIndex, state, counters);
            } catch (e) {
                log.error(`Worker#${slotIndex} processEvent error: ${e.message}`);
            }
        }
        log.info(`Worker#${slotIndex} finished (queue empty)`);
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, (_, i) => worker(i))
    );

    const total = state.trackedEvents.size;
    if (total > 0 || counters.resolved > 0 || counters.newTracked > 0) {
        log.info(`Agent: ${counters.newTracked} new, ${counters.rechecked} re-checked, ${counters.resolved} resolved, ${total} tracking`);
    }
}

// ─── Hot loop: events ending NOW (every 2 min) ───
// Uses Perplexity's estimatedEndMin (precise) instead of Polymarket's end_date (imprecise)

async function runHotLoop(state) {
    const concurrency = config.PERPLEXITY_SESSION_TOKENS.length;
    const now = Date.now();
    const HOT_LOOKBACK = 20 * 60_000;  // 20min ago

    // Scan tracked events for those whose estimatedEndMin has PASSED (only check after it ends)
    const hotEventIds = [];
    for (const [eventId, tracked] of state.trackedEvents) {
        if (!tracked.estimatedEndMin) continue;
        const endTime = new Date(tracked.estimatedEndMin).getTime();
        if (isNaN(endTime)) continue;
        const elapsed = now - endTime;
        // Only events that ended between 0 and 20min ago
        if (elapsed > 0 && elapsed <= HOT_LOOKBACK) {
            hotEventIds.push(eventId);
        }
    }

    if (hotEventIds.length === 0) return;

    // Fetch full event data from DB (need markets for processEvent)
    const events = await getEventsByPolymarketIds(hotEventIds);
    const eventMap = new Map(events.map(e => [e.polymarket_event_id, e]));

    // Build queue with tracked data, sorted by urgency
    const queue = [];
    for (const eventId of hotEventIds) {
        const event = eventMap.get(eventId);
        if (!event || !event.markets?.length) continue;
        if (state.resolvedEventIds.has(eventId)) continue;
        const tracked = state.trackedEvents.get(eventId);
        queue.push({ event, tracked });
    }

    if (queue.length === 0) return;

    // Sort: most recently ended first (smallest elapsed time)
    queue.sort((a, b) => {
        const aEnd = new Date(a.tracked.estimatedEndMin).getTime();
        const bEnd = new Date(b.tracked.estimatedEndMin).getTime();
        return bEnd - aEnd; // newest end first
    });

    log.info(`Hot: ${queue.length} events just ended (checking for resolution)`);

    const counters = { newTracked: 0, rechecked: 0, resolved: 0 };

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
        Array.from({ length: Math.min(concurrency, queue.length) }, (_, i) => worker(i))
    );

    if (counters.resolved > 0 || counters.rechecked > 0 || counters.newTracked > 0) {
        log.info(`Hot: ${counters.newTracked} new, ${counters.rechecked} re-checked, ${counters.resolved} resolved`);
    }
}

// ─── Event processing ───

async function processEvent(event, tracked, slotIndex, state, counters) {
    const eventId = event.polymarket_event_id;

    // Pre-flight: skip if already closed on Polymarket (saves expensive Perplexity query)
    const firstMarket = event.markets?.[0];
    if (firstMarket?.condition_id) {
        try {
            const gmRes = await fetch(`${config.GAMMA_BASE}/markets/${firstMarket.condition_id}`);
            if (gmRes.ok) {
                const live = await gmRes.json();
                if (live.closed) {
                    log.info(`SKIP (closed on PM): "${event.title.slice(0, 60)}"`);
                    state.resolvedEventIds.set(eventId, Date.now());
                    return;
                }
            }
        } catch {}
    }

    const result = await checkEventWithPerplexity(event, slotIndex);
    if (!result) return;

    if (!tracked) {
        if (result.resolved && result.confidence >= config.MIN_CONFIDENCE) {
            await writeEventResults(event, result);
            state.trackedEvents.delete(eventId);
            state.resolvedEventIds.set(eventId, Date.now());
            counters.resolved++;
        }
        else {
            await writeEventEstimatedEnds(event, result);
            const nextCheck = calculateNextCheck(result.estimatedEndMin, 0);
            state.trackedEvents.set(eventId, {
                eventId,
                title: event.title,
                marketCount: event.markets.length,
                estimatedEndMin: result.estimatedEndMin || null,
                estimatedEndMax: result.estimatedEndMax || null,
                lastChecked: Date.now(),
                checkCount: 1,
                nextCheckAt: nextCheck,
            });
            counters.newTracked++;
            log.info(`TRACKING: "${event.title.slice(0, 80)}" est: ${result.estimatedEndMin || '?'}..${result.estimatedEndMax || '?'}, next: ${new Date(nextCheck).toISOString()}`);
        }
    }
    else {
        tracked.lastChecked = Date.now();
        tracked.checkCount++;

        if (result.resolved && result.confidence >= config.MIN_CONFIDENCE) {
            await writeEventResults(event, result);
            state.trackedEvents.delete(eventId);
            state.resolvedEventIds.set(eventId, Date.now());
            counters.resolved++;
            log.info(`RESOLVED after ${tracked.checkCount} checks: "${event.title.slice(0, 80)}" → ${result.answer}`);
        }
        else {
            if (result.estimatedEndMin) {
                tracked.estimatedEndMin = result.estimatedEndMin;
                tracked.estimatedEndMax = result.estimatedEndMax;
                await writeEventEstimatedEnds(event, result);
            }
            tracked.nextCheckAt = calculateNextCheck(tracked.estimatedEndMin, tracked.checkCount);
            counters.rechecked++;
        }
    }
}

function calculateNextCheck(estimatedEndISO, checkCount = 0) {
    if (!estimatedEndISO) return Date.now() + config.DETECTION_INTERVAL;

    const endTime = new Date(estimatedEndISO).getTime();
    const now = Date.now();
    const remaining = endTime - now;

    // Event hasn't ended yet → don't check before it ends, schedule at endTime + 1min
    if (remaining > 0) {
        if (remaining > 3 * 24 * 3600000) return endTime - 24 * 3600000; // >3d: wake 24h before
        if (remaining > 24 * 3600000) return now + 6 * 3600000;          // 1-3d: every 6h
        if (remaining > 4 * 3600000) return now + 2 * 3600000;           // 4-24h: every 2h
        return endTime + 60000;                                           // <4h: wait until endTime + 1min
    }

    // Event already ended → recheck with escalating backoff
    const POST_INTERVALS = [60000, 2 * 60000, 5 * 60000, 10 * 60000]; // 1m, 2m, 5m, 10m
    const idx = Math.min(checkCount, POST_INTERVALS.length - 1);
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
        const input = {
            mode: 'event',
            event_title: event.title,
            event_description: event.description || '',
            end_date: event.end_date || '',
            market_questions: event.markets.map(m => m.question),
            market_descriptions: event.markets.map(m => m.description || ''),
        };

        const line = await bridge.query(input);
        const parsed = JSON.parse(line);

        if (parsed.error) {
            log.warn(`Perplexity error (bridge#${slotIndex}): ${parsed.error}`);
            return null;
        }

        const marketOutcomes = Array.isArray(parsed.markets)
            ? parsed.markets.map(m => ({
                index: (m.market || 1) - 1,
                outcome: m.outcome || 'unknown',
                confidence: Number(m.confidence) || 0,
            }))
            : [];

        const winner = marketOutcomes
            .filter(m => m.outcome === 'yes')
            .sort((a, b) => b.confidence - a.confidence)[0] || null;

        return {
            resolved: parsed.resolved === true,
            answer: parsed.answer || 'unknown',
            winningMarketIndex: winner ? winner.index : null,
            marketOutcomes,
            confidence: Number(parsed.confidence) || 0,
            estimatedEnd: parsed.estimated_end || null,
            estimatedEndMin: parsed.estimated_end_min || parsed.estimated_end || null,
            estimatedEndMax: parsed.estimated_end_max || parsed.estimated_end || null,
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

// ─── Result mapping ───

async function writeEventResults(event, result) {
    const markets = event.markets;
    const outcomes = result.marketOutcomes || [];

    const outcomeMap = new Map();
    for (const mo of outcomes) {
        if (mo.index >= 0 && mo.index < markets.length) {
            outcomeMap.set(mo.index, mo);
        }
    }

    let winnerIdx = result.winningMarketIndex;
    let alertMarket = null;

    for (let i = 0; i < markets.length; i++) {
        const mo = outcomeMap.get(i);
        const outcome = mo ? mo.outcome : (i === winnerIdx ? 'yes' : 'no');
        const conf = mo ? mo.confidence : result.confidence;

        await writeResult(markets[i], {
            ...result,
            outcome,
            confidence: conf,
            resolved: result.resolved,
        });

        if (outcome === 'yes' && !alertMarket) {
            alertMarket = { market: markets[i], confidence: conf };
        }
    }

    if (alertMarket) {
        log.info(`MAPPED: "${event.title.slice(0, 60)}" → "${alertMarket.market.question.slice(0, 60)}" = YES (${alertMarket.confidence}%)`);

        // Always try real prices first (for profit calc), fall back to implied for resolved
        const realPrices = await fetchPrices(alertMarket.market);
        const prices = realPrices || (result.resolved ? { type: 'resolved', yes: '1.00', no: '0.00' } : null);

        // Calculate profit % for resolved events with live prices
        let profitPct = null;
        if (result.resolved && prices && prices.type !== 'resolved') {
            const buyPrice = prices.type === 'book'
                ? parseFloat(prices.yesAsk)
                : parseFloat(prices.yes);
            if (!isNaN(buyPrice) && buyPrice > 0 && buyPrice < 1) {
                profitPct = ((1.00 - buyPrice) / buyPrice) * 100;
            }
        }

        // Store profit_pct in DB
        if (profitPct !== null && alertMarket.market.id) {
            await upsertOutcome({
                market_id: alertMarket.market.id,
                profit_pct: Math.round(profitPct * 100) / 100,
            });
        }

        await sendTelegramAlert(event, alertMarket.market, { ...result, outcome: 'yes' }, prices, profitPct);
    } else {
        log.warn(`NO YES: "${event.title.slice(0, 60)}" answer="${result.answer}"`);
    }
}

async function writeEventEstimatedEnds(event, result) {
    for (const mkt of event.markets) {
        await writeEstimatedEnd(mkt, result);
    }
}

// ─── DB writers ───

async function writeResult(market, result) {
    const dbId = market.id;
    if (!dbId) {
        log.error(`Cannot find DB id for market ${market.polymarket_market_id}`);
        return;
    }

    await upsertOutcome({
        market_id: dbId,
        detected_outcome: result.outcome,
        confidence: result.confidence,
        detection_source: result.source,
        detected_at: new Date().toISOString(),
        estimated_end_min: null,
        estimated_end_max: null,
        is_resolved: true,
    });

    log.info(`RESULT: "${market.question.slice(0, 80)}" → ${result.outcome} (${result.confidence}%)`);
}

async function writeEstimatedEnd(market, result) {
    const dbId = market.id;
    if (!dbId) return;

    await upsertOutcome({
        market_id: dbId,
        detected_outcome: 'pending',
        confidence: 0,
        detection_source: result.source,
        detected_at: new Date().toISOString(),
        estimated_end_min: result.estimatedEndMin || null,
        estimated_end_max: result.estimatedEndMax || null,
        is_resolved: false,
    });
}

// ─── Prices ───

function parseTokenIds(market) {
    const raw = typeof market.clob_token_ids === 'string'
        ? JSON.parse(market.clob_token_ids)
        : market.clob_token_ids || [];
    return raw.length >= 2 ? raw : null;
}

async function fetchPrices(market) {
    try {
        const tokenIds = parseTokenIds(market);

        if (tokenIds) {
            const [yesBook, noBook] = await Promise.all([
                fetch(`${config.CLOB_BASE}/book?token_id=${tokenIds[0]}`).then(r => r.json()),
                fetch(`${config.CLOB_BASE}/book?token_id=${tokenIds[1]}`).then(r => r.json()),
            ]);
            const yesBid = yesBook.bids?.[0]?.price;
            const yesAsk = yesBook.asks?.[0]?.price;
            if (yesBid || yesAsk) {
                return {
                    type: 'book',
                    yesBid: yesBid || '—', yesAsk: yesAsk || '—',
                    noBid: noBook.bids?.[0]?.price || '—', noAsk: noBook.asks?.[0]?.price || '—',
                };
            }
        }

        if (market.condition_id) {
            const res = await fetch(`${config.GAMMA_BASE}/markets/${market.condition_id}`);
            if (res.ok) {
                const gm = await res.json();
                const op = typeof gm.outcomePrices === 'string' ? JSON.parse(gm.outcomePrices) : gm.outcomePrices;
                if (op?.length >= 2) {
                    return { type: 'price', yes: Number(op[0]).toFixed(2), no: Number(op[1]).toFixed(2) };
                }
            }
        }

        const stored = typeof market.outcome_prices === 'string'
            ? JSON.parse(market.outcome_prices) : market.outcome_prices;
        if (stored?.length >= 2) {
            return { type: 'stored', yes: Number(stored[0]).toFixed(2), no: Number(stored[1]).toFixed(2) };
        }

        return null;
    } catch (e) {
        log.warn(`Failed to fetch prices for "${market.question.slice(0, 40)}"`, e.message);
        return null;
    }
}

// ─── Telegram ───

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

function shortQuestion(q, eventTitle) {
    if (!q) return '?';
    const titleWords = (eventTitle || '').split(/\s+/).slice(0, 4).join(' ');
    if (titleWords.length > 10 && q.startsWith(titleWords)) {
        q = q.slice(eventTitle.length).replace(/^\s*[-–—:]\s*/, '').trim() || q;
    }
    return q.length > 50 ? q.slice(0, 47) + '...' : q;
}

async function sendTelegramAlert(event, market, result, prices, profitPct) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

    const eventUrl = `https://polymarket.com/event/${event.slug || ''}`;
    const marketUrl = `https://polymarket.com/event/${event.slug || ''}/${market.slug || ''}`;

    const icon = r => r === 'yes' ? '✅' : r === 'no' ? '❌' : '❓';

    const lines = [];
    if (result.resolved) {
        lines.push(`🟢 <b>RESOLVED</b>  ·  ${result.confidence}%`);
    } else {
        lines.push(`🟡 <b>PENDING</b>`);
    }
    lines.push('');
    lines.push(`<b>${event.title}</b>`);

    const answer = result.answer || result.reasoning || '';
    if (answer && answer !== 'unknown') {
        lines.push(`<i>${answer}</i>`);
    }

    const outcomes = result.marketOutcomes || [];
    if (outcomes.length > 0) {
        const allSame = outcomes.every(m => m.outcome === outcomes[0].outcome);
        lines.push('');
        if (allSame && outcomes.length > 2) {
            lines.push(`${icon(outcomes[0].outcome)} All ${outcomes.length} markets: <b>${outcomes[0].outcome.toUpperCase()}</b>`);
        } else {
            for (const mo of outcomes) {
                const q = shortQuestion(event.markets?.[mo.index]?.question, event.title);
                lines.push(`${icon(mo.outcome)} ${mo.confidence}%  ${q}`);
            }
        }
    }

    if (prices) {
        lines.push('');
        if (prices.type === 'book') {
            lines.push(`💰 <code>YES ${prices.yesBid}/${prices.yesAsk}  ·  NO ${prices.noBid}/${prices.noAsk}</code>`);
        } else {
            lines.push(`💰 YES <b>${prices.yes}</b>  ·  NO <b>${prices.no}</b>`);
        }
    }

    if (profitPct !== null && profitPct !== undefined) {
        const buyPrice = prices?.type === 'book'
            ? prices.yesAsk
            : prices?.yes;
        lines.push(`📈 <b>Profit: ~${profitPct.toFixed(2)}%</b>  (buy YES @ ${buyPrice} → 1.00)`);
    }

    if (!result.resolved) {
        const fExact = formatDate(result.estimatedEnd);
        const fMin = formatDate(result.estimatedEndMin);
        const fMax = formatDate(result.estimatedEndMax);
        if (fExact) {
            lines.push('');
            lines.push(`📅 ${fExact}`);
        } else if (fMin && fMax && fMin !== fMax) {
            lines.push('');
            lines.push(`📅 ${fMin} – ${fMax}`);
        } else if (fMin) {
            lines.push('');
            lines.push(`📅 ${fMin}`);
        }
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
