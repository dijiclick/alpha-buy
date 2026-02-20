import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getActiveMarkets, upsertOutcome, getMarketDbId } from '../db/supabase.js';
const log = createLogger('agent');

function runCmd(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, opts.timeout || 60000);
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) {
                const err = new Error(`Exit code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });
        child.on('error', e => { clearTimeout(timer); reject(e); });
    });
}

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

        const marketId = mkt.polymarket_market_id;
        const tracked = state.trackedMarkets.get(marketId);

        if (!tracked) {
            // New market above trigger — initial check
            const result = await checkWithPerplexity(mkt);
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
            await sleep(2000);
        }
        else {
            // Already tracking — should we re-check?
            if (Date.now() < tracked.nextCheckAt)
                continue;

            const result = await checkWithPerplexity(mkt);
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
            await sleep(2000);
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

async function checkWithPerplexity(mkt) {
    if (!config.PERPLEXITY_SESSION_TOKEN) {
        log.warn('No PERPLEXITY_SESSION_TOKEN configured');
        return null;
    }

    try {
        const input = JSON.stringify({
            question: mkt.question,
            description: mkt.description || '',
            end_date: mkt.end_date || '',
        });

        // Write input to temp file (uv run can consume stdin during dep resolution)
        const tmpFile = join(tmpdir(), `perplexity_input_${Date.now()}.json`);
        await writeFile(tmpFile, input);

        let stdout, stderr;
        try {
            ({ stdout, stderr } = await runCmd(
                config.PYTHON_CMD,
                ['run', '--script', config.PERPLEXITY_BRIDGE_PATH, tmpFile],
                {
                    env: {
                        ...process.env,
                        PERPLEXITY_SESSION_TOKEN: config.PERPLEXITY_SESSION_TOKEN,
                    },
                    timeout: 60_000,
                }
            ));
        } finally {
            await unlink(tmpFile).catch(() => {});
        }

        if (stderr) {
            log.debug(`Perplexity bridge stderr: ${stderr.slice(0, 200)}`);
        }

        if (!stdout || !stdout.trim()) {
            log.warn('Perplexity bridge returned empty stdout');
            return null;
        }

        const parsed = JSON.parse(stdout.trim());

        if (parsed.error) {
            log.warn(`Perplexity bridge error: ${parsed.error}`);
            return null;
        }

        return {
            resolved: parsed.resolved === true,
            outcome: parsed.outcome || 'unknown',
            confidence: Number(parsed.confidence) || 0,
            estimatedEnd: parsed.estimated_end || null,
            reasoning: parsed.reasoning || '',
            source: 'perplexity',
        };
    }
    catch (e) {
        log.warn(`Perplexity check failed for "${mkt.question.slice(0, 60)}"`, e.message);
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
