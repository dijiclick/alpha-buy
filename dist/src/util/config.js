import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
function env(key) {
    const v = process.env[key];
    if (!v)
        throw new Error(`Missing env: ${key}`);
    return v;
}
function optEnv(key) {
    return process.env[key] || undefined;
}
function getPerplexityTokens() {
    const tokens = [];
    const primary = process.env.PERPLEXITY_SESSION_TOKEN;
    if (!primary) throw new Error('Missing env: PERPLEXITY_SESSION_TOKEN');
    tokens.push(primary);
    for (let i = 2; i <= 10; i++) {
        const t = process.env[`PERPLEXITY_SESSION_TOKEN_${i}`];
        if (t) tokens.push(t);
    }
    return tokens;
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
export const config = {
    // Supabase
    SUPABASE_URL: env('SUPABASE_URL'),
    SUPABASE_KEY: env('SUPABASE_SERVICE_KEY'),
    // Perplexity (multiple tokens = concurrent bridges)
    PERPLEXITY_SESSION_TOKENS: getPerplexityTokens(),
    // Python bridge
    PYTHON_CMD: optEnv('PYTHON_CMD') || 'uv',
    PERPLEXITY_BRIDGE_PATH: optEnv('PERPLEXITY_BRIDGE_PATH')
        || join(PROJECT_ROOT, 'scripts', 'perplexity_bridge.py'),
    // Telegram
    TELEGRAM_BOT_TOKEN: optEnv('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_CHAT_ID: optEnv('TELEGRAM_CHAT_ID'),
    // CLOB API
    CLOB_BASE: 'https://clob.polymarket.com',
    CLOB_WS: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    // API bases
    GAMMA_BASE: 'https://gamma-api.polymarket.com',
    // Tag IDs
    CRYPTO_TAG_ID: 21,
    // Thresholds
    MIN_CONFIDENCE: 80,
    PRICE_SPIKE_THRESHOLD: Number(optEnv('PRICE_SPIKE_THRESHOLD') || '0.85'),
    // Intervals (ms)
    SYNC_INTERVAL: 3_600_000,
    QUICK_SYNC_INTERVAL: 5 * 60_000,
    DETECTION_INTERVAL: 3_600_000,
    STATE_PERSIST_INTERVAL: 60_000,
    STATUS_REPORT_INTERVAL: 30_000,
    // Pagination
    GAMMA_PAGE_SIZE: 500,
};
