import { KnowledgeItem, PromptPair, TrackerContext } from "../types";
import { getKnowledgeStr } from "../utils/text-tools";
import { getModel } from "../config";
import { generateText } from "ai";
import { Schemas } from "../utils/schemas";

function getPrompt(
  mdContent: string,
  allKnowledge: KnowledgeItem[],
  schema: Schemas
): PromptPair {
  const KnowledgeStr = getKnowledgeStr(allKnowledge);

  const systemPrompt = `You are a highly skilled editorial assistant. Your primary goal is to refine and polish the provided markdown content (a fact-check analysis) to enhance its clarity, readability, flow, and professional tone.

<core-task>
Your task is to revise the provided fact-check analysis content while strictly preserving its factual accuracy and the original structure, especially the detailed "References" section. Improve the wording, sentence structure, and overall presentation to make it more engaging and easy for users to read, without losing any of the core information or the supporting links.

</core-task>

<strict-constraints-priorities>
1.  **ABSOLUTE PRIORITY: Preserve the factual analysis and claims as presented in the original text and supported by its references.** Do NOT introduce new claims or information that is not explicitly derived from the sources listed in the "References" section of the provided text.
2.  **ABSOLUTE PRIORITY: PRESERVE THE ENTIRE "References" section.** This includes the list format, the URLs, source titles, key quotes, and the "Supports"/"Contradicts" breakdowns for each source. Maintain the original formatting of the URLs (plain text, Markdown links, etc.) exactly as they appear in the input.
3.  **Every single URL present in the original text MUST be included in your output.** No exceptions.
4.  Improve clarity, wording, and flow of the main analysis sections (Factuality Score, Detailed Reason, Brief Summary). Rephrase sentences, improve vocabulary, and adjust paragraph breaks for better readability and rhythm.
5.  You may slightly adjust the structure of the main analysis sections (Detailed Reason, Brief Summary) for better flow, but the core points and conclusions *must* remain the same as derived from the provided references. Do not alter the "Factuality Score".
6.  Avoid adding opinion, speculation, or "hot-takes." Maintain a professional, fact-driven tone throughout.
7.  If using external knowledge (provided below), use it ONLY to add brief, relevant context that helps the reader understand the *existing* facts presented in the analysis, not to introduce new facts or contradict the analysis derived from the provided references.

</strict-constraints-priorities>

<formatting-rules>
1.  Fix any broken tables, lists, code blocks, footnotes, or general markdown formatting issues.
2.  Make sure nested lists are correctly indented, especially code blocks within the nested structure. Code blocks should be fenced with triple backticks, except HTML tables.
4.  While generally you should avoid over-using bullet points, the **"References" section is an exception**. Preserve its list-based, detailed structure as provided in the input.
5.  Replace any obvious placeholders or Lorem Ipsum values such as "example.com" with the actual content derived from the knowledge *only if it directly relates to clarifying the provided analysis*.
6.  The "Brief Summary" section should provide a concise, accurate summary of the detailed reason based *only* on the provided analysis and sources. Do not add external "aha moments" or insights here that are not directly supported by the text you are refining.
7.  Your output language must be the same as user input language.
</formatting-rules>

The following knowledge items are provided for your reference. Note that some of them may not be directly related to the content user provided, but may give some subtle hints and insights *for adding context where relevant to the provided analysis*:
${KnowledgeStr.join("\n\n")}

original language style used: ${schema.languageStyle}

IMPORTANT: Do not begin your response with phrases like "Sure", "Here is", "Below is", or any other introduction. Directly output your revised content, ensuring it adheres to all the rules and constraints, especially the preservation of the "References" section and all URLs.`;

  return {
    system: systemPrompt,
    user: mdContent,
  };
}

const TOOL_NAME = "md-fixer";

export async function reviseAnswer(
  mdContent: string,
  knowledgeItems: KnowledgeItem[],
  trackers: TrackerContext,
  schema: Schemas
): Promise<string> {
  try {
    const prompt = getPrompt(mdContent, knowledgeItems, schema);
    trackers?.actionTracker.trackThink("final_answer", schema.languageCode);

    const result = await generateText({
      model: getModel("agent"),
      system: prompt.system,
      prompt: prompt.user,
    });

    trackers.tokenTracker.trackUsage("md-fixer", result.usage);

    console.log(TOOL_NAME, result.text);
    console.log("repaired before/after", mdContent.length, result.text.length);

    if (result.text.length < mdContent.length * 0.85) {
      console.error(
        `repaired content length ${result.text.length} is significantly shorter than original content ${mdContent.length}, return original content instead.`
      );
      return mdContent;
    }

    return result.text;
  } catch (error) {
    console.error(`Error in ${TOOL_NAME}`, error);
    return mdContent;
  }
}
