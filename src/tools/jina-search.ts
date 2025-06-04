import { TokenTracker } from "../utils/token-tracker";
import { SearchResponse, SERPQuery } from "../types";
import { JINA_API_KEY } from "../config";
import axiosClient from '../utils/axios-client';
import { get_search_logger } from "../utils/structured-logger";

export async function search(
  query: SERPQuery,
  tracker?: TokenTracker
): Promise<{ response: SearchResponse }> {
  const logger = get_search_logger();
  const startTime = Date.now();

  try {
    logger.external_service_call(
      "jina-search",
      "search",
      undefined,
      query,
      undefined,
      undefined,
      "STARTED"
    );

    const { data } = await axiosClient.post<SearchResponse>(
      `https://s.jina.ai/`,
      query,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${JINA_API_KEY}`,
          "X-Respond-With": "no-content",
          "X-No-Cache": true,
        },
        timeout: 30000,
        responseType: "json",
      }
    );

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format");
    }

    const totalTokens = data.data.reduce(
      (sum, item) => sum + (item.usage?.tokens || 0),
      0
    );

    console.log("Total URLs:", data.data.length);

    const tokenTracker = tracker || new TokenTracker();
    tokenTracker.trackUsage("search", {
      totalTokens,
      promptTokens: query.q.length,
      completionTokens: totalTokens,
    });

    logger.external_service_call(
      "jina-search",
      "search",
      undefined,
      query,
      { resultCount: data.data.length, totalTokens },
      Date.now() - startTime,
      "SUCCESS"
    );

    return { response: data };
  } catch (error) {
    logger.external_service_call(
      "jina-search",
      "search",
      undefined,
      query,
      undefined,
      Date.now() - startTime,
      "ERROR",
      error as Error
    );
    console.error('Error in jina search:', error);
    throw error;
  }
}
