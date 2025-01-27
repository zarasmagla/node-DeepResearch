import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import dotenv from 'dotenv';
import { ProxyAgent, setGlobalDispatcher } from "undici";

// Proxy setup
if (process.env.https_proxy) {
  try {
    const proxyUrl = new URL(process.env.https_proxy).toString();
    const dispatcher = new ProxyAgent({ uri: proxyUrl });
    setGlobalDispatcher(dispatcher);
  } catch (error) {
    console.error('Failed to set proxy:', error);
  }
}
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY not found in environment variables");
}

type DedupResponse = {
  thought: string;
  unique_queries: string[];
};

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    thought: {
      type: SchemaType.STRING,
      description: "Strategic reasoning about the overall deduplication approach"
    },
    unique_queries: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.STRING
      },
      description: "Array of semantically unique queries from set A"
    }
  },
  required: ["thought", "unique_queries"]
};

const modelName = 'gemini-1.5-flash';

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: modelName,
  generationConfig: {
    temperature: 0.1,
    responseMimeType: "application/json",
    responseSchema: responseSchema
  }
});

function getPrompt(newQueries: string[], existingQueries: string[]): string {
  return `You are an expert in semantic similarity analysis. Given a set of new queries (A) and existing queries (B), identify which queries from set A are semantically unique when compared BOTH to other queries within A AND to queries in set B.

Core Rules:
1. Consider semantic meaning and query intent, not just lexical similarity
2. Account for different phrasings of the same information need
3. A query is considered duplicate if its core information need is already covered by:
   - any query in set A
   - OR any query in set B
4. Be aggressive - mark as duplicate as long as they are reasonably similar
5. Different aspects or perspectives of the same object are not duplicates
6. Consider query specificity - a more specific query might not be a duplicate of a general one

Examples:

Set A: [
  "how to install python on windows",
  "what's the best pizza in brooklyn heights",
  "windows python installation guide",
  "recommend good pizza places brooklyn heights"
]
Set B: [
  "macbook setup guide",
  "restaurant recommendations manhattan"
]
Thought: Let's analyze set A both internally and against B:
1. The first python installation query is unique
2. The first pizza query is unique
3. The second python query is a duplicate of the first
4. The second pizza query is a duplicate of the earlier one
Neither query in set B is similar enough to affect our decisions.
Unique Queries: [
  "how to install python on windows",
  "what's the best pizza in brooklyn heights"
]

Now, analyze these sets:
Set A: ${JSON.stringify(newQueries)}
Set B: ${JSON.stringify(existingQueries)}`;
}

export async function dedupQueries(newQueries: string[], existingQueries: string[]): Promise<string[]> {
  try {
    const prompt = getPrompt(newQueries, existingQueries);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const json = JSON.parse(response.text()) as DedupResponse;
    console.log('Dedup:', json);
    return json.unique_queries;
  } catch (error) {
    console.error('Error in deduplication analysis:', error);
    throw error;
  }
}

// Example usage
async function main() {
  const newQueries = process.argv[2] ? JSON.parse(process.argv[2]) : [];
  const existingQueries = process.argv[3] ? JSON.parse(process.argv[3]) : [];

  console.log('\nNew Queries (Set A):', newQueries);
  console.log('Existing Queries (Set B):', existingQueries);

  try {
    const uniqueQueries = await dedupQueries(newQueries, existingQueries);
    console.log('Unique Queries:', uniqueQueries);
  } catch (error) {
    console.error('Failed to deduplicate queries:', error);
  }
}

if (require.main === module) {
  main().catch(console.error);
}