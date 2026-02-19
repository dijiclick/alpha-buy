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
    // Perplexity Sonar (optional until Tier 2 active)
    PERPLEXITY_API_KEY: optEnv('PERPLEXITY_API_KEY'),
    // Brave Search (future)
    BRAVE_API_KEY: optEnv('BRAVE_API_KEY'),
    // API bases
    GAMMA_BASE: 'https://gamma-api.polymarket.com',
    CLOB_BASE: 'https://clob.polymarket.com',
    // Tag IDs
    CRYPTO_TAG_ID: 21,
    // Thresholds
    PRICE_WATCHLIST: 0.85,
    PRICE_TRIGGER: 0.90,
    MIN_CONFIDENCE: 80,
    // Actionability filters
    MIN_DAILY_VOLUME: 5000,
    MAX_BEST_ASK: 0.97,
    MAX_SPREAD: 0.05,
    // Intervals (ms)
    SYNC_INTERVAL: 30_000,
    DETECTION_INTERVAL: 30_000,
    GAMMA_CHECK_INTERVAL: 5_000,
    HOT_PRICE_INTERVAL: 10_000,
    ACTIVE_PRICE_INTERVAL: 30_000,
    STATE_PERSIST_INTERVAL: 60_000,
    STATUS_REPORT_INTERVAL: 30_000,
    // Pagination
    GAMMA_PAGE_SIZE: 500,
};
//# sourceMappingURL=config.js.map