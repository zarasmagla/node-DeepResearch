import { TokenTracker } from "../utils/token-tracker";
import { ReadResponse } from '../types';
import axiosClient from "../utils/axios-client";
import { JINA_API_KEY, SCRAPE_DO_API_KEY } from "../config";
import { isBotCheck } from '../utils/bot-detection';
import { extractDomainFromUri, getDomainCountry } from '../utils/domain-country';
import { estimateGeminiTokens } from '../utils/gemini-tools';

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

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${JINA_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Retain-Images': 'none',
    'X-Md-Link-Style': 'discarded',
  };

  if (withAllLinks) {
    headers['X-With-Links-Summary'] = 'all';
  }

  try {
    // Use axios which handles encoding properly
    const { data } = await axiosClient.post<ReadResponse>(
      'https://r.jina.ai/',
      { url },
      {
        headers,
        timeout: 60000,
        responseType: 'json'
      }
    );

    if (!data.data) {
      throw new Error('Invalid response data');
    }

    if (await isBotCheck(data)) {
      console.log('Bot check triggered, attempting to scrape...');

      const domain = extractDomainFromUri(url);
      const domainDetails = await getDomainCountry(domain);
      const scrapeResponse = await axios.get<string>(
        'https://api.scrape.do',
        {
          headers,
          params: {
            url: url,
            token: SCRAPE_DO_API_KEY,
            geoCode: domainDetails.country?.code || 'us',
            super: true,
            output: 'markdown'
          },
          timeout: 60000,
          responseType: 'text'
        }
      );

      console.log('Scrape response content length:', scrapeResponse.data.length);

      data.data.content = scrapeResponse.data;
      data.data.usage.tokens = estimateGeminiTokens(scrapeResponse.data);
      data.data.title = scrapeResponse.data.split('\n')[0];
    }

    console.log('Read:', {
      title: data.data.title,
      url: data.data.url,
      tokens: data.data.usage?.tokens || 0
    });

    const tokens = data.data.usage?.tokens || 0;
    const tokenTracker = tracker || new TokenTracker();
    tokenTracker.trackUsage('read', {
      totalTokens: tokens,
      promptTokens: url.length,
      completionTokens: tokens
    });

    return { response: data };
  } catch (error: any) {
    console.error(`Error reading URL: ${error.message}`);
    throw error;
  }
}