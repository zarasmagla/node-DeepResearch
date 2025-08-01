import { TokenTracker } from "../utils/token-tracker";
import { getEmbeddings } from "./embeddings";
import { logError, logDebug } from '../logging';

// Utility function to calculate dot product (cosine similarity for normalized vectors)
function dotProduct(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error('Vector dimensions must match for dot product calculation');
    }
    return a.reduce((sum, val, i) => sum + val * b[i], 0);
}

// Utility function to normalize a vector to unit length
function normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (magnitude === 0) return vector; // Avoid division by zero
    return vector.map(val => val / magnitude);
}

// Types for Google Gemini Rerank (using embeddings + similarity)
interface RerankResult {
    index: number;
    document: {
        text: string;
    };
    relevance_score: number;
}

export async function rerankDocuments(
    query: string,
    documents: string[],
    tracker?: TokenTracker,
): Promise<{ results: Array<{ index: number, relevance_score: number, document: { text: string } }> }> {
    try {
        if (documents.length === 0) {
            return { results: [] };
        }

        logDebug(`Reranking ${documents.length} documents using Google embeddings and cosine similarity`);

        // Get embeddings for query and documents
        // Use RETRIEVAL_QUERY task for the query and RETRIEVAL_DOCUMENT for documents
        const [queryEmbeddingResult, documentsEmbeddingResult] = await Promise.all([
            getEmbeddings([query], tracker, {
                task: "retrieval.query",
                model: "gemini-embedding-001"
            }),
            getEmbeddings(documents, tracker, {
                task: "retrieval.passage",
                model: "gemini-embedding-001"
            })
        ]);

        const queryEmbedding = queryEmbeddingResult.embeddings[0];
        const documentEmbeddings = documentsEmbeddingResult.embeddings;

        // Track total token usage
        const totalTokens = queryEmbeddingResult.tokens + documentsEmbeddingResult.tokens;
        if (tracker) {
            tracker.trackUsage('rerank', {
                promptTokens: totalTokens,
                completionTokens: 0,
                totalTokens: totalTokens
            });
        }

        if (!queryEmbedding || documentEmbeddings.length !== documents.length) {
            logError('Failed to get embeddings for query or documents');
            return { results: [] };
        }

        // Normalize embeddings for accurate cosine similarity calculation
        const normalizedQueryEmbedding = normalizeVector(queryEmbedding);
        const normalizedDocumentEmbeddings = documentEmbeddings.map(normalizeVector);

        // Calculate similarity scores using dot product (cosine similarity for normalized vectors)
        const results: RerankResult[] = documents.map((document, index) => {
            const similarity = dotProduct(normalizedQueryEmbedding, normalizedDocumentEmbeddings[index]);

            return {
                index,
                document: { text: document },
                relevance_score: similarity
            };
        });

        // Sort by relevance score (highest first)
        results.sort((a, b) => b.relevance_score - a.relevance_score);

        logDebug(`Reranking complete. Top relevance score: ${results[0]?.relevance_score.toFixed(4)}, Bottom: ${results[results.length - 1]?.relevance_score.toFixed(4)}`);

        return { results };
    } catch (error) {
        logError('Reranking error:', { error });

        // Return documents in original order if reranking fails
        const fallbackResults = documents.map((document, index) => ({
            index,
            relevance_score: 0.5, // Neutral score
            document: { text: document }
        }));

        return { results: fallbackResults };
    }
}