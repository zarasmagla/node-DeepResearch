import { ReadResponse } from '../types';

/**
 * Status codes that commonly indicate bot protection mechanisms
 */
const BOT_CHECK_STATUS_CODES = Object.freeze([403, 401, 429]);

/**
 * Keywords in page titles that suggest bot protection pages
 */
const BOT_CHECK_TITLE_KEYWORDS = Object.freeze(["moment", "bot", "captcha", "verify"]);

/**
 * Common phrases in content that indicate bot protection challenges
 */
const BOT_CHECK_CONTENT_PHRASES = Object.freeze([
  "verify you are human",
  "complete the action below",
  "security check",
  "captcha",
  "bot detection",
]);

/**
 * Phrases in error messages that suggest bot protection
 */
const BOT_CHECK_MESSAGE_PHRASES = Object.freeze([
  "requiring CAPTCHA",
  "bot check",
]);

/**
 * Domains associated with common bot protection services
 */
const BOT_PROTECTION_DOMAINS = Object.freeze([
  "cloudflare.com",
  "recaptcha.net",
  "akamai.com",
  "perimeterx.com",
  "datadome.co",
  "imperva.com",
  "hcaptcha.com", // Added additional common service
]);

/**
 * Checks if text contains any of the provided phrases (case-insensitive)
 * 
 * @param text - The text to search within
 * @param phrases - Array of phrases to look for
 * @returns True if any phrase is found in the text
 */
function containsPhrase(text: string | undefined, phrases: readonly string[]): boolean {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return phrases.some(phrase => lowerText.includes(phrase.toLowerCase()));
}

/**
 * Checks if any links point to known bot protection domains
 * 
 * @param links - Array of [text, url] pairs to check
 * @param botProtectionDomains - List of bot protection service domains
 * @returns True if any link contains a bot protection domain
 */
function hasBotProtectionLink(
  links: ReadonlyArray<readonly [string, string]> | undefined, 
  botProtectionDomains: readonly string[]
): boolean {
  return links?.some(([, url]) => 
    botProtectionDomains.some(domain => url.includes(domain))
  ) ?? false;
}

/**
 * Detects if a response indicates a bot protection mechanism was triggered
 * 
 * @param response - The API response to analyze
 * @returns True if the response shows signs of bot protection
 */
export function isBotCheck(response: ReadResponse): boolean {
  if (!response) return false;
  
  if (response.data) {
    const { content, links, title } = response.data;
    const status = response.status || 200; // Default to 200 if status is not provided 
    
    // Check content for bot protection phrases
    if (containsPhrase(content, BOT_CHECK_CONTENT_PHRASES)) {
      return true;
    }
    
    // Check if links contain bot protection domains
    if (hasBotProtectionLink(links, BOT_PROTECTION_DOMAINS)) {
      return true;
    }
    
    // Check title keywords when status code is suspicious
    const hasTitleKeyword = title?.toLowerCase() && 
      BOT_CHECK_TITLE_KEYWORDS.some(keyword => 
        title.toLowerCase().includes(keyword));
    
    if (BOT_CHECK_STATUS_CODES.includes(status) && hasTitleKeyword) {
      return true;
    }
  }
  
  // Check error messages for bot detection phrases
  return containsPhrase(response.message, BOT_CHECK_MESSAGE_PHRASES) || 
         containsPhrase(response.readableMessage, BOT_CHECK_MESSAGE_PHRASES);
}

/**
 * Exports all bot detection functionality
 */
export default {
  isBotCheck,
  constants: {
    BOT_CHECK_STATUS_CODES,
    BOT_CHECK_TITLE_KEYWORDS,
    BOT_CHECK_CONTENT_PHRASES,
    BOT_CHECK_MESSAGE_PHRASES,
    BOT_PROTECTION_DOMAINS
  }
};