import winston from "winston";
import { LoggingWinston } from "@google-cloud/logging-winston";

export interface LogMetadata {
    verification_id?: string;
    task_id?: string;
    operation?: string;
    status?: string;
    duration_ms?: number;
    error?: any;
    metadata?: Record<string, any>;
    [key: string]: any;
}

export class StructuredLogger {
    private logger: winston.Logger;
    private service_name: string;
    private component: string;

    constructor(service_name: string, component: string = "unknown") {
        this.service_name = service_name;
        this.component = component;
        this.logger = this._setup_logger();
    }

    private _setup_logger(): winston.Logger {
        const loggingWinston = new LoggingWinston({
            projectId: process.env.GCLOUD_PROJECT,
            keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            labels: {
                service: this.service_name,
                component: this.component,
                environment: process.env.NODE_ENV || "development",
            },
        });

        return winston.createLogger({
            level: "info",
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json()
            ),
            defaultMeta: {
                service: this.service_name,
                component: this.component,
            },
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple()
                    )
                }),
                loggingWinston,
            ],
        });
    }

    private _truncate_data(data: any, max_length: number = 1000): string {
        if (data === null || data === undefined) {
            return "null";
        }

        const data_str = typeof data === 'string' ? data : JSON.stringify(data);
        if (data_str.length <= max_length) {
            return data_str;
        }

        return `${data_str.substring(0, max_length)}... [TRUNCATED - Original length: ${data_str.length}]`;
    }

    private _build_log_payload(
        message: string,
        level: string = "info",
        metadata: LogMetadata = {}
    ): Record<string, any> {
        const payload: Record<string, any> = {
            timestamp: new Date().toISOString(),
            service: this.service_name,
            component: this.component,
            message,
            level: level.toUpperCase(),
            ...metadata,
        };

        // Truncate large data fields
        if (payload.error && typeof payload.error === 'object') {
            payload.error = this._truncate_data(payload.error, 500);
        }

        if (payload.metadata) {
            payload.metadata = JSON.parse(this._truncate_data(payload.metadata, 500));
        }

        return payload;
    }

    info(message: string, metadata: LogMetadata = {}): void {
        const payload = this._build_log_payload(message, "info", metadata);
        this.logger.info(payload);
    }

    error(message: string, error?: Error | any, metadata: LogMetadata = {}): void {
        const error_details = error ? {
            type: error.constructor?.name || "Error",
            message: error.message || String(error),
            stack: error.stack,
        } : undefined;

        const payload = this._build_log_payload(message, "error", {
            ...metadata,
            error: error_details,
        });
        this.logger.error(payload);
    }

    warning(message: string, metadata: LogMetadata = {}): void {
        const payload = this._build_log_payload(message, "warning", metadata);
        this.logger.warn(payload);
    }

    debug(message: string, metadata: LogMetadata = {}): void {
        const payload = this._build_log_payload(message, "debug", metadata);
        this.logger.debug(payload);
    }

    api_request(
        endpoint: string,
        method: string = "POST",
        verification_id?: string,
        request_data?: any,
        response_data?: any,
        status_code?: number,
        duration_ms?: number,
        error?: Error
    ): void {
        const status = error || (status_code && (status_code < 200 || status_code >= 300))
            ? "ERROR"
            : "SUCCESS";

        this.info(`API ${method} ${endpoint}`, {
            verification_id,
            operation: "api_request",
            status,
            duration_ms,
            metadata: {
                endpoint,
                method,
                status_code,
                request_data: this._truncate_data(request_data, 300),
                response_data: this._truncate_data(response_data, 500),
            },
            error: error ? {
                type: error.constructor?.name || "Error",
                message: error.message || String(error),
                stack: error.stack,
            } : undefined,
        });
    }

    external_service_call(
        service_name: string,
        operation: string,
        verification_id?: string,
        request_data?: any,
        response_data?: any,
        duration_ms?: number,
        status?: string,
        error?: Error
    ): void {
        const final_status = status || (error ? "ERROR" : "SUCCESS");

        this.info(`External service call: ${service_name}.${operation}`, {
            verification_id,
            operation: `external_service_${operation}`,
            status: final_status,
            duration_ms,
            metadata: {
                external_service: service_name,
                operation,
                request_data: this._truncate_data(request_data, 300),
                response_data: this._truncate_data(response_data, 500),
            },
            error: error ? {
                type: error.constructor?.name || "Error",
                message: error.message || String(error),
                stack: error.stack,
            } : undefined,
        });
    }


    search_operation(
        query: string,
        verification_id: string,
        provider: string,
        status: string = "STARTED",
        results_count?: number,
        duration_ms?: number,
        error?: Error
    ): void {
        this.info(`Search operation: ${provider}`, {
            verification_id,
            operation: "search",
            status,
            duration_ms,
            metadata: {
                provider,
                query: this._truncate_data(query, 100),
                results_count,
            },
            error: error ? {
                type: error.constructor?.name || "Error",
                message: error.message || String(error),
                stack: error.stack,
            } : undefined,
        });
    }

    url_processing(
        url: string,
        verification_id: string,
        status: string = "STARTED",
        duration_ms?: number,
        content_length?: number,
        error?: Error
    ): void {
        this.info(`URL processing: ${url}`, {
            verification_id,
            operation: "url_processing",
            status,
            duration_ms,
            metadata: {
                url,
                content_length,
            },
            error: error ? {
                type: error.constructor?.name || "Error",
                message: error.message || String(error),
                stack: error.stack,
            } : undefined,
        });
    }
}

// Factory functions for common loggers
export function get_agent_logger(): StructuredLogger {
    return new StructuredLogger("jina-deepsearch", "agent");
}

export function get_api_logger(): StructuredLogger {
    return new StructuredLogger("jina-deepsearch", "api");
}

export function get_search_logger(): StructuredLogger {
    return new StructuredLogger("jina-deepsearch", "search");
}

export function get_tools_logger(): StructuredLogger {
    return new StructuredLogger("jina-deepsearch", "tools");
} 