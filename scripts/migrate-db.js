/**
 * One-off script to migrate all data from old Supabase to new Supabase.
 *
 * Prerequisites:
 *   1. Run schema.sql in the new Supabase Dashboard SQL Editor first.
 *   2. npm install @supabase/supabase-js (already installed)
 *
 * Usage:
 *   node scripts/migrate-db.js
 */

import { createClient } from '@supabase/supabase-js';

// ─── Old & New credentials ───

const OLD_URL = 'https://yitqtpzsrvsdworcwsfb.supabase.co';
const OLD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpdHF0cHpzcnZzZHdvcmN3c2ZiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTc3NDM0MywiZXhwIjoyMDg1MzUwMzQzfQ.cLI1pKo4nvAsLFFYmgeFARiw52FqhvykZu86BmOg-ZE';

const NEW_URL = 'https://xcmnrucckdxytnxovtrd.supabase.co';
const NEW_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhjbW5ydWNja2R4eXRueG92dHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjA0MTAwNywiZXhwIjoyMDg3NjE3MDA3fQ.HHekvDAtmhYKZiaL1nU59MSwEpOGnDlSioPS1vllE2c';

const oldDb = createClient(OLD_URL, OLD_KEY);
const newDb = createClient(NEW_URL, NEW_KEY);

// ─── Helpers ───

async function fetchAll(db, table, orderBy = 'id') {
    const rows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
        const { data, error } = await db
            .from(table)
            .select('*')
            .order(orderBy, { ascending: true })
            .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`Read ${table} failed: ${error.message}`);
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
    }
    return rows;
}

async function insertBatch(db, table, rows, batchSize = 50) {
    const inserted = [];
    for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const { data, error } = await db
            .from(table)
            .insert(chunk)
            .select('*');
        if (error) {
            console.error(`Insert ${table} batch ${i}–${i + chunk.length} failed:`, error.message);
            // Try one-by-one for the failed batch
            for (const row of chunk) {
                const { data: d, error: e } = await db.from(table).insert(row).select('*');
                if (e) {
                    console.error(`  Skip ${table} row:`, e.message, JSON.stringify(row).slice(0, 100));
                } else if (d) {
                    inserted.push(...d);
                }
            }
        } else if (data) {
            inserted.push(...data);
        }
    }
    return inserted;
}

// ─── Main migration ───

async function main() {
    console.log('=== Supabase Database Migration ===\n');

    // 1. Verify connectivity
    console.log('Verifying connectivity...');
    const { error: oldErr } = await oldDb.from('events').select('id').limit(1);
    if (oldErr) { console.error('Cannot connect to OLD DB:', oldErr.message); process.exit(1); }
    const { error: newErr } = await newDb.from('events').select('id').limit(1);
    if (newErr) { console.error('Cannot connect to NEW DB:', newErr.message); process.exit(1); }
    console.log('Both databases connected.\n');

    // 2. Events
    console.log('Reading events...');
    const oldEvents = await fetchAll(oldDb, 'events');
    console.log(`  ${oldEvents.length} events found`);

    const eventsToInsert = oldEvents.map(e => {
        const { id, last_checked_at, ...rest } = e; // strip auto-generated id + extra columns
        return rest;
    });

    console.log('Inserting events into new DB...');
    const newEvents = await insertBatch(newDb, 'events', eventsToInsert);
    console.log(`  ${newEvents.length} events inserted`);

    // Build old event ID → new event ID mapping (via polymarket_event_id)
    const eventIdMap = new Map(); // old id → new id
    const eventByPmId = new Map(newEvents.map(e => [e.polymarket_event_id, e.id]));
    for (const old of oldEvents) {
        const newId = eventByPmId.get(old.polymarket_event_id);
        if (newId) eventIdMap.set(old.id, newId);
    }
    console.log(`  ${eventIdMap.size} event ID mappings created\n`);

    // 3. Markets
    console.log('Reading markets...');
    const oldMarkets = await fetchAll(oldDb, 'markets');
    console.log(`  ${oldMarkets.length} markets found`);

    const marketsToInsert = oldMarkets.map(m => {
        const { id, ...rest } = m;
        // Remap event_id FK
        rest.event_id = eventIdMap.get(m.event_id) || null;
        return rest;
    });

    // Warn about unmapped FKs
    const unmappedEvents = marketsToInsert.filter(m => m.event_id === null && oldMarkets.find(om => om.polymarket_market_id === m.polymarket_market_id)?.event_id !== null);
    if (unmappedEvents.length > 0) {
        console.warn(`  WARNING: ${unmappedEvents.length} markets have unmapped event_id FKs`);
    }

    console.log('Inserting markets into new DB...');
    const newMarkets = await insertBatch(newDb, 'markets', marketsToInsert);
    console.log(`  ${newMarkets.length} markets inserted`);

    // Build old market ID → new market ID mapping
    const marketIdMap = new Map();
    const marketByPmId = new Map(newMarkets.map(m => [m.polymarket_market_id, m.id]));
    for (const old of oldMarkets) {
        const newId = marketByPmId.get(old.polymarket_market_id);
        if (newId) marketIdMap.set(old.id, newId);
    }
    console.log(`  ${marketIdMap.size} market ID mappings created\n`);

    // 4. Outcomes
    console.log('Reading outcomes...');
    const oldOutcomes = await fetchAll(oldDb, 'outcomes');
    console.log(`  ${oldOutcomes.length} outcomes found`);

    const outcomesToInsert = oldOutcomes.map(o => {
        const { id, estimated_end, ...rest } = o; // strip id + extra columns
        rest.market_id = marketIdMap.get(o.market_id) || null;
        return rest;
    }).filter(o => o.market_id !== null); // skip orphans

    const skippedOutcomes = oldOutcomes.length - outcomesToInsert.length;
    if (skippedOutcomes > 0) {
        console.warn(`  WARNING: ${skippedOutcomes} outcomes skipped (unmapped market_id)`);
    }

    console.log('Inserting outcomes into new DB...');
    const newOutcomes = await insertBatch(newDb, 'outcomes', outcomesToInsert);
    console.log(`  ${newOutcomes.length} outcomes inserted\n`);

    // 5. Edge predictions
    console.log('Reading edge_predictions...');
    const oldPreds = await fetchAll(oldDb, 'edge_predictions');
    console.log(`  ${oldPreds.length} edge_predictions found`);

    if (oldPreds.length > 0) {
        const predsToInsert = oldPreds.map(p => {
            const { id, ...rest } = p;
            return rest;
        });

        console.log('Inserting edge_predictions into new DB...');
        const newPreds = await insertBatch(newDb, 'edge_predictions', predsToInsert);
        console.log(`  ${newPreds.length} edge_predictions inserted\n`);
    } else {
        console.log('  (empty table, skipping)\n');
    }

    // 6. Summary
    console.log('=== Migration Complete ===');
    console.log(`  events:           ${oldEvents.length} → ${newEvents.length}`);
    console.log(`  markets:          ${oldMarkets.length} → ${newMarkets.length}`);
    console.log(`  outcomes:         ${oldOutcomes.length} → ${newOutcomes.length}`);
    console.log(`  edge_predictions: ${oldPreds.length}`);
    console.log('\nNext: update .env with new SUPABASE_URL and SUPABASE_SERVICE_KEY');
}

main().catch(e => {
    console.error('Migration failed:', e);
    process.exit(1);
});
