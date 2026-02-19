export interface HotMarket {
    marketId: string;
    question: string;
    questionNorm: string;
    detectedOutcome: string;
    confidence: number;
    detectedAt: number;
    winningPrice: number;
    currentPrice: number;
    profitPct: number;
    isActionable: boolean;
    eventId: string;
    clobTokenId: string;
    customLiveness: number;
}
export declare class State {
    hotMarkets: Map<string, HotMarket>;
    knownEventIds: Set<string>;
    knownMarketIds: Set<string>;
    marketsByQuestion: Map<string, string>;
    lastProcessedBlock: number;
    backfillComplete: boolean;
    load(): void;
    persist(): void;
    stats(): {
        events: number;
        markets: number;
        hotMarkets: number;
        block: number;
    };
}
