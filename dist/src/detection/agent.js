import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getActiveMarkets, upsertOutcome, getMarketDbId } from '../db/supabase.js';
const log = createLogger('agent');

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
    const markets = await getActiveMarkets();
    let newTracked = 0;
    let rechecked = 0;
    let resolved = 0;

    for (const mkt of markets) {
        if (mkt.closed)
            continue;

        const prices = (mkt.outcome_prices || []).map(Number).filter(n => !isNaN(n));
        if (prices.length === 0)
            continue;
        const maxPrice = Math.max(...prices);
        if (maxPrice < config.PRICE_TRIGGER)
            continue;

        const marketId = mkt.polymarket_market_id;
        const tracked = state.trackedMarkets.get(marketId);

        if (!tracked) {
            // New market above trigger — initial check
            const result = await checkWithHaiku(mkt);
            if (!result)
                continue;

            if (result.resolved && result.confidence >= config.MIN_CONFIDENCE) {
                await writeResult(mkt, result);
                state.trackedMarkets.delete(marketId);
                resolved++;
            }
            else {
                // Not finished — write estimated_end to DB and track for re-checking
                await writeEstimatedEnd(mkt, result);
                const entry = {
                    marketId,
                    question: mkt.question,
                    estimatedEnd: result.estimatedEnd || null,
                    lastChecked: Date.now(),
                    checkCount: 1,
                    nextCheckAt: calculateNextCheck(result.estimatedEnd),
                };
                state.trackedMarkets.set(marketId, entry);
                newTracked++;
                log.info(`TRACKING: "${mkt.question.slice(0, 80)}" — estimated end: ${result.estimatedEnd || 'unknown'}`);
            }
        }
        else {
            // Already tracking — should we re-check?
            if (Date.now() < tracked.nextCheckAt)
                continue;

            const result = await checkWithHaiku(mkt);
            if (!result)
                continue;

            tracked.lastChecked = Date.now();
            tracked.checkCount++;

            if (result.resolved && result.confidence >= config.MIN_CONFIDENCE) {
                await writeResult(mkt, result);
                state.trackedMarkets.delete(marketId);
                resolved++;
                log.info(`RESOLVED after ${tracked.checkCount} checks: "${mkt.question.slice(0, 80)}" → ${result.outcome}`);
            }
            else {
                // Update estimated end if we get a new estimate
                if (result.estimatedEnd) {
                    tracked.estimatedEnd = result.estimatedEnd;
                    await writeEstimatedEnd(mkt, result);
                }
                tracked.nextCheckAt = calculateNextCheck(tracked.estimatedEnd, tracked.checkCount);
                rechecked++;
                log.info(`RE-CHECK #${tracked.checkCount}: "${mkt.question.slice(0, 60)}" — still pending, next check: ${new Date(tracked.nextCheckAt).toISOString()}`);
            }
        }
    }

    // Clean up tracked markets that are no longer active
    for (const [marketId] of state.trackedMarkets) {
        if (!markets.find(m => m.polymarket_market_id === marketId)) {
            state.trackedMarkets.delete(marketId);
        }
    }

    const total = state.trackedMarkets.size;
    if (total > 0 || resolved > 0 || newTracked > 0) {
        log.info(`Agent: ${newTracked} new, ${rechecked} re-checked, ${resolved} resolved, ${total} tracking`);
    }
}

function calculateNextCheck(estimatedEndISO, checkCount = 0) {
    if (!estimatedEndISO) {
        // No estimate — check again next cycle
        return Date.now() + config.DETECTION_INTERVAL;
    }

    const endTime = new Date(estimatedEndISO).getTime();
    const remaining = endTime - Date.now();

    if (remaining <= 0) {
        // Past estimated end — check every 15 min
        return Date.now() + 15 * 60 * 1000;
    }
    if (remaining <= 2 * 60 * 60 * 1000) {
        // Within 2 hours — check every 15 min
        return Date.now() + 15 * 60 * 1000;
    }
    if (remaining <= 24 * 60 * 60 * 1000) {
        // Within 24 hours — check every 2 hours
        return Date.now() + 2 * 60 * 60 * 1000;
    }
    // More than 24 hours — check every 6 hours
    return Date.now() + 6 * 60 * 60 * 1000;
}

async function checkWithHaiku(mkt) {
    if (!config.PUTER_TOKEN) {
        log.warn('No PUTER_TOKEN configured');
        return null;
    }

    try {
        const res = await fetch('https://api.puter.com/puterai/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.PUTER_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5',
                messages: [
                    {
                        role: 'system',
                        content: 'You determine if real-world events have already happened. Return JSON only, no markdown fences.',
                    },
                    {
                        role: 'user',
                        content: `Has this event already resolved/finished?

Question: "${mkt.question}"
Context: ${mkt.description || 'none'}
Market end date: ${mkt.end_date || 'none'}

Return ONLY this JSON:
{
  "resolved": true or false,
  "outcome": "yes" or "no" or "unknown",
  "confidence": 0 to 100,
  "estimated_end": "ISO date when event will finish, or null if resolved or unknown",
  "reasoning": "one sentence"
}`,
                    },
                ],
                temperature: 0.1,
                max_tokens: 200,
            }),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            log.warn(`Puter API ${res.status}: ${body.slice(0, 200)}`);
            return null;
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content)
            return null;

        const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);

        return {
            resolved: parsed.resolved === true,
            outcome: parsed.outcome || 'unknown',
            confidence: Number(parsed.confidence) || 0,
            estimatedEnd: parsed.estimated_end || null,
            reasoning: parsed.reasoning || '',
            source: 'haiku',
        };
    }
    catch (e) {
        log.warn(`Haiku check failed for "${mkt.question.slice(0, 60)}"`, e.message);
        return null;
    }
}

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
