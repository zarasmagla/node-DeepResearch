import { GEMINI_API_KEY } from "../config";
import { GoogleGenAI } from "@google/genai";
import { logError, logDebug } from "../logging";

const BATCH_SIZE = 50; // Reduced batch size to avoid 500 errors
const MAX_RETRIES = 5; // Increased retries for 500 errors
const BASE_DELAY_MS = 2000; // Base delay for exponential backoff
const MAX_DELAY_MS = 30000; // Maximum delay (30 seconds)

// Initialize Google GenAI client
let genAI: GoogleGenAI | null = null;

// Simple circuit breaker for consecutive failures
let consecutiveFailures = 0;
let lastFailureTime = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
const CIRCUIT_BREAKER_RESET_TIME = 60000; // 1 minute

// Text preprocessing to avoid API errors
function preprocessText(text: string): string {
  if (!text || typeof text !== "string") return text || "";

  let processed = text;

  // 1. Fix common encoding issues
  processed = processed
    .replace(/â€™/g, "'") // Smart apostrophe
    .replace(/â€œ/g, '"') // Left smart quote
    .replace(/â€\u009D/g, '"') // Right smart quote
    .replace(/â€"/g, "-") // Em dash
    .replace(/â€¦/g, "...") // Ellipsis
    .replace(/Â/g, "") // Non-breaking space artifacts
    .replace(/\u00A0/g, " "); // Non-breaking space to regular space

  // 2. Normalize Unicode characters
  processed = processed.normalize("NFKC");

  // 3. Remove problematic characters
  processed = processed
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width characters
    .replace(/[""]/g, '"') // Smart quotes
    .replace(/['']/g, "'") // Smart apostrophes
    .replace(/[–—]/g, "-") // Em/en dashes
    .replace(/…/g, "..."); // Ellipsis

  // 4. Handle excessive whitespace and ensure reasonable length
  processed = processed.replace(/\s+/g, " ").trim();

  // 5. Truncate extremely long texts that might cause issues
  if (processed.length > 30000) {
    processed = processed.substring(0, 30000) + "...";
  }

  return processed;
}

function getGenAIClient(): GoogleGenAI {
  if (!genAI) {
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set");
    }

    // Configure with potential region override
    const config: any = { apiKey: GEMINI_API_KEY };

    genAI = new GoogleGenAI(config);
  }
  return genAI;
}

// Modified to support different embedding tasks and dimensions
export async function getEmbeddings(
  texts: string[] | Record<string, string>[],
  tokenTracker?: any,
  options: {
    task?:
      | "SEMANTIC_SIMILARITY"
      | "RETRIEVAL_QUERY"
      | "RETRIEVAL_DOCUMENT"
      | "QUESTION_ANSWERING"
      | "FACT_VERIFICATION"
      | "CLASSIFICATION";
    dimensions?: number;
    late_chunking?: boolean;
    embedding_type?: string;
    model?: string;
  } = {}
): Promise<{ embeddings: number[][]; tokens: number }> {
  logDebug(`[embeddings] Getting embeddings for ${texts.length} texts`);

  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  // Handle empty input case
  if (texts.length === 0) {
    return { embeddings: [], tokens: 0 };
  }

  // Convert Record<string, string>[] to string[] if needed and preprocess text
  const textStrings = texts.map((text) => {
    const textContent =
      typeof text === "string" ? text : Object.values(text)[0];
    return preprocessText(textContent);
  });

  // Process in batches
  const allEmbeddings: number[][] = [];
  let totalTokens = 0;
  const batchCount = Math.ceil(textStrings.length / BATCH_SIZE);

  for (let i = 0; i < textStrings.length; i += BATCH_SIZE) {
    const batchTexts = textStrings.slice(i, i + BATCH_SIZE);
    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
    logDebug(
      `Embedding batch ${currentBatch}/${batchCount} (${batchTexts.length} texts)`
    );

    // Get embeddings for the batch with retry logic
    const { batchEmbeddings, batchTokens } = await getBatchEmbeddingsWithRetry(
      batchTexts,
      options,
      currentBatch,
      batchCount
    );

    allEmbeddings.push(...batchEmbeddings);
    totalTokens += batchTokens;
    logDebug(
      `[embeddings] Batch ${currentBatch} complete. Tokens used: ${batchTokens}, total so far: ${totalTokens}`
    );
  }

  // Track token usage if tracker is provided
  if (tokenTracker) {
    tokenTracker.trackUsage("embeddings", {
      promptTokens: totalTokens,
      completionTokens: 0,
      totalTokens: totalTokens,
    });
  }

  logDebug(
    `[embeddings] Complete. Generated ${allEmbeddings.length} embeddings using ${totalTokens} tokens`
  );
  return { embeddings: allEmbeddings, tokens: totalTokens };
}

// Helper function to get embeddings for a batch with retry logic
async function getBatchEmbeddingsWithRetry(
  batchTexts: string[],
  options: {
    task?:
      | "SEMANTIC_SIMILARITY"
      | "RETRIEVAL_QUERY"
      | "RETRIEVAL_DOCUMENT"
      | "QUESTION_ANSWERING"
      | "FACT_VERIFICATION"
      | "CLASSIFICATION";
    dimensions?: number;
    late_chunking?: boolean;
    embedding_type?: string;
    model?: string;
  },
  currentBatch: number,
  batchCount: number
): Promise<{ batchEmbeddings: number[][]; batchTokens: number }> {
  // Filter out empty strings and keep track of their indices
  const PLACEHOLDER_TEXT = " "; // Single space as placeholder for empty strings
  const emptyIndices: number[] = [];
  const processedTexts = batchTexts.map((text, index) => {
    if (!text || text.trim() === "") {
      emptyIndices.push(index);
      logDebug(
        `[embeddings] Replacing empty string at index ${index} with placeholder`
      );
      return PLACEHOLDER_TEXT;
    }
    return text;
  });

  // Check circuit breaker
  const now = Date.now();
  if (
    consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
    now - lastFailureTime < CIRCUIT_BREAKER_RESET_TIME
  ) {
    logDebug(
      `[embeddings] Circuit breaker engaged, skipping API call for batch ${currentBatch}`
    );

    const defaultDimensions = options.dimensions || 768;
    const placeholderEmbeddings = batchTexts.map((text, idx) => {
      logError(
        `Creating zero embedding (circuit breaker) for text ${idx}: [${truncateInputString(
          text
        )}...]`
      );
      return new Array(defaultDimensions).fill(0);
    });

    return {
      batchEmbeddings: placeholderEmbeddings,
      batchTokens: 0,
    };
  }

  let retryCount = 0;

  while (retryCount < MAX_RETRIES) {
    try {
      logDebug("getting client");
      const genAI = getGenAIClient();
      logDebug("got client");
      // Prepare the request configuration with fallback model on consecutive failures
      const model = options.model || "gemini-embedding-001";

      const taskType = options.task || "SEMANTIC_SIMILARITY";
      logDebug(taskType);
      const config = {
        taskType: taskType,
      };

      logDebug(
        `[embeddings] Calling Google Embeddings API for batch ${currentBatch}/${batchCount}`
      );
      logDebug(processedTexts.join("=========="));
      const response = await genAI.models.embedContent({
        model,
        contents: processedTexts,
        config,
      });

      if (!response.embeddings || response.embeddings.length === 0) {
        throw new Error("No embeddings returned from Google API");
      }

      // Extract embeddings and calculate tokens
      const batchEmbeddings = response.embeddings.map(
        (embedding) => embedding.values || []
      );

      // Replace embeddings for empty strings with zero vectors
      const defaultDimensions =
        options.dimensions || batchEmbeddings[0]?.length || 768;
      emptyIndices.forEach((index) => {
        logDebug(
          `[embeddings] Creating zero embedding for empty string at index ${index}`
        );
        batchEmbeddings[index] = new Array(defaultDimensions).fill(0);
      });

      // Google doesn't provide token usage in embeddings response, so we estimate
      // based on original text length (roughly 4 chars per token), excluding placeholders
      const estimatedTokens = batchTexts.reduce(
        (total, text) => total + Math.ceil((text || "").length / 4),
        0
      );

      logDebug(
        `[embeddings] Successfully got ${batchEmbeddings.length} embeddings for batch ${currentBatch}`
      );

      // Reset circuit breaker on success
      consecutiveFailures = 0;

      return {
        batchEmbeddings,
        batchTokens: estimatedTokens,
      };
    } catch (error: any) {
      logDebug(error);
      retryCount++;

      // Enhanced error logging with status code detection
      const isServerError =
        error?.status === 500 ||
        error?.message?.includes("500") ||
        error?.message?.includes("Internal error") ||
        error?.message?.includes("INTERNAL");
      const isOverloadError =
        error?.status === 503 ||
        error?.message?.includes("503") ||
        error?.message?.includes("overloaded");

      logError(
        `Error calling Google Embeddings API (attempt ${retryCount}/${MAX_RETRIES}):`,
        {
          error: error?.message || error,
          status: error?.status,
          isServerError,
          isOverloadError,
          batchSize: batchTexts.length,
        }
      );

      if (retryCount >= MAX_RETRIES) {
        // Update circuit breaker on consecutive failures
        if (isServerError || isOverloadError) {
          consecutiveFailures++;
          lastFailureTime = Date.now();
          logDebug(
            `[embeddings] Circuit breaker: ${consecutiveFailures} consecutive failures`
          );
        }

        // On final retry failure, create placeholder embeddings
        logError(
          `Failed to get embeddings after ${MAX_RETRIES} retries, creating placeholder embeddings`
        );

        const defaultDimensions = options.dimensions || 768; // Default Gemini embedding size
        const placeholderEmbeddings = batchTexts.map((text, idx) => {
          logError(
            `Creating zero embedding for text ${idx}: [${truncateInputString(
              text
            )}...]`
          );
          return new Array(defaultDimensions).fill(0);
        });

        return {
          batchEmbeddings: placeholderEmbeddings,
          batchTokens: 0,
        };
      }

      // Enhanced exponential backoff with jitter for 500/503 errors
      let delayMs: number;
      if (isServerError || isOverloadError) {
        // Longer delays for server errors
        delayMs = Math.min(
          BASE_DELAY_MS * Math.pow(2, retryCount - 1),
          MAX_DELAY_MS
        );
        // Add jitter to avoid thundering herd
        delayMs += Math.random() * 1000;
      } else {
        // Standard exponential backoff for other errors
        delayMs = Math.min(1000 * Math.pow(2, retryCount - 1), 10000);
      }

      logDebug(`[embeddings] Retrying in ${Math.round(delayMs)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // This should never be reached due to the logic above, but TypeScript wants it
  throw new Error("Unexpected end of retry loop");
}

function truncateInputString(input: string | Record<string, string>): string {
  if (typeof input === "string") {
    return input.slice(0, 50);
  } else {
    return Object.values(input)[0].slice(0, 50);
  }
}
