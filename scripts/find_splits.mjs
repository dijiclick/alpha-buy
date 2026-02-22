/**
 * Find all Polymarket accounts that performed "split" transactions
 * (splitPosition on CTF contract) in the last 24 hours.
 *
 * Usage: node scripts/find_splits.mjs
 *
 * Zero dependencies — Node.js 18+ built-ins only.
 * Uses Polygon RPC (eth_getLogs) with incremental aggregation.
 */

const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const POSITION_SPLIT_TOPIC = '0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298';
const ETHERSCAN_API_KEY = 'C5MMHWYARZTRK8YVVCM9DAUU5ZIASC2CKN';
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const RPC_URL = 'https://polygon.drpc.org';
const CHUNK_BLOCKS = 400; // ~31K events per chunk, safely under drpc timeout
const RPC_DELAY_MS = 2000; // generous delay for free RPC
const USDC_DECIMALS = 6;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Etherscan (block timestamp only) ─────────────────────────────────

async function getBlockByTimestamp(timestamp) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(220);
    const qs = new URLSearchParams({
      chainid: '137',
      module: 'block',
      action: 'getblocknobytime',
      timestamp: String(timestamp),
      closest: 'before',
      apikey: ETHERSCAN_API_KEY,
    });
    try {
      const res = await fetch(`${ETHERSCAN_BASE}?${qs}`, { signal: AbortSignal.timeout(15000) });
      const json = await res.json();
      if (json.status === '1') return parseInt(json.result, 10);
    } catch {}
    await sleep(2000);
  }
  throw new Error('Could not resolve block by timestamp');
}

// ── Polygon RPC ──────────────────────────────────────────────────────

let rpcId = 0;

async function rpcGetLogs(fromBlock, toBlock) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'eth_getLogs',
    params: [{
      address: CTF_ADDRESS,
      topics: [POSITION_SPLIT_TOPIC],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
    }],
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body,
        signal: AbortSignal.timeout(120000),
      });
      const json = await res.json();

      if (json.error) {
        const msg = json.error.message || JSON.stringify(json.error);
        if (msg.includes('too many') || msg.includes('more than') || msg.includes('exceed') || msg.includes('block range')) {
          return { tooMany: true };
        }
        throw new Error(msg);
      }
      return { logs: json.result || [] };
    } catch (err) {
      if (err.message?.includes('too many')) return { tooMany: true };
      if (attempt < 4) {
        await sleep((attempt + 1) * 3000);
        continue;
      }
      throw err;
    }
  }
}

// ── Incremental processing ───────────────────────────────────────────

const accounts = new Map();
let totalEvents = 0;

function processLogs(logs) {
  for (const log of logs) {
    const stakeholder = '0x' + log.topics[1].slice(26).toLowerCase();
    const dataHex = log.data.slice(2);
    const amountHex = dataHex.slice(128, 192);
    const amount = BigInt('0x' + amountHex);

    const existing = accounts.get(stakeholder);
    if (existing) {
      existing.count++;
      existing.totalAmount += amount;
    } else {
      accounts.set(stakeholder, { count: 1, totalAmount: amount });
    }
    totalEvents++;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

function formatUSDC(amountBigInt) {
  const str = amountBigInt.toString().padStart(USDC_DECIMALS + 1, '0');
  const whole = str.slice(0, -USDC_DECIMALS) || '0';
  const frac = str.slice(-USDC_DECIMALS);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac.slice(0, 2);
}

async function main() {
  console.log('Fetching PositionSplit events from last 24 hours...\n');

  const now = Math.floor(Date.now() / 1000);
  const yesterday = now - 86400;
  console.log(`  From: ${new Date(yesterday * 1000).toISOString()}`);
  console.log(`  To:   ${new Date(now * 1000).toISOString()}`);

  const fromBlock = await getBlockByTimestamp(yesterday);
  const toBlock = await getBlockByTimestamp(now);
  const totalBlocks = toBlock - fromBlock;
  console.log(`  Blocks: ${fromBlock} -> ${toBlock} (~${totalBlocks} blocks)\n`);

  const numChunks = Math.ceil(totalBlocks / CHUNK_BLOCKS);
  let apiCalls = 0;
  const startTime = Date.now();

  for (let i = 0; i < numChunks; i++) {
    const chunkFrom = fromBlock + i * CHUNK_BLOCKS;
    const chunkTo = Math.min(chunkFrom + CHUNK_BLOCKS - 1, toBlock);

    await sleep(RPC_DELAY_MS);
    const result = await rpcGetLogs(chunkFrom, chunkTo);
    apiCalls++;

    if (result.tooMany) {
      // Split this chunk in half
      const mid = Math.floor((chunkFrom + chunkTo) / 2);
      await sleep(RPC_DELAY_MS);
      const left = await rpcGetLogs(chunkFrom, mid);
      apiCalls++;
      if (left.logs) processLogs(left.logs);

      await sleep(RPC_DELAY_MS);
      const right = await rpcGetLogs(mid + 1, chunkTo);
      apiCalls++;
      if (right.logs) processLogs(right.logs);
    } else {
      processLogs(result.logs);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (i + 1) > 0 ? (Date.now() - startTime) / (i + 1) : 1000;
    const eta = ((numChunks - i - 1) * rate / 1000).toFixed(0);
    process.stdout.write(
      `\r  ${i + 1}/${numChunks} chunks | ${totalEvents.toLocaleString()} events | ${accounts.size} accounts | ${elapsed}s / ~${eta}s left`
    );
  }

  console.log('\n');

  if (totalEvents === 0) {
    console.log('No split events found.');
    return;
  }

  // Sort and print
  const sorted = [...accounts.entries()]
    .map(([address, { count, totalAmount }]) => ({ address, count, totalAmount }))
    .sort((a, b) => (b.totalAmount > a.totalAmount ? 1 : b.totalAmount < a.totalAmount ? -1 : 0));

  console.log('='.repeat(78));
  console.log('  Polymarket Split Accounts (Last 24 Hours)');
  console.log('='.repeat(78));
  console.log('');
  console.log(
    '  #'.padEnd(7) +
    'Address'.padEnd(44) +
    'Splits'.padStart(8) +
    'Total USDC'.padStart(18)
  );
  console.log('-'.repeat(78));

  for (let i = 0; i < sorted.length; i++) {
    const { address, count, totalAmount } = sorted[i];
    console.log(
      `  ${i + 1}.`.padEnd(7) +
      address.padEnd(44) +
      String(count).padStart(8) +
      ('$' + formatUSDC(totalAmount)).padStart(18)
    );
  }

  console.log('');
  console.log('='.repeat(78));
  const totalSplits = sorted.reduce((s, r) => s + r.count, 0);
  const totalUSDC = sorted.reduce((s, r) => s + r.totalAmount, 0n);
  console.log(`  Unique accounts: ${sorted.length}`);
  console.log(`  Total splits:    ${totalSplits.toLocaleString()}`);
  console.log(`  Total USDC:      $${formatUSDC(totalUSDC)}`);
  console.log(`  API calls:       ${apiCalls}`);
  console.log(`  Time:            ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('='.repeat(78));
}

main().catch(err => {
  console.error('\nFatal:', err.message || err);
  process.exit(1);
});
