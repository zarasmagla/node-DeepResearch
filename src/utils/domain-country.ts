import axios, { AxiosRequestConfig } from 'axios';
import { promises as dns } from 'dns';
import NodeCache from 'node-cache';

/**
 * Domain country information interface
 */
export interface DomainCountryInfo {
  domain: string;
  country?: {
    code: string;
    name: string;
  };
  method: 'tld' | 'ip-geolocation' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  error?: {
    message: string;
    code: string;
  };
}

/**
 * Configuration options
 */
export interface DomainCountryOptions {
  timeout?: number;
  cacheTTL?: number;
  ipGeolocationApiKey?: string;
  fallbackApi?: 'ipstack' | 'ipdata' | 'ipinfo';
}

// Default configuration
const DEFAULT_OPTIONS: Required<DomainCountryOptions> = {
  timeout: 5000,
  cacheTTL: 3600, // 1 hour
  ipGeolocationApiKey: '',
  fallbackApi: 'ipstack'
};

// Setup cache
const domainCache = new NodeCache({
  stdTTL: DEFAULT_OPTIONS.cacheTTL,
  checkperiod: 120
});

// Extended country code top-level domains mapping
const ccTLDs: Record<string, string> = {
  'ge': 'Georgia',
  'us': 'United States',
  'uk': 'United Kingdom',
  'ca': 'Canada',
  'jp': 'Japan',
  'fr': 'France',
  'de': 'Germany',
  'ru': 'Russia',
  'cn': 'China',
  'in': 'India',
  'au': 'Australia',
  // ...additional country codes would go here
};

// Special TLD cases
const specialTLDs: Record<string, string> = {
  'co.uk': 'United Kingdom',
  'ac.uk': 'United Kingdom',
  'org.uk': 'United Kingdom',
  'com.au': 'Australia',
  'co.jp': 'Japan',
  'co.nz': 'New Zealand',
};

/**
 * Validates domain format
 */
function isValidDomain(domain: string): boolean {
  const cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
  return domainRegex.test(cleanDomain);
}

/**
 * Extracts the top-level domain from a domain string
 */
function extractTLD(domain: string): { tld: string, specialTld: string | null } {
  // Remove protocol if present
  let cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
  
  // Remove path, query parameters, etc.
  cleanDomain = cleanDomain.split('/')[0];
  
  const parts = cleanDomain.split('.');
  if (parts.length < 2) return { tld: '', specialTld: null };
  
  // Check for special TLDs like co.uk
  if (parts.length >= 3) {
    const possibleSpecialTld = parts.slice(parts.length - 2).join('.');
    if (specialTLDs[possibleSpecialTld]) {
      return { 
        tld: parts[parts.length - 1],
        specialTld: possibleSpecialTld
      };
    }
  }
  
  return { 
    tld: parts[parts.length - 1],
    specialTld: null
  };
}

/**
 * Try to determine country from TLD
 */
function getCountryFromTLD(domain: string): DomainCountryInfo | null {
  const { tld, specialTld } = extractTLD(domain);
  
  // Check if it's a special case TLD
  if (specialTld && specialTLDs[specialTld]) {
    const countryCode = specialTld.split('.').pop()!;
    return {
      domain,
      country: {
        code: countryCode,
        name: specialTLDs[specialTld]
      },
      method: 'tld',
      confidence: 'high'
    };
  }
  
  // Check if it's a country code TLD
  if (tld in ccTLDs) {
    return {
      domain,
      country: {
        code: tld,
        name: ccTLDs[tld]
      },
      method: 'tld',
      confidence: 'high'
    };
  }
  
  return null;
}

/**
 * Resolve domain to IP address with timeout
 */
async function resolveIP(domain: string, timeout: number): Promise<string | null> {
  try {
    // Clean domain for DNS lookup
    const cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
    
    // Implement timeout for DNS resolution
    const addresses = await Promise.race([
      dns.resolve4(cleanDomain),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('DNS resolution timeout')), timeout);
      })
    ]);
    
    return addresses[0] || null;
  } catch (error) {
    console.error(`Failed to resolve IP for domain ${domain}:`, error);
    return null;
  }
}

/**
 * Get country information from IP using multiple geolocation APIs
 */
async function getCountryFromIP(
  ip: string, 
  timeout: number, 
  options?: DomainCountryOptions
): Promise<{code: string, name: string} | null> {
  const axiosConfig: AxiosRequestConfig = {
    timeout,
    headers: { 'User-Agent': 'DomainCountryService/1.0' }
  };

  try {
    // Try primary service (ipapi.co)
    const response = await axios.get(`https://ipapi.co/${ip}/json/`, axiosConfig);
    const data = response.data;
    
    if (data.country_code && data.country_name) {
      return {
        code: data.country_code.toLowerCase(),
        name: data.country_name
      };
    }
  } catch (error) {
    console.error(`Primary IP geolocation failed for ${ip}:`, error);
    
    // Try fallback API if primary fails
    if (options?.ipGeolocationApiKey && options?.fallbackApi) {
      try {
        let fallbackUrl = '';
        switch (options.fallbackApi) {
          case 'ipstack':
            fallbackUrl = `http://api.ipstack.com/${ip}?access_key=${options.ipGeolocationApiKey}`;
            break;
          case 'ipdata':
            fallbackUrl = `https://api.ipdata.co/${ip}?api-key=${options.ipGeolocationApiKey}`;
            break;
          case 'ipinfo':
            fallbackUrl = `https://ipinfo.io/${ip}/json?token=${options.ipGeolocationApiKey}`;
            break;
        }
        
        if (fallbackUrl) {
          const fallbackResponse = await axios.get(fallbackUrl, axiosConfig);
          const fallbackData = fallbackResponse.data;
          
          return {
            code: fallbackData.country_code?.toLowerCase() || fallbackData.country?.toLowerCase(),
            name: fallbackData.country_name || fallbackData.country || ''
          };
        }
      } catch (fallbackError) {
        console.error(`Fallback geolocation failed for ${ip}:`, fallbackError);
      }
    }
  }
  
  return null;
}

/**
 * Gets country information for a domain
 * @param domain Domain name to check
 * @param options Configuration options
 * @returns Promise with domain country information
 */
export async function getDomainCountry(
  domain: string, 
  options: DomainCountryOptions = {}
): Promise<DomainCountryInfo> {
  const config = { ...DEFAULT_OPTIONS, ...options };

  // Check cache first
  const cachedResult = domainCache.get<DomainCountryInfo>(domain);
  if (cachedResult) return cachedResult;
  
  // Basic validation
  if (!domain || typeof domain !== 'string') {
    throw new Error('Domain must be a non-empty string');
  }
  
  // Enhanced validation
  if (!isValidDomain(domain)) {
    return {
      domain,
      method: 'unknown',
      confidence: 'low',
      error: {
        code: 'INVALID_FORMAT',
        message: 'Invalid domain format'
      }
    };
  }
  
  try {
    // Try to get country from TLD first (fastest method)
    const tldInfo = getCountryFromTLD(domain);
    if (tldInfo) {
      domainCache.set(domain, tldInfo, config.cacheTTL);
      return tldInfo;
    }
    
    // If TLD method fails, try IP geolocation
    const ip = await resolveIP(domain, config.timeout);
    if (ip) {
      const countryInfo = await getCountryFromIP(ip, config.timeout, config);
      if (countryInfo) {
        const result = {
          domain,
          country: countryInfo,
          method: 'ip-geolocation' as const,
          confidence: 'medium' as const
        };
        domainCache.set(domain, result, config.cacheTTL);
        return result;
      }
    }
    
    // If all methods fail
    const unknownResult = {
      domain,
      method: 'unknown' as const,
      confidence: 'low' as const
    };
    domainCache.set(domain, unknownResult, config.cacheTTL);
    return unknownResult;
    
  } catch (error) {
    return {
      domain,
      method: 'unknown',
      confidence: 'low',
      error: {
        code: 'LOOKUP_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}

/**
 * Batch process multiple domains with controlled concurrency
 * @param domains Array of domain strings
 * @param options Configuration options
 * @param batchSize Maximum number of concurrent requests
 * @returns Promise with array of domain country information
 */
export async function batchGetDomainCountries(
  domains: string[], 
  options: DomainCountryOptions = {},
  batchSize = 5
): Promise<DomainCountryInfo[]> {
  // Deduplicate domains
  const uniqueDomains = [...new Set(domains)];
  const results: DomainCountryInfo[] = [];
  
  // Process domains in batches with limited concurrency
  for (let i = 0; i < uniqueDomains.length; i += batchSize) {
    const batch = uniqueDomains.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(domain => getDomainCountry(domain, options))
    );
    results.push(...batchResults);
  }
  
  return results;
}

/**
 * Clear domain cache
 * @param domain Optional domain to clear from cache. If not provided, clears entire cache.
 */
export function clearDomainCache(domain?: string): void {
  if (domain) {
    domainCache.del(domain);
  } else {
    domainCache.flushAll();
  }
}

/**
 * Extracts clean domain name from any URI
 * Handles URLs with protocols, subdomains, paths, query parameters, and fragments
 * 
 * @param uri - URI string to extract domain from
 * @returns Clean domain name or empty string if invalid
 * 
 * @example
 * extractDomainFromUri('https://www.example.com/path?query=1')  // returns 'example.com'
 * extractDomainFromUri('subdomain.example.co.uk/page')          // returns 'subdomain.example.co.uk'
 * extractDomainFromUri('example.com')                           // returns 'example.com'
 */
export function extractDomainFromUri(uri: string): string {
  try {
    // Handle empty or non-string input
    if (!uri || typeof uri !== 'string') {
      return '';
    }

    // Remove leading/trailing whitespace
    const trimmedUri = uri.trim();
    
    // Add protocol if missing to properly parse URL
    let normalizedUri = trimmedUri;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedUri)) {
      normalizedUri = `http://${trimmedUri}`;
    }
    
    // Use URL API for robust parsing
    const url = new URL(normalizedUri);
    return url.hostname;
  } catch (error) {
    // Fall back to regex-based extraction for malformed URLs
    try {
      // Match domain portion from various URL formats
      const match = uri.match(/^(?:https?:\/\/)?(?:www\.)?([^/\s?#]+)/i);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }
}