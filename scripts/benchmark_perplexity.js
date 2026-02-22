import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { config } from '../dist/src/util/config.js';

const db = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

class Bridge {
  constructor(token, index) {
    this.index = index;
    this.dead = false;
    this.proc = spawn(config.PYTHON_CMD, ['run', config.PERPLEXITY_BRIDGE_PATH, '--server', '--token', token], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.on('exit', () => { this.dead = true; });
    this.pending = null;
    this.buffer = '';
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line && this.pending) {
          this.pending.resolve(line);
          this.pending = null;
        }
      }
    });
  }
  async query(input) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('timeout')); this.pending = null; }, 90000);
      this.pending = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject };
      this.proc.stdin.write(JSON.stringify(input) + '\n');
    });
  }
  kill() { this.proc.kill(); }
}

// Get 50 open events with end_date
const { data: events } = await db.from('events')
  .select('title, description, end_date, markets(question, description)')
  .eq('closed', false)
  .not('end_date', 'is', null)
  .lt('end_date', '2026-03-01')
  .order('end_date', { ascending: true })
  .limit(50);

console.log('Events to check: ' + events.length);
console.log('Spawning ' + config.PERPLEXITY_SESSION_TOKENS.length + ' bridges...');

const bridges = config.PERPLEXITY_SESSION_TOKENS.map((t, i) => new Bridge(t, i));
await new Promise(r => setTimeout(r, 3000));

const queue = [...events];
let completed = 0;
let failed = 0;
const t0 = Date.now();

async function worker(bridge) {
  while (queue.length > 0) {
    const event = queue.shift();
    const input = {
      mode: 'event',
      event_title: event.title,
      event_description: event.description || '',
      end_date: event.end_date || '',
      market_questions: (event.markets || []).map(m => m.question),
      market_descriptions: (event.markets || []).map(m => m.description || ''),
    };
    try {
      const raw = await bridge.query(input);
      const parsed = JSON.parse(raw);
      completed++;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log('[' + elapsed + 's] #' + completed + ' bridge' + bridge.index + ': ' + event.title.slice(0, 50) + ' -> resolved=' + parsed.resolved + ' est=' + (parsed.estimated_end_min || '?'));
    } catch (e) {
      failed++;
      console.log('FAIL bridge' + bridge.index + ': ' + event.title.slice(0, 40) + ' - ' + e.message);
    }
  }
}

await Promise.all(bridges.map(b => worker(b)));

const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
const perMin = (completed / (totalSec / 60)).toFixed(1);
console.log('');
console.log('=== BENCHMARK RESULTS ===');
console.log('Completed: ' + completed + ' / ' + events.length);
console.log('Failed: ' + failed);
console.log('Total time: ' + totalSec + 's');
console.log('Rate: ' + perMin + ' requests/min');
console.log('Avg per request: ' + (totalSec / completed).toFixed(1) + 's');

bridges.forEach(b => b.kill());
process.exit(0);
