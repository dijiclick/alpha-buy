import { config } from '../util/config.js';
import { createLogger } from '../util/logger.js';
const log = createLogger('perplexity');
export async function checkPerplexity(question, description) {
    if (!config.PERPLEXITY_API_KEY) {
        log.warnOnce('no-key', 'Perplexity API key not configured, skipping Tier 2');
        return null;
    }
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.PERPLEXITY_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'sonar',
            messages: [
                {
                    role: 'system',
                    content: 'You determine if real-world events have already happened and their outcomes. Return JSON only, no markdown.',
                },
                {
                    role: 'user',
                    content: `Has this event already resolved/finished? Question: "${question}"\nContext: ${description}\n\nReturn JSON: { "resolved": boolean, "outcome": "yes"|"no"|"unknown", "confidence": 0-100, "source_url": "url or empty string", "reasoning": "brief 1-sentence explanation" }`,
                },
            ],
            temperature: 0.1,
            max_tokens: 200,
        }),
    });
    if (!res.ok) {
        log.warn(`Perplexity API ${res.status}: ${await res.text().catch(() => '')}`);
        return null;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content)
        return null;
    try {
        // Strip markdown code fences if present
        const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        return {
            resolved: parsed.resolved === true,
            outcome: parsed.outcome || 'unknown',
            confidence: Number(parsed.confidence) || 0,
            source: `perplexity:${parsed.source_url || ''}`,
        };
    }
    catch (e) {
        log.warn('Failed to parse Perplexity response', content.slice(0, 200));
        return null;
    }
}
//# sourceMappingURL=tier2-perplexity.js.map