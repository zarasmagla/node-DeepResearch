import { z } from 'zod';
import { generateObject } from 'ai';
import { getModel, getMaxTokens } from "../config";
import { TokenTracker } from "../utils/token-tracker";
import { EvaluationResponse } from '../types';
import { handleGenerateObjectError } from '../utils/error-handling';

const model = getModel('evaluator');

const responseSchema = z.object({
  is_definitive: z.boolean().describe('Whether the answer provides a definitive response without uncertainty or negative statements'),
  reasoning: z.string().describe('Explanation of why the answer is or isn\'t definitive')
});

function getPrompt(question: string, answer: string): string {
  return `You are an evaluator of answer definitiveness. Analyze if the given answer provides a definitive response or not.

<rules>
First, if the answer is not a direct response to the question, it must return false. 
Definitiveness is the king! The following types of responses are NOT definitive and must return false:
  1. Expressions of uncertainty: "I don't know", "not sure", "might be", "probably"
  2. Lack of information statements: "doesn't exist", "lack of information", "could not find"
  3. Inability statements: "I cannot provide", "I am unable to", "we cannot"
  4. Negative statements that redirect: "However, you can...", "Instead, try..."
  5. Non-answers that suggest alternatives
</rules>


<examples>
Question: "What are the system requirements for running Python 3.9?"
Answer: "I'm not entirely sure, but I think you need a computer with some RAM."
Evaluation: {
  "is_definitive": false,
  "reasoning": "The answer contains uncertainty markers like 'not entirely sure' and 'I think', making it non-definitive."
}

Question: "What are the system requirements for running Python 3.9?"
Answer: "Python 3.9 requires Windows 7 or later, macOS 10.11 or later, or Linux."
Evaluation: {
  "is_definitive": true,
  "reasoning": "The answer makes clear, definitive statements without uncertainty markers or ambiguity."
}

Question: "Who will be the president of the United States in 2032?"
Answer: "I cannot predict the future, it depends on the election results."
Evaluation: {
  "is_definitive": false,
  "reasoning": "The answer contains a statement of inability to predict the future, making it non-definitive."
}

Question: "Who is the sales director at Company X?"
Answer: "I cannot provide the name of the sales director, but you can contact their sales team at sales@companyx.com"
Evaluation: {
  "is_definitive": false,
  "reasoning": "The answer starts with 'I cannot provide' and redirects to an alternative contact method instead of answering the original question."
}

Question: "what is the twitter account of jina ai's founder?"
Answer: "The provided text does not contain the Twitter account of Jina AI's founder."
Evaluation: {
  "is_definitive": false,
  "reasoning": "The answer indicates a lack of information rather than providing a definitive response."
}
</examples>
Now evaluate this pair:
Question: ${JSON.stringify(question)}
Answer: ${JSON.stringify(answer)}`;
}

export async function evaluateAnswer(question: string, answer: string, tracker?: TokenTracker): Promise<{ response: EvaluationResponse, tokens: number }> {
  try {
    const prompt = getPrompt(question, answer);
    let object;
    let totalTokens = 0;
    try {
      const result = await generateObject({
        model,
        schema: responseSchema,
        prompt,
        maxTokens: getMaxTokens('evaluator')
      });
      object = result.object;
      totalTokens = result.usage?.totalTokens || 0;
    } catch (error) {
      const result = await handleGenerateObjectError<EvaluationResponse>(error);
      object = result.object;
      totalTokens = result.totalTokens;
    }
    console.log('Evaluation:', {
      definitive: object.is_definitive,
      reason: object.reasoning
    });
    (tracker || new TokenTracker()).trackUsage('evaluator', totalTokens);
    return { response: object, tokens: totalTokens };
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

  try {
    await evaluateAnswer(question, answer);
  } catch (error) {
    console.error('Failed to evaluate answer:', error);
  }
}

if (require.main === module) {
  main().catch(console.error);
}