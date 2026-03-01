import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('trading');
let _client = null;
let _initAttempted = false;

export async function initTrading() {
    _initAttempted = true;

    if (!config.POLYMARKET_PRIVATE_KEY) {
        log.info('Trading disabled: no POLYMARKET_PRIVATE_KEY set');
        return;
    }

    if (!config.TRADING_ENABLED) {
        log.info('Trading in DRY RUN mode (set TRADING_ENABLED=true to go live)');
        return;
    }

    try {
        // Dynamic imports — these packages are optional
        const { ClobClient } = await import('@polymarket/clob-client');
        const { Wallet } = await import('ethers');

        const signer = new Wallet(config.POLYMARKET_PRIVATE_KEY);
        const chainId = 137; // Polygon

        let apiCreds;
        if (config.POLYMARKET_API_KEY && config.POLYMARKET_API_SECRET && config.POLYMARKET_API_PASSPHRASE) {
            apiCreds = {
                key: config.POLYMARKET_API_KEY,
                secret: config.POLYMARKET_API_SECRET,
                passphrase: config.POLYMARKET_API_PASSPHRASE,
            };
            log.info('Using provided API credentials');
        } else {
            const tempClient = new ClobClient(config.CLOB_BASE, chainId, signer);
            apiCreds = await tempClient.createOrDeriveApiKey();
            log.info('Derived API key from wallet');
        }

        _client = new ClobClient(
            config.CLOB_BASE,
            chainId,
            signer,
            apiCreds,
            0,  // signatureType: EOA
            config.POLYMARKET_FUNDER || signer.address,
        );

        log.info(`Trading client initialized (funder=${config.POLYMARKET_FUNDER || signer.address})`);
    } catch (e) {
        log.error(`Failed to initialize trading client: ${e.message}`);
        _client = null;
    }
}

export function isTradingReady() {
    return _client !== null && config.TRADING_ENABLED;
}

export async function executeTrade(market, side, amountUsd, currentPrice) {
    if (!_client) throw new Error('Trading client not initialized');

    // Determine token ID
    let tokenIds = market.clob_token_ids;
    if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = []; }
    }
    if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
        throw new Error(`No valid token IDs for market ${market.polymarket_market_id}`);
    }

    const tokenId = side === 'YES' ? tokenIds[0] : tokenIds[1];
    const negRisk = market.neg_risk || false;

    // Price with slippage tolerance (5 cents above current)
    const maxPrice = Math.min(currentPrice + 0.05, 0.99);

    log.info(`Placing FOK order: ${side} ${tokenId.slice(0, 12)}... amount=$${amountUsd} maxPrice=${maxPrice.toFixed(2)} negRisk=${negRisk}`);

    try {
        const { Side, OrderType } = await import('@polymarket/clob-client');

        const order = await _client.createMarketOrder({
            tokenID: tokenId,
            side: Side.BUY,
            amount: amountUsd,
            price: maxPrice,
        }, {
            tickSize: '0.01',
            negRisk,
        });

        const response = await _client.postOrder(order, OrderType.FOK);

        log.info(`Order response: ${JSON.stringify(response).slice(0, 300)}`);

        if (response.success === false || response.errorMsg) {
            throw new Error(response.errorMsg || 'Order rejected');
        }

        return response;
    } catch (e) {
        log.error(`Order execution failed: ${e.message}`);
        throw e;
    }
}
