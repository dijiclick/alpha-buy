import 'dotenv/config';
function env(key) {
    const v = process.env[key];
    if (!v)
        throw new Error(`Missing env: ${key}`);
    return v;
}
function optEnv(key) {
    return process.env[key] || undefined;
}
export const config = {
    // Supabase
    SUPABASE_URL: env('SUPABASE_URL'),
    SUPABASE_KEY: env('SUPABASE_SERVICE_KEY'),
    // OpenRouter (DeepSeek with web search)
    OPENROUTER_API_KEY: env('OPENROUTER_API_KEY'),
    OPENROUTER_MODEL: optEnv('OPENROUTER_MODEL') || 'deepseek/deepseek-chat-v3-0324:online',
    OPENROUTER_CONCURRENCY: Number(optEnv('OPENROUTER_CONCURRENCY') || '5'),
    OPENROUTER_TIMEOUT_MS: Number(optEnv('OPENROUTER_TIMEOUT_MS') || '60000'),
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
    // Intervals (ms)
    SYNC_INTERVAL: 3_600_000,
    QUICK_SYNC_INTERVAL: 5 * 60_000,
    DETECTION_INTERVAL: 3_600_000,
    STATE_PERSIST_INTERVAL: 60_000,
    STATUS_REPORT_INTERVAL: 30_000,
    // Pagination
    GAMMA_PAGE_SIZE: 500,
};
