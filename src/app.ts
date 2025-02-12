import express, {Request, Response, RequestHandler} from 'express';
import cors from 'cors';
import {getResponse} from './agent';
import {
  TrackerContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  AnswerAction,
  Model
} from './types';
import {TokenTracker} from "./utils/token-tracker";
import {ActionTracker} from "./utils/action-tracker";

const app = express();

// Get secret from command line args for optional authentication
const secret = process.argv.find(arg => arg.startsWith('--secret='))?.split('=')[1];

app.use(cors());
app.use(express.json());

// Add health check endpoint for Docker container verification
app.get('/health', (req, res) => {
  res.json({status: 'ok'});
});

function buildMdFromAnswer(answer: AnswerAction) {
  let refStr = '';
  if (answer.references?.length > 0) {
    refStr = `
<references>
${answer.references.map((ref, i) => `
${i + 1}. [${ref.exactQuote}](${ref.url})`).join('')}
</references>
`.trim();
  }
  return `${answer.answer.replace(/\(REF_(\d+)\)/g, (_, num) => `[^${num}]`)}\n\n${refStr}`;
}


// Modified streamTextWordByWord function
async function* streamTextWordByWord(text: string, streamingState: StreamingState) {
  const words = text.split(/(\s+)/);
  for (const word of words) {
    if (streamingState.currentlyStreaming) {
      const delay = Math.floor(Math.random() * 100);
      await new Promise(resolve => setTimeout(resolve, delay));
      yield word;
    } else {
      // If streaming was interrupted, yield all remaining words at once
      const remainingWords = words.slice(words.indexOf(word)).join('');
      yield remainingWords;
      return;
    }
  }
}

// Helper function to emit remaining content immediately
async function emitRemainingContent(
  res: Response,
  requestId: string,
  created: number,
  model: string,
  content: string,
) {
  if (!content) return;

  const chunk: ChatCompletionChunk = {
    id: requestId,
    object: 'chat.completion.chunk',
    created,
    model: model,
    system_fingerprint: 'fp_' + requestId,
    choices: [{
      index: 0,
      delta: {content},
      logprobs: null,
      finish_reason: null
    }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

interface StreamingState {
  currentlyStreaming: boolean;
  currentGenerator: AsyncGenerator<string> | null;
  remainingContent: string;
  isEmitting: boolean;
  queue: { content: string; resolve: () => void }[];
  processingQueue: boolean;
}

function getTokenBudgetAndMaxAttempts(
  reasoningEffort: 'low' | 'medium' | 'high' | null = 'medium',
  maxCompletionTokens: number | null = null
): { tokenBudget: number, maxBadAttempts: number } {
  if (maxCompletionTokens !== null) {
    return {
      tokenBudget: maxCompletionTokens,
      maxBadAttempts: 3 // Default to medium setting for max attempts
    };
  }

  switch (reasoningEffort) {
    case 'low':
      return {tokenBudget: 100000, maxBadAttempts: 1};
    case 'high':
      return {tokenBudget: 1000000, maxBadAttempts: 3};
    case 'medium':
    default:
      return {tokenBudget: 500000, maxBadAttempts: 2};
  }
}


async function completeCurrentStreaming(
  streamingState: StreamingState,
  res: Response,
  requestId: string,
  created: number,
  model: string
) {
  if (streamingState.currentlyStreaming && streamingState.remainingContent) {
    // Force completion of current streaming
    await emitRemainingContent(
      res,
      requestId,
      created,
      model,
      streamingState.remainingContent
    );
    // Reset streaming state
    streamingState.currentlyStreaming = false;
    streamingState.remainingContent = '';
    streamingState.currentGenerator = null;
  }
}

// OpenAI-compatible chat completions endpoint
// Models API endpoints
app.get('/v1/models', (async (_req: Request, res: Response) => {
  const models: Model[] = [{
    id: 'jina-deepsearch-v1',
    object: 'model',
    created: 1686935002,
    owned_by: 'jina-ai'
  }];

  res.json({
    object: 'list',
    data: models
  });
}) as RequestHandler);

app.get('/v1/models/:model', (async (req: Request, res: Response) => {
  const modelId = req.params.model;

  if (modelId === 'jina-deepsearch-v1') {
    res.json({
      id: 'jina-deepsearch-v1',
      object: 'model',
      created: 1686935002,
      owned_by: 'jina-ai'
    });
  } else {
    res.status(404).json({
      error: {
        message: `Model '${modelId}' not found`,
        type: 'invalid_request_error',
        param: null,
        code: 'model_not_found'
      }
    });
  }
}) as RequestHandler);

if (secret) {
  // Check authentication only if secret is set
  app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== secret) {
      console.log('[chat/completions] Unauthorized request');
      res.status(401).json({error: 'Unauthorized'});
      return;
    }

    return next();
  });
}

async function processQueue(streamingState: StreamingState, res: Response, requestId: string, created: number, model: string) {
  if (streamingState.processingQueue) return;

  streamingState.processingQueue = true;

  while (streamingState.queue.length > 0) {
    const current = streamingState.queue[0];

    // Reset streaming state for new content
    streamingState.currentlyStreaming = true;
    streamingState.remainingContent = current.content;
    streamingState.isEmitting = true;

    try {
      for await (const word of streamTextWordByWord(current.content, streamingState)) {
        const chunk: ChatCompletionChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          system_fingerprint: 'fp_' + requestId,
          choices: [{
            index: 0,
            delta: {content: word},
            logprobs: null,
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        // Small delay between words
        await new Promise(resolve => setTimeout(resolve, 30));
      }

      // Add newline after content
      const newlineChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: '\n'},
          logprobs: null,
          finish_reason: null
        }]
      };
      res.write(`data: ${JSON.stringify(newlineChunk)}\n\n`);

    } catch (error) {
      console.error('Error in streaming:', error);
    } finally {
      // Reset state and remove from queue
      streamingState.isEmitting = false;
      streamingState.currentlyStreaming = false;
      streamingState.remainingContent = '';
      streamingState.queue.shift();
      current.resolve();

      // Small delay between queue items
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  streamingState.processingQueue = false;
}

app.post('/v1/chat/completions', (async (req: Request, res: Response) => {
  // Check authentication only if secret is set
  if (secret) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== secret) {
      console.log('[chat/completions] Unauthorized request');
      res.status(401).json({error: 'Unauthorized'});
      return;
    }
  }

  // Log request details (excluding sensitive data)
  console.log('[chat/completions] Request:', {
    model: req.body.model,
    stream: req.body.stream,
    messageCount: req.body.messages?.length,
    hasAuth: !!req.headers.authorization,
    requestId: Date.now().toString()
  });

  const body = req.body as ChatCompletionRequest;
  if (!body.messages?.length) {
    return res.status(400).json({error: 'Messages array is required and must not be empty'});
  }
  const lastMessage = body.messages[body.messages.length - 1];
  if (lastMessage.role !== 'user') {
    return res.status(400).json({error: 'Last message must be from user'});
  }

  const {tokenBudget, maxBadAttempts} = getTokenBudgetAndMaxAttempts(
    body.reasoning_effort,
    body.max_completion_tokens
  );

  const requestId = Date.now().toString();
  const created = Math.floor(Date.now() / 1000);
  const context: TrackerContext = {
    tokenTracker: new TokenTracker(),
    actionTracker: new ActionTracker()
  };

  // Add this inside the chat completions endpoint, before setting up the action listener
  const streamingState: StreamingState = {
    currentlyStreaming: false,
    currentGenerator: null,
    remainingContent: '',
    isEmitting: false,
    queue: [],
    processingQueue: false
  };

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');


    // Send initial chunk with opening think tag
    const initialChunk: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      system_fingerprint: 'fp_' + requestId,
      choices: [{
        index: 0,
        delta: {role: 'assistant', content: '<think>'},
        logprobs: null,
        finish_reason: null
      }]
    };
    res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

    // Set up progress listener with cleanup
    const actionListener = async (action: any) => {
      if (action.thisStep.think) {
        // Create a promise that resolves when this content is done streaming
        await new Promise<void>(resolve => {
          streamingState.queue.push({
            content: action.thisStep.think,
            resolve
          });

          // Start processing queue if not already processing
          processQueue(streamingState, res, requestId, created, body.model);
        });
      }
    };
    context.actionTracker.on('action', actionListener);

    // Make sure to update the cleanup code
    res.on('finish', () => {
      streamingState.currentlyStreaming = false;
      streamingState.currentGenerator = null;
      streamingState.remainingContent = '';
      context.actionTracker.removeListener('action', actionListener);
    });
  }

  try {
    const {result} = await getResponse(lastMessage.content as string, tokenBudget, maxBadAttempts, context, body.messages)

    const usage = context.tokenTracker.getTotalUsageSnakeCase();
    if (body.stream) {
      // Complete any ongoing streaming before sending final answer
      await completeCurrentStreaming(streamingState, res, requestId, created, body.model);

      // Send closing think tag
      const closeThinkChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: `</think>\n\n`},
          logprobs: null,
          finish_reason: null
        }]
      };
      res.write(`data: ${JSON.stringify(closeThinkChunk)}\n\n`);

      // Send final answer as separate chunk
      const answerChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: result.action === 'answer' ? buildMdFromAnswer(result) : result.think},
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage
      };
      res.write(`data: ${JSON.stringify(answerChunk)}\n\n`);
      res.end();
    } else {

      const response: ChatCompletionResponse = {
        id: requestId,
        object: 'chat.completion',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.action === 'answer' ? buildMdFromAnswer(result) : result.think
          },
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage
      };

      // Log final response (excluding full content for brevity)
      console.log('[chat/completions] Response:', {
        id: response.id,
        status: 200,
        contentLength: response.choices[0].message.content.length,
        usage: response.usage
      });

      res.json(response);
    }
  } catch (error: any) {
    // Log error details
    console.error('[chat/completions] Error:', {
      message: error?.message || 'An error occurred',
      stack: error?.stack,
      type: error?.constructor?.name,
      requestId
    });

    // Track error as rejected tokens with Vercel token counting
    const errorMessage = error?.message || 'An error occurred';

    // Clean up event listeners
    context.actionTracker.removeAllListeners('action');

    // Get token usage in OpenAI API format
    const usage = context.tokenTracker.getTotalUsageSnakeCase();

    if (body.stream && res.headersSent) {
      // For streaming responses that have already started, send error as a chunk
      // First send closing think tag if we're in the middle of thinking
      const closeThinkChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: '</think>'},
          logprobs: null,
          finish_reason: null
        }],
        usage
      };
      res.write(`data: ${JSON.stringify(closeThinkChunk)}\n\n`);


      const errorChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: errorMessage},
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.end();
    } else {
      // For non-streaming or not-yet-started responses, send error as JSON
      const response: ChatCompletionResponse = {
        id: requestId,
        object: 'chat.completion',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: `Error: ${errorMessage}`
          },
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage
      };
      res.json(response);
    }
  }
}) as RequestHandler);


export default app;
