import type { State } from '../state.js';
interface GammaEvent {
    id: string;
    title: string;
    description?: string;
    slug?: string;
    tags?: {
        id: number;
        slug: string;
        label: string;
    }[];
    image?: string;
    startDate?: string;
    endDate?: string;
    negRisk?: boolean;
    negRiskMarketID?: string;
    active?: boolean;
    closed?: boolean;
    markets?: GammaMarket[];
    volume?: number;
}
interface GammaMarket {
    id: string;
    conditionId?: string;
    questionID?: string;
    question: string;
    description?: string;
    slug?: string;
    outcomes?: string;
    outcomePrices?: string;
    clobTokenIds?: string;
    bestAsk?: number;
    lastTradePrice?: number;
    spread?: number;
    volume?: number;
    volumeClob?: number;
    volume24hr?: number;
    volume1wk?: number;
    volume1mo?: number;
    oneDayPriceChange?: number;
    endDate?: string;
    resolutionSource?: string;
    umaBond?: string;
    umaReward?: string;
    customLiveness?: number;
    umaResolutionStatuses?: any[];
    resolvedBy?: string;
    active?: boolean;
    closed?: boolean;
    acceptingOrders?: boolean;
    negRisk?: boolean;
    automaticallyResolved?: boolean;
}
export declare function backfill(state: State): Promise<void>;
export type { GammaEvent, GammaMarket };
