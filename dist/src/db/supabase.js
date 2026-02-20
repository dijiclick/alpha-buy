import { createClient } from '@supabase/supabase-js';
import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
const log = createLogger('db');
let client;
export function getDb() {
    if (!client) {
        client = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);
        log.info('Supabase client initialized');
    }
    return client;
}
export async function upsertEvent(row) {
    const db = getDb();
    const { data, error } = await db
        .from('events')
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'polymarket_event_id' })
        .select('id')
        .single();
    if (error) {
        log.error(`upsert event ${row.polymarket_event_id} failed`, error.message);
        return null;
    }
    return data?.id ?? null;
}
export async function upsertMarket(row) {
    const db = getDb();
    const { data, error } = await db
        .from('markets')
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'polymarket_market_id' })
        .select('id')
        .single();
    if (error) {
        log.error(`upsert market ${row.polymarket_market_id} failed`, error.message);
        return null;
    }
    return data?.id ?? null;
}
export async function upsertOutcome(row) {
    const db = getDb();
    const payload = { ...row, updated_at: new Date().toISOString() };
    const { data, error } = await db
        .from('outcomes')
        .upsert(payload, { onConflict: 'market_id' })
        .select('id')
        .single();
    if (error) {
        // If columns don't exist yet (pre-migration), retry without them
        if (error.message?.toLowerCase().includes('could not find') && error.message?.toLowerCase().includes('column')) {
            const safe = { ...payload };
            delete safe.estimated_end_min;
            delete safe.estimated_end_max;
            const { data: d2, error: e2 } = await db
                .from('outcomes')
                .upsert(safe, { onConflict: 'market_id' })
                .select('id')
                .single();
            if (e2) {
                log.error(`upsert outcome for market ${row.market_id} failed`, e2.message);
                return null;
            }
            return d2?.id ?? null;
        }
        log.error(`upsert outcome for market ${row.market_id} failed`, error.message);
        return null;
    }
    return data?.id ?? null;
}
export async function getActiveEventsWithMarkets() {
    const db = getDb();
    const results = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
        const { data, error } = await db
            .from('events')
            .select('*, markets(*)')
            .eq('active', true)
            .eq('closed', false)
            .range(from, from + pageSize - 1);
        if (error) {
            log.error('getActiveEventsWithMarkets failed', error.message);
            break;
        }
        if (!data || data.length === 0) break;
        results.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return results
        .map(event => ({
            ...event,
            markets: (event.markets || []).filter(m => m.active && !m.closed),
        }))
        .filter(event => event.markets.length > 0);
}
// ─── Query helpers ───
export async function getMarketDbId(polymarketMarketId) {
    const db = getDb();
    const { data } = await db
        .from('markets')
        .select('id')
        .eq('polymarket_market_id', polymarketMarketId)
        .single();
    return data?.id ?? null;
}
export async function getActiveMarkets() {
    const db = getDb();
    const results = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
        const { data, error } = await db
            .from('markets')
            .select('*')
            .eq('active', true)
            .eq('closed', false)
            .range(from, from + pageSize - 1);
        if (error) {
            log.error('getActiveMarkets failed', error.message);
            break;
        }
        if (!data || data.length === 0)
            break;
        results.push(...data);
        if (data.length < pageSize)
            break;
        from += pageSize;
    }
    return results;
}
