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
    // Puter (free Claude Haiku via puter.com)
    PUTER_TOKEN: env('PUTER_TOKEN'),
    // Brave Search (future)
    BRAVE_API_KEY: optEnv('BRAVE_API_KEY'),
    // API bases
    GAMMA_BASE: 'https://gamma-api.polymarket.com',
    // Tag IDs
    CRYPTO_TAG_ID: 21,
    // Thresholds
    PRICE_TRIGGER: 0.85,
    MIN_CONFIDENCE: 80,
    // Intervals (ms)
    SYNC_INTERVAL: 3_600_000,
    DETECTION_INTERVAL: 3_600_000,
    STATE_PERSIST_INTERVAL: 60_000,
    STATUS_REPORT_INTERVAL: 30_000,
    // Pagination
    GAMMA_PAGE_SIZE: 500,
};
