/**
 * Migration script: Move data from alphafinder_events/alphafinder_markets
 * into the events/markets tables, then drop the old tables.
 *
 * Usage: node scripts/migrate-alphafinder.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Column whitelists (must match schema.sql) ───────────────────────────────

const EVENT_COLS = [
  'polymarket_event_id', 'title', 'description', 'slug', 'tags', 'image',
  'start_date', 'end_date', 'neg_risk', 'neg_risk_market_id',
  'active', 'closed', 'markets_count', 'total_volume',
];

const MARKET_COLS = [
  'polymarket_market_id', 'condition_id', 'question_id', 'question',
  'question_normalized', 'description', 'slug', 'outcomes', 'outcome_prices',
  'clob_token_ids', 'best_ask', 'last_trade_price', 'spread',
  'volume', 'volume_clob', 'volume_1d', 'volume_1wk', 'volume_1mo',
  'one_day_price_change', 'end_date', 'resolution_source', 'resolved_by',
  'active', 'closed', 'accepting_orders', 'neg_risk', 'automatically_resolved',
];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchAll(table) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await db.from(table).select('*').range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchAll ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// ── migrate events ───────────────────────────────────────────────────────────

async function migrateEvents() {
  const srcRows = await fetchAll('alphafinder_events');
  console.log(`Found ${srcRows.length} rows in alphafinder_events`);
  if (srcRows.length === 0) return {};

  // old_id → polymarket_event_id
  const oldIdMap = {};
  for (const row of srcRows) {
    oldIdMap[row.id] = row.polymarket_event_id;
  }

  // Batch upsert in chunks of 200
  let ok = 0, fail = 0;
  const BATCH = 200;
  for (let i = 0; i < srcRows.length; i += BATCH) {
    const batch = srcRows.slice(i, i + BATCH).map(row => ({
      ...pick(row, EVENT_COLS),
      updated_at: new Date().toISOString(),
    }));
    const { error } = await db
      .from('events')
      .upsert(batch, { onConflict: 'polymarket_event_id' });
    if (error) {
      console.error(`  events batch ${i}: ${error.message}`);
      fail += batch.length;
    } else {
      ok += batch.length;
    }
  }
  console.log(`Events migrated: ${ok} ok, ${fail} failed`);
  return oldIdMap;
}

// ── migrate markets ──────────────────────────────────────────────────────────

async function migrateMarkets(oldEventIdMap) {
  const srcRows = await fetchAll('alphafinder_markets');
  console.log(`Found ${srcRows.length} rows in alphafinder_markets`);
  if (srcRows.length === 0) return;

  // Build lookup: polymarket_event_id → new events.id
  const newEventIdLookup = {};
  const polyEventIds = [...new Set(Object.values(oldEventIdMap))];
  for (let i = 0; i < polyEventIds.length; i += 50) {
    const batch = polyEventIds.slice(i, i + 50);
    const { data } = await db
      .from('events')
      .select('id, polymarket_event_id')
      .in('polymarket_event_id', batch);
    if (data) {
      for (const r of data) newEventIdLookup[r.polymarket_event_id] = r.id;
    }
  }
  console.log(`Built event ID lookup (${Object.keys(newEventIdLookup).length} entries)`);

  let ok = 0, fail = 0, skipped = 0;
  const BATCH = 200;

  // Prepare all rows first
  const prepared = [];
  for (const row of srcRows) {
    const polyEventId = oldEventIdMap[row.event_id];
    const newEventId = polyEventId ? newEventIdLookup[polyEventId] : null;
    if (!newEventId) {
      skipped++;
      continue;
    }
    prepared.push({
      ...pick(row, MARKET_COLS),
      event_id: newEventId,
      updated_at: new Date().toISOString(),
    });
  }

  // Batch upsert
  for (let i = 0; i < prepared.length; i += BATCH) {
    const batch = prepared.slice(i, i + BATCH);
    const { error } = await db
      .from('markets')
      .upsert(batch, { onConflict: 'polymarket_market_id' });
    if (error) {
      console.error(`  markets batch ${i}: ${error.message}`);
      fail += batch.length;
    } else {
      ok += batch.length;
    }
    if (i % 2000 === 0 && i > 0) console.log(`  ... ${i}/${prepared.length} markets processed`);
  }
  console.log(`Markets migrated: ${ok} ok, ${fail} failed, ${skipped} skipped (no event match)`);
}

// ── drop old tables ──────────────────────────────────────────────────────────

async function dropOldTables() {
  for (const table of ['alphafinder_markets', 'alphafinder_events']) {
    const { error } = await db.rpc('exec_sql', {
      query: `DROP TABLE IF EXISTS ${table} CASCADE`
    });
    if (error) {
      console.warn(`Could not drop ${table} via rpc: ${error.message}`);
      console.warn(`  → Drop manually in Supabase SQL Editor: DROP TABLE IF EXISTS ${table} CASCADE;`);
    } else {
      console.log(`Dropped table ${table}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Alphafinder → Events/Markets Migration ===\n');

  const { count: srcEventCount, error: e1 } = await db
    .from('alphafinder_events').select('*', { count: 'exact', head: true });
  const { count: srcMarketCount, error: e2 } = await db
    .from('alphafinder_markets').select('*', { count: 'exact', head: true });

  if (e1 || e2) {
    console.error('Cannot read alphafinder tables. Do they exist?');
    if (e1) console.error('  alphafinder_events:', e1.message);
    if (e2) console.error('  alphafinder_markets:', e2.message);
    process.exit(1);
  }
  console.log(`Source: ${srcEventCount} events, ${srcMarketCount} markets\n`);

  const oldIdMap = await migrateEvents();
  console.log('');
  await migrateMarkets(oldIdMap);

  console.log('\n--- Verification ---');
  const { count: dstEvents } = await db.from('events').select('*', { count: 'exact', head: true });
  const { count: dstMarkets } = await db.from('markets').select('*', { count: 'exact', head: true });
  console.log(`Target: ${dstEvents} events, ${dstMarkets} markets`);

  console.log('\n--- Dropping old tables ---');
  await dropOldTables();

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
