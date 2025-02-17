import { z } from 'zod';
import { TokenTracker } from "../utils/token-tracker";
import { ObjectGeneratorSafe } from "../utils/safe-generator";

// Define the response schema for code generation
const codeGenerationSchema = z.object({
  code: z.string().describe('The JavaScript code that solves the problem and always use \'return\' statement to return the result. Focus on solving the core problem; No need for error handling or try-catch blocks.'),
});

// Define the types
interface CodeGenerationResponse {
  code: string;
}

interface SandboxResult {
  success: boolean;
  output?: any;
  error?: string;
}

interface AvailableVariable {
  name: string;
  type: string;
  sample?: string;
}

function getPrompt(
  problem: string,
  availableVars: AvailableVariable[],
  previousAttempts: Array<{ code: string; error?: string }> = []
): string {
  const previousAttemptsContext = previousAttempts.map((attempt, index) => `
Attempt ${index + 1}:
${attempt.code}
${attempt.error ? `Error: ${attempt.error}` : ''}
`).join('\n');

  const varsContext = availableVars.map(v =>
    `${v.name} (${v.type})${v.sample ? ` e.g. ${v.sample}` : ''}`
  ).join('\n');

  return `You are an expert JavaScript programmer. Your task is to generate JavaScript code to solve the given problem.

<rules>
1. Generate plain JavaScript code that returns the result directly
2. You can use any of these available variables directly:
${varsContext}
3. No need to declare variables that are already available, especially big long strings or arrays; try to always start with using "allContext" object
4. Focus on solving the core problem; No need for error handling or try-catch blocks; Always use 'return' statement to return the result
</rules>

${previousAttempts.length > 0 ? `Previous attempts and their errors:
${previousAttemptsContext}
` : ''}

<example>
Available variables:
numbers (Array<number>) e.g. [1, 2, 3, 4, 5, 6]
threshold (number) e.g. 4

Problem: Sum all numbers above threshold

Response:
{
  "code": "return numbers.filter(n => n > threshold).reduce((a, b) => a + b, 0);"
}
</example>

Problem to solve:
${problem}`;
}

export class CodeSandbox {
  private tracker?: TokenTracker;
  private generator: ObjectGeneratorSafe;
  private maxAttempts: number;
  private availableVars: AvailableVariable[];
  private context: Record<string, any>;

  constructor(
    context: Record<string, any> = {},
    tracker?: TokenTracker,
    maxAttempts: number = 3
  ) {
    this.tracker = tracker;
    this.generator = new ObjectGeneratorSafe(tracker);
    this.maxAttempts = maxAttempts;
    this.context = context;
    this.availableVars = this.collectVariables(context);
  }

  private collectVariables(context: Record<string, any>): AvailableVariable[] {
    const vars: AvailableVariable[] = [];

    // Collect from provided context
    for (const [name, value] of Object.entries(context)) {
      vars.push(this.createVariableInfo(name, value));
    }

    // Collect from global scope (window in browser, global in Node)
    const globalObj = typeof window !== 'undefined' ? window : global;
    for (const key of Object.keys(globalObj)) {
      if (key === 'window' || key === 'global' || key === 'globalThis') continue;
      const value = (globalObj as any)[key];
      if (typeof value === 'function') continue; // Skip functions
      if (!vars.some(v => v.name === key)) { // Avoid duplicates
        vars.push(this.createVariableInfo(key, value));
      }
    }

    return vars;
  }

  private createVariableInfo(name: string, value: any): AvailableVariable {
    const type = Array.isArray(value)
      ? `Array<${typeof value[0]}>`
      : typeof value;

    let sample: string | undefined;
    try {
      if (Array.isArray(value)) {
        sample = JSON.stringify(value.slice(0, 3));
        if (value.length > 3) sample = sample.replace(']', ', ...]');
      } else if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value).slice(0, 2);
        sample = JSON.stringify(Object.fromEntries(entries));
        if (Object.keys(value).length > 2) sample = sample.replace('}', ', ...}');
      } else if (value !== undefined && value !== null) {
        sample = JSON.stringify(value);
      }
    } catch (e) {
      // If we can't stringify the value, skip the sample
    }

    return { name, type, sample };
  }

  private async generateCode(
    problem: string,
    previousAttempts: Array<{ code: string; error?: string }> = []
  ): Promise<CodeGenerationResponse> {
    const prompt = getPrompt(problem, this.availableVars, previousAttempts);

    const result = await this.generator.generateObject({
      model: 'coder',
      schema: codeGenerationSchema,
      prompt,
    });

    return result.object;
  }

  private evaluateCode(code: string): SandboxResult {
    try {
      // Create a function that uses 'with' to evaluate in the context and return the result
      const evalInContext = new Function('context', `
        with (context) {
          ${code}
        }
      `);

      console.log('Context:', this.context);

      // Execute the code with the context and get the return value
      const output = evalInContext(this.context);

      if (output === undefined) {
        return {
          success: false,
          error: 'No value was returned'
        };
      }

      return {
        success: true,
        output
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  async solve(problem: string): Promise<{
    solution: { code: string; output: any };
    attempts: Array<{ code: string; error?: string }>;
  }> {
    const attempts: Array<{ code: string; error?: string }> = [];

    for (let i = 0; i < this.maxAttempts; i++) {
      // Generate code
      const generation = await this.generateCode(problem, attempts);
      const { code } = generation;

      console.log(`Coding attempt ${i + 1}:`, code);
      // Evaluate the code
      const result = this.evaluateCode(code);

      if (result.success) {
        return {
          solution: {
            code,
            output: result.output
          },
          attempts
        };
      }

      console.error('Coding error:', result.error);

      // Store the failed attempt
      attempts.push({
        code,
        error: result.error
      });

      // If we've reached max attempts, throw an error
      if (i === this.maxAttempts - 1) {
        throw new Error(`Failed to generate working code after ${this.maxAttempts} attempts`);
      }
    }

    // This should never be reached due to the throw above
    throw new Error('Unexpected end of execution');
  }
}