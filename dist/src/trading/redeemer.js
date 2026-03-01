import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
import { getOpenPositions, markPositionSettled, markPositionRedeemed } from '../db/supabase.js';
import { sendRedeemNotification } from '../detection/agent.js';

const log = createLogger('redeemer');
const REDEEM_CHECK_INTERVAL = 5 * 60_000; // every 5 minutes

export function startRedeemMonitor(state) {
    if (!config.TRADING_ENABLED && !config.REDEEM_ENABLED) {
        log.info('Auto-redeem disabled (neither TRADING_ENABLED nor REDEEM_ENABLED set)');
        return;
    }

    const check = async () => {
        try {
            await checkSettlements(state);
        } catch (e) {
            log.error('Redeem check failed', e.message);
        }
    };

    // First check after 2 minutes, then every 5 minutes
    setTimeout(check, 2 * 60_000);
    setInterval(check, REDEEM_CHECK_INTERVAL);
    log.info('Auto-redeem monitor started (every 5 min)');
}

async function checkSettlements(state) {
    const positions = await getOpenPositions();
    if (positions.length === 0) return;

    log.info(`Checking ${positions.length} open positions for settlement...`);

    for (const pos of positions) {
        try {
            // Check if market has settled via Gamma API
            const res = await fetch(`${config.GAMMA_BASE}/markets/${pos.market_id}`);
            if (!res.ok) {
                log.warn(`Gamma API ${res.status} for ${pos.market_id}`);
                continue;
            }

            const market = await res.json();

            if (!market.closed) continue; // not settled yet

            // Market is settled — determine winning outcome
            const winningOutcome = determineWinner(market);
            if (!winningOutcome) {
                log.warn(`Market ${pos.market_id} closed but can't determine winner`);
                continue;
            }

            const weWon = pos.side.toUpperCase() === winningOutcome.toUpperCase();
            const pnl = weWon
                ? (1 - pos.buy_price) * pos.shares  // win: pay buyPrice, receive $1 per share
                : -pos.amount_usd;                    // loss: lose entire investment

            log.info(`SETTLED: "${pos.market_question?.slice(0, 60)}" → ${winningOutcome} | ${weWon ? 'WIN' : 'LOSS'} | P&L: $${pnl.toFixed(2)}`);

            // Update DB
            await markPositionSettled(pos.id, winningOutcome, pnl);

            // Remove from active positions in state
            if (state.activePositions) {
                const key = `${pos.market_id}_${pos.side}`;
                state.activePositions.delete(key);
            }

            // Attempt on-chain redeem if we won
            if (weWon && config.REDEEM_ENABLED && config.POLYMARKET_PRIVATE_KEY) {
                try {
                    await redeemOnChain(pos, market);
                    await markPositionRedeemed(pos.id);
                    log.info(`Redeemed on-chain: trade #${pos.id}`);
                } catch (e) {
                    log.warn(`On-chain redeem failed for trade #${pos.id}: ${e.message} (user can redeem manually)`);
                }
            }

            // Send Telegram notification
            await sendRedeemNotification(
                { title: pos.market_question || 'Unknown' },
                { question: pos.market_question },
                pos.side,
                weWon,
                pnl
            );
        } catch (e) {
            log.warn(`Settlement check failed for ${pos.market_id}: ${e.message}`);
        }
    }
}

function determineWinner(market) {
    // Try outcomePrices — settled markets show [1,0] or [0,1]
    let prices = market.outcomePrices;
    if (typeof prices === 'string') {
        try { prices = JSON.parse(prices); } catch { prices = null; }
    }

    if (Array.isArray(prices) && prices.length >= 2) {
        const yes = Number(prices[0]);
        const no = Number(prices[1]);
        if (yes >= 0.99) return 'YES';
        if (no >= 0.99) return 'NO';
    }

    // Try winnerOutcome field (if Gamma provides it)
    if (market.winnerOutcome) return market.winnerOutcome.toUpperCase();

    return null;
}

async function redeemOnChain(position, market) {
    // Dynamic import ethers — only needed if actually redeeming
    const { ethers } = await import('ethers');

    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new ethers.Wallet(config.POLYMARKET_PRIVATE_KEY, provider);

    // Conditional Tokens Framework contract on Polygon
    const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const PARENT_COLLECTION_ID = '0x' + '0'.repeat(64);

    const CTF_ABI = [
        'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    ];

    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

    const conditionId = market.conditionId || market.condition_id;
    if (!conditionId) throw new Error('No conditionId available');

    const tx = await ctf.redeemPositions(
        USDC_E,
        PARENT_COLLECTION_ID,
        conditionId,
        [1, 2], // both index sets
    );
    const receipt = await tx.wait();
    log.info(`Redeemed: tx=${receipt.transactionHash}`);
    return receipt;
}

// Exported for WebSocket-triggered settlement checks
export async function handleMarketResolution(data, state) {
    const marketId = data.market_id || data.asset_id;
    if (!marketId) return;

    const winningOutcome = data.winning_outcome?.toUpperCase();
    if (!winningOutcome) return;

    log.info(`WS RESOLVED: ${marketId} → ${winningOutcome}`);

    // Check if we have an open position on this market
    const positions = await getOpenPositions();
    const matching = positions.filter(p => p.market_id === marketId || p.token_id === marketId);

    for (const pos of matching) {
        const weWon = pos.side.toUpperCase() === winningOutcome;
        const pnl = weWon
            ? (1 - pos.buy_price) * pos.shares
            : -pos.amount_usd;

        log.info(`WS SETTLED: trade #${pos.id} "${pos.market_question?.slice(0, 40)}" → ${weWon ? 'WIN' : 'LOSS'} P&L: $${pnl.toFixed(2)}`);

        await markPositionSettled(pos.id, winningOutcome, pnl);

        if (state.activePositions) {
            const key = `${pos.market_id}_${pos.side}`;
            state.activePositions.delete(key);
        }

        await sendRedeemNotification(
            { title: pos.market_question || 'Unknown' },
            { question: pos.market_question },
            pos.side,
            weWon,
            pnl
        );
    }
}
