import axiosClient from "../utils/axios-client";
import { SPIDER_API_KEY } from "../config";
import { SpiderSearchResponse, SERPQuery } from "../types";

export async function spiderSearch(query: SERPQuery, options?: { fetch_page_content?: boolean; search_limit?: number; return_format?: "raw" | "markdown" | "text"; limit?: number; language?: string; country?: string; location?: string; tbs?: string; }): Promise<{ response: SpiderSearchResponse }> {
    const body: any = {
        search: query.q,
        search_limit: options?.search_limit ?? 10,
    };

    if (options?.fetch_page_content) {
        body.fetch_page_content = true;
        if (options?.return_format) body.return_format = options.return_format;
        if (typeof options?.limit === 'number') body.limit = options.limit;
    }

    if (query.location || options?.location) body.location = query.location || options?.location;
    if (query.tbs || options?.tbs) body.tbs = query.tbs || options?.tbs;
    if (options?.language) body.language = options.language;
    if (options?.country) body.country = options.country;

    const response = await axiosClient.post<SpiderSearchResponse | any>(
        "https://api.spider.cloud/search",
        body,
        {
            headers: {
                Authorization: `Bearer ${SPIDER_API_KEY}`,
                "Content-Type": "application/json",
            },
            timeout: 20000,
        }
    );

    // Response can be either { content: [...] } or an array of objects when fetch_page_content is true
    const data = response.data;

    if (Array.isArray(data)) {
        // Normalize to minimal search snippets from the array of detailed results
        const content = data
            .filter((item: any) => item && typeof item === 'object' && item.url)
            .map((item: any) => ({
                title: item.title || item.url,
                description: (item.content && typeof item.content === 'string') ? item.content.slice(0, 300) : "",
                url: item.url,
            }));
        return { response: { content } as SpiderSearchResponse };
    }

    if (!data?.content || !Array.isArray(data.content)) {
        throw new Error("Invalid Spider response format");
    }

    return { response: data as SpiderSearchResponse };
}


