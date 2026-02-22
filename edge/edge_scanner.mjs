import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { spawn, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = join(__dirname, 'cache');
const REPORT_DIR = join(__dirname, 'reports');
const CACHE_FILE = join(CACHE_DIR, 'relation_cache.json');

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
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

const cfg = {
  SUPABASE_URL: env('SUPABASE_URL'),
  SUPABASE_KEY: env('SUPABASE_SERVICE_KEY'),
  PYTHON_CMD: resolvePythonCmd(process.env.PYTHON_CMD || 'uv'),
  BRIDGE_PATH: process.env.CONSTRAINT_BRIDGE_PATH || join(__dirname, 'constraint_bridge.py'),
  HORIZON_HOURS: numEnv('EDGE_HORIZON_HOURS', 72),
  MAX_EVENTS: numEnv('EDGE_MAX_EVENTS', 600),
  MAX_MARKETS_PER_EVENT: numEnv('EDGE_MAX_MARKETS_PER_EVENT', 14),
  MAX_PAIRS_PER_EVENT: numEnv('EDGE_MAX_PAIRS_PER_EVENT', 28),
  MAX_PAIR_CHECKS: numEnv('EDGE_MAX_PAIR_CHECKS', 120),
  MIN_SHARED_TOKENS: numEnv('EDGE_MIN_SHARED_TOKENS', 2),
  MIN_YES_PRICE: numEnv('EDGE_MIN_YES_PRICE', 0.08),
  MAX_YES_PRICE: numEnv('EDGE_MAX_YES_PRICE', 0.95),
  PREFILTER_SUM_EXCESS: numEnv('EDGE_PREFILTER_SUM_EXCESS', 0.03),
  PREFILTER_DIFF: numEnv('EDGE_PREFILTER_DIFF', 0.08),
  PREFILTER_HIGH_PRICE: numEnv('EDGE_PREFILTER_HIGH_PRICE', 0.8),
  RELATION_MIN_CONFIDENCE: numEnv('EDGE_RELATION_MIN_CONFIDENCE', 78),
  IMPOSSIBLE_MIN_CONFIDENCE: numEnv('EDGE_IMPOSSIBLE_MIN_CONFIDENCE', 88),
  FEE_BUFFER_TWO_LEG: numEnv('EDGE_FEE_BUFFER_TWO_LEG', 0.03),
  FEE_BUFFER_SINGLE_LEG: numEnv('EDGE_FEE_BUFFER_SINGLE_LEG', 0.015),
  MIN_NET_EDGE: numEnv('EDGE_MIN_NET_EDGE', 0.02),
  CACHE_TTL_HOURS: numEnv('EDGE_CACHE_TTL_HOURS', 6),
  REPORT_TOP_N: numEnv('EDGE_REPORT_TOP_N', 40),
  MAX_BRIDGE_WORKERS: numEnv('EDGE_MAX_BRIDGE_WORKERS', 3),
  PAIR_QUERY_RETRIES: Math.max(0, Math.floor(numEnv('EDGE_PAIR_QUERY_RETRIES', 2))),
  PAIR_RETRY_BACKOFF_MS: Math.max(250, Math.floor(numEnv('EDGE_PAIR_RETRY_BACKOFF_MS', 1500))),
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'at', 'by',
  'will', 'be', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'with',
  'from', 'than', 'that', 'this', 'these', 'those', 'as', 'it', 'its', 'their',
  'after', 'before', 'over', 'under', 'into', 'vs', 'if', 'any', 'all',
]);

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

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonMaybe(v, fallback) {
  if (v == null) return fallback;
  if (Array.isArray(v) || typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function norm(s) {
  return String(s || '').toLowerCase();
}

function tokenize(text) {
  return norm(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2 && !STOPWORDS.has(x));
}

function sharedTokenCount(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let c = 0;
  for (const t of ta) if (tb.has(t)) c++;
  return c;
}

function looksLikeNegationPair(a, b) {
  const sa = norm(a);
  const sb = norm(b);
  const hasNegA = /\bnot\b|\bno\b|\bnever\b|\bwithout\b/.test(sa);
  const hasNegB = /\bnot\b|\bno\b|\bnever\b|\bwithout\b/.test(sb);
  if (hasNegA === hasNegB) return false;
  return sharedTokenCount(a, b) >= 3;
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

function isBinaryYesNo(market) {
  const outcomes = parseJsonMaybe(market.outcomes, null);
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return false;
  const set = new Set(outcomes.map(x => String(x).toLowerCase()));
  return set.has('yes') && set.has('no');
}

function shouldCheckPair(a, b) {
  const shared = sharedTokenCount(a.question, b.question);
  const sum = a.yesPrice + b.yesPrice;
  const diff = Math.abs(a.yesPrice - b.yesPrice);
  const negationClue = looksLikeNegationPair(a.question, b.question);

  if (negationClue) return true;
  if (shared < cfg.MIN_SHARED_TOKENS) return false;
  if (sum >= 1 + cfg.PREFILTER_SUM_EXCESS) return true;
  if (diff >= cfg.PREFILTER_DIFF) return true;
  if (a.yesPrice >= cfg.PREFILTER_HIGH_PRICE || b.yesPrice >= cfg.PREFILTER_HIGH_PRICE) return true;
  return false;
}

function pairPriority(a, b) {
  const sumExcess = Math.max(0, a.yesPrice + b.yesPrice - 1);
  const diff = Math.abs(a.yesPrice - b.yesPrice);
  const shared = sharedTokenCount(a.question, b.question);
  return (sumExcess * 100) + (diff * 30) + (shared * 2);
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

function loadCache() {
  ensureDirs();
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  ensureDirs();
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function cacheKey(c) {
  return [
    c.event.polymarket_event_id,
    c.a.polymarket_market_id,
    c.b.polymarket_market_id,
    c.a.updated_at || '',
    c.b.updated_at || '',
  ].join('|');
}

function isCacheFresh(entry) {
  if (!entry || !entry.cached_at) return false;
  const ts = new Date(entry.cached_at).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < cfg.CACHE_TTL_HOURS * 3600_000;
}

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
      if (attempt > cfg.PAIR_QUERY_RETRIES || !isRetryableError(msg)) {
        throw new Error(msg);
      }
      const wait = cfg.PAIR_RETRY_BACKOFF_MS * attempt;
      await sleep(wait);
    }
  }
}

async function fetchEvents(db) {
  const out = [];
  let from = 0;
  const pageSize = 300;
  const now = Date.now();
  const horizonMs = cfg.HORIZON_HOURS * 3600_000;

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
      const endTs = ev.end_date ? new Date(ev.end_date).getTime() : NaN;
      if (Number.isFinite(endTs) && endTs - now > horizonMs) continue;
      eligibleEvents.push(ev);
    }

    if (eligibleEvents.length > 0) {
      const ids = eligibleEvents.map(e => e.id);
      const marketsByEvent = new Map(ids.map(id => [id, []]));

      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { data: marketRows, error: mkErr } = await db
          .from('markets')
          .select('event_id,polymarket_market_id,question,description,slug,outcomes,outcome_prices,best_ask,last_trade_price,active,closed,end_date,updated_at')
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
          .filter(isBinaryYesNo)
          .map(m => ({ ...m, yesPrice: yesPrice(m) }))
          .filter(m => m.yesPrice != null)
          .filter(m => m.yesPrice >= cfg.MIN_YES_PRICE && m.yesPrice <= cfg.MAX_YES_PRICE)
          .sort((a, b) => b.yesPrice - a.yesPrice)
          .slice(0, cfg.MAX_MARKETS_PER_EVENT);

        if (markets.length < 2) continue;
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

function buildCandidates(events) {
  const pairs = [];
  for (const event of events) {
    const local = [];
    const mkts = event.markets;
    for (let i = 0; i < mkts.length; i++) {
      for (let j = i + 1; j < mkts.length; j++) {
        const a = mkts[i];
        const b = mkts[j];
        if (!shouldCheckPair(a, b)) continue;
        local.push({
          event,
          a,
          b,
          priority: pairPriority(a, b),
          shared_tokens: sharedTokenCount(a.question, b.question),
        });
      }
    }
    local.sort((x, y) => y.priority - x.priority);
    pairs.push(...local.slice(0, cfg.MAX_PAIRS_PER_EVENT));
  }

  pairs.sort((x, y) => y.priority - x.priority);
  return pairs.slice(0, cfg.MAX_PAIR_CHECKS);
}

function relationPayload(candidate) {
  return {
    event_title: candidate.event.title,
    event_description: candidate.event.description || '',
    scheduled_end: candidate.event.end_date || '',
    market_a: {
      id: candidate.a.polymarket_market_id,
      question: candidate.a.question,
      description: candidate.a.description || '',
      yes_price: candidate.a.yesPrice,
    },
    market_b: {
      id: candidate.b.polymarket_market_id,
      question: candidate.b.question,
      description: candidate.b.description || '',
      yes_price: candidate.b.yesPrice,
    },
  };
}

function maybeAdd(opps, op) {
  if (op.net_edge < cfg.MIN_NET_EDGE) return;
  opps.push(op);
}

function evaluate(candidate, rel) {
  const opps = [];
  const pA = candidate.a.yesPrice;
  const pB = candidate.b.yesPrice;
  const ev = candidate.event;
  const base = {
    event_id: ev.polymarket_event_id,
    event_title: ev.title,
    event_slug: ev.slug || '',
    market_a_id: candidate.a.polymarket_market_id,
    market_b_id: candidate.b.polymarket_market_id,
    market_a_question: candidate.a.question,
    market_b_question: candidate.b.question,
    market_a_yes: pA,
    market_b_yes: pB,
    market_a_url: marketUrl(ev.slug, candidate.a.slug),
    market_b_url: marketUrl(ev.slug, candidate.b.slug),
    relation: rel.relation,
    confidence: rel.confidence,
    reason: rel.reason || '',
    evidence: rel.evidence || [],
  };

  if (rel.confidence >= cfg.RELATION_MIN_CONFIDENCE) {
    if (rel.relation === 'mutually_exclusive') {
      {
        const gross = (pA + pB) - 1;
        const net = gross - cfg.FEE_BUFFER_TWO_LEG;
        maybeAdd(opps, {
          ...base,
          type: 'mutex_no_no',
          strategy: 'Buy NO on both markets',
          gross_edge: Number(gross.toFixed(6)),
          net_edge: Number(net.toFixed(6)),
          guaranteed_payout: 1.0,
          total_cost: Number((2 - pA - pB).toFixed(6)),
          exhaustive: !!rel.exhaustive,
        });
      }
      if (rel.exhaustive === true) {
        const gross = 1 - (pA + pB);
        const net = gross - cfg.FEE_BUFFER_TWO_LEG;
        maybeAdd(opps, {
          ...base,
          type: 'mutex_yes_yes_exhaustive',
          strategy: 'Buy YES on both markets',
          gross_edge: Number(gross.toFixed(6)),
          net_edge: Number(net.toFixed(6)),
          guaranteed_payout: 1.0,
          total_cost: Number((pA + pB).toFixed(6)),
          exhaustive: true,
        });
      }
    }

    if (rel.relation === 'equivalent') {
      if (pA > pB) {
        const gross = pA - pB;
        const net = gross - cfg.FEE_BUFFER_TWO_LEG;
        maybeAdd(opps, {
          ...base,
          type: 'equiv_spread',
          strategy: 'Buy YES(B) + Buy NO(A)',
          gross_edge: Number(gross.toFixed(6)),
          net_edge: Number(net.toFixed(6)),
          guaranteed_payout: 1.0,
          total_cost: Number((1 + pB - pA).toFixed(6)),
          exhaustive: false,
        });
      } else if (pB > pA) {
        const gross = pB - pA;
        const net = gross - cfg.FEE_BUFFER_TWO_LEG;
        maybeAdd(opps, {
          ...base,
          type: 'equiv_spread',
          strategy: 'Buy YES(A) + Buy NO(B)',
          gross_edge: Number(gross.toFixed(6)),
          net_edge: Number(net.toFixed(6)),
          guaranteed_payout: 1.0,
          total_cost: Number((1 + pA - pB).toFixed(6)),
          exhaustive: false,
        });
      }
    }

    if (rel.relation === 'a_implies_b' && pA > pB) {
      const gross = pA - pB;
      const net = gross - cfg.FEE_BUFFER_TWO_LEG;
      maybeAdd(opps, {
        ...base,
        type: 'implication_violation',
        strategy: 'Buy YES(B) + Buy NO(A)',
        gross_edge: Number(gross.toFixed(6)),
        net_edge: Number(net.toFixed(6)),
        guaranteed_payout: 1.0,
        total_cost: Number((1 + pB - pA).toFixed(6)),
        exhaustive: false,
      });
    }

    if (rel.relation === 'b_implies_a' && pB > pA) {
      const gross = pB - pA;
      const net = gross - cfg.FEE_BUFFER_TWO_LEG;
      maybeAdd(opps, {
        ...base,
        type: 'implication_violation',
        strategy: 'Buy YES(A) + Buy NO(B)',
        gross_edge: Number(gross.toFixed(6)),
        net_edge: Number(net.toFixed(6)),
        guaranteed_payout: 1.0,
        total_cost: Number((1 + pA - pB).toFixed(6)),
        exhaustive: false,
      });
    }
  }

  if (rel.confidence >= cfg.IMPOSSIBLE_MIN_CONFIDENCE && Array.isArray(rel.impossible_yes)) {
    if (rel.impossible_yes.includes('a')) {
      const gross = pA;
      const net = gross - cfg.FEE_BUFFER_SINGLE_LEG;
      maybeAdd(opps, {
        ...base,
        type: 'impossible_yes',
        strategy: 'Buy NO(A)',
        gross_edge: Number(gross.toFixed(6)),
        net_edge: Number(net.toFixed(6)),
        guaranteed_payout: 1.0,
        total_cost: Number((1 - pA).toFixed(6)),
        exhaustive: false,
      });
    }
    if (rel.impossible_yes.includes('b')) {
      const gross = pB;
      const net = gross - cfg.FEE_BUFFER_SINGLE_LEG;
      maybeAdd(opps, {
        ...base,
        type: 'impossible_yes',
        strategy: 'Buy NO(B)',
        gross_edge: Number(gross.toFixed(6)),
        net_edge: Number(net.toFixed(6)),
        guaranteed_payout: 1.0,
        total_cost: Number((1 - pB).toFixed(6)),
        exhaustive: false,
      });
    }
  }

  return opps;
}

function tsFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function toMarkdown(summary, opportunities) {
  const lines = [];
  lines.push(`# Logic-Edge Scanner Report`);
  lines.push('');
  lines.push(`- Generated at: ${summary.generated_at}`);
  lines.push(`- Events scanned: ${summary.events_scanned}`);
  lines.push(`- Pair candidates: ${summary.candidates}`);
  lines.push(`- Pair analyses: ${summary.analyzed_pairs}`);
  lines.push(`- Opportunities: ${summary.opportunities_found}`);
  lines.push('');
  lines.push('| Net Edge | Type | Strategy | Relation | Confidence | Event |');
  lines.push('|---:|---|---|---|---:|---|');
  for (const o of opportunities.slice(0, cfg.REPORT_TOP_N)) {
    lines.push(
      `| ${(o.net_edge * 100).toFixed(2)}% | ${o.type} | ${o.strategy} | ${o.relation} | ${o.confidence} | ${o.event_title.replace(/\|/g, '\\|')} |`
    );
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('- `net_edge` is discounted by configurable fee/slippage buffers.');
  lines.push('- This report is for signal generation; always verify resolution rules manually before execution.');
  return lines.join('\n');
}

async function main() {
  console.log('[edge] starting standalone logic-edge scanner');
  console.log(`[edge] python_cmd=${cfg.PYTHON_CMD}`);
  const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

  const events = await fetchEvents(db);
  console.log(`[edge] fetched ${events.length} events`);
  const candidates = buildCandidates(events);
  console.log(`[edge] built ${candidates.length} candidate pairs`);

  const cache = loadCache();
  const opportunities = [];
  let analyzedPairs = 0;
  let cacheHits = 0;
  let failedPairs = 0;
  const failReasons = new Map();
  let uncachedPairs = 0;

  const queue = [...candidates];
  if (queue.length === 0) {
    const summary = {
      generated_at: new Date().toISOString(),
      config: cfg,
      events_scanned: events.length,
      candidates: 0,
      analyzed_pairs: 0,
      cache_hits: 0,
      failed_pairs: 0,
      opportunities_found: 0,
    };
    ensureDirs();
    const stamp = tsFile();
    const payload = { summary, opportunities: [] };
    writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
    writeFileSync(join(REPORT_DIR, `edge-${stamp}.json`), JSON.stringify(payload, null, 2));
    const md = toMarkdown(summary, []);
    writeFileSync(join(REPORT_DIR, 'latest.md'), md);
    writeFileSync(join(REPORT_DIR, `edge-${stamp}.md`), md);
    console.log('[edge] no candidates, report generated');
    return;
  }

  const tokens = getPerplexityTokens();
  console.log(`[edge] using ${tokens.length} Perplexity token(s)`);
  const pool = new BridgePool(tokens);
  const workerCap = Math.max(1, Math.floor(cfg.MAX_BRIDGE_WORKERS));
  const workerCount = Math.min(tokens.length, workerCap, queue.length || 1);
  console.log(`[edge] bridge_workers=${workerCount}`);

  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) break;
      const key = cacheKey(c);
      let rel = null;
      if (isCacheFresh(cache[key])) {
        rel = cache[key].result;
        cacheHits++;
      } else {
        uncachedPairs++;
        try {
          rel = await queryWithRetries(pool, relationPayload(c));
          cache[key] = {
            cached_at: new Date().toISOString(),
            result: rel,
          };
        } catch (e) {
          failedPairs++;
          const msg = normalizeErrorMessage(e?.message || e);
          failReasons.set(msg, (failReasons.get(msg) || 0) + 1);
          continue;
        }
      }

      analyzedPairs++;
      const opps = evaluate(c, rel);
      opportunities.push(...opps);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  pool.close();
  saveCache(cache);

  const failTop = [...failReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ count, reason }));

  if (failTop.length > 0) {
    for (const f of failTop) {
      console.warn(`[edge] fail_reason x${f.count}: ${f.reason}`);
    }
  }

  // Hard fail only if no uncached pair could be analyzed successfully.
  if (uncachedPairs > 0 && analyzedPairs - cacheHits <= 0 && failedPairs >= uncachedPairs) {
    const firstReason = failTop[0]?.reason || 'unknown error';
    throw new Error(
      `All uncached pair analyses failed (${failedPairs}/${uncachedPairs}). Top error: ${firstReason}`
    );
  }

  opportunities.sort((a, b) => {
    if (b.net_edge !== a.net_edge) return b.net_edge - a.net_edge;
    return b.confidence - a.confidence;
  });

  const summary = {
    generated_at: new Date().toISOString(),
    config: cfg,
    events_scanned: events.length,
    candidates: candidates.length,
    analyzed_pairs: analyzedPairs,
    analyzed_uncached_pairs: Math.max(0, analyzedPairs - cacheHits),
    cache_hits: cacheHits,
    failed_pairs: failedPairs,
    failed_uncached_pairs: failedPairs,
    fail_reasons_top: failTop,
    opportunities_found: opportunities.length,
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

  console.log(`[edge] analyzed=${analyzedPairs} cache_hits=${cacheHits} failed=${failedPairs}`);
  console.log(`[edge] opportunities=${opportunities.length}`);
  if (opportunities[0]) {
    console.log(`[edge] top: ${(opportunities[0].net_edge * 100).toFixed(2)}% ${opportunities[0].strategy} | ${opportunities[0].event_title}`);
  }
  console.log(`[edge] wrote ${latestJson}`);
  console.log(`[edge] wrote ${latestMd}`);
}

main().catch((err) => {
  console.error('[edge] fatal:', err.message);
  process.exit(1);
});
