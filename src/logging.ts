// Cloud Run structured logging helper
const project = process.env.GOOGLE_CLOUD_PROJECT;

interface LogEntry {
  severity: string;
  message: string;
  component: string;
  [key: string]: any;
}

function createLogEntry(severity: string, message: string, context: Record<string, any> = {}): LogEntry {
  const entry: LogEntry = {
    severity,
    message,
    component: 'deepsearch',
    timestamp: new Date().toISOString(),
    ...context
  };

  // Add trace context if available
  if (typeof process.env.K_REVISION !== 'undefined' && project) {
    entry['logging.googleapis.com/trace'] = `projects/${project}/traces/${process.env.K_REVISION}`;
  }

  // Add source location if available
  if (context.file && context.line) {
    entry['logging.googleapis.com/sourceLocation'] = {
      file: context.file,
      line: context.line,
      function: context.function || 'unknown'
    };
  }

  // Add request ID if available
  if (context.requestId) {
    entry['logging.googleapis.com/requestId'] = context.requestId;
  }

  return entry;
}

export function logInfo(message: string, context: Record<string, any> = {}) {
  console.log(JSON.stringify(createLogEntry('INFO', message, context)));
}

export function logError(message: string, context: Record<string, any> = {}) {
  console.error(JSON.stringify(createLogEntry('ERROR', message, context)));
}

export function logDebug(message: string, context: Record<string, any> = {}) {
  console.log(JSON.stringify(createLogEntry('DEBUG', message, context)));
}

export function logWarning(message: string, context: Record<string, any> = {}) {
  console.warn(JSON.stringify(createLogEntry('WARNING', message, context)));
}
