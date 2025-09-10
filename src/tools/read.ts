import axiosClient from "../utils/axios-client";
import { TokenTracker } from "../utils/token-tracker";
import { ReadResponse } from "../types";
import { SCRAPE_DO_API_KEY } from "../config";
import {
  extractDomainFromUri,
  getDomainCountry,
} from "../utils/domain-country";
import { estimateGeminiTokens } from "../utils/gemini-tools";

export async function readUrl(
  url: string,
  withAllLinks?: boolean,
  tracker?: TokenTracker,
): Promise<{ response: ReadResponse }> {
  if (!url.trim()) {
    throw new Error("URL cannot be empty");
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("Invalid URL, only http and https URLs are supported");
  }

  let responseData: ReadResponse | null = null;

  try {
    console.log(`Attempting to read URL with Scrape.do: ${url}`);
    const domain = extractDomainFromUri(url);
    const domainDetails = await getDomainCountry(domain);
    const geoCode = (domainDetails.country?.code || "US").toUpperCase();
    const scrapeDoParams = {
      token: SCRAPE_DO_API_KEY,
      url: url,
      geoCode: geoCode, // Scrape.do expects uppercase geoCode
      super: true, // Enable premium proxies if needed
      output: "markdown", // Request markdown output
      render: true,
    };
    console.log('scrapeDoParams', scrapeDoParams);
    const scrapeResponse = await axiosClient.get<string>(
      "https://api.scrape.do",
      {
        params: scrapeDoParams,
        timeout: 15000, // Longer timeout for potentially complex scrapes
      }
    );
    console.log('scrapeResponse', scrapeResponse.data, scrapeDoParams);

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
        images: {},
      },
    };
  } catch (error) {
    console.error(
      `Scrape.do request failed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new Error(`Failed to read URL content. Scrape.do Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!responseData || !responseData.data) {
    throw new Error("Failed to obtain valid response data from Scrape.do");
  }

  console.log("Read successful:", {
    title: responseData.data.title,
    url: responseData.data.url,
    tokens: responseData.data.usage?.tokens || 0,
    source: "Scrape.do",
  });

  const tokens = responseData.data.usage?.tokens || 0;
  const tokenTracker = tracker || new TokenTracker();
  tokenTracker.trackUsage("read", {
    totalTokens: tokens,
    promptTokens: url.length, // Keep original URL length as prompt approximation
    completionTokens: tokens, // Use calculated/estimated tokens as completion
  });

  return { response: responseData };
}