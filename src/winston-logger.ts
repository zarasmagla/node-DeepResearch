import { LoggingWinston } from "@google-cloud/logging-winston";
import winston from "winston";

// Create a Winston logger that streams to Cloud Logging
const loggingWinston = new LoggingWinston();

export const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }), // This is important for capturing full stack traces
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
                    let output = `${timestamp} [${level}]: ${message}`;
                    if (stack) {
                        output += `\n${stack}`;
                    }
                    if (Object.keys(meta).length > 0) {
                        output += `\n${JSON.stringify(meta, null, 2)}`;
                    }
                    return output;
                })
            )
        }),
        // Add Cloud Logging
        loggingWinston,
    ],
});

