import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { spawn, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { loadAlertState, saveAlertState, isDuplicateWithinWindow, markSent } from './alert_state.mjs';
import { sendEdgeTelegramAlert } from './telegram.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = join(__dirname, 'cache');
const REPORT_DIR = join(__dirname, 'reports');
const CACHE_FILE = join(CACHE_DIR, 'prediction_cache.json');
const ALERT_STATE_FILE = join(CACHE_DIR, 'alert_state.json');

// ─── Env helpers ───

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function commandExists(cmd) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('cmd', ['/c', 'where', cmd], { stdio: 'ignore' });
      return r.status === 0;
    }
    const r = spawnSync('sh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function resolvePythonCmd(preferred) {
  if (preferred && commandExists(preferred)) return preferred;
  if (preferred === 'uv' && commandExists('python')) {
    console.warn('[edge] WARN: uv not found; falling back to python');
    return 'python';
  }
  if (!preferred && commandExists('python')) return 'python';
  throw new Error(`Python runner not found: ${preferred || 'python'}`);
}

// ─── Config ───

const cfg = {
  SUPABASE_URL: env('SUPABASE_URL'),
  SUPABASE_KEY: env('SUPABASE_SERVICE_KEY'),
  PYTHON_CMD: resolvePythonCmd(process.env.PYTHON_CMD || 'uv'),
  BRIDGE_PATH: process.env.CONSTRAINT_BRIDGE_PATH || join(__dirname, 'constraint_bridge.py'),
  GAMMA_BASE: process.env.GAMMA_BASE || 'https://gamma-api.polymarket.com',
  CLOB_BASE: process.env.EDGE_CLOB_BASE || 'https://clob.polymarket.com',
  HORIZON_HOURS: numEnv('EDGE_HORIZON_HOURS', 24),
  HORIZON_BUFFER_MINS: numEnv('EDGE_HORIZON_BUFFER_MINS', 10),
  MAX_EVENTS: numEnv('EDGE_MAX_EVENTS', 200),
  MAX_MARKETS_PER_EVENT: numEnv('EDGE_MAX_MARKETS_PER_EVENT', 15),
  MIN_PROBABILITY: numEnv('EDGE_MIN_PROBABILITY', 80),
  MAX_BUY_PRICE: numEnv('EDGE_MAX_BUY_PRICE', 0.95),
  MIN_PROFIT_PCT: numEnv('EDGE_MIN_PROFIT_PCT', 5),
  CACHE_TTL_HOURS: numEnv('EDGE_CACHE_TTL_HOURS', 2),
  REPORT_TOP_N: numEnv('EDGE_REPORT_TOP_N', 40),
  MAX_BRIDGE_WORKERS: numEnv('EDGE_MAX_BRIDGE_WORKERS', 3),
  QUERY_RETRIES: Math.max(0, Math.floor(numEnv('EDGE_QUERY_RETRIES', 2))),
  RETRY_BACKOFF_MS: Math.max(250, Math.floor(numEnv('EDGE_RETRY_BACKOFF_MS', 1500))),
  TELEGRAM_ENABLED: boolEnv('EDGE_TELEGRAM_ENABLED', true),
  ALERT_DEDUPE_HOURS: numEnv('EDGE_ALERT_DEDUPE_HOURS', 4),
  ALERT_TOP_N: Math.max(1, Math.floor(numEnv('EDGE_ALERT_TOP_N', 10))),
};

// ─── Blocked categories ───

const BLOCKED_TITLE_PATTERNS = [
  // Soccer
  /\bsoccer\b/i, /\bfootball\b(?!.*american)/i, /\bUEFA\b/i, /\bFIFA\b/i,
  /\bPremier League\b/i, /\bLa Liga\b/i, /\bSerie A\b/i, /\bBundesliga\b/i,
  /\bChampions League\b/i, /\bMLS\b/i, /\bEuro\s*\d/i, /\bLigue 1\b/i,
  /\bEredivisie\b/i, /\bEPL\b/i,
  // Basketball
  /\bbasketball\b/i, /\bNBA\b/, /\bWNBA\b/, /\bNCAA basketball\b/i,
  /\bMarch Madness\b/i, /\bNCAA\b.*\b(men|women).*basketball/i,
  // Baseball
  /\bbaseball\b/i, /\bMLB\b/, /\bWorld Series\b/i,
  // Crypto
  /\bbitcoin\b/i, /\bethereum\b/i, /\bBTC\b/, /\bETH\b/,
  /\bcrypto\b/i, /\btoken price\b/i, /\bsolana\b/i, /\bSOL\b/,
  /\bdogecoin\b/i, /\bDOGE\b/, /\bcardano\b/i, /\bADA\b/,
  /\bXRP\b/, /\bripple\b/i,
];

function isBlockedEvent(title) {
  for (const pat of BLOCKED_TITLE_PATTERNS) {
    if (pat.test(title)) return true;
  }
  return false;
}

// ─── Utilities ───

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonMaybe(v, fallback) {
  if (v == null) return fallback;
  if (Array.isArray(v) || typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function yesPrice(market) {
  const direct = [
    toNum(market.best_ask),
    toNum(market.bestAsk),
    toNum(market.last_trade_price),
    toNum(market.lastTradePrice),
  ].find(v => v != null && v >= 0 && v <= 1);
  if (direct != null) return direct;

  const outcomes = parseJsonMaybe(market.outcomes, null);
  const prices = parseJsonMaybe(market.outcome_prices, null);
  if (!Array.isArray(prices) || prices.length === 0) return null;
  let idx = 0;
  if (Array.isArray(outcomes)) {
    const i = outcomes.findIndex(x => String(x).toLowerCase() === 'yes');
    if (i >= 0) idx = i;
  }
  const p = toNum(prices[idx]);
  if (p == null || p < 0 || p > 1) return null;
  return p;
}

function marketUrl(eventSlug, marketSlug) {
  if (marketSlug) return `https://polymarket.com/event/${eventSlug || ''}/${marketSlug}`.replace(/\/+$/, '');
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  return '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDirs() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
}

// ─── Cache ───

function loadCache() {
  ensureDirs();
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch { return {}; }
}

function saveCache(cache) {
  ensureDirs();
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function predictionCacheKey(event) {
  return `${event.polymarket_event_id}|${event.end_date || ''}`;
}

function isCacheFresh(entry) {
  if (!entry || !entry.cached_at) return false;
  const ts = new Date(entry.cached_at).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < cfg.CACHE_TTL_HOURS * 3600_000;
}

// ─── Perplexity tokens ───

function getPerplexityTokens() {
  const out = [];
  const first = process.env.PERPLEXITY_SESSION_TOKEN;
  if (!first) throw new Error('Missing env: PERPLEXITY_SESSION_TOKEN');
  out.push(first);
  for (let i = 2; i <= 10; i++) {
    const t = process.env[`PERPLEXITY_SESSION_TOKEN_${i}`];
    if (t) out.push(t);
  }
  return out;
}

// ─── Bridge ───

class Bridge {
  constructor(token, index) {
    this.index = index;
    this.dead = false;
    this.waiters = [];
    this.buffer = '';

    const args = cfg.PYTHON_CMD === 'uv'
      ? ['run', '--script', cfg.BRIDGE_PATH, '--server']
      : [cfg.BRIDGE_PATH, '--server'];

    this.child = spawn(cfg.PYTHON_CMD, args, {
      env: { ...process.env, PERPLEXITY_SESSION_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const w = this.waiters.shift();
        if (w) w.resolve(line);
      }
    });

    this.child.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (!msg) return;
      if (/RATE_LIMITED|SESSION_ERR|ERROR|WARN|FAILED|COOLDOWN/i.test(msg)) {
        process.stderr.write(`[bridge#${this.index}] ${msg}\n`);
      }
    });

    this.child.on('close', (code) => {
      this.dead = true;
      while (this.waiters.length) {
        const w = this.waiters.shift();
        w?.reject(new Error(`Bridge#${this.index} exited with code ${code}`));
      }
    });

    this.child.on('error', (err) => {
      this.dead = true;
      while (this.waiters.length) {
        const w = this.waiters.shift();
        w?.reject(err);
      }
    });
  }

  query(payload, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error(`Bridge#${this.index} is dead`));
      const waiter = { resolve: null, reject: null, done: false, timer: null };
      waiter.resolve = (line) => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timer);
        resolve(line);
      };
      waiter.reject = (err) => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timer);
        reject(err);
      };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Bridge#${this.index} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push(waiter);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  kill() {
    this.dead = true;
    this.child.kill();
  }
}

class BridgePool {
  constructor(tokens) {
    this.bridges = tokens.map((t, i) => new Bridge(t, i));
    this.ptr = 0;
  }

  next() {
    if (this.bridges.length === 0) throw new Error('No bridges available');
    const n = this.bridges.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.ptr + i) % n;
      const b = this.bridges[idx];
      if (!b.dead) {
        this.ptr = (idx + 1) % n;
        return b;
      }
    }
    throw new Error('All bridges are dead');
  }

  async query(payload) {
    const b = this.next();
    const line = await b.query(payload);
    const parsed = JSON.parse(line);
    if (parsed?.error) throw new Error(parsed.error);
    return parsed;
  }

  close() {
    for (const b of this.bridges) b.kill();
  }
}

function normalizeErrorMessage(msg) {
  return String(msg || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function isRetryableError(msg) {
  const m = normalizeErrorMessage(msg).toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('rate_limit') ||
    m.includes('rate limit') ||
    m.includes('429') ||
    m.includes('temporarily unavailable') ||
    m.includes('capacity') ||
    m.includes('cooldown')
  );
}

async function queryWithRetries(pool, payload) {
  let attempt = 0;
  while (true) {
    try {
      return await pool.query(payload);
    } catch (e) {
      attempt++;
      const msg = normalizeErrorMessage(e?.message || e);
      if (attempt > cfg.QUERY_RETRIES || !isRetryableError(msg)) {
        throw new Error(msg);
      }
      const wait = cfg.RETRY_BACKOFF_MS * attempt;
      await sleep(wait);
    }
  }
}

// ─── Fetch events from Supabase ───

async function fetchEvents(db) {
  const out = [];
  let from = 0;
  const pageSize = 300;
  const now = Date.now();
  const horizonMs = (cfg.HORIZON_HOURS * 60 + cfg.HORIZON_BUFFER_MINS) * 60_000;

  while (out.length < cfg.MAX_EVENTS) {
    const { data: eventRows, error: evErr } = await db
      .from('events')
      .select('id,polymarket_event_id,title,description,slug,end_date,active,closed')
      .eq('closed', false)
      .eq('active', true)
      .range(from, from + pageSize - 1);

    if (evErr) throw new Error(`Supabase events query failed: ${evErr.message}`);
    if (!eventRows || eventRows.length === 0) break;

    const eligibleEvents = [];
    for (const ev of eventRows) {
      // Must have an end_date
      const endTs = ev.end_date ? new Date(ev.end_date).getTime() : NaN;
      if (!Number.isFinite(endTs)) continue;
      // Must end within horizon
      if (endTs - now > horizonMs) continue;
      // Must not have already ended more than 1 hour ago (allow buffer for late resolution)
      if (endTs < now - 3600_000) continue;
      // Not blocked category
      if (isBlockedEvent(ev.title || '')) continue;
      eligibleEvents.push(ev);
    }

    if (eligibleEvents.length > 0) {
      const ids = eligibleEvents.map(e => e.id);
      const marketsByEvent = new Map(ids.map(id => [id, []]));

      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { data: marketRows, error: mkErr } = await db
          .from('markets')
          .select('event_id,polymarket_market_id,question,description,slug,outcomes,outcome_prices,best_ask,last_trade_price,clob_token_ids,active,closed,end_date,updated_at')
          .in('event_id', batch)
          .eq('active', true)
          .eq('closed', false);
        if (mkErr) throw new Error(`Supabase markets query failed: ${mkErr.message}`);
        for (const m of marketRows || []) {
          if (!marketsByEvent.has(m.event_id)) continue;
          marketsByEvent.get(m.event_id).push(m);
        }
      }

      for (const ev of eligibleEvents) {
        const markets = (marketsByEvent.get(ev.id) || [])
          .map(m => ({ ...m, yesPrice: yesPrice(m) }))
          .filter(m => m.yesPrice != null)
          .slice(0, cfg.MAX_MARKETS_PER_EVENT);

        if (markets.length === 0) continue;
        out.push({
          polymarket_event_id: ev.polymarket_event_id,
          title: ev.title,
          description: ev.description,
          slug: ev.slug,
          end_date: ev.end_date,
          markets,
        });
        if (out.length >= cfg.MAX_EVENTS) break;
      }
    }

    if (eventRows.length < pageSize || out.length >= cfg.MAX_EVENTS) break;
    from += pageSize;
  }

  return out;
}

// ─── Gamma pre-flight ───

async function isEventClosedOnGamma(event) {
  try {
    const res = await fetch(`${cfg.GAMMA_BASE}/events/${event.polymarket_event_id}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.closed === true;
  } catch {
    return false;
  }
}

// ─── Live price fetching ───

async function fetchLivePrices(market) {
  // Try Gamma API first
  try {
    const res = await fetch(`${cfg.GAMMA_BASE}/markets/${market.polymarket_market_id}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const yes = toNum(data?.bestAsk ?? data?.best_ask ?? data?.lastTradePrice ?? data?.last_trade_price);
      if (yes != null && yes >= 0 && yes <= 1) {
        return { yesPrice: yes, noPrice: Number((1 - yes).toFixed(4)), source: 'gamma', closed: data?.closed === true };
      }
    }
  } catch { /* fallthrough */ }

  // Fallback to stored price
  const stored = yesPrice(market);
  if (stored != null) {
    return { yesPrice: stored, noPrice: Number((1 - stored).toFixed(4)), source: 'stored', closed: false };
  }

  return null;
}

// ─── Build prediction payload ───

function buildPayload(event, calibrationData) {
  const payload = {
    event_title: event.title,
    event_description: event.description || '',
    end_date: event.end_date || '',
    market_questions: event.markets.map(m => m.question),
    market_descriptions: event.markets.map(m => m.description || ''),
  };
  if (calibrationData) payload.calibration = calibrationData;
  return payload;
}

// ─── DB: upsert prediction ───

async function upsertEdgePrediction(db, row) {
  const payload = { ...row, updated_at: new Date().toISOString() };
  // Cap profit_pct to prevent NUMERIC(8,4) overflow (max 9999.9999)
  if (payload.profit_pct != null && payload.profit_pct > 9999) payload.profit_pct = 9999;
  const { data, error } = await db
    .from('edge_predictions')
    .upsert(payload, { onConflict: 'event_id,market_id' })
    .select('id')
    .single();
  if (error) {
    console.error(`[edge] upsert prediction failed for ${row.market_id}:`, error.message);
    return null;
  }
  return data?.id ?? null;
}

// ─── Resolution checker ───

const ACCURACY_STATS_FILE = join(CACHE_DIR, 'accuracy_stats.json');
const RESOLVE_BATCH_SIZE = numEnv('EDGE_RESOLVE_BATCH_SIZE', 100);
const RESOLVE_MIN_AGE_HOURS = numEnv('EDGE_RESOLVE_MIN_AGE_HOURS', 1);
const CALIBRATION_MIN_SAMPLES = numEnv('EDGE_CALIBRATION_MIN_SAMPLES', 20);

async function checkResolutions(db) {
  const cutoff = new Date(Date.now() - RESOLVE_MIN_AGE_HOURS * 3600_000).toISOString();

  const { data: unresolved, error } = await db
    .from('edge_predictions')
    .select('id, market_id, predicted_outcome, event_title')
    .is('actual_outcome', null)
    .lt('event_end_date', cutoff)
    .limit(RESOLVE_BATCH_SIZE);

  if (error) {
    console.error('[edge] checkResolutions query failed:', error.message);
    return;
  }
  if (!unresolved || unresolved.length === 0) {
    console.log('[edge] no unresolved predictions to check');
    return;
  }

  // Group by unique market_id
  const byMarket = new Map();
  for (const row of unresolved) {
    if (!byMarket.has(row.market_id)) byMarket.set(row.market_id, []);
    byMarket.get(row.market_id).push(row);
  }

  const marketIds = [...byMarket.keys()];
  let resolved = 0, correct = 0, incorrect = 0, skipped = 0;

  // Batch Gamma API calls
  for (let i = 0; i < marketIds.length; i += 20) {
    const batch = marketIds.slice(i, i + 20);
    const results = await Promise.allSettled(
      batch.map(async (mid) => {
        const res = await fetch(`${cfg.GAMMA_BASE}/markets/${mid}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        return res.json();
      })
    );

    for (let j = 0; j < batch.length; j++) {
      const mid = batch[j];
      const result = results[j];
      if (result.status !== 'fulfilled' || !result.value) {
        skipped += byMarket.get(mid).length;
        continue;
      }

      const gammaMarket = result.value;
      if (gammaMarket.closed !== true) {
        skipped += byMarket.get(mid).length;
        continue;
      }

      // Determine actual outcome from final prices
      const outcomes = parseJsonMaybe(gammaMarket.outcomes, ['Yes', 'No']);
      const prices = parseJsonMaybe(gammaMarket.outcomePrices, null);
      if (!Array.isArray(prices) || prices.length === 0) {
        skipped += byMarket.get(mid).length;
        continue;
      }

      let yesIdx = 0;
      if (Array.isArray(outcomes)) {
        const idx = outcomes.findIndex(x => String(x).toLowerCase() === 'yes');
        if (idx >= 0) yesIdx = idx;
      }

      const finalYes = parseFloat(prices[yesIdx]) || 0;
      const finalNo = 1 - finalYes;

      let actualOutcome = null;
      if (finalYes >= 0.65) actualOutcome = 'yes';
      else if (finalYes <= 0.35) actualOutcome = 'no';

      if (!actualOutcome) {
        skipped += byMarket.get(mid).length;
        continue;
      }

      // Update all predictions for this market
      for (const row of byMarket.get(mid)) {
        const wasCorrect = row.predicted_outcome === actualOutcome;
        const { error: upErr } = await db
          .from('edge_predictions')
          .update({
            actual_outcome: actualOutcome,
            was_correct: wasCorrect,
            resolved_at: new Date().toISOString(),
            final_yes_price: Number(finalYes.toFixed(4)),
            final_no_price: Number(finalNo.toFixed(4)),
            resolution_source: 'gamma',
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);

        if (upErr) {
          console.error(`[edge] resolution update failed for prediction ${row.id}:`, upErr.message);
        } else {
          resolved++;
          if (wasCorrect) correct++;
          else incorrect++;
        }
      }
    }

    // Rate-limit pause between batches
    if (i + 20 < marketIds.length) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[edge] resolved ${resolved} predictions (${correct} correct, ${incorrect} incorrect, ${skipped} skipped)`);
}

// ─── Accuracy stats ───

const CATEGORY_PATTERNS = [
  { category: 'weather', pattern: /weather|temperature|snow|rain|wind|forecast|°[CF]|humidity|storm/i },
  { category: 'esports', pattern: /Counter-Strike|CS2|LoL|Dota|esport|Valorant|League of Legends|HOTU|BO[135]\b/i },
  { category: 'earnings', pattern: /earnings|EPS|revenue|quarterly|beat.*earnings/i },
  { category: 'politics', pattern: /Trump|Biden|election|congress|senate|vote|bill|executive order|legislation/i },
  { category: 'sports', pattern: /NFL|NHL|UFC|boxing|tennis|golf|Formula|F1|NASCAR|Olympics/i },
];

function categorizeEvent(title) {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(title)) return category;
  }
  return 'other';
}

async function computeAccuracyStats(db) {
  const { data: resolved, error } = await db
    .from('edge_predictions')
    .select('event_title, market_question, predicted_outcome, actual_outcome, was_correct, probability, reasoning')
    .not('actual_outcome', 'is', null);

  if (error) {
    console.error('[edge] computeAccuracyStats query failed:', error.message);
    return null;
  }
  if (!resolved || resolved.length === 0) {
    console.log('[edge] no resolved predictions for accuracy stats');
    return null;
  }

  const total = resolved.length;
  const correctCount = resolved.filter(r => r.was_correct).length;

  // By confidence bucket
  const buckets = [
    { bucket: '80-84', min: 80, max: 84, total: 0, correct: 0 },
    { bucket: '85-89', min: 85, max: 89, total: 0, correct: 0 },
    { bucket: '90-94', min: 90, max: 94, total: 0, correct: 0 },
    { bucket: '95-100', min: 95, max: 100, total: 0, correct: 0 },
  ];
  for (const r of resolved) {
    for (const b of buckets) {
      if (r.probability >= b.min && r.probability <= b.max) {
        b.total++;
        if (r.was_correct) b.correct++;
        break;
      }
    }
  }

  // By category
  const catMap = new Map();
  for (const r of resolved) {
    const cat = categorizeEvent(r.event_title || '');
    if (!catMap.has(cat)) catMap.set(cat, { total: 0, correct: 0 });
    const c = catMap.get(cat);
    c.total++;
    if (r.was_correct) c.correct++;
  }

  // By predicted outcome
  const byOutcome = { yes: { total: 0, correct: 0 }, no: { total: 0, correct: 0 } };
  for (const r of resolved) {
    const key = r.predicted_outcome === 'yes' ? 'yes' : 'no';
    byOutcome[key].total++;
    if (r.was_correct) byOutcome[key].correct++;
  }

  // Recent mistakes (last 20 wrong predictions)
  const mistakes = resolved
    .filter(r => !r.was_correct)
    .slice(-20)
    .map(r => ({
      event_title: (r.event_title || '').slice(0, 100),
      market_question: (r.market_question || '').slice(0, 120),
      predicted: r.predicted_outcome,
      actual: r.actual_outcome,
      probability: r.probability,
      reasoning: (r.reasoning || '').slice(0, 150),
    }));

  const stats = {
    computed_at: new Date().toISOString(),
    overall: {
      total,
      correct: correctCount,
      accuracy: Number((correctCount / total).toFixed(3)),
    },
    by_confidence: buckets
      .filter(b => b.total > 0)
      .map(b => ({
        bucket: b.bucket,
        total: b.total,
        correct: b.correct,
        accuracy: Number((b.correct / b.total).toFixed(3)),
      })),
    by_category: [...catMap.entries()]
      .map(([category, c]) => ({
        category,
        total: c.total,
        correct: c.correct,
        accuracy: Number((c.correct / c.total).toFixed(3)),
      }))
      .sort((a, b) => b.total - a.total),
    by_outcome: {
      yes: { ...byOutcome.yes, accuracy: byOutcome.yes.total > 0 ? Number((byOutcome.yes.correct / byOutcome.yes.total).toFixed(3)) : 0 },
      no: { ...byOutcome.no, accuracy: byOutcome.no.total > 0 ? Number((byOutcome.no.correct / byOutcome.no.total).toFixed(3)) : 0 },
    },
    recent_mistakes: mistakes,
  };

  try {
    ensureDirs();
    writeFileSync(ACCURACY_STATS_FILE, JSON.stringify(stats, null, 2));
    console.log(`[edge] accuracy: ${correctCount}/${total} (${(stats.overall.accuracy * 100).toFixed(1)}%) — saved to ${ACCURACY_STATS_FILE}`);
  } catch (e) {
    console.error('[edge] failed to write accuracy stats:', e.message);
  }

  return stats;
}

function loadAccuracyStats() {
  try {
    if (!existsSync(ACCURACY_STATS_FILE)) return null;
    const raw = JSON.parse(readFileSync(ACCURACY_STATS_FILE, 'utf-8'));
    if (!raw?.overall || raw.overall.total < CALIBRATION_MIN_SAMPLES) return null;
    return raw;
  } catch {
    return null;
  }
}

// ─── Report helpers ───

function tsFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function toMarkdown(summary, opportunities) {
  const lines = [];
  lines.push('# Edge Prediction Scanner Report');
  lines.push('');
  lines.push(`- Generated at: ${summary.generated_at}`);
  lines.push(`- Events scanned: ${summary.events_scanned}`);
  lines.push(`- Events analyzed: ${summary.events_analyzed}`);
  lines.push(`- Predictions made: ${summary.predictions_total}`);
  lines.push(`- Opportunities: ${summary.opportunities_found}`);
  lines.push(`- Alerts sent: ${summary.alerts_sent}`);
  lines.push('');
  lines.push('| Profit % | Prob % | Outcome | Market | Event |');
  lines.push('|---:|---:|---|---|---|');
  for (const o of opportunities.slice(0, cfg.REPORT_TOP_N)) {
    lines.push(
      `| ${Number(o.profit_pct).toFixed(1)}% | ${o.probability}% | ${o.predicted_outcome} | ${o.market_question?.replace(/\|/g, '\\|')?.slice(0, 60)} | ${o.event_title?.replace(/\|/g, '\\|')?.slice(0, 40)} |`
    );
  }
  lines.push('');
  if (summary.accuracy) {
    lines.push('## Prediction Accuracy');
    lines.push(`- Resolved: ${summary.accuracy.total_resolved} predictions`);
    if (summary.accuracy.overall_accuracy != null) {
      lines.push(`- Overall accuracy: ${(summary.accuracy.overall_accuracy * 100).toFixed(1)}%`);
    }
    if (summary.accuracy.weakest_category) {
      lines.push(`- Weakest category: ${summary.accuracy.weakest_category} (${(summary.accuracy.weakest_accuracy * 100).toFixed(1)}%)`);
    }
    lines.push('');
  }
  lines.push('## Notes');
  lines.push('- Only shows markets with AI probability >= configured minimum and profit >= minimum.');
  lines.push('- Profit = ((1 - buy_price) / buy_price) * 100');
  return lines.join('\n');
}

// ─── Main ───

async function main() {
  console.log('[edge] Starting prediction scanner...');
  const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

  // ─── Resolution tracking & accuracy stats (before scan) ───
  await checkResolutions(db);
  await computeAccuracyStats(db);
  const calibration = loadAccuracyStats();
  if (calibration) {
    console.log(`[edge] calibration loaded: ${calibration.overall.correct}/${calibration.overall.total} (${(calibration.overall.accuracy * 100).toFixed(1)}%)`);
  }

  // Fetch events ending within horizon
  const events = await fetchEvents(db);
  console.log(`[edge] Found ${events.length} events ending within ${cfg.HORIZON_HOURS}h + ${cfg.HORIZON_BUFFER_MINS}m`);

  if (events.length === 0) {
    console.log('[edge] No events to analyze. Done.');
    return;
  }

  // Gamma pre-flight: remove already-closed events
  let gammaFiltered = 0;
  const openEvents = [];
  for (const event of events) {
    const closed = await isEventClosedOnGamma(event);
    if (closed) {
      gammaFiltered++;
      continue;
    }
    openEvents.push(event);
  }
  console.log(`[edge] ${openEvents.length} open events (${gammaFiltered} closed on Gamma)`);

  if (openEvents.length === 0) {
    console.log('[edge] All events closed. Done.');
    return;
  }

  // Setup bridge pool
  const tokens = getPerplexityTokens();
  const workerCount = Math.min(tokens.length, cfg.MAX_BRIDGE_WORKERS, openEvents.length);
  const pool = new BridgePool(tokens.slice(0, workerCount));
  console.log(`[edge] Bridge pool: ${workerCount} workers`);

  // Load cache
  const cache = loadCache();
  let cacheHits = 0;
  let analyzedEvents = 0;
  let failedEvents = 0;
  const failReasons = new Map();

  // Process events
  const allPredictions = []; // all market predictions (stored to DB)
  const opportunities = [];  // high-confidence, high-profit ones (for alerts)

  // Worker queue
  const queue = [...openEvents];
  let queueIdx = 0;

  async function worker() {
    while (queueIdx < queue.length) {
      const event = queue[queueIdx++];
      if (!event) break;

      const ck = predictionCacheKey(event);
      let result;

      // Check cache
      if (cache[ck] && isCacheFresh(cache[ck])) {
        result = cache[ck].result;
        cacheHits++;
      } else {
        // Query Perplexity
        const payload = buildPayload(event, calibration);
        try {
          result = await queryWithRetries(pool, payload);
          cache[ck] = { cached_at: new Date().toISOString(), result };
        } catch (e) {
          failedEvents++;
          const msg = normalizeErrorMessage(e?.message || e);
          failReasons.set(msg, (failReasons.get(msg) || 0) + 1);
          continue;
        }
      }

      analyzedEvents++;

      // Process each market prediction
      if (!result?.markets || !Array.isArray(result.markets)) continue;

      for (const mResult of result.markets) {
        const marketIdx = (mResult.market || 1) - 1;
        const market = event.markets[marketIdx];
        if (!market) continue;

        const outcome = mResult.outcome;
        const probability = mResult.probability;
        const reasoning = mResult.reasoning || '';

        // Fetch live price
        const livePrice = await fetchLivePrices(market);
        if (!livePrice) continue;
        if (livePrice.closed) continue;

        // Calculate buy price and profit
        const buyPrice = outcome === 'yes' ? livePrice.yesPrice : livePrice.noPrice;
        const profitPct = buyPrice > 0 ? ((1.0 - buyPrice) / buyPrice) * 100 : 0;

        const prediction = {
          event_id: event.polymarket_event_id,
          event_title: event.title,
          event_slug: event.slug || '',
          event_end_date: event.end_date,
          market_id: market.polymarket_market_id,
          market_question: market.question,
          market_slug: market.slug || '',
          predicted_outcome: outcome,
          probability,
          reasoning,
          ai_summary: result.summary || '',
          yes_price: livePrice.yesPrice,
          no_price: livePrice.noPrice,
          divergence: outcome === 'yes'
            ? Math.abs((probability / 100) - livePrice.yesPrice)
            : Math.abs((probability / 100) - livePrice.noPrice),
          profit_pct: Number(profitPct.toFixed(2)),
          detected_at: new Date().toISOString(),
          event_url: marketUrl(event.slug, ''),
          market_url: marketUrl(event.slug, market.slug),
        };

        // Store ALL predictions to DB
        allPredictions.push(prediction);
        await upsertEdgePrediction(db, {
          event_id: prediction.event_id,
          event_title: prediction.event_title,
          event_slug: prediction.event_slug,
          event_end_date: prediction.event_end_date,
          market_id: prediction.market_id,
          market_question: prediction.market_question,
          predicted_outcome: prediction.predicted_outcome,
          probability: prediction.probability,
          reasoning: prediction.reasoning,
          ai_summary: prediction.ai_summary,
          yes_price: prediction.yes_price,
          no_price: prediction.no_price,
          divergence: prediction.divergence,
          profit_pct: prediction.profit_pct,
          detected_at: prediction.detected_at,
        });

        // Check if it's an opportunity
        if (
          probability >= cfg.MIN_PROBABILITY &&
          buyPrice < cfg.MAX_BUY_PRICE &&
          profitPct >= cfg.MIN_PROFIT_PCT &&
          outcome !== 'unknown'
        ) {
          opportunities.push(prediction);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  pool.close();
  saveCache(cache);

  // Sort opportunities by profit descending
  opportunities.sort((a, b) => b.profit_pct - a.profit_pct);

  console.log(`[edge] analyzed=${analyzedEvents} cache_hits=${cacheHits} failed=${failedEvents}`);
  console.log(`[edge] predictions=${allPredictions.length} opportunities=${opportunities.length}`);

  // ─── Telegram alerts ───

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
  const telegramConfigured = !!(telegramBotToken && telegramChatId);
  const telegramReady = cfg.TELEGRAM_ENABLED && telegramConfigured;

  let alertsSent = 0;
  let alertsSkippedDedupe = 0;
  let alertsSkippedRecheck = 0;
  let alertsFailedSend = 0;
  const alertSkipReasons = new Map();

  if (telegramReady) {
    const alertState = loadAlertState(ALERT_STATE_FILE, Math.max(cfg.ALERT_DEDUPE_HOURS * 4, 24 * 7));
    const alertCandidates = opportunities.slice(0, cfg.ALERT_TOP_N);

    for (const op of alertCandidates) {
      const dedupeKey = `${op.event_id}|${op.market_id}|${op.predicted_outcome}`;

      if (isDuplicateWithinWindow(alertState, dedupeKey, cfg.ALERT_DEDUPE_HOURS)) {
        alertsSkippedDedupe++;
        alertSkipReasons.set('duplicate_within_window', (alertSkipReasons.get('duplicate_within_window') || 0) + 1);
        continue;
      }

      // Live recheck price before alerting
      const market = allPredictions.find(p => p.market_id === op.market_id);
      if (!market) continue;

      // Re-fetch live price to confirm
      const freshMarketData = { polymarket_market_id: op.market_id, best_ask: op.yes_price };
      const liveCheck = await fetchLivePrices(freshMarketData);
      if (!liveCheck || liveCheck.closed) {
        alertsSkippedRecheck++;
        alertSkipReasons.set('market_closed_recheck', (alertSkipReasons.get('market_closed_recheck') || 0) + 1);
        continue;
      }

      const freshBuyPrice = op.predicted_outcome === 'yes' ? liveCheck.yesPrice : liveCheck.noPrice;
      if (freshBuyPrice >= cfg.MAX_BUY_PRICE) {
        alertsSkippedRecheck++;
        alertSkipReasons.set('price_above_max_recheck', (alertSkipReasons.get('price_above_max_recheck') || 0) + 1);
        continue;
      }

      // Update with live prices
      const alertData = {
        ...op,
        yes_price: liveCheck.yesPrice,
        no_price: liveCheck.noPrice,
        profit_pct: freshBuyPrice > 0 ? Number((((1.0 - freshBuyPrice) / freshBuyPrice) * 100).toFixed(2)) : 0,
      };

      const send = await sendEdgeTelegramAlert(alertData, {
        botToken: telegramBotToken,
        chatId: telegramChatId,
      });

      if (send.ok) {
        alertsSent++;
        markSent(alertState, dedupeKey, {
          last_probability: op.probability,
          last_profit_pct: alertData.profit_pct,
        });
        // Update DB with alert_sent
        await upsertEdgePrediction(db, {
          event_id: op.event_id,
          market_id: op.market_id,
          event_title: op.event_title,
          market_question: op.market_question,
          predicted_outcome: op.predicted_outcome,
          probability: op.probability,
          alert_sent: true,
          alert_sent_at: new Date().toISOString(),
        });
      } else {
        alertsFailedSend++;
        const rsn = send.error || `telegram_status_${send.status || 0}`;
        alertSkipReasons.set(rsn, (alertSkipReasons.get(rsn) || 0) + 1);
      }
    }

    saveAlertState(ALERT_STATE_FILE, alertState, Math.max(cfg.ALERT_DEDUPE_HOURS * 4, 24 * 7));
  }

  console.log(`[edge] alerts sent=${alertsSent} skip_dedupe=${alertsSkippedDedupe} skip_recheck=${alertsSkippedRecheck} failed_send=${alertsFailedSend}`);

  // ─── Reports ───

  const alertSkipTop = [...alertSkipReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  const failTop = [...failReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ count, reason }));

  const summary = {
    generated_at: new Date().toISOString(),
    config: {
      HORIZON_HOURS: cfg.HORIZON_HOURS,
      HORIZON_BUFFER_MINS: cfg.HORIZON_BUFFER_MINS,
      MAX_EVENTS: cfg.MAX_EVENTS,
      MIN_PROBABILITY: cfg.MIN_PROBABILITY,
      MAX_BUY_PRICE: cfg.MAX_BUY_PRICE,
      MIN_PROFIT_PCT: cfg.MIN_PROFIT_PCT,
      CACHE_TTL_HOURS: cfg.CACHE_TTL_HOURS,
      MAX_BRIDGE_WORKERS: cfg.MAX_BRIDGE_WORKERS,
      ALERT_DEDUPE_HOURS: cfg.ALERT_DEDUPE_HOURS,
    },
    events_scanned: events.length,
    events_filtered_gamma: gammaFiltered,
    events_analyzed: analyzedEvents,
    cache_hits: cacheHits,
    failed_events: failedEvents,
    fail_reasons_top: failTop,
    predictions_total: allPredictions.length,
    opportunities_found: opportunities.length,
    alerts_sent: alertsSent,
    alerts_skipped_dedupe: alertsSkippedDedupe,
    alerts_skipped_recheck: alertsSkippedRecheck,
    alerts_failed_send: alertsFailedSend,
    alert_skip_reasons_top: alertSkipTop,
    accuracy: calibration ? {
      total_resolved: calibration.overall.total,
      overall_accuracy: calibration.overall.accuracy,
      weakest_category: calibration.by_category?.filter(c => c.total >= 5).sort((a, b) => a.accuracy - b.accuracy)[0]?.category || null,
      weakest_accuracy: calibration.by_category?.filter(c => c.total >= 5).sort((a, b) => a.accuracy - b.accuracy)[0]?.accuracy || null,
    } : null,
  };

  ensureDirs();
  const stamp = tsFile();
  const jsonPayload = { summary, opportunities };
  const latestJson = join(REPORT_DIR, 'latest.json');
  const datedJson = join(REPORT_DIR, `edge-${stamp}.json`);
  writeFileSync(latestJson, JSON.stringify(jsonPayload, null, 2));
  writeFileSync(datedJson, JSON.stringify(jsonPayload, null, 2));

  const md = toMarkdown(summary, opportunities);
  const latestMd = join(REPORT_DIR, 'latest.md');
  const datedMd = join(REPORT_DIR, `edge-${stamp}.md`);
  writeFileSync(latestMd, md);
  writeFileSync(datedMd, md);

  if (opportunities[0]) {
    console.log(`[edge] top: ${opportunities[0].profit_pct.toFixed(1)}% profit | ${opportunities[0].predicted_outcome} | ${opportunities[0].probability}% | ${opportunities[0].event_title}`);
  }
  console.log(`[edge] wrote ${latestJson}`);
  console.log(`[edge] wrote ${latestMd}`);
}

main().catch((err) => {
  console.error('[edge] fatal:', err.message);
  process.exit(1);
});
