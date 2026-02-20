import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

function runCmd(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('close', code => {
            if (code !== 0) {
                const err = new Error(`Exit code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });
        child.on('error', reject);
    });
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
    // 1. Grab one market from Supabase
    console.log('1. Fetching one market from Supabase...');
    const { data: markets, error } = await db
        .from('markets')
        .select('*')
        .limit(1);

    let mkt;
    if (!markets || markets.length === 0) {
        console.log('   No markets in DB — using hardcoded test question');
        mkt = {
            question: 'Will the Kansas City Chiefs win Super Bowl LIX?',
            description: 'Super Bowl LIX is scheduled for February 9, 2025 at the Caesars Superdome in New Orleans.',
            end_date: '2025-02-10',
        };
    } else {
        mkt = markets[0];
    }
    console.log(`   Market: "${mkt.question}"`);
    console.log('');

    // 2. Call Perplexity bridge
    console.log('2. Querying Perplexity...');
    const input = JSON.stringify({
        question: mkt.question,
        description: mkt.description || '',
        end_date: mkt.end_date || '',
    });

    const bridgePath = join(__dirname, 'scripts', 'perplexity_bridge.py');
    const tmpFile = join(tmpdir(), `perplexity_test_${Date.now()}.json`);
    await writeFile(tmpFile, input);

    try {
        const { stdout, stderr } = await runCmd(
            'uv',
            ['run', '--script', bridgePath, tmpFile],
            {
                env: {
                    ...process.env,
                    PERPLEXITY_SESSION_TOKEN: process.env.PERPLEXITY_SESSION_TOKEN,
                },
                timeout: 90_000,
            }
        );

        if (stderr) console.log(`   stderr: ${stderr.slice(0, 300)}`);

        const parsed = JSON.parse(stdout.trim());
        console.log('   Perplexity response:', JSON.stringify(parsed, null, 2));
        console.log('');

        if (parsed.error) {
            console.error('   Bridge error:', parsed.error);
            process.exit(1);
        }

        // 3. Write to DB if we have a real market
        if (mkt.id) {
            console.log('3. Writing result to Supabase outcomes table...');
            const outcome = {
                market_id: mkt.id,
                detected_outcome: parsed.resolved ? (parsed.outcome || 'unknown') : 'pending',
                confidence: parsed.resolved ? (Number(parsed.confidence) || 0) : 0,
                detection_source: 'perplexity',
                detected_at: new Date().toISOString(),
                estimated_end: parsed.estimated_end || null,
                is_resolved: parsed.resolved === true,
                updated_at: new Date().toISOString(),
            };

            const { data: outData, error: outErr } = await db
                .from('outcomes')
                .upsert(outcome, { onConflict: 'market_id' })
                .select('id')
                .single();

            if (outErr) {
                console.error('   DB write error:', outErr.message);
                process.exit(1);
            }
            console.log(`   Written! Outcome ID: ${outData.id}`);
        } else {
            console.log('3. Skipping DB write (no real market in DB)');
        }

        console.log('');
        console.log('TEST PASSED — Perplexity bridge works end-to-end');

    } catch (e) {
        console.error('Bridge failed:', e.message);
        if (e.stderr) console.error('stderr:', e.stderr);
        if (e.stdout) console.error('stdout:', e.stdout);
        process.exit(1);
    } finally {
        await unlink(tmpFile).catch(() => {});
    }
}

main();
