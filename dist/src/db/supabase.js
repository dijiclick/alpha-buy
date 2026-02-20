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
export async function closeStaleEvents(activeGammaIds) {
    const db = getDb();
    // Get all polymarket_event_ids that are active+open in our DB
    const dbActiveIds = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
        const { data, error } = await db
            .from('events')
            .select('polymarket_event_id')
            .eq('active', true)
            .eq('closed', false)
            .range(from, from + pageSize - 1);
        if (error) {
            log.error('closeStaleEvents query failed', error.message);
            return 0;
        }
        if (!data || data.length === 0) break;
        dbActiveIds.push(...data.map(r => r.polymarket_event_id));
        if (data.length < pageSize) break;
        from += pageSize;
    }
    // Find DB events no longer in Gamma's active results → they closed/resolved
    const staleIds = dbActiveIds.filter(id => !activeGammaIds.has(id));
    if (staleIds.length === 0) return 0;
    const now = new Date().toISOString();
    // Mark events as closed
    const { error: evErr } = await db
        .from('events')
        .update({ closed: true, updated_at: now })
        .in('polymarket_event_id', staleIds);
    if (evErr) {
        log.error('closeStaleEvents (events) failed', evErr.message);
        return 0;
    }
    // Get DB IDs of those events to close their markets too
    const { data: eventRows } = await db
        .from('events')
        .select('id')
        .in('polymarket_event_id', staleIds);
    if (eventRows?.length) {
        const { error: mktErr } = await db
            .from('markets')
            .update({ closed: true, updated_at: now })
            .in('event_id', eventRows.map(r => r.id));
        if (mktErr) {
            log.error('closeStaleEvents (markets) failed', mktErr.message);
        }
    }
    log.info(`Closed ${staleIds.length} stale events (no longer active on Polymarket)`);
    return staleIds.length;
}
export async function getHighPriceEvents(threshold) {
    const db = getDb();
    // Get markets where price indicates a likely outcome (≥ threshold)
    const results = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
        const { data, error } = await db
            .from('markets')
            .select('event_id')
            .eq('active', true)
            .eq('closed', false)
            .or(`best_ask.gte.${threshold},last_trade_price.gte.${threshold}`)
            .range(from, from + pageSize - 1);
        if (error) {
            log.error('getHighPriceEvents failed', error.message);
            break;
        }
        if (!data || data.length === 0) break;
        results.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    // Get unique event IDs
    const eventIds = [...new Set(results.map(r => r.event_id))];
    if (eventIds.length === 0) return [];
    // Fetch those events with their markets
    const events = [];
    // Supabase .in() has practical limits, batch if needed
    const batchSize = 100;
    for (let i = 0; i < eventIds.length; i += batchSize) {
        const batch = eventIds.slice(i, i + batchSize);
        const { data, error } = await db
            .from('events')
            .select('*, markets(*)')
            .in('id', batch)
            .eq('active', true)
            .eq('closed', false);
        if (error) {
            log.error('getHighPriceEvents (events) failed', error.message);
            continue;
        }
        if (data) events.push(...data);
    }
    return events
        .map(event => ({
            ...event,
            markets: (event.markets || []).filter(m => m.active && !m.closed),
        }))
        .filter(event => event.markets.length > 0);
}
export async function getEventByMarketTokenId(tokenId) {
    const db = getDb();
    // Find market containing this token ID, return its event with all markets
    const { data: markets } = await db
        .from('markets')
        .select('event_id, clob_token_ids')
        .eq('active', true)
        .eq('closed', false);
    if (!markets) return null;
    const market = markets.find(m => {
        const ids = typeof m.clob_token_ids === 'string'
            ? JSON.parse(m.clob_token_ids) : m.clob_token_ids;
        return ids && ids.includes(tokenId);
    });
    if (!market) return null;
    const { data: event } = await db
        .from('events')
        .select('*, markets(*)')
        .eq('id', market.event_id)
        .single();
    if (!event) return null;
    return {
        ...event,
        markets: (event.markets || []).filter(m => m.active && !m.closed),
    };
}
export async function getAllActiveTokenIds() {
    const db = getDb();
    const results = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
        const { data, error } = await db
            .from('markets')
            .select('clob_token_ids')
            .eq('active', true)
            .eq('closed', false)
            .not('clob_token_ids', 'is', null)
            .range(from, from + pageSize - 1);
        if (error) {
            log.error('getAllActiveTokenIds failed', error.message);
            break;
        }
        if (!data || data.length === 0) break;
        for (const row of data) {
            const ids = typeof row.clob_token_ids === 'string'
                ? JSON.parse(row.clob_token_ids) : row.clob_token_ids;
            if (Array.isArray(ids)) {
                // Only push YES token (index 0) — that's what we watch for spikes
                if (ids[0]) results.push(ids[0]);
            }
        }
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return results;
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
