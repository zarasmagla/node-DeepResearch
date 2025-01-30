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

type EvaluationResponse = {
  is_valid_answer: boolean;
  reasoning: string;
};

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    is_valid_answer: {
      type: SchemaType.BOOLEAN,
      description: "Whether the answer provides any useful information to the question"
    },
    reasoning: {
      type: SchemaType.STRING,
      description: "Detailed explanation of the evaluation"
    }
  },
  required: ["is_valid_answer", "reasoning"]
};

const modelName = 'gemini-1.5-flash';

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: modelName,
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: responseSchema
  }
});

function getPrompt(question: string, answer: string): string {
  return `You are an expert evaluator of question-answer pairs. Analyze if the given answer based on the following criteria is valid or not.

Core Evaluation Criteria:
- Definitiveness: "I don't know", "lack of information", "doesn't exist" or highly uncertain responses are **not** valid answers, return false!
- Informativeness: Answer must provide substantial, useful information
- Completeness: Answer must directly address the main point of the question
- Clarity: Answer should be clear and unambiguous
- Specificity: Generic or vague responses are not acceptable
- Relevance: Answer must be directly related to the question topic


Examples:

Question: "What are the system requirements for running Python 3.9?"
Answer: "I'm not entirely sure, but I think you need a computer with some RAM."
Evaluation: {
  "is_valid_answer": false,
  "reasoning": "The answer is vague, uncertain, and lacks specific information about actual system requirements. It fails the specificity and informativeness criteria."
}

Question: "What are the system requirements for running Python 3.9?"
Answer: "Python 3.9 requires: Windows 7 or later, macOS 10.11 or later, or Linux. Minimum 4GB RAM recommended, 2GB disk space, and x86-64 processor. For Windows, you'll need Microsoft Visual C++ 2015 or later."
Evaluation: {
  "is_valid_answer": true,
  "reasoning": "The answer is comprehensive, specific, and covers all key system requirements across different operating systems. It provides concrete numbers and necessary additional components."
}

Question: "what is the twitter account of jina ai's founder?"
Answer: "The provided text does not contain the Twitter account of Jina AI's founder."
Evaluation: {
  "is_valid_answer": false,
  "reasoning": "The answer is not definitive and fails to provide the requested information. Don't know, can't derive, lack of information is unacceptable,"
}

Question: "who owns jina ai?"
Answer: "The ownership structure of Jina AI is not publicly disclosed."
Evaluation: {
  "is_valid_answer": false,
  "reasoning": "The answer is not definitive and fails to provide the requested information. Lack of information is unacceptable, more search and deep reasoning is needed."
}

Now evaluate this pair:
Question: ${JSON.stringify(question)}
Answer: ${JSON.stringify(answer)}`;
}

export async function evaluateAnswer(question: string, answer: string): Promise<EvaluationResponse> {
  try {
    const prompt = getPrompt(question, answer);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const json = JSON.parse(response.text()) as EvaluationResponse;
    console.log('Evaluation:', json);
    return json;
  } catch (error) {
    console.error('Error in answer evaluation:', error);
    throw error;
  }
}

// Example usage
async function main() {
  const question = process.argv[2] || '';
  const answer = process.argv[3] || '';

  if (!question || !answer) {
    console.error('Please provide both question and answer as command line arguments');
    process.exit(1);
  }

  console.log('\nQuestion:', question);
  console.log('Answer:', answer);

  try {
    const evaluation = await evaluateAnswer(question, answer);
    console.log('\nEvaluation Result:', evaluation);
  } catch (error) {
    console.error('Failed to evaluate answer:', error);
  }
}

if (require.main === module) {
  main().catch(console.error);
}