# Structured Logging for DeepSearch Agent

This document explains how to use the structured logging system implemented across the DeepSearch agent application.

## Overview

The structured logging system provides consistent, searchable logs across all components of the application. Each log entry includes:

- `verification_id` - Unique identifier for tracking a complete chat completion request
- `service` - Service name (e.g., "jina-deepsearch")
- `component` - Component name (e.g., "api", "agent", "search", "tools")
- `operation` - Specific operation being performed
- `status` - Current status (STARTED, SUCCESS, ERROR, etc.)
- `timestamp` - ISO timestamp
- `metadata` - Additional contextual information

## Usage

### API Endpoint

```typescript
// The verification_id comes from the request body
{
  "model": "jina-deepsearch-v1",
  "messages": [...],
  "verification_id": "my-unique-id-123"
}
```

If no `verification_id` is provided, the system will generate one using the request timestamp.

### Example Log Entries

#### API Request Start

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "jina-deepsearch",
  "component": "api",
  "message": "API POST /v1/chat/completions",
  "verification_id": "my-unique-id-123",
  "operation": "api_request",
  "status": "STARTED",
  "metadata": {
    "model": "jina-deepsearch-v1",
    "messageCount": 1,
    "stream": false,
    "tokenBudget": 500000,
    "maxBadAttempts": 1
  }
}
```

#### Agent Processing

```json
{
  "timestamp": "2024-01-15T10:30:01.000Z",
  "service": "jina-deepsearch",
  "component": "agent",
  "message": "Agent step: start_processing",
  "verification_id": "my-unique-id-123",
  "operation": "agent_start_processing",
  "status": "STARTED",
  "metadata": {
    "question": "What is the latest version of Python?",
    "tokenBudget": 500000,
    "maxBadAttempts": 1,
    "hasMessages": true
  }
}
```

#### Search Operation

```json
{
  "timestamp": "2024-01-15T10:30:02.000Z",
  "service": "jina-deepsearch",
  "component": "search",
  "message": "Search operation: jina",
  "verification_id": "my-unique-id-123",
  "operation": "search",
  "status": "SUCCESS",
  "duration_ms": 1500,
  "metadata": {
    "provider": "jina",
    "query": "latest Python version",
    "results_count": 10
  }
}
```

#### External Service Call

```json
{
  "timestamp": "2024-01-15T10:30:03.000Z",
  "service": "jina-deepsearch",
  "component": "search",
  "message": "External service call: jina-search.search",
  "verification_id": "my-unique-id-123",
  "operation": "external_service_search",
  "status": "SUCCESS",
  "duration_ms": 1200,
  "metadata": {
    "external_service": "jina-search",
    "operation": "search",
    "resultCount": 10,
    "totalTokens": 1500
  }
}
```

#### Evaluation

```json
{
  "timestamp": "2024-01-15T10:30:05.000Z",
  "service": "jina-deepsearch",
  "component": "tools",
  "message": "Completed answer evaluation",
  "verification_id": "my-unique-id-123",
  "operation": "evaluate_answer",
  "status": "PASSED",
  "duration_ms": 800,
  "metadata": {
    "evaluationType": "definitive",
    "evaluationReason": "The answer provides clear, definitive information..."
  }
}
```

#### Final Success

```json
{
  "timestamp": "2024-01-15T10:30:10.000Z",
  "service": "jina-deepsearch",
  "component": "api",
  "message": "API POST /v1/chat/completions",
  "verification_id": "my-unique-id-123",
  "operation": "api_request",
  "status": "SUCCESS",
  "duration_ms": 10000,
  "metadata": {
    "contentLength": 1500,
    "visitedURLs": 5,
    "readURLs": 3,
    "totalURLs": 15
  }
}
```

## Filtering Logs by verification_id

### Google Cloud Console

In the Google Cloud Console Logs Explorer, use this filter:

```
jsonPayload.verification_id="my-unique-id-123"
```

### gcloud CLI

```bash
gcloud logging read 'jsonPayload.verification_id="my-unique-id-123"' --limit=100
```

### For streaming logs in real-time:

```bash
gcloud logging tail 'jsonPayload.verification_id="my-unique-id-123"'
```

### Advanced Filtering

Filter by specific operations:

```
jsonPayload.verification_id="my-unique-id-123" AND jsonPayload.operation="search"
```

Filter by component:

```
jsonPayload.verification_id="my-unique-id-123" AND jsonPayload.component="agent"
```

Filter by status:

```
jsonPayload.verification_id="my-unique-id-123" AND jsonPayload.status="ERROR"
```

Filter by time range and verification_id:

```
jsonPayload.verification_id="my-unique-id-123" AND timestamp>="2024-01-15T10:00:00Z"
```

## Common Use Cases

### 1. Debug a Failed Request

```
jsonPayload.verification_id="failed-request-123" AND jsonPayload.status="ERROR"
```

### 2. Track Performance

```
jsonPayload.verification_id="slow-request-456" AND jsonPayload.duration_ms>=1000
```

### 3. Monitor Search Operations

```
jsonPayload.verification_id="my-request" AND jsonPayload.operation="search"
```

### 4. Follow Complete Request Journey

```
jsonPayload.verification_id="my-request"
ORDER BY timestamp ASC
```

## Available Loggers

The system provides several pre-configured loggers:

- `get_api_logger()` - For API endpoint logging
- `get_agent_logger()` - For core agent processing
- `get_search_logger()` - For search operations
- `get_tools_logger()` - For tool operations (evaluation, etc.)

## Environment Variables

For Google Cloud Logging integration:

- `GCLOUD_PROJECT` - Your Google Cloud project ID
- `GOOGLE_APPLICATION_CREDENTIALS` - Path to service account key file
- `NODE_ENV` - Set to "production" for production logging format

## Performance Impact

The structured logger is designed to be lightweight:

- Truncates large data fields automatically
- Uses non-blocking logging operations
- Includes local console output for development
- Minimal serialization overhead

## Best Practices

1. Always include `verification_id` when available
2. Use consistent operation names across similar functions
3. Include timing information for performance monitoring
4. Truncate large request/response data in metadata
5. Use appropriate log levels (info, error, warning, debug)
6. Include contextual metadata for debugging
