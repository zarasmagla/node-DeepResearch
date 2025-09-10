import Groq from "groq-sdk";
import { GROQ_API_KEY } from "../config";
import { SpiderSearchResponse, SERPQuery } from "../types";


interface GroqSearchResult {
    title: string;
    url: string;
    content: string;
    score: number;
}

interface GroqExecutedTool {
    index: number;
    type: string;
    arguments: string;
    output: string;
    search_results: {
        results: GroqSearchResult[];
    };
}

interface GroqMessage {
    role: "assistant";
    content: string;
    reasoning: string;
    executed_tools: GroqExecutedTool[];
}

// Groq Compound web search wrapper that normalizes to SpiderSearchResponse shape
export async function groqSearch(query: SERPQuery): Promise<{ response: SpiderSearchResponse }> {
    if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY not found");
    }

    const groq = new Groq({ apiKey: GROQ_API_KEY });

    // Map SERPQuery -> Groq search_settings
    const countryMap: Record<string, string> = {
        'US': 'united states',
        'GB': 'united kingdom',
        'CA': 'canada',
        'AU': 'australia',
        'DE': 'germany',
        'FR': 'france',
        'JP': 'japan',
        'IN': 'india',
        'BR': 'brazil',
        'RU': 'russia',
        'CN': 'china',
        'IT': 'italy',
        'ES': 'spain',
        'MX': 'mexico',
        'KR': 'south korea',
        'GE': 'georgia'
    };

    const country = ((query.country || query.gl || "").toString().toUpperCase() || undefined);
    const mappedCountry = country ? countryMap[country] : undefined;

    // Build a concise prompt; model will decide to invoke web search
    const userPrompt = query.q;

    let data;
    try {
        data = await groq.chat.completions.create({
            model: "groq/compound",

            messages: [
                {
                    "role": "system", content: `You are the best searcher and content finder for fact checking process which can fact check content from any region from United States, Europe and small countries like Georgia. Use georgian or english search queries, whatever is appropriate and relevant before and after keywords inside the search queries

Instructions:
For the search queries use before and after filters like this based on the event and the person because some events might have roots very far away and stuff so make sure what the topic and search query is about and then try to come up with appropriate before and after filters. for some queries you might need to find out the biography of the person first because he might have some info not in near future but in the past
use 'before' and 'after' filter like this.

for example: Ukraine war after:2023-01-01 before:2023-03-01`},
                { role: "user", content: "Search information on the web for query: " + userPrompt }
            ],
            // Pass search settings if available
            ...(mappedCountry ? { search_settings: { country: mappedCountry } as any } : {})
        } as any);
    } catch (err) {
        // Surface a clean error
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Groq web search failed: ${message}`);
    }

    // Extract search results from executed tool calls
    const choice = data?.choices?.[0] || {};
    const msg: GroqMessage = choice.message as GroqMessage;

    const executedTools = msg.executed_tools[0].search_results
    // Some versions may nest tools differently; attempt a couple of fallbacks
    const allResults = executedTools.results as GroqSearchResult[];
    // Normalize into SpiderSearchResponse.content
    const content = (allResults || []).map((r) => {
        const title = r.title || r.url || "";
        const url = r.url || "";
        const description = r.content || "";
        return { title, url, description };
    }).filter((r) => r.url);
    return { response: { content } as SpiderSearchResponse };
}
