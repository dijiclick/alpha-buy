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
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
export const config = {
    // Supabase
    SUPABASE_URL: env('SUPABASE_URL'),
    SUPABASE_KEY: env('SUPABASE_SERVICE_KEY'),
    // Perplexity
    PERPLEXITY_SESSION_TOKEN: env('PERPLEXITY_SESSION_TOKEN'),
    // Python bridge
    PYTHON_CMD: optEnv('PYTHON_CMD') || 'uv',
    PERPLEXITY_BRIDGE_PATH: optEnv('PERPLEXITY_BRIDGE_PATH')
        || join(PROJECT_ROOT, 'scripts', 'perplexity_bridge.py'),
    // Telegram
    TELEGRAM_BOT_TOKEN: optEnv('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_CHAT_ID: optEnv('TELEGRAM_CHAT_ID'),
    // CLOB API
    CLOB_BASE: 'https://clob.polymarket.com',
    // API bases
    GAMMA_BASE: 'https://gamma-api.polymarket.com',
    // Tag IDs
    CRYPTO_TAG_ID: 21,
    // Thresholds
    MIN_CONFIDENCE: 80,
    // Intervals (ms)
    SYNC_INTERVAL: 3_600_000,
    DETECTION_INTERVAL: 3_600_000,
    STATE_PERSIST_INTERVAL: 60_000,
    STATUS_REPORT_INTERVAL: 30_000,
    // Pagination
    GAMMA_PAGE_SIZE: 500,
};
