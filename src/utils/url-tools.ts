import {BoostedSearchSnippet, SearchResult, SearchSnippet, TrackerContext} from "../types";
import {smartMergeStrings} from "./text-tools";
import {rerankDocuments} from "../tools/jina-rerank";

export function normalizeUrl(urlString: string, debug = false): string {
  if (!urlString?.trim()) {
    throw new Error('Empty URL');
  }

  urlString = urlString.trim();

  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(urlString)) {
    urlString = 'https://' + urlString;
  }

  try {
    const url = new URL(urlString);

    url.hostname = url.hostname.toLowerCase();
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
    }

    if ((url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }

    // Path normalization with error tracking
    url.pathname = url.pathname
      .split('/')
      .map(segment => {
        try {
          return decodeURIComponent(segment);
        } catch (e) {
          if (debug) console.error(`Failed to decode path segment: ${segment}`, e);
          return segment;
        }
      })
      .join('/')
      .replace(/\/+/g, '/')
      .replace(/\/+$/, '') || '/';

    // Query parameter normalization with error details
    const searchParams = new URLSearchParams(url.search);
    const sortedParams = Array.from(searchParams.entries())
      .map(([key, value]) => {
        if (value === '') return [key, ''];
        try {
          const decodedValue = decodeURIComponent(value);
          if (encodeURIComponent(decodedValue) === value) {
            return [key, decodedValue];
          }
        } catch (e) {
          if (debug) console.error(`Failed to decode query param ${key}=${value}`, e);
        }
        return [key, value];
      })
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .filter(([key]) => key !== '');

    url.search = new URLSearchParams(sortedParams).toString();

    // Fragment handling with validation
    if (url.hash === '#' || url.hash === '#top' || url.hash === '#/' || !url.hash) {
      url.hash = '';
    } else if (url.hash) {
      try {
        const decodedHash = decodeURIComponent(url.hash.slice(1));
        const encodedBack = encodeURIComponent(decodedHash);
        // Only use decoded version if it's safe
        if (encodedBack === url.hash.slice(1)) {
          url.hash = '#' + decodedHash;
        }
      } catch (e) {
        if (debug) console.error(`Failed to decode fragment: ${url.hash}`, e);
      }
    }

    let normalizedUrl = url.toString();

    // Final URL normalization with validation
    try {
      const decodedUrl = decodeURIComponent(normalizedUrl);
      const encodedBack = encodeURIComponent(decodedUrl);
      // Only use decoded version if it's safe
      if (encodedBack === normalizedUrl) {
        normalizedUrl = decodedUrl;
      }
    } catch (e) {
      if (debug) console.error('Failed to decode final URL', e);
    }

    return normalizedUrl;
  } catch (error) {
    // Main URL parsing error - this one we should throw
    throw new Error(`Invalid URL "${urlString}": ${error}`);
  }
}


export function getUnvisitedURLs(allURLs: Record<string, SearchSnippet>, visitedURLs: string[]): SearchSnippet[] {
  return Object.entries(allURLs)
    .filter(([url]) => !visitedURLs.includes(url))
    .map(([, result]) => result);
}


// Function to extract hostname and path from a URL
const extractUrlParts = (urlStr: string) => {
  try {
    const url = new URL(urlStr);
    return {
      hostname: url.hostname,
      path: url.pathname
    };
  } catch (e) {
    console.error(`Error parsing URL: ${urlStr}`, e);
    return {hostname: "", path: ""};
  }
};

// Function to count occurrences of hostnames and paths
export const countUrlParts = (urlItems: SearchResult[]) => {
  const hostnameCount: Record<string, number> = {};
  const pathPrefixCount: Record<string, number> = {};
  let totalUrls = 0;

  urlItems.forEach(item => {
    item = (item as { title: string; url: string; description: string; weight?: number })
    if (!item || !item.url) return; // Skip invalid items

    totalUrls++;
    const {hostname, path} = extractUrlParts(item.url);

    // Count hostnames
    hostnameCount[hostname] = (hostnameCount[hostname] || 0) + 1;

    // Count path prefixes (segments)
    const pathSegments = path.split('/').filter(segment => segment.length > 0);
    pathSegments.forEach((segment, index) => {
      const prefix = '/' + pathSegments.slice(0, index + 1).join('/');
      pathPrefixCount[prefix] = (pathPrefixCount[prefix] || 0) + 1;
    });
  });

  return {hostnameCount, pathPrefixCount, totalUrls};
};

// Calculate normalized frequency for boosting
const normalizeCount = (count: any, total: any) => {
  return total > 0 ? count / total : 0;
};

// Calculate boosted weights
export const rankURLs = (urlItems: SearchSnippet[], options: any = {}, trackers: TrackerContext): any[] => {
  // Default parameters for boosting - can be overridden
  const {
    freqFactor = 0.5,           // How much to boost based on term frequency
    hostnameBoostFactor = 0.5,  // How much to boost based on hostname frequency
    pathBoostFactor = 0.4,      // How much to boost based on path frequency
    decayFactor = 0.8,          // Decay factor for longer paths (0-1)
    jinaRerankFactor = 0.8,     // How much to boost based on Jina reranking
    minBoost = 0,               // Minimum boost score
    maxBoost = 5,                // Maximum boost score cap
    question = '',              // Optional question for Jina reranking
  } = options;

  // Count URL parts first
  const counts = countUrlParts(urlItems);
  const {hostnameCount, pathPrefixCount, totalUrls} = counts;

  if (question.trim().length > 0) {
    // get from jina rerank
    rerankDocuments(question, urlItems.map(item => smartMergeStrings(item.title, item.description)), trackers.tokenTracker)
      .then(({results}) => {
        results.forEach(({index, relevance_score}) => {
          (urlItems[index] as BoostedSearchSnippet).jinaRerankBoost = relevance_score * jinaRerankFactor;
        });
      })
  }


  return (urlItems as BoostedSearchSnippet[]).map(item => {
    if (!item || !item.url) {
      console.error('Skipping invalid item:', item);
      return item; // Return unchanged
    }

    const {hostname, path} = extractUrlParts(item.url);

    // Base weight from original
    const freq = item.weight || 1.0; // Default to 1 if weight is missing

    // Hostname boost (normalized by total URLs)
    const hostnameFreq = normalizeCount(hostnameCount[hostname] || 0, totalUrls);
    const hostnameBoost = hostnameFreq * hostnameBoostFactor;

    // Path boost (consider all path prefixes with decay for longer paths)
    let pathBoost = 0;
    const pathSegments = path.split('/').filter(segment => segment.length > 0);
    pathSegments.forEach((segment, index) => {
      const prefix = '/' + pathSegments.slice(0, index + 1).join('/');
      const prefixCount = pathPrefixCount[prefix] || 0;
      const prefixFreq = normalizeCount(prefixCount, totalUrls);

      // Apply decay factor based on path depth
      const decayedBoost = prefixFreq * Math.pow(decayFactor, index) * pathBoostFactor;
      pathBoost += decayedBoost;
    });

    const freqBoost = freq / totalUrls * freqFactor;
    const jinaRerankBoost = item.jinaRerankBoost || 0;
    // Calculate new weight with clamping
    const finalScore = Math.min(
      Math.max(
        hostnameBoost
        + pathBoost
        + freqBoost
        + jinaRerankBoost, minBoost),
      maxBoost);

    return {
      ...item,
      freqBoost,
      hostnameBoost,
      pathBoost,
      jinaRerankBoost,
      finalScore
    } as BoostedSearchSnippet;
  }).sort((a, b) => b.finalScore - a.finalScore);
};

export const addToAllURLs = (r: SearchSnippet, allURLs: Record<string, SearchSnippet>) => {
  if (!allURLs[r.url]) {
    allURLs[r.url] = r;
    allURLs[r.url].weight = 1;
  } else {
    (allURLs[r.url].weight as number)++;
    const curDesc = allURLs[r.url].description;
    allURLs[r.url].description = smartMergeStrings(curDesc, r.description);
  }
}

export const weightedURLToString = (allURLs: BoostedSearchSnippet[], maxURLs = 70) => {
  if (!allURLs || allURLs.length === 0) return '';

  return (allURLs)
    .map(r => {
      const merged = smartMergeStrings(r.title, r.description);
      return {
        url: r.url,
        score: r.finalScore,
        merged
      };
    })
    .filter(item => item.merged !== '' && item.merged !== undefined && item.merged !== null)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, maxURLs)
    .map(item => `  + weight: ${item.score.toFixed(2)} "${item.url}": "${item.merged}"`)
    .join('\n');
}


/**
 * Draw a sample from a multinomial distribution
 * @param items Array of [name, weight] tuples
 * @returns A randomly selected item based on the weights, or null if array is empty
 */
export function sampleMultinomial<T>(items: [T, number][]): T | null {
  // Handle empty array
  if (!items || items.length === 0) {
    return null;
  }

  // Calculate total weight
  const totalWeight = items.reduce((sum, [, weight]) => sum + weight, 0);

  // Handle case where all weights are 0
  if (totalWeight === 0) {
    return null;
  }

  // Generate a random number between 0 and total weight
  const randValue = Math.random() * totalWeight;

  // Find the item corresponding to the random value
  let cumulativeWeight = 0;

  for (const [item, weight] of items) {
    cumulativeWeight += weight;
    if (randValue <= cumulativeWeight) {
      return item;
    }
  }

  // Fallback (should rarely happen due to floating point precision)
  return items[items.length - 1][0];
}




/**
 * Fetches the last modified date for a URL using the datetime detection API
 * @param url The URL to check for last modified date
 * @returns Promise containing the last modified date or null if not found
 */
export async function getLastModified(url: string): Promise<string | null> {
  try {
    // Call the API with proper encoding
    const apiUrl = `https://api-beta-datetime.jina.ai?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();

    // Return the bestGuess date if available
    if (data.bestGuess) {
      return data.bestGuess;
    }

    return null;
  } catch (error) {
    console.error('Failed to fetch last modified date:', error);
    return null;
  }
}
