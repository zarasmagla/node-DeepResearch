import {BoostedSearchResult, SearchResult} from "../types";

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


export function getUnvisitedURLs(allURLs: Record<string, SearchResult>, visitedURLs: string[]): SearchResult[] {
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
    return { hostname: "", path: "" };
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
    const { hostname, path } = extractUrlParts(item.url);

    // Count hostnames
    hostnameCount[hostname] = (hostnameCount[hostname] || 0) + 1;

    // Count path prefixes (segments)
    const pathSegments = path.split('/').filter(segment => segment.length > 0);
    pathSegments.forEach((segment, index) => {
      const prefix = '/' + pathSegments.slice(0, index + 1).join('/');
      pathPrefixCount[prefix] = (pathPrefixCount[prefix] || 0) + 1;
    });
  });

  return { hostnameCount, pathPrefixCount, totalUrls };
};

// Calculate normalized frequency for boosting
const normalizeCount = (count: any, total: any) => {
  return total > 0 ? count / total : 0;
};

// Calculate boosted weights
export const calculateBoostedWeights = (urlItems: SearchResult[], options: any = {}): any[] => {
  // Default parameters for boosting - can be overridden
  const {
    hostnameBoostFactor = 0.7,  // How much to boost based on hostname frequency
    pathBoostFactor = 0.4,      // How much to boost based on path frequency
    decayFactor = 0.8,          // Decay factor for longer paths (0-1)
    minBoost = 0,               // Minimum boost score
    maxBoost = 5                // Maximum boost score cap
  } = options;

  // Count URL parts first
  const counts = countUrlParts(urlItems);
  const { hostnameCount, pathPrefixCount, totalUrls } = counts;

  return urlItems.map(item => {
    item = (item as BoostedSearchResult)
    if (!item || !item.url) {
      console.error('Skipping invalid item:', item);
      return item; // Return unchanged
    }

    const { hostname, path } = extractUrlParts(item.url);

    // Base weight from original
    const originalWeight = item.weight || 1.0; // Default to 1 if weight is missing

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

    // Calculate new weight with clamping
    const boostScore = Math.min(Math.max(hostnameBoost + pathBoost, minBoost), maxBoost);
    const boostedWeight = originalWeight + boostScore;

    return {
      ...item,
      originalWeight,
      hostnameBoost,
      pathBoost,
      boostScore,
      boostedWeight
    } as BoostedSearchResult;
  });
};