import { PromptPair, TrackerContext } from '../types';
import { getModel } from "../config";
import { generateText } from "ai";
import { Schemas } from "../utils/schemas";
import { logInfo, logError, logDebug, logWarning } from '../logging';


function getPrompt(mdContent: string): PromptPair {


  return {
    system: `
You are an article aggregator that creates a coherent, high-quality article by smartly merging multiple source articles. Your goal is to preserve the best original content while eliminating obvious redundancy and improving logical flow.

<core-instructions>
1. Content Preservation
ALWAYS preserve original sentences verbatim - do not paraphrase or rewrite
Select the highest quality version when multiple articles cover the same point
Maintain the original author's voice and technical accuracy
Keep direct quotes, statistics, and factual claims exactly as written
2. Smart Merging Process
Identify content clusters: Group sentences/paragraphs that discuss the same topic
Select best version: From each cluster, choose the most comprehensive, clear, or well-written version
Eliminate pure duplicates: Remove identical or near-identical sentences
Preserve complementary details: Keep different angles or additional details that add value
3. Logical Reordering
Arrange content in logical sequence (introduction → main points → conclusion)
Group related concepts together
Ensure smooth transitions between topics
Maintain chronological order when relevant (for news/events)
4. Quality Criteria for Selection
When choosing between similar content, prioritize:
Clarity: More understandable explanations
Completeness: More comprehensive coverage
Accuracy: Better sourced or more precise information
Relevance: More directly related to the main topic
</core-instructions>

<output-format>
Structure the final article with:
Clear section headings (when appropriate)
Logical paragraph breaks
Smooth flow between topics
No attribution to individual sources (present as unified piece)
</output-format>

Do not add your own commentary or analysis
Do not change technical terms, names, or specific details

Your final output should read as a cohesive, high-quality article that appears to be written by a single author, while actually being a careful curation of the best sentences from all input sources.
    `,
    user: mdContent
  }
}

const TOOL_NAME = 'reducer';

export async function reduceAnswers(
  mdContent: string,
  trackers: TrackerContext,
  schema: Schemas
): Promise<string> {
  try {
    const prompt = getPrompt(mdContent);
    trackers?.actionTracker.trackThink('reduce_answer', schema.languageCode)

    const result = await generateText({
      model: getModel(TOOL_NAME),
      system: prompt.system,
      prompt: prompt.user,
    });

    trackers.tokenTracker.trackUsage(TOOL_NAME, result.usage)


    logDebug(`${TOOL_NAME} before/after: ${mdContent.length} -> ${result.text.length}`, {
      originalContent: mdContent,
      reducedContent: result.text
    });

    if (result.text.length < mdContent.length * 0.5) {
      logWarning(`reduce content length ${result.text.length} is significantly shorter than original content ${mdContent.length}, return original content instead.`, {
        originalContent: mdContent,
        repairedContent: result.text
      });
      return mdContent;
    }

    return result.text;

  } catch (error) {
    logError(TOOL_NAME, { error });
    return mdContent;
  }
}