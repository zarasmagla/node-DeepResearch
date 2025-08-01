import { GEMINI_API_KEY } from "../config";
import { GoogleGenAI } from "@google/genai";
import { logError, logDebug } from '../logging';

const BATCH_SIZE = 100; // Google allows larger batches
const MAX_RETRIES = 3; // Maximum number of retries for missing embeddings

// Initialize Google GenAI client
let genAI: GoogleGenAI | null = null;

function getGenAIClient(): GoogleGenAI {
  if (!genAI) {
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return genAI;
}

// Map task types to Google's task types
function mapTaskType(task?: string): string {
  switch (task) {
    case "text-matching":
      return "SEMANTIC_SIMILARITY";
    case "retrieval.passage":
      return "RETRIEVAL_DOCUMENT";
    case "retrieval.query":
      return "RETRIEVAL_QUERY";
    default:
      return "SEMANTIC_SIMILARITY";
  }
}

// Modified to support different embedding tasks and dimensions
export async function getEmbeddings(
  texts: string[] | Record<string, string>[],
  tokenTracker?: any,
  options: {
    task?: "text-matching" | "retrieval.passage" | "retrieval.query",
    dimensions?: number,
    late_chunking?: boolean,
    embedding_type?: string,
    model?: string,
  } = {}
): Promise<{ embeddings: number[][], tokens: number }> {
  logDebug(`[embeddings] Getting embeddings for ${texts.length} texts`);

  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  // Handle empty input case
  if (texts.length === 0) {
    return { embeddings: [], tokens: 0 };
  }

  // Convert Record<string, string>[] to string[] if needed
  const textStrings = texts.map(text =>
    typeof text === 'string' ? text : Object.values(text)[0]
  );

  // Process in batches
  const allEmbeddings: number[][] = [];
  let totalTokens = 0;
  const batchCount = Math.ceil(textStrings.length / BATCH_SIZE);

  for (let i = 0; i < textStrings.length; i += BATCH_SIZE) {
    const batchTexts = textStrings.slice(i, i + BATCH_SIZE);
    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
    logDebug(`Embedding batch ${currentBatch}/${batchCount} (${batchTexts.length} texts)`);

    // Get embeddings for the batch with retry logic
    const { batchEmbeddings, batchTokens } = await getBatchEmbeddingsWithRetry(
      batchTexts,
      options,
      currentBatch,
      batchCount
    );

    allEmbeddings.push(...batchEmbeddings);
    totalTokens += batchTokens;
    logDebug(`[embeddings] Batch ${currentBatch} complete. Tokens used: ${batchTokens}, total so far: ${totalTokens}`);
  }

  // Track token usage if tracker is provided
  if (tokenTracker) {
    tokenTracker.trackUsage('embeddings', {
      promptTokens: totalTokens,
      completionTokens: 0,
      totalTokens: totalTokens
    });
  }

  logDebug(`[embeddings] Complete. Generated ${allEmbeddings.length} embeddings using ${totalTokens} tokens`);
  return { embeddings: allEmbeddings, tokens: totalTokens };
}

// Helper function to get embeddings for a batch with retry logic
async function getBatchEmbeddingsWithRetry(
  batchTexts: string[],
  options: {
    task?: "text-matching" | "retrieval.passage" | "retrieval.query",
    dimensions?: number,
    late_chunking?: boolean,
    embedding_type?: string,
    model?: string,
  },
  currentBatch: number,
  batchCount: number
): Promise<{ batchEmbeddings: number[][], batchTokens: number }> {
  let retryCount = 0;

  while (retryCount < MAX_RETRIES) {
    try {
      const genAI = getGenAIClient();

      // Prepare the request configuration
      const model = options.model || "gemini-embedding-001";
      const taskType = mapTaskType(options.task);

      const config = {
        taskType,
        ...(options.dimensions && { outputDimensionality: options.dimensions })
      };

      logDebug(`[embeddings] Calling Google Embeddings API for batch ${currentBatch}/${batchCount}`);

      const response = await genAI.models.embedContent({
        model,
        contents: batchTexts,
        config
      });

      if (!response.embeddings || response.embeddings.length === 0) {
        throw new Error('No embeddings returned from Google API');
      }

      // Extract embeddings and calculate tokens
      const batchEmbeddings = response.embeddings.map(embedding => embedding.values || []);

      // Google doesn't provide token usage in embeddings response, so we estimate
      // based on text length (roughly 4 chars per token)
      const estimatedTokens = batchTexts.reduce((total, text) => total + Math.ceil(text.length / 4), 0);

      logDebug(`[embeddings] Successfully got ${batchEmbeddings.length} embeddings for batch ${currentBatch}`);

      return {
        batchEmbeddings,
        batchTokens: estimatedTokens
      };

    } catch (error: any) {
      retryCount++;
      logError(`Error calling Google Embeddings API (attempt ${retryCount}/${MAX_RETRIES}):`, { error });

      if (retryCount >= MAX_RETRIES) {
        // On final retry failure, create placeholder embeddings
        logError(`Failed to get embeddings after ${MAX_RETRIES} retries, creating placeholder embeddings`);

        const defaultDimensions = options.dimensions || 768; // Default Gemini embedding size
        const placeholderEmbeddings = batchTexts.map((text, idx) => {
          logError(`Creating zero embedding for text ${idx}: [${truncateInputString(text)}...]`);
          return new Array(defaultDimensions).fill(0);
        });

        return {
          batchEmbeddings: placeholderEmbeddings,
          batchTokens: 0
        };
      }

      // Wait before retrying
      const delayMs = Math.min(1000 * Math.pow(2, retryCount - 1), 10000); // Exponential backoff, max 10s
      logDebug(`[embeddings] Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // This should never be reached due to the logic above, but TypeScript wants it
  throw new Error('Unexpected end of retry loop');
}

function truncateInputString(input: string | Record<string, string>): string {
  if (typeof input === 'string') {
    return input.slice(0, 50);
  } else {
    return Object.values(input)[0].slice(0, 50);
  }
}