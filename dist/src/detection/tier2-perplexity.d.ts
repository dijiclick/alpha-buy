interface PerplexityResult {
    resolved: boolean;
    outcome: string;
    confidence: number;
    source: string;
}
export declare function checkPerplexity(question: string, description: string): Promise<PerplexityResult | null>;
export {};
