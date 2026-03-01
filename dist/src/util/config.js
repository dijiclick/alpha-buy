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
function getPerplexityCsrfTokens() {
    const tokens = [];
    tokens.push(process.env.PERPLEXITY_CSRF_TOKEN || '');
    for (let i = 2; i <= 10; i++) {
        const t = process.env[`PERPLEXITY_CSRF_TOKEN_${i}`];
        tokens.push(t || '');
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
    PERPLEXITY_CSRF_TOKENS: getPerplexityCsrfTokens(),
    // Python bridge
    PYTHON_CMD: optEnv('PYTHON_CMD') || 'uv',
    PERPLEXITY_BRIDGE_PATH: optEnv('PERPLEXITY_BRIDGE_PATH')
        || join(PROJECT_ROOT, 'scripts', 'perplexity_bridge.py'),
    // Rust MCP binary (alternative Perplexity backend)
    PERPLEXITY_MCP_PATH: optEnv('PERPLEXITY_MCP_PATH')
        || join(PROJECT_ROOT, 'scripts', 'perplexity-web-api-mcp.exe'),
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
    BLOCKED_TAG_SLUGS: new Set(['soccer', 'basketball', 'ncaa-basketball', 'nba', 'cwbb', 'hockey', 'nhl', 'khl', 'ahl']),
    // Thresholds
    MIN_CONFIDENCE: 80,
    PRICE_SPIKE_THRESHOLD: Number(optEnv('PRICE_SPIKE_THRESHOLD') || '0.85'),
    END_DATE_HORIZON: Number(optEnv('END_DATE_HORIZON_HOURS') || '24') * 3_600_000, // ms
    EDGE_THRESHOLD: Number(optEnv('EDGE_THRESHOLD') || '0.15'), // 15% edge to trigger buy
    // Trading
    TRADING_ENABLED: optEnv('TRADING_ENABLED') === 'true',
    TRADE_AMOUNT: Number(optEnv('TRADE_AMOUNT') || '1'), // USD per trade
    POLYMARKET_PRIVATE_KEY: optEnv('POLYMARKET_PRIVATE_KEY'),
    POLYMARKET_API_KEY: optEnv('POLYMARKET_API_KEY'),
    POLYMARKET_API_SECRET: optEnv('POLYMARKET_API_SECRET'),
    POLYMARKET_API_PASSPHRASE: optEnv('POLYMARKET_API_PASSPHRASE'),
    POLYMARKET_FUNDER: optEnv('POLYMARKET_FUNDER'),
    // Auto-redeem
    REDEEM_ENABLED: optEnv('REDEEM_ENABLED') === 'true',
    // Intervals (ms)
    SYNC_INTERVAL: 3_600_000,
    QUICK_SYNC_INTERVAL: 5 * 60_000,
    DETECTION_INTERVAL: 3_600_000,
    STATE_PERSIST_INTERVAL: 60_000,
    STATUS_REPORT_INTERVAL: 30_000,
    // Pagination
    GAMMA_PAGE_SIZE: 500,
};
