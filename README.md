# DeepResearch

[Official UI](https://search.jina.ai/) | [UI Code](https://github.com/jina-ai/deepsearch-ui) | [Stable API](https://jina.ai/deepsearch) | [Blog](https://jina.ai/news/a-practical-guide-to-implementing-deepsearch-deepresearch)

Keep searching, reading webpages, reasoning until an answer is found (or the token budget is exceeded). Useful for deeply investigating a query.

> [!IMPORTANT]  
> Unlike OpenAI/Gemini/Perplexity's "Deep Research", we focus solely on **finding the right answers via our iterative process**. We don't optimize for long-form articles, that's a **completely different problem** – so if you need quick, concise answers from deep search, you're in the right place. If you're looking for AI-generated long reports like OpenAI/Gemini/Perplexity does, this isn't for you.

```mermaid
---
config:
  theme: mc
  look: handDrawn
---
flowchart LR
 subgraph Loop["until budget exceed"]
    direction LR
        Search["Search"]
        Read["Read"]
        Reason["Reason"]
  end
    Query(["Query"]) --> Loop
    Search --> Read
    Read --> Reason
    Reason --> Search
    Loop --> Answer(["Answer"])

```

## [Blog Post](https://jina.ai/news/a-practical-guide-to-implementing-deepsearch-deepresearch)

Whether you like this implementation or not, I highly recommend you to read DeepSearch/DeepResearch implementation guide I wrote, which gives you a gentle intro to this topic.

- [English Part I](https://jina.ai/news/a-practical-guide-to-implementing-deepsearch-deepresearch), [Part II](https://jina.ai/news/snippet-selection-and-url-ranking-in-deepsearch-deepresearch)
- [中文微信公众号 第一讲](https://mp.weixin.qq.com/s/-pPhHDi2nz8hp5R3Lm_mww), [第二讲](https://mp.weixin.qq.com/s/apnorBj4TZs3-Mo23xUReQ)
- [日本語: DeepSearch/DeepResearch 実装の実践ガイド](https://jina.ai/ja/news/a-practical-guide-to-implementing-deepsearch-deepresearch)

## Try it Yourself

We host an online deployment of this **exact** codebase, which allows you to do a vibe-check; or use it as daily productivity tools.

https://search.jina.ai

The official API is also available for you to use:

```
https://deepsearch.jina.ai/v1/chat/completions
```

Learn more about the API at https://jina.ai/deepsearch

## Install

```bash
git clone https://github.com/jina-ai/node-DeepResearch.git
cd node-DeepResearch
npm install
```

[安装部署视频教程 on Youtube](https://youtu.be/vrpraFiPUyA)

It is also available on npm but not recommended for now, as the code is still under active development.

## Usage

We use Gemini (latest `gemini-2.0-flash`) / OpenAI / [LocalLLM](#use-local-llm) for reasoning, [Jina Reader](https://jina.ai/reader) for searching and reading webpages, you can get a free API key with 1M tokens from jina.ai.

```bash
export GEMINI_API_KEY=...  # for gemini
# export OPENAI_API_KEY=... # for openai
# export LLM_PROVIDER=openai # for openai
export JINA_API_KEY=jina_...  # free jina api key, get from https://jina.ai/reader

npm run dev $QUERY
```

### Official Site

You can try it on [our official site](https://search.jina.ai).

### Official API

You can also use [our official DeepSearch API](https://jina.ai/deepsearch):

```
https://deepsearch.jina.ai/v1/chat/completions
```

You can use it with any OpenAI-compatible client.

For the authentication Bearer, API key, rate limit, get from https://jina.ai/deepsearch.

#### Client integration guidelines

If you are building a web/local/mobile client that uses `Jina DeepSearch API`, here are some design guidelines:

- Our API is fully compatible with [OpenAI API schema](https://platform.openai.com/docs/api-reference/chat/create), this should greatly simplify the integration process. The model name is `jina-deepsearch-v1`.
- Our DeepSearch API is a reasoning+search grounding LLM, so it's best for questions that require deep reasoning and search.
- Two special tokens are introduced `<think>...</think>`. Please render them with care.
- Citations are often provided, and in [Github-flavored markdown footnote format](https://github.blog/changelog/2021-09-30-footnotes-now-supported-in-markdown-fields/), e.g. `[^1]`, `[^2]`, ...
- Guide the user to get a Jina API key from https://jina.ai, with 1M free tokens for new API key.
- There are rate limits, [between 10RPM to 30RPM depending on the API key tier](https://jina.ai/contact-sales#rate-limit).
- [Download Jina AI logo here](https://jina.ai/logo-Jina-1024.zip)

## Demo

> was recorded with `gemini-1.5-flash`, the latest `gemini-2.0-flash` leads to much better results!

Query: `"what is the latest blog post's title from jina ai?"`
3 steps; answer is correct!
![demo1](.github/visuals/demo.gif)

Query: `"what is the context length of readerlm-v2?"`
2 steps; answer is correct!
![demo1](.github/visuals/demo3.gif)

Query: `"list all employees from jina ai that u can find, as many as possible"`
11 steps; partially correct! but im not in the list :(
![demo1](.github/visuals/demo2.gif)

Query: `"who will be the biggest competitor of Jina AI"`
42 steps; future prediction kind, so it's arguably correct! atm Im not seeing `weaviate` as a competitor, but im open for the future "i told you so" moment.
![demo1](.github/visuals/demo4.gif)

More examples:

```
# example: no tool calling
npm run dev "1+1="
npm run dev "what is the capital of France?"

# example: 2-step
npm run dev "what is the latest news from Jina AI?"

# example: 3-step
npm run dev "what is the twitter account of jina ai's founder"

# example: 13-step, ambiguious question (no def of "big")
npm run dev "who is bigger? cohere, jina ai, voyage?"

# example: open question, research-like, long chain of thoughts
npm run dev "who will be president of US in 2028?"
npm run dev "what should be jina ai strategy for 2025?"
```

## Use Local LLM

> Note, not every LLM works with our reasoning flow, we need those who support structured output (sometimes called JSON Schema output, object output) well. Feel free to purpose a PR to add more open-source LLMs to the working list.

If you use Ollama or LMStudio, you can redirect the reasoning request to your local LLM by setting the following environment variables:

```bash
export LLM_PROVIDER=openai  # yes, that's right - for local llm we still use openai client
export OPENAI_BASE_URL=http://127.0.0.1:1234/v1  # your local llm endpoint
export OPENAI_API_KEY=whatever  # random string would do, as we don't use it (unless your local LLM has authentication)
export DEFAULT_MODEL_NAME=qwen2.5-7b  # your local llm model name
```

## OpenAI-Compatible Server API

If you have a GUI client that supports OpenAI API (e.g. [CherryStudio](https://docs.cherry-ai.com/), [Chatbox](https://github.com/Bin-Huang/chatbox)) , you can simply config it to use this server.

![demo1](.github/visuals/demo6.gif)

Start the server:

```bash
# Without authentication
npm run serve

# With authentication (clients must provide this secret as Bearer token)
npm run serve --secret=your_secret_token
```

The server will start on http://localhost:3000 with the following endpoint:

### Logging

The server uses Winston with Google Cloud Logging for comprehensive logging. When deployed to Google Cloud environments (App Engine, GKE, Compute Engine, etc.), logs will automatically be sent to Cloud Logging.

For local development, logs will be output to the console. To view logs in Google Cloud:

1. Go to [Cloud Logging Console](https://console.cloud.google.com/logs)
2. Select your project
3. Use the query builder to filter logs by severity, request URLs, or other metadata

Configure your Google Cloud project credentials by either:

- Setting up Application Default Credentials
- For local development, you can also specify project ID and credentials:
  ```bash
  # Optional: for local development with specific credentials
  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
  ```

### POST /v1/chat/completions

```bash
# Without authentication
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jina-deepsearch-v1",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'

# With authentication (when server is started with --secret)
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_secret_token" \
  -d '{
    "model": "jina-deepsearch-v1",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ],
    "stream": true
  }'
```

Response format:

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "jina-deepsearch-v1",
  "system_fingerprint": "fp_44709d6fcb",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "YOUR FINAL ANSWER"
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 12,
    "total_tokens": 21
  }
}
```

For streaming responses (stream: true), the server sends chunks in this format:

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion.chunk",
  "created": 1694268190,
  "model": "jina-deepsearch-v1",
  "system_fingerprint": "fp_44709d6fcb",
  "choices": [
    {
      "index": 0,
      "delta": {
        "content": "..."
      },
      "logprobs": null,
      "finish_reason": null
    }
  ]
}
```

Note: The think content in streaming responses is wrapped in XML tags:

```
<think>
[thinking steps...]
</think>
[final answer]
```

## Docker Setup

### Build Docker Image

To build the Docker image for the application, run the following command:

```bash
docker build -t deepresearch:latest .
```

### Run Docker Container

To run the Docker container, use the following command:

```bash
docker run -p 3000:3000 --env GEMINI_API_KEY=your_gemini_api_key --env JINA_API_KEY=your_jina_api_key deepresearch:latest
```

### Docker Compose

You can also use Docker Compose to manage multi-container applications. To start the application with Docker Compose, run:

```bash
docker-compose up
```

## How Does it Work?

Not sure a flowchart helps, but here it is:

```mermaid
flowchart TD
    Start([Start]) --> Init[Initialize context & variables]
    Init --> CheckBudget{Token budget<br/>exceeded?}
    CheckBudget -->|No| GetQuestion[Get current question<br/>from gaps]
    CheckBudget -->|Yes| BeastMode[Enter Beast Mode]

    GetQuestion --> GenPrompt[Generate prompt]
    GenPrompt --> ModelGen[Generate response<br/>using Gemini]
    ModelGen --> ActionCheck{Check action<br/>type}

    ActionCheck -->|answer| AnswerCheck{Is original<br/>question?}
    AnswerCheck -->|Yes| EvalAnswer[Evaluate answer]
    EvalAnswer --> IsGoodAnswer{Is answer<br/>definitive?}
    IsGoodAnswer -->|Yes| HasRefs{Has<br/>references?}
    HasRefs -->|Yes| End([End])
    HasRefs -->|No| GetQuestion
    IsGoodAnswer -->|No| StoreBad[Store bad attempt<br/>Reset context]
    StoreBad --> GetQuestion

    AnswerCheck -->|No| StoreKnowledge[Store as intermediate<br/>knowledge]
    StoreKnowledge --> GetQuestion

    ActionCheck -->|reflect| ProcessQuestions[Process new<br/>sub-questions]
    ProcessQuestions --> DedupQuestions{New unique<br/>questions?}
    DedupQuestions -->|Yes| AddGaps[Add to gaps queue]
    DedupQuestions -->|No| DisableReflect[Disable reflect<br/>for next step]
    AddGaps --> GetQuestion
    DisableReflect --> GetQuestion

    ActionCheck -->|search| SearchQuery[Execute search]
    SearchQuery --> NewURLs{New URLs<br/>found?}
    NewURLs -->|Yes| StoreURLs[Store URLs for<br/>future visits]
    NewURLs -->|No| DisableSearch[Disable search<br/>for next step]
    StoreURLs --> GetQuestion
    DisableSearch --> GetQuestion

    ActionCheck -->|visit| VisitURLs[Visit URLs]
    VisitURLs --> NewContent{New content<br/>found?}
    NewContent -->|Yes| StoreContent[Store content as<br/>knowledge]
    NewContent -->|No| DisableVisit[Disable visit<br/>for next step]
    StoreContent --> GetQuestion
    DisableVisit --> GetQuestion

    BeastMode --> FinalAnswer[Generate final answer] --> End
```

## Troubleshooting

### Google Cloud 500 Internal Server Errors

If you're experiencing intermittent `500 Internal Server Error` when using Google's Gemini API for embeddings, this is a known issue affecting many users. Here are the solutions implemented in this codebase:

#### The Problem

- **Error Message**: `"500 Internal error encountered"` or `"An internal error has occurred"`
- **Frequency**: Intermittent, especially during high load periods
- **Root Causes**:
  - Regional API endpoint overload
  - Model capacity limitations (often shows as 503 but manifests as 500)
  - Large payload sizes triggering server errors
  - Problematic text characters causing tokenization issues

#### Solutions Applied

1. **Reduced Batch Sizes** (Line 5 in `src/tools/embeddings.ts`)

   ```typescript
   const BATCH_SIZE = 50; // Reduced from 100 to avoid 500 errors
   ```

2. **Enhanced Retry Logic with Exponential Backoff**

   - Increased retries from 3 to 5 attempts
   - Longer delays for server errors (2-30 seconds vs 1-10 seconds)
   - Added jitter to prevent thundering herd effects

3. **Text Preprocessing**

   - Removes problematic Unicode characters that can cause tokenization errors
   - Normalizes encoding issues (smart quotes, em dashes, etc.)
   - Truncates extremely long texts (>30,000 characters)

4. **Circuit Breaker Pattern**

   - After 3 consecutive failures, temporarily stops API calls for 1 minute
   - Automatically generates zero embeddings as placeholders
   - Prevents cascading failures and API rate limiting

5. **Alternative Model Fallback**
   - Switches to `text-embedding-004` after 2 consecutive failures
   - Provides redundancy when primary model is overloaded

#### Manual Workarounds

If you continue experiencing issues, try these approaches:

1. **Regional Switching** (Based on [Google Cloud Community feedback](https://www.googlecloudcommunity.com/gc/AI-ML/InternalServerError-500-Internal-error-encountered/m-p/698728))

   - The error is often region-specific
   - Users report success switching from `northamerica-northeast1` to `us-central1`
   - Add this environment variable to try different regions:

   ```bash
   export GOOGLE_AI_REGION=us-central1
   ```

2. **Reduce Payload Size**

   - Further reduce `BATCH_SIZE` in `src/tools/embeddings.ts` (try 25 or 10)
   - Implement text chunking for very long documents

3. **Implement Request Queuing**
   - Add delays between batches to reduce API load
   - Use a queue system to serialize requests during peak hours

#### Monitoring and Logging

The enhanced error logging now captures:

- HTTP status codes (500, 503)
- Error type classification (server error vs overload)
- Batch sizes that trigger errors
- Circuit breaker status
- Retry attempt details

Look for these log patterns:

```
ERROR: Error calling Google Embeddings API (attempt X/5)
DEBUG: Circuit breaker: X consecutive failures
DEBUG: Using alternative model due to failures: text-embedding-004
```

#### References

- [Google Cloud Community Discussion](https://www.googlecloudcommunity.com/gc/AI-ML/InternalServerError-500-Internal-error-encountered/td-p/693571)
- [Google Developer Troubleshooting Guide](https://developers.generativeai.google/guide/troubleshooting)
