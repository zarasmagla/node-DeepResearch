import { Langfuse } from "langfuse";

// Create a shared Langfuse instance for the application with environment and version info
export const langfuse = new Langfuse({
    environment: process.env.NODE_ENV || "development",
    release: process.env.K_REVISION || "unknown",

})