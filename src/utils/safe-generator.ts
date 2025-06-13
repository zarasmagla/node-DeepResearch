import { z } from "zod/v4";
import {
  CoreMessage,
  LanguageModelUsage,
  NoObjectGeneratedError,
  Schema,
} from "ai";
import { TokenTracker } from "./token-tracker";
import { getModel, ToolName, getToolConfig } from "../config";
import Hjson from "hjson"; // Import Hjson library
import { logger } from "../winston-logger";
import { GoogleGenAIHelper } from "./google-genai-helper";
import { ContentListUnion } from "@google/genai";
import { cleanupLineBreaks, cleanupJsonString } from "./text-cleanup";

interface GenerateObjectResult<T> {
  object: T;
  usage: LanguageModelUsage;
}

interface GenerateOptions<T> {
  model: ToolName;
  schema: any;
  prompt?: string;
  system?: string;
  messages?: CoreMessage[];
  numRetries?: number;
  providerOptions?: Record<string, any>;
}

export class ObjectGeneratorSafe {
  private tokenTracker: TokenTracker;

  constructor(tokenTracker?: TokenTracker) {
    this.tokenTracker = tokenTracker || new TokenTracker();
  }

  /**
   * Creates a distilled version of a schema by removing all descriptions
   * This makes the schema simpler for fallback parsing scenarios
   */
  private createDistilledSchema<T>(
    schema: z.ZodType<T> | Schema<T>
  ): z.ZodType<T> | Schema<T> {
    // For zod schemas
    if (schema instanceof z.ZodType) {
      return schema;
    }

    // For AI SDK Schema objects
    if (typeof schema === "object" && schema !== null) {
      return this.stripSchemaDescriptions(schema as Schema<T>);
    }

    // If we can't determine the schema type, return as is
    return schema;
  }

  /**
   * Strips descriptions from AI SDK Schema objects
   */
  private stripSchemaDescriptions<T>(schema: Schema<T>): Schema<T> {
    // Deep clone the schema to avoid modifying the original
    const clonedSchema = JSON.parse(JSON.stringify(schema));

    // Recursively remove description properties
    const removeDescriptions = (obj: any) => {
      if (typeof obj !== "object" || obj === null) return;

      if (obj.properties) {
        for (const key in obj.properties) {
          // Remove description property
          if (obj.properties[key].description) {
            delete obj.properties[key].description;
          }

          // Recursively process nested properties
          removeDescriptions(obj.properties[key]);
        }
      }

      // Handle arrays
      if (obj.items) {
        if (obj.items.description) {
          delete obj.items.description;
        }
        removeDescriptions(obj.items);
      }

      // Handle any other nested objects that might contain descriptions
      if (obj.anyOf) obj.anyOf.forEach(removeDescriptions);
      if (obj.allOf) obj.allOf.forEach(removeDescriptions);
      if (obj.oneOf) obj.oneOf.forEach(removeDescriptions);
    };

    removeDescriptions(clonedSchema);
    return clonedSchema;
  }

  async generateObject<T>(
    options: GenerateOptions<T>
  ): Promise<GenerateObjectResult<T>> {
    const {
      model,
      schema,
      prompt,
      system,
      messages,
      numRetries = 0,
      providerOptions,
    } = options;

    if (!model || !schema) {
      throw new Error("Model and schema are required parameters");
    }

    try {
      // Primary attempt with main model
      console.log("==============================");
      const result = await GoogleGenAIHelper.generateObject({
        model: getModel(model),
        schema,
        prompt: prompt
          ? prompt
          : (messages?.map((message) => ({
              role: message.role === "assistant" ? "model" : message.role,
              parts: [
                {
                  text: message.content,
                },
              ],
            })) as ContentListUnion),
        systemInstruction: system,
        maxOutputTokens: getToolConfig(model).maxTokens,
        providerOptions,
      });
      this.tokenTracker.trackUsage(model, result.usage);
      return result as unknown as GenerateObjectResult<T>;
    } catch (error) {
      // First fallback: Try manual parsing of the error response
      try {
        const errorResult = await this.handleGenerateObjectError<T>(error);
        this.tokenTracker.trackUsage(model, errorResult.usage);
        return errorResult;
      } catch (parseError) {
        if (numRetries > 0) {
          logger.error(
            `${model} failed on object generation -> manual parsing failed -> retry with ${
              numRetries - 1
            } retries remaining`
          );
          return this.generateObject({
            model,
            schema,
            prompt,
            system,
            messages,
            numRetries: numRetries - 1,
            providerOptions,
          });
        } else {
          // Second fallback: Try with fallback model if provided
          logger.error(
            `${model} failed on object generation -> manual parsing failed -> trying fallback with distilled schema`
          );
          try {
            let failedOutput = "";

            if (NoObjectGeneratedError.isInstance(parseError)) {
              failedOutput = (parseError as any).text;
              // find last `"url":` appear in the string, which is the source of the problem
              failedOutput = failedOutput.slice(
                0,
                Math.min(failedOutput.lastIndexOf('"url":'), 8000)
              );
            }

            // Create a distilled version of the schema without descriptions
            const distilledSchema = this.createDistilledSchema(schema);

            const fallbackResult = await GoogleGenAIHelper.generateObject({
              model: getModel("fallback"),
              schema: distilledSchema,
              prompt: `Following the given JSON schema, extract the field from below: \n\n ${failedOutput}`,
              temperature: getToolConfig("fallback").temperature,
              providerOptions,
            });

            this.tokenTracker.trackUsage("fallback", fallbackResult.usage); // Track against fallback model
            console.log("Distilled schema parse success!");
            return fallbackResult as unknown as GenerateObjectResult<T>;
          } catch (fallbackError) {
            // If fallback model also fails, try parsing its error response
            try {
              const lastChanceResult = await this.handleGenerateObjectError<T>(
                fallbackError
              );
              this.tokenTracker.trackUsage("fallback", lastChanceResult.usage);
              return lastChanceResult as unknown as GenerateObjectResult<T>;
            } catch (finalError) {
              logger.error(`All recovery mechanisms failed`);
              throw error; // Throw original error for better debugging
            }
          }
        }
      }
    }
  }

  private async handleGenerateObjectError<T>(
    error: unknown
  ): Promise<GenerateObjectResult<T>> {
    if (NoObjectGeneratedError.isInstance(error)) {
      logger.error(
        "Object not generated according to schema, fallback to manual parsing"
      );
      logger.error("error", error.text);

      // Clean up line breaks from the error text before parsing
      const cleanedText = cleanupJsonString(
        cleanupLineBreaks((error as any).text)
      );

      try {
        // First try standard JSON parsing
        const partialResponse = JSON.parse(cleanedText);
        console.log("JSON parse success!");
        return {
          object: partialResponse as T,
          usage: (error as any).usage,
        };
      } catch (parseError) {
        // Use Hjson to parse the error response for more lenient parsing
        try {
          const hjsonResponse = Hjson.parse(cleanedText);
          console.log("Hjson parse success!");
          return {
            object: hjsonResponse as T,
            usage: (error as any).usage,
          };
        } catch (hjsonError) {
          logger.error("Both JSON and Hjson parsing failed:", hjsonError);
          throw error;
        }
      }
    }
    throw error;
  }
}
