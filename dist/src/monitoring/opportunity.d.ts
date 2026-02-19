import type { State } from '../state.js';
import type { UmaEvent } from './uma-websocket.js';
export interface DetectionResult {
    outcome: string;
    confidence: number;
    tier: string;
    source: string;
    rawData: any;
}
export declare function processDetectedOutcome(state: State, market: any, result: DetectionResult): Promise<void>;
export declare function processUmaProposal(state: State, marketId: string, event: UmaEvent): Promise<void>;
