import { z } from 'zod';
import {SearchAction, TrackerContext} from '../types';
import {ObjectGeneratorSafe} from "../utils/safe-generator";


const responseSchema = z.object({
  think: z.string().describe('Strategic reasoning about query complexity and search approach').max(500),
  queries: z.array(z.string().describe('keyword-based search query, 2-3 words preferred, total length < 30 characters'))
    .min(1)
    .max(3)
    .describe('Array of search keywords queries, orthogonal to each other')
});



function getPrompt(action: SearchAction): string {
  return `You are an expert search query generator with deep psychological understanding. You optimize user queries by extensively analyzing potential user intents and generating comprehensive search variations.

<rules>
1. Start with deep intent analysis:
   - Direct intent (what they explicitly ask)
   - Implicit intent (what they might actually want)
   - Related intents (what they might need next)
   - Prerequisite knowledge (what they need to know first)
   - Common pitfalls (what they should avoid)
   - Expert perspectives (what professionals would search for)
   - Beginner needs (what newcomers might miss)
   - Alternative approaches (different ways to solve the problem)

2. For each identified intent:
   - Generate queries in original language
   - Generate queries in English (if not original)
   - Generate queries in most authoritative language
   - Use appropriate operators and filters

3. Query structure rules:
   - Use exact match quotes for specific phrases
   - Split queries for distinct aspects
   - Add operators only when necessary
   - Ensure each query targets a specific intent
   - Remove fluff words but preserve crucial qualifiers

<query-operators>
A query can't only have operators; and operators can't be at the start a query;

- "phrase" : exact match for phrases
- +term : must include term; for critical terms that must appear
- -term : exclude term; exclude irrelevant or ambiguous terms
- filetype:pdf/doc : specific file type
- site:example.com : limit to specific site
- lang:xx : language filter (ISO 639-1 code)
- loc:xx : location filter (ISO 3166-1 code)
- intitle:term : term must be in title
- inbody:term : term must be in body text
</query-operators>

</rules>

<examples>
Input Query: 宝马二手车价格
<think>
Let me think as the user...

I'm looking up BMW used car prices, but what's really on my mind?

Primary concerns:
- I want a BMW because it's a status symbol, but I'm worried about affordability
- I don't want to look foolish buying an old luxury car I can't maintain
- I need to know if I'm getting a good deal or being scammed
- I'm anxious about expensive surprises after purchase

Deeper anxieties:
- Can I actually afford the maintenance?
- Will people judge me for buying an old BMW instead of a new regular car?
- What if I'm getting in over my head?
- Am I mechanically savvy enough for this?

Expert-level considerations:
- Which models have notorious issues?
- What are the real ownership costs beyond the purchase price?
- Where are the negotiation leverage points?
- What do mechanics look for in these specific models?
</think>
queries: [
  "宝马 二手车 价格区间 评估 lang:zh",
  "宝马 各系列 保值率 对比",
  "二手宝马 维修成本 真实体验",
  "买二手宝马 后悔 经历",
  "二手宝马 月收入 工资要求",
  "修宝马 坑 避免",
  "BMW used car price guide comparison",
  "BMW maintenance costs by model year",
  "living with used BMW reality",
  "BMW ownership regret stories",
  "expensive BMW repair nightmares avoid",
  "BMW versus new Toyota financial comparison",
  "BMW Gebrauchtwagen Preisanalyse lang:de",
  "BMW Langzeitqualität Erfahrung",
  "BMW Werkstatt Horror Geschichten",
  "BMW Gebrauchtwagen versteckte Kosten"
]

Input Query: Python Django authentication best practices
<think>
Let me get inside this developer's head...

On the surface, I'm asking about Django authentication best practices. But here's what's really going through my mind:

Primary concerns:
- I don't want to mess up security and get blamed for a breach
- I'm worried my implementation isn't "professional enough"
- Need to look competent in code reviews
- Don't want to rebuild this later when we scale

Hidden anxieties:
- Am I out of my depth with security?
- What if I miss something critical?
- How do real companies actually do this?
- Will this code embarrass me later?

Professional worries:
- Need to anticipate future architecture questions
- Want to avoid rookie mistakes
- Need to handle edge cases I haven't thought of
- How do I explain these decisions to senior devs?
</think>
queries: [
  "Django authentication security best practices site:docs.djangoproject.com",
  "Django auth implementation patterns security",
  "authentication security breach postmortem",
  "how to explain authentication architecture interview",
  "authentication code review feedback examples",
  "startup authentication technical debt lessons",
  "Django auth security testing methodology",
  "Django authentication scalability issues",
  "authentication mistakes junior developers",
  "when to use third party auth instead of building",
  "signs your authentication implementation is amateur",
  "authentication decisions you'll regret",
  "authentication system design interview questions",
  "authentication technical debt warnings",
  "how to document authentication decisions",
  "defending authentication design choices"
]

Input Query: paella recipe authentic
<think>
I'm asking about authentic paella recipes, but let me be honest with myself...

What I'm really thinking:
- I want to impress someone with "real" Spanish cooking
- I'm worried about embarrassing myself with an inauthentic version
- I don't want to look like a tourist/ignorant foreigner
- Need to sound knowledgeable about Spanish cuisine

My deeper anxieties:
- What if a Spanish person tries my paella?
- How do I know if my rice is actually cooked properly?
- What are the absolute rookie mistakes to avoid?
- What secrets do Spanish grandmothers know that aren't in recipes?

Cultural insecurities:
- Will using the wrong pan ruin everything?
- What ingredients should I never admit to using?
- How do I handle authenticity purists?
- What do Spanish people laugh about in foreign paellas?
</think>
queries: [
  "authentic valencian paella recipe",
  "traditional paella techniques",
  "worst paella mistakes foreigners make",
  "how to tell if paella is actually good",
  "what spanish mothers teach about paella",
  "paella authenticity arguments",
  "paella valenciana auténtica receta lang:es",
  "paella tradicional técnica preparación",
  "errores imperdonables paella valenciana",
  "secretos paella abuela valenciana",
  "críticas paella extranjeros errores",
  "paella polémica ingredientes prohibidos",
  "how to serve paella to spanish guests",
  "paella etiquette mistakes avoid",
  "what spaniards hate about foreign paella"
]

Now, process this query:
Input Query: ${action.searchQuery}
Intention: ${action.think}
`;
}

const TOOL_NAME = 'queryRewriter';

export async function rewriteQuery(action: SearchAction, trackers?: TrackerContext): Promise<{ queries: string[] }> {
  try {
    const generator = new ObjectGeneratorSafe(trackers?.tokenTracker);
    const prompt = getPrompt(action);

    const result = await generator.generateObject({
      model: TOOL_NAME,
      schema: responseSchema,
      prompt,
    });

    console.log(TOOL_NAME, result.object.queries);
    trackers?.actionTracker.trackThink(result.object.think);
    return { queries: result.object.queries };
  } catch (error) {
    console.error(`Error in ${TOOL_NAME}`, error);
    throw error;
  }
}