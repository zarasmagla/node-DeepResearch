import axios from "axios";
import { TokenTracker } from "../utils/token-tracker";
import { ReadResponse } from '../types';
import { JINA_API_KEY, SCRAPE_DO_API_KEY } from "../config";
import { isBotCheck } from "../utils/bot-detection";
import {
  extractDomainFromUri,
  getDomainCountry,
} from "../utils/domain-country";
import { estimateGeminiTokens } from "../utils/gemini-tools";

export async function readUrl(
  url: string,
  withAllLinks?: boolean,
  tracker?: TokenTracker
): Promise<{ response: ReadResponse }> {
  if (!url.trim()) {
    throw new Error('URL cannot be empty');
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('Invalid URL, only http and https URLs are supported');
  }

  let responseData: ReadResponse | null = null;
  let lastError: Error | null = null;

  // --- Try Jina First ---
  try {
    console.log(`Attempting to read URL with Jina: ${url}`);
    const jinaHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${JINA_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Retain-Images': 'none',
      'X-Md-Link-Style': 'discarded',
    };
    if (withAllLinks) {
      jinaHeaders['X-With-Links-Summary'] = 'all';
    }

    const { data: jinaResponse } = await axios.post<ReadResponse>(
      'https://r.jina.ai/',
      { url },
      {
        headers: jinaHeaders,
        timeout: 60000, // 60 seconds timeout
        responseType: 'json',
      }
    );

    if (!jinaResponse.data) {
      console.log("Jina response data is missing.");
      lastError = new Error("Jina response data is missing.");
    } else if (await isBotCheck(jinaResponse)) {
      console.log("Jina detected bot check.");
      lastError = new Error("Jina detected bot check.");
    } else {
      console.log("Jina request successful.");
      responseData = jinaResponse;
    }
  } catch (error) {
    console.log(
      `Jina request failed: ${error instanceof Error ? error.message : String(error)
      }`
    );
    lastError = error instanceof Error ? error : new Error(String(error));
    if (axios.isAxiosError(error) && error.response?.status === 402) {
      // If Jina fails due to insufficient balance, throw immediately
      throw new Error(
        (error.response.data as any)?.readableMessage ||
        "Jina: Insufficient balance"
      );
    }
  }

  // --- Fallback to Scrape.do if Jina failed or returned invalid/bot data ---
  if (!responseData) {
    console.log(
      `Jina failed or returned unusable data, falling back to Scrape.do for URL: ${url}`
    );
    try {
      const domain = extractDomainFromUri(url);
      const domainDetails = await getDomainCountry(domain);
      const scrapeResponse = await axios.get<string>("https://api.scrape.do", {
        params: {
          token: SCRAPE_DO_API_KEY,
          url: url,
          geoCode: domainDetails.country?.code || "us", // Default to 'us' if country code not found
          super: true, // Enable premium proxies if needed
          output: "markdown", // Request markdown output
        },
        timeout: 90000, // Longer timeout for potentially complex scrapes
        responseType: "text", // Expecting markdown text
      });

      if (!scrapeResponse.data || scrapeResponse.data.trim().length === 0) {
        throw new Error("Scrape.do returned empty content.");
      }

      console.log(
        `Scrape.do request successful. Content length: ${scrapeResponse.data.length}`
      );

      // Construct a ReadResponse object from Scrape.do data
      const estimatedTokens = estimateGeminiTokens(scrapeResponse.data);
      const title =
        scrapeResponse.data
          .split("\n")[0]
          .replace(/^#+\s*/, "")
          .trim() || "Content"; // Extract first line as title

      responseData = {
        code: 0, // Assuming success if we get here
        status: 200,
        data: {
          url: url,
          title: title,
          content: scrapeResponse.data,
          description: "", // Scrape.do doesn't provide description in this format
          links: [], // Scrape.do doesn't provide links in this format
          usage: {
            tokens: estimatedTokens,
          },
        },
      };
      lastError = null; // Clear previous Jina error if Scrape.do succeeded
    } catch (error) {
      console.error(
        `Scrape.do request failed: ${error instanceof Error ? error.message : String(error)
        }`
      );
      // If Scrape.do also fails, throw an error combining the context
      const jinaErrorMsg = lastError?.message
        ? `Jina Error: ${lastError.message}`
        : "Jina failed or returned unusable data.";
      const scrapeErrorMsg = `Scrape.do Error: ${error instanceof Error ? error.message : String(error)
        }`;
      throw new Error(
        `Failed to read URL content. ${jinaErrorMsg}. ${scrapeErrorMsg}`
      );
    }
  }

  if (!responseData || !responseData.data) {
    // This should ideally not be reached if error handling above is correct, but acts as a safeguard
    throw (
      lastError ||
      new Error("Failed to obtain valid response data from any source.")
    );
  }

  console.log("Read successful:", {
    title: responseData.data.title,
    url: responseData.data.url,
    tokens: responseData.data.usage?.tokens || 0,
    source: lastError === null && responseData.code === 0 && responseData.status === 200 && responseData.data.content.length > 0 ? "Jina" : "Scrape.do", // Indicate the source
  });

  const tokens = responseData.data.usage?.tokens || 0;
  const tokenTracker = tracker || new TokenTracker();
  tokenTracker.trackUsage('read', {
    totalTokens: tokens,
    promptTokens: url.length, // Keep original URL length as prompt approximation
    completionTokens: tokens // Use calculated/estimated tokens as completion
  });

  return { response: responseData };
}