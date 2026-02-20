/**
 * End-to-end test: DB → Perplexity → outcome → Telegram
 * Run: node test-e2e.js
 *
 * Tests the full pipeline once with a single real event, then exits.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Helpers ───

function log(step, msg) {
    console.log(`\n[${'='.repeat(3)} STEP ${step} ${'='.repeat(40 - String(step).length)}]`);
    console.log(msg);
}

function elapsed(start) {
    return ((Date.now() - start) / 1000).toFixed(1) + 's';
}

// ─── Persistent bridge (same logic as agent.js) ───

function createBridge() {
    const bridgePath = join(__dirname, 'scripts', 'perplexity_bridge.py');
    const child = spawn('uv', ['run', '--script', bridgePath, '--server'], {
        env: { ...process.env, PERPLEXITY_SESSION_TOKEN: process.env.PERPLEXITY_SESSION_TOKEN },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    const waiters = [];

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
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
        if (msg) console.log(`  [bridge] ${msg}`);
    });

    child.on('close', (code) => {
        console.log(`  [bridge] process exited (code ${code})`);
        bridge.dead = true;
        while (waiters.length) {
            const entry = waiters.shift();
            if (!entry.done) {
                entry.done = true;
                clearTimeout(entry.timer);
                entry.reject(new Error(`Bridge died (code ${code})`));
            }
        }
    });

    child.on('error', e => {
        console.log(`  [bridge] spawn error: ${e.message}`);
        bridge.dead = true;
    });

    const bridge = {
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
                entry.resolve = (line) => { entry.done = true; clearTimeout(entry.timer); resolve(line); };
                entry.reject = (err) => { entry.done = true; clearTimeout(entry.timer); reject(err); };
                waiters.push(entry);
                child.stdin.write(JSON.stringify(input) + '\n');
            });
        },
        kill() { this.dead = true; child.kill(); }
    };
    return bridge;
}

// ─── Telegram ───

async function sendTelegram(text) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.log('  Telegram: skipped (no bot token or chat ID)');
        return false;
    }
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }),
    });
    const body = await res.json();
    if (!res.ok) {
        console.log(`  Telegram: FAILED ${res.status}`, body);
        return false;
    }
    console.log(`  Telegram: sent (message_id: ${body.result?.message_id})`);
    return true;
}

// ─── Order book ───

async function fetchPrices(market) {
    try {
        const tokenIds = typeof market.clob_token_ids === 'string'
            ? JSON.parse(market.clob_token_ids)
            : market.clob_token_ids || [];

        // 1. Try CLOB order book (best for active markets — shows spread)
        if (tokenIds.length >= 2) {
            const [yesBook, noBook] = await Promise.all([
                fetch(`https://clob.polymarket.com/book?token_id=${tokenIds[0]}`).then(r => r.json()),
                fetch(`https://clob.polymarket.com/book?token_id=${tokenIds[1]}`).then(r => r.json()),
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

        // 2. Try gamma API for latest prices
        if (market.condition_id) {
            const res = await fetch(`https://gamma-api.polymarket.com/markets/${market.condition_id}`);
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
    } catch {
        return null;
    }
}

// ─── Main ───

async function main() {
    const t0 = Date.now();

    // ──── STEP 1: DB connection ────
    log(1, 'Connecting to Supabase...');
    const { count: ec, error: e1 } = await db.from('events').select('*', { count: 'exact', head: true });
    if (e1) { console.error('DB error:', e1.message); process.exit(1); }
    const { count: mc } = await db.from('markets').select('*', { count: 'exact', head: true });
    console.log(`  Events: ${ec}, Markets: ${mc}`);

    // ──── STEP 2: Fetch one active event with markets ────
    log(2, 'Fetching active events with markets...');
    // Find events ending soon (within next 7 days) for a meaningful test
    const now = new Date().toISOString();
    const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: events, error: e2 } = await db
        .from('events')
        .select('*, markets(*)')
        .eq('active', true)
        .eq('closed', false)
        .gte('end_date', now)
        .lte('end_date', weekFromNow)
        .order('end_date', { ascending: true })
        .limit(20);

    if (e2) { console.error('Fetch error:', e2.message); process.exit(1); }

    // Pick an event with 2+ markets
    const candidates = events
        .map(ev => ({
            ...ev,
            markets: (ev.markets || []).filter(m => m.active && !m.closed),
        }))
        .filter(ev => ev.markets.length >= 2);

    if (candidates.length === 0) {
        console.log('  No suitable multi-market events found. Trying single-market...');
        const single = events.find(ev => (ev.markets || []).some(m => m.active && !m.closed));
        if (!single) { console.error('  No active events at all!'); process.exit(1); }
        candidates.push({ ...single, markets: single.markets.filter(m => m.active && !m.closed) });
    }

    const event = candidates[0];
    console.log(`  Event: "${event.title}"`);
    console.log(`  End date: ${event.end_date}`);
    console.log(`  Markets (${event.markets.length}):`);
    for (const m of event.markets) {
        console.log(`    ${m.question}`);
    }

    // ──── STEP 3: Query Perplexity bridge ────
    log(3, 'Starting Perplexity bridge and querying...');
    const bridge = createBridge();
    const queryStart = Date.now();

    const input = {
        mode: 'event',
        event_title: event.title,
        event_description: event.description || '',
        end_date: event.end_date || '',
        market_questions: event.markets.map(m => m.question),
    };
    console.log(`  Sending query for "${event.title.slice(0, 60)}"...`);

    let parsed;
    try {
        const line = await bridge.query(input);
        parsed = JSON.parse(line);
        console.log(`  Response (${elapsed(queryStart)}):`);
        console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
        console.error(`  Bridge failed (${elapsed(queryStart)}):`, e.message);
        bridge.kill();
        process.exit(1);
    }

    if (parsed.error) {
        console.error('  Perplexity error:', parsed.error);
        bridge.kill();
        process.exit(1);
    }

    // ──── STEP 4: Parse per-market outcomes ────
    log(4, 'Parsing per-market outcomes...');
    const marketOutcomes = Array.isArray(parsed.markets)
        ? parsed.markets.map(m => ({
            index: (m.market || 1) - 1,
            outcome: m.outcome || 'unknown',
            confidence: Number(m.confidence) || 0,
        }))
        : [];

    console.log(`  resolved: ${parsed.resolved}`);
    console.log(`  answer: ${parsed.answer}`);
    console.log(`  overall confidence: ${parsed.confidence}`);
    console.log(`  estimated_end: ${parsed.estimated_end_min || '?'} .. ${parsed.estimated_end_max || '?'}`);
    console.log(`  recheck_in_minutes: ${parsed.recheck_in_minutes}`);
    console.log(`  reasoning: ${parsed.reasoning}`);
    console.log(`  market outcomes:`);
    for (const mo of marketOutcomes) {
        const q = event.markets[mo.index]?.question || '?';
        console.log(`    [${mo.index + 1}] ${mo.outcome} (${mo.confidence}%) — ${q.slice(0, 60)}`);
    }

    // ──── STEP 5: Write outcomes to DB ────
    log(5, 'Writing outcomes to Supabase...');
    for (const mo of marketOutcomes) {
        const market = event.markets[mo.index];
        if (!market) continue;

        const payload = {
            market_id: market.id,
            detected_outcome: mo.outcome,
            confidence: mo.confidence,
            detection_source: 'perplexity',
            detected_at: new Date().toISOString(),
            estimated_end_min: parsed.estimated_end_min || null,
            estimated_end_max: parsed.estimated_end_max || null,
            is_resolved: parsed.resolved === true,
            updated_at: new Date().toISOString(),
        };

        let { data: outData, error: outErr } = await db
            .from('outcomes')
            .upsert(payload, { onConflict: 'market_id' })
            .select('id')
            .single();

        // If columns don't exist yet (pre-migration), retry without them
        if (outErr?.message?.toLowerCase().includes('could not find') && outErr?.message?.toLowerCase().includes('column')) {
            const safe = { ...payload };
            delete safe.estimated_end_min;
            delete safe.estimated_end_max;
            ({ data: outData, error: outErr } = await db
                .from('outcomes')
                .upsert(safe, { onConflict: 'market_id' })
                .select('id')
                .single());
        }

        if (outErr) {
            console.log(`  FAILED market ${market.id}: ${outErr.message}`);
        } else {
            console.log(`  OK outcome_id=${outData.id} market="${market.question.slice(0, 50)}" → ${mo.outcome} (${mo.confidence}%)`);
        }
    }

    // ──── STEP 6: Fetch prices ────
    log(6, 'Fetching market prices...');
    const winnerMo = marketOutcomes.find(m => m.outcome === 'yes')
        || marketOutcomes.sort((a, b) => b.confidence - a.confidence)[0];
    const targetMarket = winnerMo ? event.markets[winnerMo.index] : event.markets[0];

    const prices = await fetchPrices(targetMarket);
    if (prices) {
        console.log(`  Market: "${targetMarket.question.slice(0, 60)}"`);
        if (prices.type === 'book') {
            console.log(`  YES  Bid: ${prices.yesBid}  Ask: ${prices.yesAsk}`);
            console.log(`  NO   Bid: ${prices.noBid}  Ask: ${prices.noAsk}`);
        } else {
            console.log(`  YES: ${prices.yes}  NO: ${prices.no}  (${prices.type})`);
        }
    } else {
        console.log('  No price data available');
    }

    // ──── STEP 7: Send Telegram alert ────
    log(7, 'Sending Telegram alert...');
    const eventUrl = `https://polymarket.com/event/${event.slug || ''}`;
    const icon = r => r === 'yes' ? '✅' : r === 'no' ? '❌' : '❓';

    function fmtDate(iso) {
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

    function shortQ(q) {
        if (!q) return '?';
        const titleWords = (event.title || '').split(/\s+/).slice(0, 4).join(' ');
        if (titleWords.length > 10 && q.startsWith(titleWords)) {
            q = q.slice(event.title.length).replace(/^\s*[-–—:]\s*/, '').trim() || q;
        }
        return q.length > 50 ? q.slice(0, 47) + '...' : q;
    }

    // Header
    const lines = [];
    if (parsed.resolved) {
        lines.push(`🧪  🟢 <b>RESOLVED</b>  ·  ${parsed.confidence}%`);
    } else {
        lines.push(`🧪  🟡 <b>PENDING</b>`);
    }
    lines.push('');
    lines.push(`<b>${event.title}</b>`);

    // Answer — only if meaningful
    const answer = parsed.answer || '';
    if (answer && answer !== 'unknown') {
        lines.push(`<i>${answer}</i>`);
    }

    // Per-market outcomes — collapse if all same
    if (marketOutcomes.length > 0) {
        const allSame = marketOutcomes.every(m => m.outcome === marketOutcomes[0].outcome);
        lines.push('');
        if (allSame && marketOutcomes.length > 2) {
            lines.push(`${icon(marketOutcomes[0].outcome)} All ${marketOutcomes.length} markets: <b>${marketOutcomes[0].outcome.toUpperCase()}</b>`);
        } else {
            for (const mo of marketOutcomes) {
                const q = shortQ(event.markets[mo.index]?.question);
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

    // Timing info
    const parts = [];
    if (parsed.recheck_in_minutes) parts.push(`⏰ ${parsed.recheck_in_minutes}m`);
    const fMin = fmtDate(parsed.estimated_end_min);
    const fMax = fmtDate(parsed.estimated_end_max);
    if (fMin && fMax && fMin !== fMax) {
        parts.push(`📅 ${fMin} – ${fMax}`);
    } else if (fMin) {
        parts.push(`📅 ${fMin}`);
    }
    if (parts.length) {
        lines.push('');
        lines.push(parts.join('  ·  '));
    }

    // Reasoning — only if adds info beyond the answer
    if (parsed.reasoning && parsed.reasoning !== parsed.answer && parsed.reasoning !== answer) {
        lines.push('');
        lines.push(`💡 ${parsed.reasoning}`);
    }

    lines.push('');
    lines.push(`<a href="${eventUrl}">View on Polymarket</a>`);

    const alertText = lines.join('\n');

    await sendTelegram(alertText);

    // ──── DONE ────
    console.log(`\n${'='.repeat(50)}`);
    console.log(`E2E TEST COMPLETE in ${elapsed(t0)}`);
    console.log(`  DB: ✓  Perplexity: ✓ (${elapsed(queryStart)})  Outcomes: ✓  Telegram: ✓`);
    console.log(`${'='.repeat(50)}`);

    bridge.kill();
    process.exit(0);
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
