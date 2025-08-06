import { PromptPair, TrackerContext } from '../types';
import { ObjectGeneratorSafe } from "../utils/safe-generator";
import { Schemas } from "../utils/schemas";
import { logInfo, logError } from '../logging';
import { SearchSnippet } from '../types';

function formatSearchResults(results: SearchSnippet[]): string {
  return results.map((result, index) => {
    const parts = [
      `Result ${index + 1}:`,
      `title: "${result.title}"`,
      `url: "${result.url}"`,
      `description: "${result.description}"`
    ];

    if (result.weight !== undefined) {
      parts.push(`weight: ${result.weight}`);
    }

    if (result.date) {
      parts.push(`date: "${result.date}"`);
    }

    return parts.join('\n');
  }).join('\n\n');
}

function getPrompt(results: SearchSnippet[]): PromptPair {
  return {
    system: `
You are a search engine result analyzer. You look at the SERP API response and group them into meaningful cluster. 

Each cluster should contain a summary of the content, key data and insights, the corresponding URLs and search advice. 
`,
    user: `
Here are the search results to analyze:

${formatSearchResults(results)}

Please analyze these results and group them into meaningful clusters.
`
  };
}
const TOOL_NAME = 'serpCluster';

export async function serpCluster(results: SearchSnippet[], trackers: TrackerContext, schemaGen: Schemas): Promise<any[]> {
  try {
    const generator = new ObjectGeneratorSafe(trackers.tokenTracker);
    const prompt = getPrompt(results);
    const result = await generator.generateObject({
      model: TOOL_NAME,
      schema: schemaGen.getSerpClusterSchema(),
      system: prompt.system,
      prompt: prompt.user,
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 2000,
          },
        },
      },
    });
    trackers?.actionTracker.trackThink((result.object as any).think);
    const clusters = (result.object as any).clusters;
    logInfo(TOOL_NAME, { clusters });
    return clusters;
  } catch (error) {
    logError(TOOL_NAME, { error });
    throw error;
  }
}