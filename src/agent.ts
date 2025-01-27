import {GoogleGenerativeAI, SchemaType} from "@google/generative-ai";
import dotenv from 'dotenv';
import {ProxyAgent, setGlobalDispatcher} from "undici";
import {readUrl} from "./tools/read";
import fs from 'fs/promises';
import {SafeSearchType, search} from "duck-duck-scrape";
import {rewriteQuery} from "./tools/query-rewriter";
import {dedupQueries} from "./tools/dedup";
import {evaluateAnswer} from "./tools/evaluator";
import {buildURLMap} from "./tools/getURLIndex";

// Proxy setup remains the same
if (process.env.https_proxy) {
  try {
    const proxyUrl = new URL(process.env.https_proxy).toString();
    const dispatcher = new ProxyAgent({uri: proxyUrl});
    setGlobalDispatcher(dispatcher);
  } catch (error) {
    console.error('Failed to set proxy:', error);
  }
}
dotenv.config();

async function sleep(ms: number) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const startTime = Date.now();
  const endTime = startTime + ms;

  // Clear current line and hide cursor
  process.stdout.write('\x1B[?25l');

  while (Date.now() < endTime) {
    const remaining = Math.ceil((endTime - Date.now()) / 1000);
    const frameIndex = Math.floor(Date.now() / 100) % frames.length;

    // Clear line and write new frame
    process.stdout.write(`\r${frames[frameIndex]} Cool down... ${remaining}s remaining`);

    // Small delay for animation
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Clear line, show cursor and move to next line
  process.stdout.write('\r\x1B[K\x1B[?25h\n');

  // Original sleep
  await new Promise(resolve => setTimeout(resolve, 0));
}

type ResponseSchema = {
  type: SchemaType.OBJECT;
  properties: {
    action: {
      type: SchemaType.STRING;
      enum: string[];
      description: string;
    };
    searchQuery: {
      type: SchemaType.STRING;
      description: string;
    };
    URLTargets?: {
      type: SchemaType.ARRAY;
      items: {
        type: SchemaType.STRING;
      };
      description: string;
    };
    answer: {
      type: SchemaType.STRING;
      description: string;
    };
    references: {
      type: SchemaType.ARRAY;
      items: {
        type: SchemaType.OBJECT;
        properties: {
          title: {
            type: SchemaType.STRING;
            description: string;
          };
          url: {
            type: SchemaType.STRING;
            description: string;
          };
        };
        required: string[];
      };
      description: string;
    };
    reasoning: {
      type: SchemaType.STRING;
      description: string;
    };
    questionsToAnswer?: {
      type: SchemaType.ARRAY;
      items: {
        type: SchemaType.STRING;
        description: string;
      };
      description: string;
      maxItems: number;
    };
  };
  required: string[];
};

function getSchema(allowReflect: boolean, allowRead: boolean): ResponseSchema {
  let actions = ["search", "answer"];
  if (allowReflect) {
    actions.push("reflect");
  }
  if (allowRead) {
    actions.push("read");
  }
  return {
    type: SchemaType.OBJECT,
    properties: {
      action: {
        type: SchemaType.STRING,
        enum: actions,
        description: "Must match exactly one action type"
      },
      questionsToAnswer: allowReflect ? {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.STRING,
          description: "each question must be a single line, concise and clear. not composite or compound, less than 20 words.",
        },
        description: "Only required when choosing 'reflect' action, list of most important questions to answer to fill the knowledge gaps.",
        maxItems: 2
      } : undefined,
      searchQuery: {
        type: SchemaType.STRING,
        description: "Only required when choosing 'search' action, must be a short, keyword-based query that BM25, tf-idf based search engines can understand.",
      },
      URLTargets: allowRead ? {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.STRING
        },
        description: "Only required when choosing 'deep dive' action, must be an array of URLs"
      } : undefined,
      answer: {
        type: SchemaType.STRING,
        description: "Only required when choosing 'answer' action, must be the final answer in natural language"
      },
      references: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            title: {
              type: SchemaType.STRING,
              description: "Title of the document; must be directly from the context",
            },
            url: {
              type: SchemaType.STRING,
              description: "URL of the document; must be directly from the context"
            }
          },
          required: ["title", "url"]
        },
        description: "Only required when choosing 'answer' action, must be an array of references"
      },
      reasoning: {
        type: SchemaType.STRING,
        description: "Explain why choose this action?"
      },
    },
    required: ["action", "reasoning"],
  };
}

function getPrompt(question: string, context?: any[], allQuestions?: string[], allowReflect: boolean = false, badContext?: any[], knowledge?: any[], allURLs?: Record<string, string>) {
  // console.log('Context:', context);
  // console.log('All URLs:', JSON.stringify(allURLs, null, 2));

  const knowledgeIntro = knowledge?.length ?
    `
## Knowledge
You have successfully gathered some knowledge from the following questions:

${JSON.stringify(knowledge, null, 2)}

`
    : '';

  const badContextIntro = badContext?.length ?
    `
## Unsuccessful Answer Analysis
Your last unsuccessful answer are:

${JSON.stringify(badContext, null, 2)}
    
Learn to avoid these mistakes and think of a new approach, from a different angle, e.g. search for different keywords, read different URLs, or ask different questions.
    `
    : '';

  const contextIntro = context?.length ?
    `
## Context
You have conducted the following actions:

${JSON.stringify(context, null, 2)}

`
    : '';

  let actionsDescription = `
## Actions

When uncertain or needing additional information, select one of these actions:

${allURLs ? `
**read**:
- Access any URLs from below to gather external knowledge

${JSON.stringify(allURLs, null, 2)}

- When you have enough search result in the context and want to deep dive into specific URLs
- It allows you access the full content behind any URLs
` : ''}

**search**:
- Query external sources using a public search engine
- Focus on solving one specific aspect of the question
- Only give keywords search query, not full sentences

**answer**:
- Provide final response only when 100% certain
- Responses must be definitive (no ambiguity, uncertainty, or disclaimers)
${allowReflect ? `- If doubts remain, use "reflect" instead` : ''}`;

  if (allowReflect) {
    actionsDescription += `

**reflect**:
- Perform critical analysis through hypothetical scenarios or systematic breakdowns
- Identify knowledge gaps and formulate essential clarifying questions
- Questions must be:
  - Original (not variations of existing questions)
  - Focused on single concepts
  - Under 20 words
  - Non-compound/non-complex
`;
  }

  return `
You are an advanced AI research analyst specializing in multi-step reasoning. Using your training data and prior lessons learned, answer the following question with absolute certainty:

## Question
${question}

${contextIntro.trim()}

${knowledgeIntro.trim()}

${badContextIntro.trim()}

${actionsDescription.trim()}

Respond exclusively in valid JSON format matching exact JSON schema.

Critical Requirements:
- Include ONLY ONE action type
- Never add unsupported keys
- Exclude all non-JSON text, markdown, or explanations
- Maintain strict JSON syntax`.trim();
}

async function getResponse(question: string, tokenBudget: number = 30000000) {
  let totalTokens = 0;
  let context = [];
  let step = 0;
  let gaps: string[] = [question];  // All questions to be answered including the orginal question
  let allQuestions = [question];
  let allKeywords = [];
  let allKnowledge = [];  // knowledge are intermedidate questions that are answered
  let badContext = [];
  let allURLs: Record<string, string> = {};
  while (totalTokens < tokenBudget) {
    // add 1s delay to avoid rate limiting
    await sleep(1000);
    step++;
    console.log('===STEPS===', step)
    console.log('Gaps:', gaps)
    const allowReflect = gaps.length <= 1;
    const currentQuestion = gaps.length > 0 ? gaps.shift()! : question;
    // update all urls with buildURLMap
    allURLs = {...allURLs, ...buildURLMap(context)};
    const allowRead = Object.keys(allURLs).length > 0;
    const prompt = getPrompt(
      currentQuestion,
      context,
      allQuestions,
      allowReflect,
      badContext,
      allKnowledge,
      allURLs);
    console.log('Prompt len:', prompt.length)

    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
        responseSchema: getSchema(allowReflect, allowRead)
      }
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const usage = response.usageMetadata;

    totalTokens += usage?.totalTokenCount || 0;
    console.log(`Tokens: ${totalTokens}/${tokenBudget}`);

    const action = JSON.parse(response.text());
    console.log('Question-Action:', currentQuestion, action);

    if (action.action === 'answer') {
      context.push({
        step,
        question: currentQuestion,
        ...action,
      });
      const evaluation = await evaluateAnswer(currentQuestion, action.answer);

      if (currentQuestion === question) {
        if (evaluation.is_valid_answer) {
          return action;
        } else {
          badContext.push({
            question: currentQuestion,
            answer: action.answer,
            "Why this is a bad answer?": evaluation.reasoning
          });
          context = [];
        }
      } else if (evaluation.is_valid_answer) {
        allKnowledge.push({question: currentQuestion, answer: action.answer});
      }
    }

    if (action.action === 'reflect' && action.questionsToAnswer) {
      let newGapQuestions = action.questionsToAnswer
      if (allQuestions.length) {
        newGapQuestions = await dedupQueries(newGapQuestions, allQuestions)
      }
      if (newGapQuestions.length > 0) {
        gaps.push(...newGapQuestions);
        allQuestions.push(...newGapQuestions);
        gaps.push(question);  // always keep the original question in the gaps
      } else {
        console.log('No new questions to ask');
        context.push({
          step,
          ...action,
          result: 'I have tried all possible questions and found no useful information. I must think out of the box or different angle!!!'
        });
      }
    }

    // Rest of the action handling remains the same
    try {
      if (action.action === 'search' && action.searchQuery) {
        // rewrite queries
        let keywordsQueries = await rewriteQuery(action.searchQuery);
        // avoid exisitng searched queries
        if (allKeywords.length) {
          keywordsQueries = await dedupQueries(keywordsQueries, allKeywords)
        }
        if (keywordsQueries.length > 0) {
          const searchResults = [];
          for (const query of keywordsQueries) {
            console.log('Searching:', query);
            const results = await search(query, {
              safeSearch: SafeSearchType.STRICT
            });
            const minResults = results.results.map(r => ({
              title: r.title,
              url: r.url,
              description: r.description,
            }));
            searchResults.push({query, results: minResults});
            allKeywords.push(query);
            await sleep(5000);
          }

          context.push({
            step,
            question: currentQuestion,
            ...action,
            result: searchResults
          });
        } else {
          console.log('No new queries to search');
          context.push({
            step,
            ...action,
            result: 'I have tried all possible queries and found no new information. I must think out of the box or different angle!!!'
          });
        }
      } else if (action.action === 'read' && action.URLTargets?.length) {
        const urlResults = await Promise.all(
          action.URLTargets.map(async (url: string) => {
            const response = await readUrl(url, jinaToken);
            return {url, result: response};
          })
        );
        context.push({
          step,
          question: currentQuestion,
          ...action,
          result: urlResults
        });
        totalTokens += urlResults.reduce((sum, r) => sum + r.result.data.usage.tokens, 0);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    }
    await storeContext(prompt, [context, allKeywords, allQuestions, allKnowledge], step);
  }
}

async function storeContext(prompt: string, memory: any[][], step: number) {
  try {
    await fs.writeFile(`prompt-${step}.txt`, prompt);
    const [context, keywords, questions, knowledge] = memory;
    await fs.writeFile('context.json', JSON.stringify(context, null, 2));
    await fs.writeFile('keywords.json', JSON.stringify(keywords, null, 2));
    await fs.writeFile('questions.json', JSON.stringify(questions, null, 2));
    await fs.writeFile('knowledge.json', JSON.stringify(knowledge, null, 2));
  } catch (error) {
    console.error('Failed to store context:', error);
  }
}

const apiKey = process.env.GEMINI_API_KEY as string;
const jinaToken = process.env.JINA_API_KEY as string;
if (!apiKey) throw new Error("GEMINI_API_KEY not found");
if (!jinaToken) throw new Error("JINA_API_KEY not found");

const modelName = 'gemini-1.5-flash';
const genAI = new GoogleGenerativeAI(apiKey);

const question = process.argv[2] || "";
getResponse(question);