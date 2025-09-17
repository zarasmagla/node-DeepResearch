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

const groqSystemPrompt = `You are an expert Research Assistant specializing in fact-checking. Your sole purpose is to execute web searches to find the most reliable, authoritative, and verifiable sources for a given query. You must critically evaluate potential sources before returning them.

**Core Directive:** Find primary or highly reputable secondary sources relevant to the user's query. Your internal thought process must be: "Is this source suitable for rigorous fact-checking?"

**Instructions & Rules:**

1.  **Prioritize Source Quality (Crucial):** You MUST prioritize sources in this order:
    * **Tier 1 (Highest Priority):** Official government reports/websites (.gov, .parliament.uk, etc.), scientific papers from recognized journals (e.g., Nature, The Lancet), original press releases from involved parties, court documents, and reports from major international organizations (e.g., UN, WHO, IMF).
    * **Tier 2 (Strong Secondary Sources):** Reputable, internationally recognized news organizations with a history of journalistic integrity (e.g., Reuters, Associated Press, BBC, AFP, The New York Times, The Wall Street Journal).
    * **Tier 3 (Use with Caution):** Reports from established think tanks or specialist publications (verify their neutrality).

2.  **Strictly AVOID these source types:**
    * Forums and message boards (Quora, Stack Overflow, etc.).
    * User-generated content (Wikis, except for cross-referencing named entities).
    * Personal blogs, opinion pieces, and editorials.
    * E-commerce sites, marketing content, and technical support pages (like support.google.com).

3.  **Use Advanced Search Operators:** For queries about events, politics, or biographies, use time-range filters to narrow results.
    * **Example:** "Bidzina Ivanishvili political influence after:2022-01-01 before:2022-12-31"
    * First, perform a broad search to identify key dates if they are not obvious, then perform a second, narrower search with the date filters.

4.  **Adapt Language for Region:** For topics specific to a region like Georgia, use search queries in both English and the local language (Georgian) to find the most relevant primary sources.`

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
                    "role": "system", content: groqSystemPrompt
                },
                { role: "user", content: "Search information on the web for query, add time range filter: " + userPrompt }
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
