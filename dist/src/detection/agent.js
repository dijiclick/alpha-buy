import { spawn } from 'child_process';
import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getActiveEventsWithMarkets, upsertOutcome, getMarketDbId } from '../db/supabase.js';
const log = createLogger('agent');

// ─── Persistent Perplexity bridge ───

let _bridge = null;

function getBridge() {
    if (_bridge && !_bridge.dead) return _bridge;

    log.info('Spawning persistent Perplexity bridge process...');

    const child = spawn(config.PYTHON_CMD,
        ['run', '--script', config.PERPLEXITY_BRIDGE_PATH, '--server'],
        {
            env: { ...process.env, PERPLEXITY_SESSION_TOKEN: config.PERPLEXITY_SESSION_TOKEN },
            stdio: ['pipe', 'pipe', 'pipe'],
        }
    );

    let buffer = '';
    const waiters = [];

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line
        for (const line of lines) {
            if (!line.trim()) continue;
            const entry = waiters.shift();
            if (entry && !entry.done) {
                entry.done = true;
                clearTimeout(entry.timer);
                entry.resolve(line);
            }
        }
    });

    child.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (!msg) return;
        // Surface rate limits and errors at warn level
        if (/RATE_LIMITED|SESSION_ERR|ERROR|FAILED/i.test(msg)) {
            log.warn(`Bridge: ${msg.slice(0, 500)}`);
        } else {
            log.info(`Bridge: ${msg.slice(0, 300)}`);
        }
    });

    const b = {
        child,
        dead: false,

        query(input) {
            return new Promise((resolve, reject) => {
                if (this.dead) return reject(new Error('Bridge is dead'));

                const entry = { done: false };

                entry.timer = setTimeout(() => {
                    if (entry.done) return;
                    entry.done = true;
                    const idx = waiters.indexOf(entry);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error('Bridge timeout (90s)'));
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
        log.warn(`Bridge exited (code ${code})`);
        b.dead = true;
        while (waiters.length) {
            const entry = waiters.shift();
            if (!entry.done) {
                entry.done = true;
                clearTimeout(entry.timer);
                entry.reject(new Error(`Bridge died (code ${code})`));
            }
        }
    });

    child.on('error', (e) => {
        log.warn(`Bridge spawn error: ${e.message}`);
        b.dead = true;
    });

    _bridge = b;
    return b;
}

// ─── Public entry point ───

export function startResolutionAgent(state) {
    log.info(`Resolution agent started (every ${config.DETECTION_INTERVAL / 1000}s)`);
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
}

async function runAgentCycle(state) {
    const events = await getActiveEventsWithMarkets();
    let newTracked = 0;
    let rechecked = 0;
    let resolved = 0;

    for (const event of events) {
        if (event.closed || !event.markets || event.markets.length === 0)
            continue;

        const eventId = event.polymarket_event_id;
        const tracked = state.trackedEvents.get(eventId);

        if (!tracked) {
            const result = await checkEventWithPerplexity(event);
            if (!result)
                continue;

            if (result.resolved && result.confidence >= config.MIN_CONFIDENCE) {
                await writeEventResults(event, result);
                state.trackedEvents.delete(eventId);
                resolved++;
            }
            else {
                await writeEventEstimatedEnds(event, result);
                const nextCheck = calculateNextCheck(result.estimatedEnd, 0, result.recheckMinutes);
                const entry = {
                    eventId,
                    title: event.title,
                    marketCount: event.markets.length,
                    estimatedEnd: result.estimatedEnd || null,
                    lastChecked: Date.now(),
                    checkCount: 1,
                    nextCheckAt: nextCheck,
                };
                state.trackedEvents.set(eventId, entry);
                newTracked++;
                log.info(`TRACKING EVENT: "${event.title.slice(0, 80)}" (${event.markets.length} markets) — est: ${result.estimatedEnd || 'unknown'}, recheck: ${new Date(nextCheck).toISOString()}`);
            }
        }
        else {
            if (Date.now() < tracked.nextCheckAt)
                continue;

            const result = await checkEventWithPerplexity(event);
            if (!result)
                continue;

            tracked.lastChecked = Date.now();
            tracked.checkCount++;

            if (result.resolved && result.confidence >= config.MIN_CONFIDENCE) {
                await writeEventResults(event, result);
                state.trackedEvents.delete(eventId);
                resolved++;
                log.info(`EVENT RESOLVED after ${tracked.checkCount} checks: "${event.title.slice(0, 80)}" → ${result.answer}`);
            }
            else {
                if (result.estimatedEnd) {
                    tracked.estimatedEnd = result.estimatedEnd;
                    await writeEventEstimatedEnds(event, result);
                }
                tracked.nextCheckAt = calculateNextCheck(tracked.estimatedEnd, tracked.checkCount, result.recheckMinutes);
                rechecked++;
                log.info(`RE-CHECK EVENT #${tracked.checkCount}: "${event.title.slice(0, 60)}" — still pending, next: ${new Date(tracked.nextCheckAt).toISOString()}`);
            }
        }
    }

    // Clean up tracked events no longer active
    for (const [eventId] of state.trackedEvents) {
        if (!events.find(e => e.polymarket_event_id === eventId)) {
            state.trackedEvents.delete(eventId);
        }
    }

    const total = state.trackedEvents.size;
    if (total > 0 || resolved > 0 || newTracked > 0) {
        log.info(`Agent: ${newTracked} new events, ${rechecked} re-checked, ${resolved} resolved, ${total} tracking`);
    }
}

function calculateNextCheck(estimatedEndISO, checkCount = 0, recheckMinutes = null) {
    const MIN_INTERVAL = 10 * 60 * 1000;  // 10 min floor

    // If Perplexity told us when to recheck, trust it (floor 10 min, no ceiling)
    if (recheckMinutes != null && recheckMinutes > 0) {
        const ms = Math.max(MIN_INTERVAL, recheckMinutes * 60 * 1000);
        return Date.now() + ms;
    }

    // No estimated end → default cycle
    if (!estimatedEndISO) {
        return Date.now() + config.DETECTION_INTERVAL;
    }

    const endTime = new Date(estimatedEndISO).getTime();
    const remaining = endTime - Date.now();

    // Past due — hammer it every 10 min
    if (remaining <= 0) {
        return Date.now() + MIN_INTERVAL;
    }
    // Under 1 hour — every 10 min
    if (remaining <= 60 * 60 * 1000) {
        return Date.now() + MIN_INTERVAL;
    }
    // Under 4 hours — every 30 min
    if (remaining <= 4 * 60 * 60 * 1000) {
        return Date.now() + 30 * 60 * 1000;
    }
    // Under 24 hours — every 2 hours
    if (remaining <= 24 * 60 * 60 * 1000) {
        return Date.now() + 2 * 60 * 60 * 1000;
    }
    // Under 3 days — every 6 hours
    if (remaining <= 3 * 24 * 60 * 60 * 1000) {
        return Date.now() + 6 * 60 * 60 * 1000;
    }
    // More than 3 days away — sleep until 24h before estimated end
    // (one check to refresh the estimate, then the tiers above kick in)
    return endTime - 24 * 60 * 60 * 1000;
}

// ─── Perplexity bridge ───

async function checkEventWithPerplexity(event) {
    if (!config.PERPLEXITY_SESSION_TOKEN) {
        log.warn('No PERPLEXITY_SESSION_TOKEN configured');
        return null;
    }

    try {
        const input = {
            mode: 'event',
            event_title: event.title,
            event_description: event.description || '',
            end_date: event.end_date || '',
            market_questions: event.markets.map(m => m.question),
        };

        const bridge = getBridge();
        const line = await bridge.query(input);
        const parsed = JSON.parse(line);

        if (parsed.error) {
            log.warn(`Perplexity error: ${parsed.error}`);
            return null;
        }

        // Parse per-market outcomes from the markets array
        const marketOutcomes = Array.isArray(parsed.markets)
            ? parsed.markets.map(m => ({
                index: (m.market || 1) - 1,  // 1-based → 0-based
                outcome: m.outcome || 'unknown',
                confidence: Number(m.confidence) || 0,
            }))
            : [];

        // Find winning market (highest-confidence "yes")
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
            recheckMinutes: Number(parsed.recheck_in_minutes) || null,
            reasoning: parsed.reasoning || '',
            source: 'perplexity',
        };
    }
    catch (e) {
        log.warn(`Perplexity check failed for event "${event.title.slice(0, 60)}"`, e.message);
        // If bridge died, null it so next call spawns a fresh one
        if (_bridge?.dead) _bridge = null;
        return null;
    }
}

// ─── Result mapping ───

async function writeEventResults(event, result) {
    const markets = event.markets;
    const outcomes = result.marketOutcomes || [];

    // Build a lookup: 0-based index → outcome from Perplexity
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
        log.info(`EVENT MAPPED: "${event.title.slice(0, 60)}" → "${alertMarket.market.question.slice(0, 60)}" = YES (${alertMarket.confidence}%)`);
        const prices = await fetchPrices(alertMarket.market);
        await sendTelegramAlert(event, alertMarket.market, { ...result, outcome: 'yes' }, prices);
    } else {
        log.warn(`EVENT NO YES: "${event.title.slice(0, 60)}" answer="${result.answer}" — no market got YES`);
    }
}

async function writeEventEstimatedEnds(event, result) {
    for (const mkt of event.markets) {
        await writeEstimatedEnd(mkt, result);
    }
}

// ─── DB writers ───

async function writeResult(market, result) {
    const marketId = market.polymarket_market_id;
    const dbId = market.id || await getMarketDbId(marketId);
    if (!dbId) {
        log.error(`Cannot find DB id for market ${marketId}`);
        return;
    }

    await upsertOutcome({
        market_id: dbId,
        detected_outcome: result.outcome,
        confidence: result.confidence,
        detection_source: result.source,
        detected_at: new Date().toISOString(),
        estimated_end: null,
        is_resolved: true,
    });

    log.info(`RESULT: "${market.question.slice(0, 80)}" → ${result.outcome} (${result.confidence}%)`);
}

async function writeEstimatedEnd(market, result) {
    const marketId = market.polymarket_market_id;
    const dbId = market.id || await getMarketDbId(marketId);
    if (!dbId) {
        log.error(`Cannot find DB id for market ${marketId}`);
        return;
    }

    await upsertOutcome({
        market_id: dbId,
        detected_outcome: 'pending',
        confidence: 0,
        detection_source: result.source,
        detected_at: new Date().toISOString(),
        estimated_end: result.estimatedEnd || null,
        is_resolved: false,
    });

    log.info(`ESTIMATED END written: "${market.question.slice(0, 60)}" → ${result.estimatedEnd || 'unknown'}`);
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

        // 1. Try CLOB order book (best for active markets — shows spread = alpha)
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

        // 2. Try gamma API for latest prices (works for resolved/thin markets)
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

        // 3. Fall back to stored outcome_prices from DB
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
    // Strip event title prefix from market question
    const titleWords = (eventTitle || '').split(/\s+/).slice(0, 4).join(' ');
    if (titleWords.length > 10 && q.startsWith(titleWords)) {
        q = q.slice(eventTitle.length).replace(/^\s*[-–—:]\s*/, '').trim() || q;
    }
    return q.length > 50 ? q.slice(0, 47) + '...' : q;
}

async function sendTelegramAlert(event, market, result, prices) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

    const eventUrl = `https://polymarket.com/event/${event.slug || ''}`;
    const marketUrl = `https://polymarket.com/event/${event.slug || ''}/${market.slug || ''}`;

    const icon = r => r === 'yes' ? '✅' : r === 'no' ? '❌' : '❓';

    // Header
    const lines = [];
    if (result.resolved) {
        lines.push(`🟢 <b>RESOLVED</b>  ·  ${result.confidence}%`);
    } else {
        lines.push(`🟡 <b>PENDING</b>`);
    }
    lines.push('');
    lines.push(`<b>${event.title}</b>`);

    // Answer — only show if meaningful
    const answer = result.answer || result.reasoning || '';
    if (answer && answer !== 'unknown') {
        lines.push(`<i>${answer}</i>`);
    }

    // Per-market outcomes — collapse if all same
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

    // Prices
    if (prices) {
        lines.push('');
        if (prices.type === 'book') {
            lines.push(`💰 <code>YES ${prices.yesBid}/${prices.yesAsk}  ·  NO ${prices.noBid}/${prices.noAsk}</code>`);
        } else {
            lines.push(`💰 YES <b>${prices.yes}</b>  ·  NO <b>${prices.no}</b>`);
        }
    }

    // Timing — only if pending
    if (!result.resolved) {
        const timing = [];
        if (result.recheckMinutes) timing.push(`⏰ ${result.recheckMinutes}m`);
        const fmtDate = formatDate(result.estimatedEnd);
        if (fmtDate) timing.push(`📅 ${fmtDate}`);
        if (timing.length) {
            lines.push('');
            lines.push(timing.join('  ·  '));
        }
    }

    lines.push('');
    lines.push(`<a href="${eventUrl}">Event</a>  ·  <a href="${marketUrl}">Market</a>`);

    const text = lines.join('\n');

    try {
        const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.TELEGRAM_CHAT_ID,
                text,
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
