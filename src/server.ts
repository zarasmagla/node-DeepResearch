import express, { Request, Response, RequestHandler } from 'express';
import cors from 'cors';
import { EventEmitter } from 'events';
import { getResponse } from './agent';
import {StepAction, StreamMessage} from './types';
import { TrackerContext } from './types/tracker';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const eventEmitter = new EventEmitter();

interface QueryRequest extends Request {
  body: {
    q: string;
    budget?: number;
    maxBadAttempt?: number;
  };
}

interface StreamResponse extends Response {
  write: (chunk: string) => boolean;
}

async function checkRequestExists(requestId: string): Promise<boolean> {
  try {
    const taskPath = path.join(process.cwd(), 'tasks', `${requestId}.json`);
    await fs.access(taskPath);
    return true;
  } catch {
    return false;
  }
}

// SSE endpoint with request validation
app.get('/api/v1/stream/:requestId', (async (req: Request, res: StreamResponse) => {
  const requestId = req.params.requestId;

  // Check if request exists before setting up SSE
  const exists = await checkRequestExists(requestId);
  if (!exists) {
    res.status(404).json({ error: 'Request ID not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const listener = (data: StreamMessage) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  eventEmitter.on(`progress-${requestId}`, listener);

  // Handle client disconnection
  req.on('close', () => {
    eventEmitter.removeListener(`progress-${requestId}`, listener);
  });

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', requestId })}\n\n`);
}) as RequestHandler);

function createProgressEmitter(requestId: string, budget: number | undefined, context: TrackerContext) {
  return () => {
    const state = context.actionTracker.getState();
    const budgetInfo = {
      used: context.tokenTracker.getTotalUsage(),
      total: budget || 1_000_000,
      percentage: ((context.tokenTracker.getTotalUsage() / (budget || 1_000_000)) * 100).toFixed(2)
    };

    eventEmitter.emit(`progress-${requestId}`, {
      type: 'progress',
      data: { ...state.thisStep, totalStep: state.totalStep },
      step: state.totalStep,
      budget: budgetInfo
    });
  };
}

app.post('/api/v1/query', (async (req: QueryRequest, res: Response) => {
  const { q, budget, maxBadAttempt } = req.body;
  if (!q) {
    return res.status(400).json({ error: 'Query (q) is required' });
  }

  const requestId = Date.now().toString();
  res.json({ requestId });

  try {
    const { result, context } = await getResponse(q, budget, maxBadAttempt);
    const emitProgress = createProgressEmitter(requestId, budget, context);
    context.actionTracker.on('action', emitProgress);
    await storeTaskResult(requestId, result);
    eventEmitter.emit(`progress-${requestId}`, { type: 'answer', data: result });
  } catch (error: any) {
    eventEmitter.emit(`progress-${requestId}`, {
      type: 'error',
      data: error?.message || 'Unknown error',
      status: 500
    });
  }
}) as RequestHandler);

async function storeTaskResult(requestId: string, result: StepAction) {
  try {
    const taskDir = path.join(process.cwd(), 'tasks');
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(
      path.join(taskDir, `${requestId}.json`),
      JSON.stringify(result, null, 2)
    );
  } catch (error) {
    console.error('Task storage failed:', error);
    throw new Error('Failed to store task result');
  }
}

app.get('/api/v1/task/:requestId', (async (req: Request, res: Response) => {
  const requestId = req.params.requestId;
  try {
    const taskPath = path.join(process.cwd(), 'tasks', `${requestId}.json`);
    const taskData = await fs.readFile(taskPath, 'utf-8');
    res.json(JSON.parse(taskData));
  } catch (error) {
    res.status(404).json({ error: 'Task not found' });
  }
}) as RequestHandler);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export default app;