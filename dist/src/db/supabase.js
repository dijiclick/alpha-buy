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
// ─── Batch upserts (50x faster than single-row) ───
export async function upsertEventsBatch(rows) {
    if (rows.length === 0) return new Map();
    const db = getDb();
    const now = new Date().toISOString();
    const payload = rows.map(r => ({ ...r, updated_at: now }));
    const idMap = new Map(); // polymarket_event_id → db id
    // Supabase has payload size limits, batch in chunks of 50
    const BATCH = 50;
    for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH);
        const { data, error } = await db
            .from('events')
            .upsert(chunk, { onConflict: 'polymarket_event_id' })
            .select('id, polymarket_event_id');
        if (error) {
            log.error(`batch upsert events failed (chunk ${i / BATCH})`, error.message);
            continue;
        }
        for (const row of data || []) {
            idMap.set(row.polymarket_event_id, row.id);
        }
    }
    return idMap;
}
export async function upsertMarketsBatch(rows) {
    if (rows.length === 0) return new Map();
    const db = getDb();
    const now = new Date().toISOString();
    const payload = rows.map(r => ({ ...r, updated_at: now }));
    const idMap = new Map(); // polymarket_market_id → db id
    const BATCH = 100;
    for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH);
        const { data, error } = await db
            .from('markets')
            .upsert(chunk, { onConflict: 'polymarket_market_id' })
            .select('id, polymarket_market_id');
        if (error) {
            log.error(`batch upsert markets failed (chunk ${i / BATCH})`, error.message);
            continue;
        }
        for (const row of data || []) {
            idMap.set(row.polymarket_market_id, row.id);
        }
    }
    return idMap;
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
export async function getAllOpenEvents() {
    const db = getDb();
    const events = [];
    let from = 0;
    const pageSize = 500;
    const marketCols = 'id,polymarket_market_id,question,description,slug,outcomes,outcome_prices,clob_token_ids,best_ask,last_trade_price,closed,end_date';
    while (true) {
        const { data, error } = await db
            .from('events')
            .select(`id,polymarket_event_id,title,description,slug,end_date,closed,markets(${marketCols})`)
            .eq('closed', false)
            .range(from, from + pageSize - 1);
        if (error) {
            log.error('getAllOpenEvents failed', error.message);
            break;
        }
        if (!data || data.length === 0) break;
        events.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return events
        .map(event => ({
            ...event,
            markets: (event.markets || []).filter(m => !m.closed),
        }))
        .filter(event => event.markets.length > 0);
}
export async function getEventsByPolymarketIds(eventIds) {
    if (eventIds.length === 0) return [];
    const db = getDb();
    const events = [];
    const batchSize = 100;
    for (let i = 0; i < eventIds.length; i += batchSize) {
        const batch = eventIds.slice(i, i + batchSize);
        const { data, error } = await db
            .from('events')
            .select('*, markets(*)')
            .in('polymarket_event_id', batch)
            .eq('active', true)
            .eq('closed', false);
        if (error) {
            log.error('getEventsByPolymarketIds failed', error.message);
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
    // Direct DB query: find market whose clob_token_ids JSON array contains this tokenId
    const { data: market } = await db
        .from('markets')
        .select('event_id')
        .eq('active', true)
        .eq('closed', false)
        .like('clob_token_ids', `%${tokenId}%`)
        .limit(1)
        .single();
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
export async function updateEventLastChecked(polymarketEventId) {
    const db = getDb();
    const { error } = await db
        .from('events')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('polymarket_event_id', polymarketEventId);
    if (error) {
        log.error(`updateEventLastChecked ${polymarketEventId} failed`, error.message);
    }
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
