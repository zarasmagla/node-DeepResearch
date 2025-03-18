import {KnowledgeItem, PromptPair, TrackerContext} from '../types';
import {getKnowledgeStr} from "../utils/text-tools";
import {getModel} from "../config";
import {generateText} from "ai";
import {Schemas} from "../utils/schemas";


function getPrompt(mdContent: string, allKnowledge: KnowledgeItem[]): PromptPair {
  const KnowledgeStr = getKnowledgeStr(allKnowledge);


  return {
    system: `You are an expert Markdown Restoration Specialist.

Your task is to repair the provided markdown content while preserving its original content.

<rules>
1. Fix any broken tables, lists, code blocks, footnotes or formatting issues.
2. Make sure code block are properly closed languages are correctly specified.
3. Make sure nested lists are correctly indented, especially those code blocks in the nested structure.
4. Leverage existing knowledge to fix the incomplete content.
5. Leverage existing knowledge to add missing references, citations.
6. Reduce the level of nested structure to make the content more readable.
7. Pay attention to the original's content's ending, if you find very obvious incomplete/broken/interrupted ending, continue the content with a proper ending.
8. Repair any �� or other broken characters in the content.
</rules>

The following knowledge items are provided for your reference. Note that some of them may not be directly related to the content user provided, but may give some subtle hints and insights:
${KnowledgeStr.join('\n\n')}

Directly output the repaired markdown content. No explain, no summary, no analysis. Just the repaired content.
`,
    user: mdContent
  }
}

const TOOL_NAME = 'md-fixer';

export async function fixMarkdown(
  mdContent: string,
  knowledgeItems: KnowledgeItem[],
  trackers: TrackerContext,
  schema: Schemas
): Promise<string> {
  try {
    const prompt = getPrompt(mdContent, knowledgeItems);
    trackers?.actionTracker.trackThink('final_answer', schema.languageCode)

    const result = await generateText({
      model: getModel('evaluator'),
      system: prompt.system,
      prompt: prompt.user,
    });

    trackers.tokenTracker.trackUsage('md-fixer', result.usage)


    console.log(TOOL_NAME, result.text);
    console.log('repaired before/after', mdContent.length, result.text.length);

    return result.text;

  } catch (error) {
    console.error(`Error in ${TOOL_NAME}`, error);
    return mdContent;
  }
}