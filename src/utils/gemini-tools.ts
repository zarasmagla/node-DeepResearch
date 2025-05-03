/**
 * Utility for estimating token counts for Gemini 2.5 LLM
 */

/**
 * Estimates the number of tokens in a string for Gemini 2.5
 * 
 * This is an approximation since exact token counts depend on the specific 
 * tokenizer implementation used by the model. The estimate uses a combination
 * of character and word-based heuristics.
 * 
 * @param text - The input text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateGeminiTokens(text: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  // Handle empty or whitespace-only strings
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  // Tokenization approximation using multiple heuristics
  
  // 1. Count words (splitting on whitespace)
  const words = trimmed.split(/\s+/).filter(Boolean);
  
  // 2. Count characters (including whitespace)
  const chars = text.length;
  
  // 3. Count special characters/tokens that might be tokenized separately
  const specialChars = (text.match(/[^\w\s]/g) || []).length;
  
  // 4. Count numbers which might be tokenized differently
  const numbers = (text.match(/\d+/g) || []).length;
  
  // Weighted formula based on LLM tokenization patterns
  // This formula is tuned as an approximation for Gemini 2.5
  // Words tend to be ~1.3 tokens on average
  // Additional tokens come from special chars and numbers
  const estimatedTokens = Math.ceil(
    words.length * 1.3 + 
    specialChars * 0.5 + 
    numbers * 0.5 + 
    // Add small char-based adjustment for very short or very long words
    chars * 0.05
  );

  return estimatedTokens;
}