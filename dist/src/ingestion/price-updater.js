import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
const log = createLogger('price');
export function startPriceUpdater(state) {
    log.info(`Price updater started (hot=${config.HOT_PRICE_INTERVAL / 1000}s)`);
    // Hot markets — fast CLOB midpoint updates
    setInterval(async () => {
        if (state.hotMarkets.size === 0)
            return;
        try {
            await updateHotPrices(state);
        }
        catch (e) {
            log.error('Hot price update failed', e.message);
        }
    }, config.HOT_PRICE_INTERVAL);
}
async function updateHotPrices(state) {
    for (const [marketId, hot] of state.hotMarkets) {
        if (!hot.clobTokenId)
            continue;
        try {
            const url = `${config.CLOB_BASE}/midpoint?token_id=${hot.clobTokenId}`;
            const res = await fetch(url);
            if (!res.ok)
                continue;
            const data = await res.json();
            const mid = Number(data.mid);
            if (isNaN(mid) || mid <= 0)
                continue;
            hot.currentPrice = mid;
            hot.profitPct = ((1 - mid) / mid) * 100;
        }
        catch {
            // Silently skip — non-critical
        }
    }
}
//# sourceMappingURL=price-updater.js.map