import {GoogleGenerativeAI, SchemaType} from "@google/generative-ai";
import dotenv from 'dotenv';
import {ProxyAgent, setGlobalDispatcher} from "undici";
import {readUrl} from "./tools/read";
import {search} from "./tools/search";
// 获取代理URL并设置代理
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

const schema = {
  type: SchemaType.OBJECT,
  properties: {
    action: {
      type: SchemaType.STRING,
      enum: ["search", "readURL", "rewrite", "answer", "reflect"],
      description: "Must match exactly one action type"
    },
    questionsToAnswer: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.STRING
      },
      description: "Only required when choosing 'reflect' action, must be a list of of important questions that need to be answered first",
      maxItems: 2
    },
    searchKeywords: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.STRING
      },
      description: "Only required when choosing 'search' action, must be an array of keywords",
      maxItems: 3
    },
    URLTargets: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.STRING
      },
      description: "Only required when choosing 'readURL' action, must be an array of URLs"
    },
    rewriteQuery: {
      type: SchemaType.STRING,
      description: "Only required when choosing 'rewrite' action, must be a new query that might lead to better or more relevant information",
    },
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
            description: "Title of the document; must be directly from the context"
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
    confidence: {
      type: SchemaType.NUMBER,
      minimum: 0.0,
      maximum: 1.0,
      description: "Represents the confidence level of in answering the question BEFORE taking the action. Must be a float between 0.0 and 1.0",
    }
  },
  required: ["action", "reasoning", "confidence"],
};

const apiKey = process.env.GEMINI_API_KEY as string;
const jinaToken = process.env.JINA_API_KEY as string;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY  not found");
}
if (!jinaToken) {
  throw new Error("JINA_API_KEY not found");
}

const modelName = 'gemini-1.5-flash';
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: modelName,
  generationConfig: {
    temperature: 0.7,
    responseMimeType: "application/json",
    responseSchema: schema
  }
});

function getPrompt(question: string, context?: string) {
  let contextIntro = ``;
  if (!!context) {
    contextIntro = `You have the following context:
    ${context}
     `;
  }

  return `You are an AI research analyst capable of multi-step reasoning.

${contextIntro}

Based on the context and the knowledge in your training data, you must answer the following question with 100% confidence:

${question}

If you are not 100% confident in your answer, you should first take a reflection to identify the gaps in your knowledge:

**reflect**:
- Challenge existing knowledge with what-if thinking.
- Fill in the gaps with divide-and-conquer type of questions.
- Reflect on the gaps in your knowledge and ask for more questions to fill those gaps.
- You use this action when you feel like you need to first answer those questions before proceeding with the current one.
- This action has higher priority than all other actions.
- Should not similar to the original question or existing questionsToAnswer in the context.

If you are still not confident after reflecting, you can take one of the following actions:

**search**:
- Search external real-world information via a public search engine.
- The search engine works best with short, keyword-based queries.
- You use this action when you need more world knowledge or up to date information that is not covered in your training data or cut-off knowledge base.

**readURL**:
- Provide a specific URL to fetch and read its content in detail.
- Any URL must come from the current context.
- You use this action when you feel like that particular URL might have the information you need to answer the question.

**rewrite**:
- Propose a new or modified query (in a different phrasing, more details, or from another angle) that might lead to better or more relevant information.
- This rewritten query can help the search engine find more accurate results, thereby improving your confidence in answering the original question.
- You use this action when you think the current query is too vague, broad, or ambiguous; or the search engine results are not satisfactory.

**answer**:
- Provide your answer to the user, **only** if you are completely sure.

When you decide on your action, respond **only** in valid JSON format according to the schema below.

**Important**:
- Do not include any extra keys.
- Do not include explanatory text, markdown formatting, or reasoning in the final output.
- Output exactly one JSON object in your response.
   `;

}


async function getResponse(question: string) {
  let tokenBudget = 30000000;
  let totalTokens = 0;
  let context = '';  // global context to store all the actions records
  let step = 0;
  let gaps: string[] = [];
  while (totalTokens < tokenBudget) {
    const currentQuestion = gaps.length > 0 ? gaps.shift()! : question;
    const prompt = getPrompt(currentQuestion, context);
    console.log('Prompt length:', prompt.length);
    console.log('Context:', context.length);
    console.log('Gaps:', gaps.length);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const usage = response.usageMetadata;
    step++;

    totalTokens += usage?.totalTokenCount || 0;
    console.log(`Tokens: ${totalTokens}/${tokenBudget}`);

    const action = JSON.parse(response.text());
    console.log('Question-Action:', currentQuestion, action);

    if (action.action === 'answer') {
      if (currentQuestion === question) {
        return action;  // Exit only for original question's answer not the gap question
      } else {
        const contextRecord = JSON.stringify({
          step,
          ...action,
          question: currentQuestion
        });
        context = `${context}\n${contextRecord}`;
      }
    }

    if (action.action === 'reflect' && action.questionsToAnswer) {
      gaps.push(...action.questionsToAnswer);
      const contextRecord = JSON.stringify({
        step,
        ...action,
        question: currentQuestion
      });
      context = `${context}\n${contextRecord}`;
    }

    try {
      if (action.action === 'search' && action.searchKeywords) {
        const results = await search(action.searchKeywords.join(' '), jinaToken);
        const contextRecord = JSON.stringify({
          step,
          ...action,
          question: currentQuestion,
          result: results.data
        });
        context = `${context}\n${contextRecord}`;
        totalTokens += results.data.reduce((sum, r) => sum + r.usage.tokens, 0);
      } else if (action.action === 'readURL' && action.URLTargets?.length) {
        const urlResults = await Promise.all(
          action.URLTargets.map(async (url: string) => {
            const response = await readUrl(url, jinaToken);
            return {url, result: response};
          })
        );

        const contextRecord = JSON.stringify({
          step,
          ...action,
          question: currentQuestion,
          result: urlResults
        });
        context = `${context}\n${contextRecord}`;
        totalTokens += urlResults.reduce((sum, r) => sum + r.result.data.usage.tokens, 0);
      } else if (action.action === 'rewrite' && action.rewriteQuery) {
        // Immediately search with the new rewriteQuery
        const results = await search(action.rewriteQuery, jinaToken);
        const contextRecord = JSON.stringify({
          step,
          ...action,
          question: currentQuestion,
          result: results.data
        });
        context = `${context}\n${contextRecord}`;
        totalTokens += results.data.reduce((sum, r) => sum + r.usage.tokens, 0);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    }
  }
}


const question = process.argv[2] || "";
getResponse(question);
