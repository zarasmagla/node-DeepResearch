import { SpiderSearchResponse, SERPQuery } from "../types";
import { groqSearch } from "./groq-search";

// For backward compatibility, keep the same function name used elsewhere but route to Groq
export async function spiderSearch(query: SERPQuery): Promise<{ response: SpiderSearchResponse }> {
    // Map language code similarly to old spider implementation but Groq uses search_settings country boost
    // groqSearch handles API and normalization
    return groqSearch(query);
}
