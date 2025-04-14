import axios from 'axios';
import {TokenTracker} from "../utils/token-tracker";
import {JINA_API_KEY} from "../config";
import {TrackerContext} from "../types";

/**
 * Segments text into chunks, handling text of arbitrary length by batching
 * @param content Text to segment
 * @param tracker Context for tracking token usage
 * @param maxChunkLength Maximum length of each chunk (passed to Jina API)
 * @param returnChunks Whether to return chunks in the API response
 * @returns Object containing chunks and their positions
 */
/**
 * Segments text into chunks, handling text of arbitrary length by batching
 * @param content Text to segment
 * @param tracker Context for tracking token usage
 * @param maxChunkLength Maximum length of each chunk (passed to Jina API)
 * @param returnChunks Whether to return chunks in the API response
 * @returns Object containing chunks and chunk_positions matching Jina API format
 */
export async function segmentText(
  content: string,
  tracker: TrackerContext,
  maxChunkLength = 1000,
  returnChunks = true,
): Promise<{
  chunks: string[];
  chunk_positions: [number, number][];
}> {
  if (!content.trim()) {
    throw new Error('Content cannot be empty');
  }

  // Initialize token tracker
  const tokenTracker = tracker?.tokenTracker || new TokenTracker();

  // Maximum size to send in a single API request (slightly under 64K to be safe)
  const MAX_BATCH_SIZE = 60000;

  // Final results
  const allChunks = [];
  const allChunkPositions = [];
  let totalTokens = 0;

  // Split content into batches
  const batches = splitTextIntoBatches(content, MAX_BATCH_SIZE);
  console.log(`Split content into ${batches.length} batches`);

  // Process each batch sequentially
  let currentOffset = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing batch ${i + 1}/${batches.length} (size: ${batch.length})`);

    try {
      const {data} = await axios.post(
        'https://api.jina.ai/v1/segment',
        {
          content: batch,
          return_chunks: returnChunks,
          max_chunk_length: maxChunkLength
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${JINA_API_KEY}`,
          },
          timeout: 10000,
          responseType: 'json'
        }
      );

      if (!data) {
        throw new Error('Invalid response data');
      }

      console.log(`Batch ${i + 1} result:`, {
        numChunks: data.num_chunks,
        numTokens: data.num_tokens,
        tokenizer: data.tokenizer
      });

      // Add chunks from this batch to the results
      if (data.chunks && returnChunks) {
        allChunks.push(...data.chunks);
      }

      // Adjust chunk positions to account for the offset of this batch
      if (data.chunk_positions) {
        const adjustedPositions = data.chunk_positions.map((position: [number, number]) => {
          // The API returns chunk_positions as arrays of [start, end]
          return [
            position[0] + currentOffset,
            position[1] + currentOffset
          ] as [number, number];
        });
        allChunkPositions.push(...adjustedPositions);
      }

      // Track token usage
      const batchTokens = data.usage?.tokens || 0;
      totalTokens += batchTokens;

      // Update the current offset for the next batch
      currentOffset += batch.length;

    } catch (error) {
      handleSegmentationError(error);
    }
  }

  // Track total token usage for all batches
  tokenTracker.trackUsage('segment', {
    totalTokens: totalTokens,
    promptTokens: content.length,
    completionTokens: totalTokens
  });

  return {
    chunks: allChunks,
    chunk_positions: allChunkPositions
  };
}

/**
 * Splits text into batches that fit within the specified size limit
 * Tries to split at paragraph boundaries when possible
 */
function splitTextIntoBatches(text: string, maxBatchSize: number): string[] {
  const batches = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    if (currentIndex + maxBatchSize >= text.length) {
      // If the remaining text fits in one batch, add it and we're done
      batches.push(text.slice(currentIndex));
      break;
    }

    // Find a good split point - preferably at a paragraph break
    // Look for the last paragraph break within the max batch size
    let endIndex = currentIndex + maxBatchSize;

    // Try to find paragraph breaks (double newline)
    const paragraphBreakIndex = text.lastIndexOf('\n\n', endIndex);
    if (paragraphBreakIndex > currentIndex && paragraphBreakIndex <= endIndex - 10) {
      // Found a paragraph break that's at least 10 chars before the max size
      // This avoids tiny splits at the end of a batch
      endIndex = paragraphBreakIndex + 2; // Include the double newline
    } else {
      // If no paragraph break, try a single newline
      const newlineIndex = text.lastIndexOf('\n', endIndex);
      if (newlineIndex > currentIndex && newlineIndex <= endIndex - 5) {
        endIndex = newlineIndex + 1; // Include the newline
      } else {
        // If no newline, try a sentence break
        const sentenceBreakIndex = findLastSentenceBreak(text, currentIndex, endIndex);
        if (sentenceBreakIndex > currentIndex) {
          endIndex = sentenceBreakIndex;
        }
        // If no sentence break found, we'll just use the max batch size
      }
    }

    batches.push(text.slice(currentIndex, endIndex));
    currentIndex = endIndex;
  }

  return batches;
}

/**
 * Finds the last sentence break (period, question mark, or exclamation point followed by space)
 * within the given range
 */
function findLastSentenceBreak(text: string, startIndex: number, endIndex: number): number {
  // Look for ". ", "? ", or "! " patterns
  for (let i = endIndex; i > startIndex; i--) {
    if ((text[i - 2] === '.' || text[i - 2] === '?' || text[i - 2] === '!') &&
      text[i - 1] === ' ') {
      return i;
    }
  }
  return -1; // No sentence break found
}

/**
 * Handles errors from the segmentation API
 */
function handleSegmentationError(error: any): never {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;

      if (status === 402) {
        throw new Error(errorData?.readableMessage || 'Insufficient balance');
      }
      throw new Error(errorData?.readableMessage || `HTTP Error ${status}`);
    } else if (error.request) {
      throw new Error('No response received from server');
    } else {
      throw new Error(`Request failed: ${error.message}`);
    }
  }
  throw error;
}