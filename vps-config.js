import 'dotenv/config';
function env(key) {
    const v = process.env[key];
    if (!v)
        throw new Error(`Missing env: ${key}`);
    return v;
}
export const config = {
    SUPABASE_URL: env('SUPABASE_URL'),
    SUPABASE_KEY: env('SUPABASE_SERVICE_KEY'),
    GAMMA_BASE: 'https://gamma-api.polymarket.com',
    CRYPTO_TAG_ID: 21,
    PAGE_SIZE: 500,
    // Intervals
    SYNC_INTERVAL: 3 * 60 * 60_000,  // 3 hours
    CLOSED_INTERVAL: 30 * 60_000,    // 30 min
    PERSIST_INTERVAL: 60_000,        // 1 min
    REPORT_INTERVAL: 60_000,         // 1 min
    // Rate limiting
    BACKFILL_DELAY: 500,             // ms between backfill pages
};
