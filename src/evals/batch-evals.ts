import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getResponse } from '../agent';
import { generateObject } from 'ai';
import { getModel, getMaxTokens } from '../config';
import { z } from 'zod';
import {AnswerAction, TrackerContext} from "../types";

const execAsync = promisify(exec);

interface Question {
  question: string;
  answer: string;
}

interface EvaluationResult {
  pass: boolean;
  reason: string;
  total_steps: number;
  total_tokens: number;
  question: string;
  expected_answer: string;
  actual_answer: string;
}

async function getCurrentGitCommit(): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --short HEAD');
    return stdout.trim();
  } catch (error) {
    console.error('Error getting git commit:', error);
    return 'unknown';
  }
}

async function evaluateAnswer(expectedAnswer: string, actualAnswer: string): Promise<{ pass: boolean; reason: string }> {
  const prompt = `You are a deterministic evaluator with zero temperature. Compare the following expected answer with the actual answer and determine if they convey the same information.

Expected answer: ${expectedAnswer}
Actual answer: ${actualAnswer}

Minor wording differences are acceptable as long as the core information of the expected answer is preserved in the actual answer.'`;

  const schema = z.object({
    pass: z.boolean().describe('Whether the actual answer matches the expected answer'),
    reason: z.string().describe('Detailed explanation of why the evaluation passed or failed')
  });

  try {
    const result = await generateObject({
      model: getModel('evaluator'),
      schema,
      prompt,
      maxTokens: getMaxTokens('evaluator'),
      temperature: 0  // Setting temperature to 0 for deterministic output
    });

    return result.object;
  } catch (error) {
    console.error('Evaluation failed:', error);
    return {
      pass: false,
      reason: `Evaluation error: ${error}`
    };
  }
}

async function batchEvaluate(inputFile: string): Promise<void> {
  // Read and parse input file
  const questions: Question[] = JSON.parse(await fs.readFile(inputFile, 'utf-8'));
  const results: EvaluationResult[] = [];

  // Process each question
  for (let i = 0; i < questions.length; i++) {
    const { question, answer: expectedAnswer } = questions[i];
    console.log(`\nProcessing question ${i + 1}/${questions.length}: ${question}`);

    try {
      // Get response using the agent
      const { result: response, context } = await getResponse(question) as { result: AnswerAction; context: TrackerContext };
      const actualAnswer = response.answer;

      // Evaluate the response
      const evaluation = await evaluateAnswer(expectedAnswer, actualAnswer);

      // Record results
      results.push({
        pass: evaluation.pass,
        reason: evaluation.reason,
        total_steps: context.actionTracker.getState().totalStep,
        total_tokens: context.tokenTracker.getTotalUsage(),
        question,
        expected_answer: expectedAnswer,
        actual_answer: actualAnswer
      });

      console.log(`Evaluation: ${evaluation.pass ? 'PASS' : 'FAIL'}`);
      console.log(`Reason: ${evaluation.reason}`);
    } catch (error) {
      console.error(`Error processing question: ${question}`, error);
      results.push({
        pass: false,
        reason: `Error: ${error}`,
        total_steps: 0,
        total_tokens: 0,
        question,
        expected_answer: expectedAnswer,
        actual_answer: 'Error occurred'
      });
    }
  }

  // Save results
  const gitCommit = await getCurrentGitCommit();
  const outputFile = `eval-${gitCommit}.json`;
  await fs.writeFile(outputFile, JSON.stringify(results, null, 2));
  console.log(`\nEvaluation results saved to ${outputFile}`);
}

// Run batch evaluation if this is the main module
if (require.main === module) {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Please provide an input file path');
    process.exit(1);
  }

  batchEvaluate(inputFile).catch(console.error);
}

export { batchEvaluate };