import { LoggingWinston } from "@google-cloud/logging-winston";
import winston from "winston";

// Create a Winston logger that streams to Cloud Logging
const loggingWinston = new LoggingWinston();

export const logger = winston.createLogger({
    level: "info",
    transports: [
        new winston.transports.Console(),
        // Add Cloud Logging
        loggingWinston,
    ],
});

