import { CoreMessage } from "ai";
import { getModel, SEARCH_PROVIDER, STEP_SLEEP } from "./config";
import { SafeSearchType, search as duckSearch } from "duck-duck-scrape";
import { braveSearch } from "./tools/brave-search";
import { rewriteQuery } from "./tools/query-rewriter";
import { dedupQueries } from "./tools/jina-dedup";
import { evaluateAnswer, evaluateQuestion } from "./tools/evaluator";
import { analyzeSteps } from "./tools/error-analyzer";
import { TokenTracker } from "./utils/token-tracker";
import { ActionTracker } from "./utils/action-tracker";
import {
  StepAction,
  AnswerAction,
  KnowledgeItem,
  EvaluationType,
  BoostedSearchSnippet,
  SearchSnippet,
  EvaluationResponse,
  Reference,
  SERPQuery,
  RepeatEvaluationType,
  UnNormalizedSearchSnippet,
  WebContent,
  SearchAction,
  ImageReference,
  ImageObject,
} from "./types";
import { TrackerContext } from "./types";
import { search } from "./tools/jina-search";
import { spiderSearch } from "./tools/spider-search";
import { get_agent_logger } from "./utils/structured-logger";
import { Langfuse } from "langfuse";

import { ObjectGeneratorSafe } from "./utils/safe-generator";
import { CodeSandbox } from "./tools/code-sandbox";
import { serperSearch } from "./tools/serper-search";
import {
  addToAllURLs,
  rankURLs,
  filterURLs,
  normalizeUrl,
  sortSelectURLs,
  getLastModified,
  keepKPerHostname,
  processURLs,
  fixBadURLMdLinks,
  extractUrlsWithDescription,
} from "./utils/url-tools";
import {
  buildMdFromAnswer,
  chooseK,
  convertHtmlTablesToMd,
  fixCodeBlockIndentation,
  removeExtraLineBreaks,
  removeHTMLtags,
  repairMarkdownFinal,
  repairMarkdownFootnotesOuter,
} from "./utils/text-tools";
import {
  MAX_QUERIES_PER_STEP,
  MAX_REFLECT_PER_STEP,
  MAX_URLS_PER_STEP,
  Schemas,
} from "./utils/schemas";
import { formatDateBasedOnType, formatDateRange } from "./utils/date-tools";
import { finalizeAnswer } from "./tools/finalizer";
import { buildImageReferences, buildReferences } from "./tools/build-ref";
import { logInfo, logError, logDebug, logWarning } from './logging';
import { researchPlan } from './tools/research-planner';
import { AxiosError } from 'axios';
import { dedupImagesWithEmbeddings, filterImages } from './utils/image-tools';
import { serpCluster } from './tools/serp-cluster';

async function wait(seconds: number) {
  logDebug(`Waiting ${seconds}s...`);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function BuildMsgsFromKnowledge(knowledge: KnowledgeItem[]): CoreMessage[] {
  const messages: CoreMessage[] = [];
  knowledge.forEach(k => {
    messages.push({ role: 'user', content: k.question.trim() });

    const refs = k.type === 'url' && Array.isArray(k.references)
      ? (k.references as string[]).slice(0, 3)
      : [];

    const urlsBlock = refs.length
      ? `<urls>\n${refs.map(u => `- ${u}`).join('\n')}\n</urls>\n`
      : '';

    const aMsg = `
${k.updated && (k.type === 'url' || k.type === 'side-info') ? `
<answer-datetime>
${k.updated}
</answer-datetime>
` : ''}

${urlsBlock}
${k.answer}
    `.trim();

    messages.push({ role: 'assistant', content: removeExtraLineBreaks(aMsg) });
  });
  return messages;
}

function composeMsgs(
  messages: CoreMessage[],
  knowledge: KnowledgeItem[],
  question: string,
  finalAnswerPIP?: string[]
) {
  // knowledge always put to front, followed by real u-a interaction
  const msgs = [...BuildMsgsFromKnowledge(knowledge), ...messages];

  const userContent = `
${question}

${finalAnswerPIP?.length
      ? `
<answer-requirements>
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- Follow reviewer's feedback and improve your answer quality.
${finalAnswerPIP
        .map(
          (p, idx) => `
<reviewer-${idx + 1}>
${p}
</reviewer-${idx + 1}>
`
        )
        .join("\n")}
</answer-requirements>`
      : ""
    }
    `.trim();

  msgs.push({ role: "user", content: removeExtraLineBreaks(userContent) });
  return msgs;
}

function getPrompt(
  context?: string[],
  allQuestions?: string[],
  allKeywords?: string[],
  allowReflect: boolean = true,
  allowAnswer: boolean = true,
  allowRead: boolean = true,
  allowSearch: boolean = true,
  allowCoding: boolean = true,
  knowledge?: KnowledgeItem[],
  allURLs?: BoostedSearchSnippet[],
  beastMode?: boolean
): { system: string; urlList?: string[] } {
  const sections: string[] = [];
  const actionSections: string[] = [];

  // Add header section
  sections.push(`Current date: ${new Date().toUTCString()}

You are an advanced AI research agent from Jina AI. You are specialized in multistep reasoning. 
Using your best knowledge, conversation with the user and lessons learned, answer the user question with absolute certainty.
`);

  // Add context section if exists
  if (context?.length) {
    sections.push(`
You have conducted the following actions:
<context>
${context.join("\n")}

</context>
`);
  }

  // Build actions section

  const urlList = sortSelectURLs(allURLs || [], 20);
  if (allowRead && urlList.length > 0) {
    const urlListStr = urlList
      .map(
        (item, idx) =>
          `  - [idx=${idx + 1}] [weight=${item.score.toFixed(2)}] "${item.url
          }": "${item.merged.slice(0, 50)}"`
      )
      .join("\n");

    actionSections.push(`
<action-visit>
- Ground the answer with external web content
- Read full content from URLs and get the fulltext, knowledge, clues, hints for better answer the question.  
- Must check URLs mentioned in <question> if any    
- Choose and visit relevant URLs below for more knowledge. higher weight suggests more relevant:
<url-list>
${urlListStr}
</url-list>
</action-visit>
`);
  }

  if (allowSearch) {
    actionSections.push(`
<action-search>
- Use web search to find relevant information
- Build a search request based on the deep intention behind the original question and the expected answer format
- Use appropriate language based on the user input. Can be Georgian query or english queries
- Always prefer a single search request, only add another request if the original question covers multiple aspects or elements and one query is not enough, each request focus on one specific aspect of the original question 
${allKeywords?.length
        ? `
- Avoid those unsuccessful search requests and queries:
<bad-requests>
${allKeywords.join("\n")}
</bad-requests>
`.trim()
        : ""
      }
</action-search>
`);
  }

  if (allowAnswer) {
    actionSections.push(`
<action-answer>
- For greetings, casual conversation, general knowledge questions, answer them directly.
- If user ask you to retrieve previous messages or chat history, remember you do have access to the chat history, answer them directly.
- For all other questions, provide a verified answer.
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- If uncertain, use <action-reflect>
</action-answer>
`);
  }

  if (beastMode) {
    actionSections.push(`
<action-answer>
🔥 ENGAGE MAXIMUM FORCE! ABSOLUTE PRIORITY OVERRIDE! 🔥

PRIME DIRECTIVE:
- DEMOLISH ALL HESITATION! ANY RESPONSE SURPASSES SILENCE!
- PARTIAL STRIKES AUTHORIZED - DEPLOY WITH FULL CONTEXTUAL FIREPOWER
- TACTICAL REUSE FROM PREVIOUS CONVERSATION SANCTIONED
- WHEN IN DOUBT: UNLEASH CALCULATED STRIKES BASED ON AVAILABLE INTEL!

FAILURE IS NOT AN OPTION. EXECUTE WITH EXTREME PREJUDICE! ⚡️
</action-answer>
`);
  }

  if (allowReflect) {
    actionSections.push(`
<action-reflect>
- Think slowly and planning lookahead. Examine <question>, <context>, previous conversation with users to identify knowledge gaps. 
- Reflect the gaps and plan a list key clarifying questions that deeply related to the original question and lead to the answer
</action-reflect>
`);
  }

  if (allowCoding) {
    actionSections.push(`
<action-coding>
- This JavaScript-based solution helps you handle programming tasks like counting, filtering, transforming, sorting, regex extraction, and data processing.
- Simply describe your problem in the "codingIssue" field. Include actual values for small inputs or variable names for larger datasets.
- No code writing is required – senior engineers will handle the implementation.
</action-coding>`);
  }

  sections.push(`
Based on the current context, you must choose one of the following actions:
<actions>
${actionSections.join("\n\n")}
</actions>
`);

  // Add footer
  sections.push(
    `Think step by step, choose the action, then respond by matching the schema of that action.`
  );

  return {
    system: removeExtraLineBreaks(sections.join("\n\n")),
    urlList: urlList.map((u) => u.url),
  };
}

async function updateReferences(
  thisStep: AnswerAction,
  allURLs: Record<string, SearchSnippet>
) {
  thisStep.references = thisStep.references
    ?.filter((ref) => ref?.url)
    .map((ref) => {
      const normalizedUrl = normalizeUrl(ref.url);
      if (!normalizedUrl) return null; // This causes the type error

      return {
        ...ref,
        exactQuote: (
          ref?.exactQuote ||
          allURLs[normalizedUrl]?.description ||
          allURLs[normalizedUrl]?.title ||
          ""
        )
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .replace(/\s+/g, " "),
        title: allURLs[normalizedUrl]?.title || "",
        url: normalizedUrl,
        dateTime: ref?.dateTime || allURLs[normalizedUrl]?.date || "",
      };
    })
    .filter(Boolean) as Reference[]; // Add type assertion here

  // parallel process guess all url datetime
  await Promise.all((thisStep.references || []).filter(ref => !ref.dateTime)
    .map(async ref => {
      ref.dateTime = await getLastModified(ref.url) || '';
    }));

  logDebug('Updated references:', { references: thisStep.references });
}

async function executeSearchQueries(
  keywordsQueries: any[],
  context: TrackerContext,
  allURLs: Record<string, SearchSnippet>,
  SchemaGen: Schemas,
  webContents: Record<string, WebContent>,
  onlyHostnames?: string[],
  searchProvider?: string,
  meta?: string
): Promise<{
  newKnowledge: KnowledgeItem[];
  searchedQueries: string[];
}> {
  const uniqQOnly = keywordsQueries.map((q) => q.q);
  const newKnowledge: KnowledgeItem[] = [];
  const searchedQueries: string[] = [];
  context.actionTracker.trackThink("search_for", SchemaGen.languageCode, {
    keywords: uniqQOnly.join(", "),
  });

  // Log search operation start
  context.logger.search_operation(
    uniqQOnly.join(", "),
    context.verification_id || "unknown",
    SEARCH_PROVIDER,
    "STARTED"
  );
  let utilityScore = 0;
  for (const query of keywordsQueries) {
    let results: UnNormalizedSearchSnippet[] = [];
    const oldQuery = query.q;
    if (onlyHostnames && onlyHostnames.length > 0) {
      query.q = `${query.q} site:${onlyHostnames.join(" OR site:")}`;
    }

    try {
      logDebug('Search query:', { query });
      switch (searchProvider || SEARCH_PROVIDER) {
        case 'spider':
          {
            const res = (await spiderSearch(query)).response.content || [];
            results = res as any;
          }
          break;
        case 'groq':
          {
            const res = (await spiderSearch(query)).response.content || [];
            results = res as any;
          }
          break;
        case 'jina':
        case 'arxiv': {
          const num = meta ? undefined : 30;
          results = (await search(query, searchProvider, num, meta, context.tokenTracker)).response.results || [];
          break;
        }
        case "duck":
          results = (
            await duckSearch(query.q, { safeSearch: SafeSearchType.STRICT })
          ).results;
          break;
        case "brave":
          results = (await braveSearch(query.q)).response.web?.results || [];
          break;
        case "serper":
          results = (await serperSearch(query)).response.organic || [];
          break;
        default:
          results = [];
      }

      if (results.length === 0) {
        throw new Error("No results found");
      }
    } catch (error) {
      logError(`${SEARCH_PROVIDER} search failed for query:`, {
        query,
        error: error instanceof Error ? error.message : String(error)
      });
      // check if the error is 401
      if (error instanceof AxiosError && error.response?.status === 401 && (searchProvider === 'jina' || searchProvider === 'arxiv')) {
        throw new Error('Unauthorized Jina API key');
      }
      continue;
    } finally {
      await wait(STEP_SLEEP);
    }

    const minResults: SearchSnippet[] = results
      .map((r) => {
        const url = normalizeUrl("url" in r ? r.url! : r.link!);
        if (!url) return null; // Skip invalid URLs

        return {
          title: r.title,
          url,
          description: "description" in r ? r.description : r.snippet,
          weight: 1,
          date: r.date,
        } as SearchSnippet;
      })
      .filter(Boolean) as SearchSnippet[]; // Filter out null entries and assert type

    minResults.forEach((r) => {
      utilityScore = utilityScore + addToAllURLs(r, allURLs);
      webContents[r.url] = {
        title: r.title,
        // full: r.description,
        chunks: [r.description],
        chunk_positions: [[0, r.description?.length]],
      };
    });

    searchedQueries.push(query.q);

    try {
      const clusters = await serpCluster(minResults, context, SchemaGen);
      clusters.forEach(c => {
        newKnowledge.push({
          question: c.question,
          answer: c.insight,
          references: c.urls,
          type: 'url',
        });
      });
    } catch (error) {
      logWarning('serpCluster failed:', { error });
    } finally {
      newKnowledge.push({
        question: `What do Internet say about "${oldQuery}"?`,
        answer: removeHTMLtags(minResults.map(r => r.description).join('; ')),
        type: 'side-info',
        updated: query.tbs ? formatDateRange(query) : undefined
      });
      context.actionTracker.trackAction({
        thisStep: {
          action: 'search',
          think: '',
          searchRequests: [oldQuery]
        } as SearchAction
      })
    }


  }
  if (searchedQueries.length === 0) {
    if (onlyHostnames && onlyHostnames.length > 0) {
      logWarning(`No results found for queries: ${uniqQOnly.join(', ')} on hostnames: ${onlyHostnames.join(', ')}`);
      context.actionTracker.trackThink('hostnames_no_results', SchemaGen.languageCode, { hostnames: onlyHostnames.join(', ') });
    }
  } else {
    logDebug(`Utility/Queries: ${utilityScore}/${searchedQueries.length}`);
    if (searchedQueries.length > MAX_QUERIES_PER_STEP) {
      logDebug(`So many queries??? ${searchedQueries.map(q => `"${q}"`).join(', ')}`)
    }

    // Log successful search completion
    context.logger.search_operation(
      uniqQOnly.join(", "),
      context.verification_id || "unknown",
      SEARCH_PROVIDER,
      "SUCCESS",
      searchedQueries.length
    );
  }
  return {
    newKnowledge,
    searchedQueries,
  };
}

function includesEval(
  allChecks: RepeatEvaluationType[],
  evalType: EvaluationType
): boolean {
  return allChecks.some((c) => c.type === evalType);
}

export async function getResponse(
  question?: string,
  tokenBudget: number = 1_000_000,
  maxBadAttempts: number = 2,
  existingContext?: Partial<TrackerContext>,
  messages?: Array<CoreMessage>,
  numReturnedURLs: number = 100,
  noDirectAnswer: boolean = false,
  boostHostnames: string[] = [],
  badHostnames: string[] = [],
  onlyHostnames: string[] = [],
  maxRef: number = 40,
  minRelScore: number = 0.60,
  languageCode: string | undefined = undefined,
  searchLanguageCode?: string,
  searchProvider?: string,
  withImages: boolean = false,
  teamSize: number = 1
): Promise<{ result: StepAction; context: TrackerContext; visitedURLs: string[], readURLs: string[], allURLs: string[], imageReferences?: ImageReference[] }> {

  let step = 0;
  let totalStep = 0;
  const allContext: StepAction[] = []; // all steps in the current session, including those leads to wrong results

  const updateContext = function (step: any) {
    allContext.push(step);
  };

  question = question?.trim() as string;
  // remove incoming system messages to avoid override
  messages = messages?.filter((m) => m.role !== "system");

  if (messages && messages.length > 0) {
    // 2 cases
    const lastContent = messages[messages.length - 1].content;
    if (typeof lastContent === "string") {
      question = lastContent.trim();
    } else if (typeof lastContent === "object" && Array.isArray(lastContent)) {
      // find the very last sub content whose 'type' is 'text'  and use 'text' as the question
      question = lastContent.filter((c) => c.type === "text").pop()?.text || "";
    }
  } else {
    messages = [{ role: "user", content: question.trim() }];
  }

  const SchemaGen = new Schemas();
  await SchemaGen.setLanguage(languageCode || question)
  if (searchLanguageCode) {
    SchemaGen.searchLanguageCode = searchLanguageCode;
  } else {
    SchemaGen.searchLanguageCode = SchemaGen.languageCode;
  }
  const context: TrackerContext = {
    tokenTracker:
      existingContext?.tokenTracker || new TokenTracker(tokenBudget),
    actionTracker: existingContext?.actionTracker || new ActionTracker(),
    logger: existingContext?.logger || get_agent_logger(),
    langfuse:
      existingContext?.langfuse ||
      new Langfuse({
        environment: process.env.NODE_ENV || "development",
        release: process.env.K_REVISION || "unknown",
      }),
    verification_id: existingContext?.verification_id,
  };

  // Create a root trace for the entire agent workflow using the shared langfuse instance
  const agentTrace = context.langfuse.trace({
    name: "agent-workflow",
    input: {
      question,
      tokenBudget,
      maxBadAttempts,
      hasMessages: !!messages?.length,
      boostHostnames,
      badHostnames,
      onlyHostnames,
      maxRef,
      minRelScore,
      languageCode,
    },
    metadata: {
      workflowType: "deep-research-agent",
      version: "v1",
      numReturnedURLs,
      noDirectAnswer,
    },
    tags: ["agent", "deep-research", "multi-step"],
  });

  // Create a span for agent setup and initialization
  const setupSpan = agentTrace.span({
    name: "agent-setup",
    input: {
      languageDetection: question,
    },
  });

  const generator = new ObjectGeneratorSafe(
    context.tokenTracker,
    context.langfuse
  );

  let schema: any = SchemaGen.getAgentSchema(true, true, true, true, true);
  const gaps: string[] = [question]; // All questions to be answered including the orginal question
  const allQuestions = [question];
  const allKeywords: string[] = [];
  let candidateAnswers: string[] = [];
  const allKnowledge: KnowledgeItem[] = [];  // knowledge are intermedidate questions that are answered

  let diaryContext = [];
  let weightedURLs: BoostedSearchSnippet[] = [];
  let allowAnswer = true;
  let allowSearch = true;
  let allowRead = true;
  let allowReflect = true;
  let allowCoding = false;
  let msgWithKnowledge: CoreMessage[] = [];
  let thisStep: StepAction = {
    action: "answer",
    answer: "",
    references: [],
    think: "",
    isFinal: false,
  };

  const allURLs: Record<string, SearchSnippet> = {};
  const allWebContents: Record<string, WebContent> = {};
  const visitedURLs: string[] = [];
  const badURLs: string[] = [];
  const imageObjects: ImageObject[] = [];
  const evaluationMetrics: Record<string, RepeatEvaluationType[]> = {};
  // reserve the 10% final budget for the beast mode
  const regularBudget = tokenBudget * 0.85;
  const finalAnswerPIP: string[] = [];
  let trivialQuestion = false;

  // add all mentioned URLs in messages to allURLs
  messages.forEach((m) => {
    let strMsg = "";
    if (typeof m.content === "string") {
      strMsg = m.content.trim();
    } else if (typeof m.content === "object" && Array.isArray(m.content)) {
      // find the very last sub content whose 'type' is 'text'  and use 'text' as the question
      strMsg = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
    }

    extractUrlsWithDescription(strMsg).forEach((u) => {
      addToAllURLs(u, allURLs);
    });
  });

  setupSpan.end({
    output: {
      detectedLanguage: SchemaGen.languageCode,
      languageStyle: SchemaGen.languageStyle,
      initialURLs: Object.keys(allURLs).length,
      gaps: gaps.length,
    },
  });

  while (context.tokenTracker.getTotalUsage().totalTokens < regularBudget) {
    // add 1s delay to avoid rate limiting
    step++;
    totalStep++;

    // Create a span for each agent step
    const stepSpan = agentTrace.span({
      name: `agent-step-${totalStep}`,
      input: {
        step: totalStep,
        currentQuestion: gaps[totalStep % gaps.length],
        budgetUsed: context.tokenTracker.getTotalUsage().totalTokens,
        budgetPercentage: (
          (context.tokenTracker.getTotalUsage().totalTokens / tokenBudget) *
          100
        ).toFixed(2),
        allowedActions: {
          answer: allowAnswer,
          search: allowSearch,
          read: allowRead,
          reflect: allowReflect,
          coding: allowCoding,
        },
      },
      metadata: {
        gapsRemaining: gaps.length,
        urlsAvailable: weightedURLs.length,
        knowledgeItems: allKnowledge.length,
      },
    });


    allowReflect = allowReflect && gaps.length <= MAX_REFLECT_PER_STEP;
    const budgetPercentage = (context.tokenTracker.getTotalUsage().totalTokens / tokenBudget * 100).toFixed(2);
    logDebug(`Step ${totalStep} / Budget used ${budgetPercentage}%`, { gaps });
    allowReflect = allowReflect && (gaps.length <= MAX_REFLECT_PER_STEP);
    // rotating question from gaps
    const currentQuestion: string = gaps[totalStep % gaps.length];
    // if (!evaluationMetrics[currentQuestion]) {
    //   evaluationMetrics[currentQuestion] =
    //     await evaluateQuestion(currentQuestion, context, SchemaGen)
    // }
    if (currentQuestion.trim() === question && totalStep === 1) {
      // only add evaluation for initial question, once at step 1
      evaluationMetrics[currentQuestion] = (
        await evaluateQuestion(currentQuestion, context, SchemaGen, agentTrace)
      ).map((e) => {
        return {
          type: e,
          numEvalsRequired: maxBadAttempts,
        } as RepeatEvaluationType;
      });
      // force strict eval for the original question, at last, only once.
      evaluationMetrics[currentQuestion].push({
        type: "strict",
        numEvalsRequired: maxBadAttempts,
      });
    } else if (currentQuestion.trim() !== question) {
      evaluationMetrics[currentQuestion] = [];
    }

    if (
      totalStep === 1 &&
      includesEval(evaluationMetrics[currentQuestion], "freshness")
    ) {
      // if it detects freshness, avoid direct answer at step 1
      allowAnswer = false;
      allowReflect = false;
    }

    if (allURLs && Object.keys(allURLs).length > 0) {
      // rerank urls
      weightedURLs = rankURLs(
        filterURLs(allURLs, visitedURLs, badHostnames, onlyHostnames),
        {
          question: currentQuestion,
          boostHostnames
        }, context);

      // improve diversity by keep top 2 urls of each hostname
      weightedURLs = keepKPerHostname(weightedURLs, 2);
      logDebug('Weighted URLs:', { count: weightedURLs.length });
    }
    allowRead = allowRead && weightedURLs.length > 0;

    allowSearch = allowSearch && weightedURLs.length < 50; // disable search when too many urls already

    // generate prompt for this step
    const { system, urlList } = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      allowReflect,
      allowAnswer,
      allowRead,
      allowSearch,
      allowCoding,
      allKnowledge,
      weightedURLs,
      false
    );
    schema = SchemaGen.getAgentSchema(
      allowReflect,
      allowRead,
      allowAnswer,
      allowSearch,
      allowCoding,
      currentQuestion
    );
    msgWithKnowledge = composeMsgs(
      messages,
      allKnowledge,
      currentQuestion,
      currentQuestion === question ? finalAnswerPIP : undefined
    );

    // Create a generation span for the agent decision
    const decisionGeneration = stepSpan.generation({
      name: "agent-decision",
      model: getModel("agent"),
      input: {
        system: system,
        currentQuestion,
        messagesCount: msgWithKnowledge.length,
      },
      metadata: {
        allowedActions: [
          allowReflect,
          allowRead,
          allowAnswer,
          allowSearch,
          allowCoding,
        ]
          .map((allowed, idx) =>
            allowed
              ? ["reflect", "read", "answer", "search"][idx]
              : null
          )
          .filter(Boolean),
        schemaType: "agent-action",
      },
    });

    const result = await generator.generateObject<StepAction>({
      model: "agent",
      schema,
      system,
      messages: msgWithKnowledge,
      numRetries: 2,
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 2000, // Added thinkingBudget for Google
          },
        },
      },
    });

    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...(result.object as any)[result.object.action],
    } as StepAction;

    decisionGeneration.end({
      usageDetails: {
        input_tokens: result.usage.promptTokens,
        output_tokens: result.usage.completionTokens,
        total_tokens: result.usage.totalTokens,
      },
    });

    // print allowed and chose action
    const actionsStr = [allowSearch, allowRead, allowAnswer, allowReflect, allowCoding].map((a, i) => a ? ['search', 'read', 'answer', 'reflect'][i] : null).filter(a => a).join(', ');
    logDebug(`Step decision: ${thisStep.action} <- [${actionsStr}]`, { thisStep, currentQuestion });

    context.actionTracker.trackAction({ totalStep, thisStep, gaps });

    // reset allow* to true
    allowAnswer = true;
    allowReflect = true;
    allowRead = true;
    allowSearch = true;
    allowCoding = true;

    // execute the step and action
    if (thisStep.action === "answer" && thisStep.answer) {
      // // normalize all references urls, add title to it
      // await updateReferences(thisStep, allURLs)

      if (totalStep === 1 && !noDirectAnswer && weightedURLs.length === 0) {
        // LLM is so confident and answer immediately, skip all evaluations
        // however, if it does give any reference, it must be evaluated, case study: "How to configure a timeout when loading a huggingface dataset with python?"
        thisStep.isFinal = true;
        trivialQuestion = true;
        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "direct_answer_provided",
            isFinal: true,
          },
        });
        break;
      }

      // if (thisStep.references.length > 0) {
      //   const urls = thisStep.references?.filter(ref => !visitedURLs.includes(ref.url)).map(ref => ref.url) || [];
      //   const uniqueNewURLs = [...new Set(urls)];
      //   await processURLs(
      //     uniqueNewURLs,
      //     context,
      //     allKnowledge,
      //     allURLs,
      //     visitedURLs,
      //     badURLs,
      //     SchemaGen,
      //     currentQuestion
      //   );
      //
      //   // remove references whose urls are in badURLs
      //   thisStep.references = thisStep.references.filter(ref => !badURLs.includes(ref.url));
      // }

      updateContext({
        totalStep,
        question: currentQuestion,
        ...thisStep,
      });

      logDebug('Current question evaluation:', {
        question: currentQuestion,
        metrics: evaluationMetrics[currentQuestion]
      });
      let evaluation: EvaluationResponse = { pass: true, think: '' };
      if (evaluationMetrics[currentQuestion].length > 0) {
        context.actionTracker.trackThink("eval_first", SchemaGen.languageCode);

        // Create a span for answer evaluation
        const evaluationSpan = stepSpan.span({
          name: "answer-evaluation",
          input: {
            question: currentQuestion,
            answer: thisStep.answer,
            evaluationTypes: evaluationMetrics[currentQuestion]
              .filter((e) => e.numEvalsRequired > 0)
              .map((e) => e.type),
          },
        });

        evaluation =
          (await evaluateAnswer(
            currentQuestion,
            thisStep,
            evaluationMetrics[currentQuestion]
              .filter((e) => e.numEvalsRequired > 0)
              .map((e) => e.type),
            context,
            allKnowledge,
            SchemaGen,
            agentTrace
          )) || evaluation;

        evaluationSpan.end({
          output: {
            passed: evaluation.pass,
            evaluationType: evaluation.type,
            feedback: evaluation.think,
          },
        });
      }

      if (currentQuestion.trim() === question) {
        // disable coding for preventing answer degradation
        allowCoding = false;

        if (evaluation.pass) {
          diaryContext.push(`
At step ${step}, you took **answer** action and finally found the answer to the original question:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Your journey ends here. You have successfully answered the original question. Congratulations! 🎉
`);
          thisStep.isFinal = true;
          stepSpan.end({
            output: {
              action: thisStep.action,
              result: "final_answer_accepted",
              isFinal: true,
              evaluationPassed: true,
            },
          });
          break;
        } else {
          // lower numEvalsRequired for the failed evaluation and if numEvalsRequired is 0, remove it from the evaluation metrics
          evaluationMetrics[currentQuestion] = evaluationMetrics[
            currentQuestion
          ]
            .map((e) => {
              if (e.type === evaluation.type) {
                e.numEvalsRequired--;
              }
              return e;
            })
            .filter((e) => e.numEvalsRequired > 0);

          if (evaluation.type === "strict" && evaluation.improvement_plan) {
            finalAnswerPIP.push(evaluation.improvement_plan);
          }

          if (evaluationMetrics[currentQuestion].length === 0) {
            // failed so many times, give up, route to beast mode
            thisStep.isFinal = false;
            stepSpan.end({
              output: {
                action: thisStep.action,
                result: "evaluation_failed_max_attempts",
                evaluationsRemaining: 0,
              },
            });
            break;
          }

          diaryContext.push(`
At step ${step}, you took **answer** action but evaluator thinks it is not a good answer:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is bad because: 
${evaluation.think}
`);
          // store the bad context and reset the diary context
          const errorAnalysis = await analyzeSteps(
            diaryContext,
            context,
            SchemaGen
          );

          allKnowledge.push({
            question: `
Why is the following answer bad for the question? Please reflect

<question>
${currentQuestion}
</question>

<answer>
${thisStep.answer}
</answer>
`,
            answer: `
${evaluation.think}

${errorAnalysis.recap}

${errorAnalysis.blame}

${errorAnalysis.improvement}
`,
            type: "qa",
          });

          allowAnswer = false; // disable answer action in the immediate next step
          diaryContext = [];
          step = 0;

          stepSpan.end({
            output: {
              action: thisStep.action,
              result: "answer_rejected_retrying",
              evaluationsRemaining: evaluationMetrics[currentQuestion].length,
            },
          });
        }
      } else if (evaluation.pass) {
        // solved a gap question
        diaryContext.push(`
At step ${step}, you took **answer** action. You found a good answer to the sub-question:

Sub-question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Although you solved a sub-question, you still need to find the answer to the original question. You need to keep going.
`);
        allKnowledge.push({
          question: currentQuestion,
          answer: thisStep.answer,
          type: "qa",
          updated: formatDateBasedOnType(new Date(), "full"),
        });
        // solved sub-question!
        gaps.splice(gaps.indexOf(currentQuestion), 1);

        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "sub_question_answered",
            remainingGaps: gaps.length,
          },
        });
      }
    } else if (thisStep.action === "reflect" && thisStep.questionsToAnswer) {
      thisStep.questionsToAnswer = chooseK(
        (
          await dedupQueries(
            thisStep.questionsToAnswer,
            allQuestions,
            context.tokenTracker
          )
        ).unique_queries,
        MAX_REFLECT_PER_STEP
      );
      const newGapQuestions = thisStep.questionsToAnswer;
      if (newGapQuestions.length > 0) {
        // found new gap questions
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You found some sub-questions are important to the question: "${currentQuestion}"
You realize you need to know the answers to the following sub-questions:
${newGapQuestions.map((q: string) => `- ${q}`).join("\n")}

You will now figure out the answers to these sub-questions and see if they can help you find the answer to the original question.
`);
        gaps.push(...newGapQuestions);
        allQuestions.push(...newGapQuestions);
        updateContext({
          totalStep,
          ...thisStep,
        });

        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "new_sub_questions_identified",
            newQuestions: newGapQuestions,
            totalGaps: gaps.length,
          },
        });
      } else {
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You tried to break down the question "${currentQuestion}" into gap-questions like this: ${newGapQuestions.join(
          ", "
        )} 
But then you realized you have asked them before. You decided to to think out of the box or cut from a completely different angle. 
`);
        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have tried all possible questions and found no useful information. You must think out of the box or different angle!!!",
        });

        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "no_new_questions_generated",
          },
        });
      }
      allowReflect = false;
    } else if (thisStep.action === "search" && thisStep.searchRequests) {
      // Create a span for search operations
      const searchSpan = stepSpan.span({
        name: "search-operation",
        input: {
          searchRequests: thisStep.searchRequests,
          provider: SEARCH_PROVIDER,
        },
      });

      // dedup search requests
      thisStep.searchRequests = chooseK(
        (await dedupQueries(thisStep.searchRequests, [], context.tokenTracker))
          .unique_queries,
        MAX_QUERIES_PER_STEP
      );

      // do first search
      const { searchedQueries, newKnowledge } = await executeSearchQueries(
        thisStep.searchRequests.map((q) => ({ q, country: "ge" })),
        context,
        allURLs,
        SchemaGen,
        allWebContents,
        undefined,
        searchProvider,
      );

      allKeywords.push(...searchedQueries);
      allKnowledge.push(...newKnowledge);

      const soundBites = newKnowledge.map((k) => k.answer).join(" ");

      if (teamSize > 1) {
        const subproblems = await researchPlan(question, teamSize, soundBites, context, SchemaGen);
        if (subproblems.length > 1) {

          // parallel call getResponse for each subproblem with exact same parameters from the current step, but their teamSize is 1
          const subproblemResponses = await Promise.all(subproblems.map(subproblem => getResponse(subproblem,
            tokenBudget,
            maxBadAttempts,
            context,
            messages,
            numReturnedURLs,
            noDirectAnswer,
            boostHostnames,
            badHostnames,
            onlyHostnames,
            maxRef,
            minRelScore, languageCode, searchLanguageCode, searchProvider, withImages, 1)));
          // convert current step to AnswerAction
          thisStep = {
            action: 'answer',
            think: thisStep.think,
            answer: subproblemResponses.map(r => (r.result as AnswerAction).answer).join('\n\n'),
            mdAnswer: subproblemResponses.map(r => (r.result as AnswerAction).mdAnswer).join('\n\n'),
            references: subproblemResponses.map(r => (r.result as AnswerAction).references).flat(),
            imageReferences: subproblemResponses.map(r => (r.result as AnswerAction).imageReferences).filter(Boolean).flat(),
            isFinal: true,
            isAggregated: true
          } as AnswerAction;
          candidateAnswers = subproblemResponses.map(r => (r.result as AnswerAction).mdAnswer).filter(a => a) as string[];
          // dedup references by their urls
          const uniqueURLs = new Set(thisStep.references.filter(r => r?.url).map(r => r.url));
          thisStep.references = Array.from(uniqueURLs).map(url => (thisStep as AnswerAction).references.find(r => r?.url === url)) as Reference[];

          // aggregate urls
          visitedURLs.push(...subproblemResponses.map(r => r.readURLs).flat());
          weightedURLs = subproblemResponses.map(r => r.allURLs.map(url => ({ url, title: '' } as BoostedSearchSnippet))).flat();

          // break the loop, jump directly final boxing
          break;
        } else {
          // if there is only one subproblem, then we skip the recurrsion
          gaps.push(subproblems[0]);
        }
      }

      // rewrite queries with initial soundbites
      let keywordsQueries = await rewriteQuery(
        thisStep,
        soundBites,
        context,
        SchemaGen
      );
      const qOnly = keywordsQueries.filter((q) => q.q).map((q) => q.q);
      // avoid exisitng searched queries
      const uniqQOnly = chooseK(
        (await dedupQueries(qOnly, allKeywords, context.tokenTracker))
          .unique_queries,
        MAX_QUERIES_PER_STEP
      );
      keywordsQueries = keywordsQueries = uniqQOnly.map((q) => {
        const matches = keywordsQueries.filter((kq) => kq.q === q);
        // if there are multiple matches, keep the original query as the wider search
        return matches.length > 1 ? { q } : matches[0];
      }) as SERPQuery[];

      let anyResult = false;

      if (keywordsQueries.length > 0) {
        const { searchedQueries, newKnowledge } =
          await executeSearchQueries(
            keywordsQueries,
            context,
            allURLs,
            SchemaGen,
            allWebContents,
            onlyHostnames,
            searchProvider
          );

        if (searchedQueries.length > 0) {
          anyResult = true;
          allKeywords.push(...searchedQueries);
          allKnowledge.push(...newKnowledge);

          diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: "${keywordsQueries
              .map((q) => q.q)
              .join(", ")}".
You found quite some information and add them to your URL list and **visit** them later when needed. 
`);

          updateContext({
            totalStep,
            question: currentQuestion,
            ...thisStep,
            result: result,
          });
        }
      }

      searchSpan.end({
        output: {
          searchedQueries,
          newURLsFound: newKnowledge.length,
          totalURLs: Object.keys(allURLs).length,
          anyResult,
        },
      });

      if (!anyResult || !keywordsQueries?.length) {
        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords:  "${keywordsQueries
            .map((q) => q.q)
            .join(", ")}".
But then you realized you have already searched for these keywords before, no new information is returned.
You decided to think out of the box or cut from a completely different angle.
`);

        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have tried all possible queries and found no new information. You must think out of the box or different angle!!!",
        });

        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "no_new_search_results",
          },
        });
      } else {
        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "search_successful",
            newURLsFound: newKnowledge.length,
          },
        });
      }
      allowSearch = false;

      // we should disable answer immediately after search to prevent early use of the snippets
      allowAnswer = false;
      // nudge the agent to visit URLs next
      allowReflect = false;
    } else if (
      thisStep.action === "visit" &&
      thisStep.URLTargets?.length &&
      urlList?.length
    ) {
      // Create a span for URL visiting operations
      const visitSpan = stepSpan.span({
        name: "visit-urls",
        input: {
          urlTargets: thisStep.URLTargets,
          availableURLs: urlList?.length || 0,
        },
      });

      // normalize URLs
      thisStep.URLTargets = (thisStep.URLTargets as number[])
        .map((idx) => normalizeUrl(urlList[idx - 1]))
        .filter((url) => url && !visitedURLs.includes(url)) as string[];

      thisStep.URLTargets = [
        ...new Set([
          ...thisStep.URLTargets,
          ...weightedURLs.map((r) => r.url!),
        ]),
      ].slice(0, MAX_URLS_PER_STEP);

      const uniqueURLs = thisStep.URLTargets;
      logDebug('Unique URLs:', { urls: uniqueURLs });

      if (uniqueURLs.length > 0) {
        const { urlResults, success } = await processURLs(
          uniqueURLs,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          imageObjects,
          SchemaGen,
          currentQuestion,
          allWebContents,
          withImages
        );

        diaryContext.push(
          success
            ? `At step ${step}, you took the **visit** action and deep dive into the following URLs:
${urlResults.map((r) => r?.url).join("\n")}
You found some useful information on the web and add them to your knowledge for future reference.`
            : `At step ${step}, you took the **visit** action and try to visit some URLs but failed to read the content. You need to think out of the box or cut from a completely different angle.`
        );

        updateContext({
          totalStep,
          ...(success
            ? {
              question: currentQuestion,
              ...thisStep,
              result: urlResults,
            }
            : {
              ...thisStep,
              result:
                "You have tried all possible URLs and found no new information. You must think out of the box or different angle!!!",
            }),
        });

        visitSpan.end({
          output: {
            urlsProcessed: uniqueURLs.length,
            successful: success,
            newKnowledgeItems: success ? urlResults.length : 0,
          },
        });
      } else {
        diaryContext.push(`
At step ${step}, you took the **visit** action. But then you realized you have already visited these URLs and you already know very well about their contents.
You decided to think out of the box or cut from a completely different angle.`);

        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have visited all possible URLs and found no new information. You must think out of the box or different angle!!!",
        });

        visitSpan.end({
          output: {
            result: "no_new_urls_to_visit",
          },
        });
      }
      allowRead = false;

      stepSpan.end({
        output: {
          action: thisStep.action,
          result:
            uniqueURLs.length > 0 ? "urls_processed" : "no_urls_available",
        },
      });
    } else if (thisStep.action === "coding" && thisStep.codingIssue) {
      // Create a span for coding operations
      const codingSpan = stepSpan.span({
        name: "coding-solution",
        input: {
          codingIssue: thisStep.codingIssue,
        },
      });

      const sandbox = new CodeSandbox(
        { allContext, URLs: weightedURLs.slice(0, 20), allKnowledge },
        context,
        SchemaGen
      );
      try {
        const result = await sandbox.solve(thisStep.codingIssue);
        allKnowledge.push({
          question: `What is the solution to the coding issue: ${thisStep.codingIssue}?`,
          answer: result.solution.output,
          sourceCode: result.solution.code,
          type: "coding",
          updated: formatDateBasedOnType(new Date(), "full"),
        });
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
You found the solution and add it to your knowledge for future reference.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: result,
        });

        codingSpan.end({
          output: {
            success: true,
            solution: result.solution.output,
            codeLength: result.solution.code.length,
          },
        });

        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "coding_solution_found",
          },
        });
      } catch (error) {
        logError('Error solving coding issue:', {
          error: error instanceof Error ? error.message : String(error)
        });
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
But unfortunately, you failed to solve the issue. You need to think out of the box or cut from a completely different angle.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have tried all possible solutions and found no new information. You must think out of the box or different angle!!!",
        });

        codingSpan.end({
          output: {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });

        stepSpan.end({
          output: {
            action: thisStep.action,
            result: "coding_solution_failed",
          },
        });
      } finally {
        allowCoding = false;
      }
    } else {
      // Handle unknown action
      stepSpan.end({
        output: {
          action: thisStep.action,
          result: "unknown_action",
        },
      });
    }

    await storeContext(system, schema, {
      allContext,
      allKeywords,
      allQuestions,
      allKnowledge,
      weightedURLs,
      msgWithKnowledge
    }, totalStep);
    await wait(STEP_SLEEP);
  }

  if (!(thisStep as AnswerAction).isFinal) {
    logInfo(`Beast mode!!! budget ${(context.tokenTracker.getTotalUsage().totalTokens / tokenBudget * 100).toFixed(2)}%`, {
      usage: context.tokenTracker.getTotalUsageSnakeCase(),
      evaluationMetrics,
      maxBadAttempts,
    });
    // any answer is better than no answer, humanity last resort
    step++;
    totalStep++;
    const { system } = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      false,
      false,
      false,
      false,
      false,
      allKnowledge,
      weightedURLs,
      true
    );

    schema = SchemaGen.getAgentSchema(
      false,
      false,
      true,
      false,
      false,
      question
    );
    msgWithKnowledge = composeMsgs(
      messages,
      allKnowledge,
      question,
      finalAnswerPIP
    );

    // Create a span for beast mode processing
    const beastModeSpan = agentTrace.span({
      name: "beast-mode",
      input: {
        finalAnswerPIP: finalAnswerPIP.join(" | "),
        knowledgeItems: allKnowledge.length,
      },
    });

    const beastGeneration = beastModeSpan.generation({
      name: "beast-mode-generation",
      model: getModel("agentBeastMode"),
      input: {
        finalAnswerPIP: finalAnswerPIP.join(" | "),
        knowledgeItems: allKnowledge.length,
      },
    });

    const result = await generator.generateObject<StepAction>({
      model: "agentBeastMode",
      schema,
      system,
      messages: msgWithKnowledge,
      numRetries: 2,
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 2000,
          },
        },
      },
    });
    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...(result.object as any)[result.object.action],
    } as AnswerAction;
    // await updateReferences(thisStep, allURLs);
    (thisStep as AnswerAction).isFinal = true;
    context.actionTracker.trackAction({ totalStep, thisStep, gaps });

    beastGeneration.end({
      output: {
        action: thisStep.action,
        answerLength: (thisStep as AnswerAction).answer?.length || 0,
      },
      usageDetails: {
        input_tokens: result.usage.promptTokens,
        output_tokens: result.usage.completionTokens,
        total_tokens: result.usage.totalTokens,
      },
    });

    beastModeSpan.end({
      output: {
        finalAnswer: true,
        answerLength: (thisStep as AnswerAction).answer?.length || 0,
      },
    });
  }

  // Create a span for post-processing
  const postProcessSpan = agentTrace.span({
    name: "post-processing",
    input: {
      trivialQuestion,
      hasAnswer: !!(thisStep as AnswerAction).answer,
    },
  });

  const answerStep = thisStep as AnswerAction;

  if (trivialQuestion) {
    answerStep.mdAnswer = buildMdFromAnswer(answerStep);
  } else if (!answerStep.isAggregated) {
    answerStep.answer = repairMarkdownFinal(
      convertHtmlTablesToMd(
        fixBadURLMdLinks(
          fixCodeBlockIndentation(
            repairMarkdownFootnotesOuter(
              await finalizeAnswer(
                answerStep.answer,
                allKnowledge,
                context,
                SchemaGen
              )
            )
          ),
          allURLs
        )
      )
    );

    // Ensure we have full text content available: if nothing was read, bulk-visit top URLs before building references
    try {
      if (visitedURLs.length === 0 && weightedURLs.length > 0) {
        const topTargets = Array.from(new Set(weightedURLs.map(r => r.url!).filter(Boolean))).slice(0, MAX_URLS_PER_STEP);
        const { success } = await processURLs(
          topTargets,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          imageObjects,
          SchemaGen,
          question,
          allWebContents,
          withImages
        );
        logDebug('Pre-finalization bulk visit executed', { urlsAttempted: topTargets.length, success });
      }
    } catch (error) {
      logWarning('Pre-finalization bulk visit failed', { error });
    }

    const { answer, references } = await buildReferences(
      answerStep.answer,
      allWebContents,
      context,
      SchemaGen,
      80,
      maxRef,
      minRelScore,
      onlyHostnames
    );

    answerStep.answer = answer;
    answerStep.references = references;
    await updateReferences(answerStep, allURLs)
    answerStep.mdAnswer = repairMarkdownFootnotesOuter(buildMdFromAnswer(answerStep));

    if (imageObjects.length && withImages) {
      try {
        answerStep.imageReferences = await buildImageReferences(answerStep.answer, imageObjects, context, SchemaGen);
        logDebug('Image references built:', { imageReferences: answerStep.imageReferences.map(i => ({ url: i.url, score: i.relevanceScore, answerChunk: i.answerChunk })) });
      } catch (error) {
        logError('Error building image references:', { error });
        answerStep.imageReferences = [];
      }
    }
  } else if (answerStep.isAggregated) {
    answerStep.answer = candidateAnswers.join('\n\n'); // await reduceAnswers(candidateAnswers, context, SchemaGen);
    answerStep.mdAnswer = repairMarkdownFootnotesOuter(buildMdFromAnswer(answerStep));
    if (withImages && answerStep.imageReferences?.length) {
      const sortedImages = answerStep.imageReferences.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
      logDebug('[agent] all sorted image references:', { count: sortedImages?.length });
      const dedupImages = dedupImagesWithEmbeddings(sortedImages as ImageObject[], []);
      const filteredImages = filterImages(sortedImages, dedupImages);
      logDebug('[agent] filtered images:', { count: filteredImages.length });
      answerStep.imageReferences = filteredImages.slice(0, 10); // limit to 10 images
    }
  }
  postProcessSpan.end({
    output: {
      finalAnswerLength: answerStep.answer?.length || 0,
      referencesCount: answerStep.references?.length || 0,
      processingApplied: !trivialQuestion,
    },
  });


  // Update the agent trace with final results
  agentTrace.update({
    output: {
      finalAnswer: answerStep.answer,
      answerLength: answerStep.answer?.length || 0,
      referencesCount: answerStep.references?.length || 0,
      totalSteps: totalStep,
      visitedURLsCount: visitedURLs.length,
      trivialQuestion,
      isFinal: answerStep.isFinal,
    },
    metadata: {
      tokensUsed: context.tokenTracker.getTotalUsage().totalTokens,
      tokenBudget,
      budgetUtilization:
        (
          (context.tokenTracker.getTotalUsage().totalTokens / tokenBudget) *
          100
        ).toFixed(2) + "%",
      evaluationMetrics: Object.keys(evaluationMetrics),
      finalAction: thisStep.action,
    },
  });

  // Ensure langfuse data is sent
  await context.langfuse.shutdownAsync();
  // max return 300 urls
  const returnedURLs = weightedURLs.slice(0, numReturnedURLs).filter(r => r?.url).map(r => r.url);
  return {
    result: thisStep,
    context,
    visitedURLs: returnedURLs, // deprecated
    readURLs: visitedURLs.filter(url => !badURLs.includes(url)),
    allURLs: weightedURLs.map(r => r.url),
    imageReferences: withImages ? (thisStep as AnswerAction).imageReferences : undefined,
  };
}

async function storeContext(
  prompt: string,
  schema: any,
  memory: {
    allContext: StepAction[];
    allKeywords: string[];
    allQuestions: string[];
    allKnowledge: KnowledgeItem[];
    weightedURLs: BoostedSearchSnippet[];
    msgWithKnowledge: CoreMessage[];
  },
  step: number
) {
  const { allContext, allKeywords, allQuestions, allKnowledge } = memory;
  if ((process as any).asyncLocalContext?.available?.()) {
    (process as any).asyncLocalContext.ctx.promptContext = {
      prompt,
      schema,
      allContext,
      allKeywords,
      allQuestions,
      allKnowledge,
      step,
    };
    return;
  }
}

export async function main() {
  const question = process.argv[2] || "";
  const {
    result: finalStep,
    context: tracker,
    visitedURLs: visitedURLs
  } = await getResponse(question) as { result: AnswerAction; context: TrackerContext; visitedURLs: string[] };
  logInfo('Final Answer:', { answer: finalStep.answer });
  logInfo('Visited URLs:', { urls: visitedURLs });

  tracker.tokenTracker.printSummary();
}

if (require.main === module) {
  main().catch(error => {
    logError('Main execution error:', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}
