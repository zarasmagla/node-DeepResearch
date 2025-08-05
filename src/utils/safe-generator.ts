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

import { Langfuse } from "langfuse";
import { logDebug, logError, logWarning } from "../logging";

interface GenerateObjectResult<T> {
  object: T;
  usage: LanguageModelUsage;
}

interface GenerateOptions {
  model: ToolName;
  schema: any;
  prompt?: ContentListUnion;
  system?: string;
  messages?: CoreMessage[];
  numRetries?: number;
  providerOptions?: Record<string, any>;
}

interface GenerateTextOptions {
  model: ToolName;
  prompt: string;
  system?: string;
  numRetries?: number;
}

interface GenerateTextResult {
  text: string;
  usage: LanguageModelUsage;
}

export class ObjectGeneratorSafe {
  private tokenTracker: TokenTracker;
  private langfuse: Langfuse;
  private ownLangfuse: boolean;

  constructor(tokenTracker?: TokenTracker, langfuse?: Langfuse) {
    this.tokenTracker = tokenTracker || new TokenTracker();
    this.langfuse =
      langfuse ||
      new Langfuse({
        environment: process.env.NODE_ENV || "development",
        release: process.env.K_REVISION || "unknown",
      });
    this.ownLangfuse = !langfuse; // Track if we created our own instance
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
    options: GenerateOptions
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

    // Create a Langfuse trace for the overall object generation
    const trace = this.langfuse.trace({
      name: "object-generation",
      metadata: {
        model: getModel(model),
        toolName: model,
        numRetries,
        hasSchema: !!schema,
        hasPrompt: !!prompt,
        hasSystem: !!system,
        hasMessages: !!messages,
        providerOptions,
      },
      tags: ["object-generation", "safe-generator"],
    });

    try {
      // Create a generation for the primary attempt
      const primaryGeneration = trace.generation({
        name: "primary-generation",
        model: getModel(model),
        input: {
          prompt:
            prompt ||
            messages?.map((message: CoreMessage) => ({
              role: message.role === "assistant" ? "model" : message.role,
              parts: [
                {
                  text: message.content,
                },
              ],
            })),
          system,
          schema:
            typeof schema === "object"
              ? JSON.stringify(schema, null, 2)
              : String(schema),
        },
        modelParameters: {
          maxOutputTokens: getToolConfig(model).maxTokens,
        },
        metadata: {
          toolName: model,
          attempt: "primary",
        },
      });

      const result = await GoogleGenAIHelper.generateObject({
        model: getModel(model),
        schema,
        prompt: prompt
          ? prompt
          : (messages?.map((message: CoreMessage) => ({
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
        langfuseGeneration: primaryGeneration, // Pass the generation to GoogleGenAIHelper
      });

      // End the generation with success
      primaryGeneration.end({
        output: result.object,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        },
      });

      // End the trace with success
      trace.update({
        output: result.object,
        metadata: {
          success: true,
          finalAttempt: "primary",
          usage: result.usage,
        },
      });

      this.tokenTracker.trackUsage(model, result.usage);
      return result as unknown as GenerateObjectResult<T>;
    } catch (error) {
      // Log the primary failure
      trace.event({
        name: "primary-generation-failed",
        level: "WARNING",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          errorType:
            error instanceof Error ? error.constructor.name : "unknown",
        },
      });

      // First fallback: Try manual parsing of the error response
      try {
        const parseSpan = trace.span({
          name: "manual-parsing-attempt",
          metadata: {
            attempt: "manual-parsing",
          },
        });

        const errorResult = await this.handleGenerateObjectError<T>(error);

        parseSpan.end({
          output: errorResult.object,
          metadata: {
            success: true,
            usage: errorResult.usage,
          },
        });

        trace.update({
          output: errorResult.object,
          metadata: {
            success: true,
            finalAttempt: "manual-parsing",
            usage: errorResult.usage,
          },
        });

        this.tokenTracker.trackUsage(model, errorResult.usage);
        return errorResult;
      } catch (parseError) {
        trace.event({
          name: "manual-parsing-failed",
          level: "WARNING",
          metadata: {
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
            errorType:
              parseError instanceof Error
                ? parseError.constructor.name
                : "unknown",
          },
        });

        if (numRetries > 0) {
          logWarning(`${model} failed on object generation -> manual parsing failed -> retry with ${numRetries - 1} retries remaining`);
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
          logWarning(`${model} failed on object generation -> manual parsing failed -> trying fallback with distilled schema`);
          try {
            const fallbackSpan = trace.span({
              name: "fallback-generation",
              metadata: {
                attempt: "fallback",
                fallbackModel: "fallback",
              },
            });

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

            const fallbackGeneration = fallbackSpan.generation({
              name: "fallback-model-generation",
              model: getModel("fallback"),
              input: {
                prompt: `Following the given JSON schema, extract the field from below: \n\n ${failedOutput}`,
                schema:
                  typeof distilledSchema === "object"
                    ? JSON.stringify(distilledSchema, null, 2)
                    : String(distilledSchema),
              },
              modelParameters: {
                temperature: getToolConfig("fallback").temperature,
              },
              metadata: {
                attempt: "fallback",
                distilledSchema: true,
              },
            });

            const fallbackResult = await GoogleGenAIHelper.generateObject({
              model: getModel("fallback"),
              schema: distilledSchema,
              prompt: `Following the given JSON schema, extract the field from below: \n\n ${failedOutput}`,
              temperature: getToolConfig("fallback").temperature,
              providerOptions,
              langfuseGeneration: fallbackGeneration,
            });

            fallbackGeneration.end({
              output: fallbackResult.object,
              usage: {
                promptTokens: fallbackResult.usage.promptTokens,
                completionTokens: fallbackResult.usage.completionTokens,
                totalTokens: fallbackResult.usage.totalTokens,
              },
            });

            fallbackSpan.end({
              output: fallbackResult.object,
              metadata: {
                success: true,
                usage: fallbackResult.usage,
              },
            });

            trace.update({
              output: fallbackResult.object,
              metadata: {
                success: true,
                finalAttempt: "fallback",
                usage: fallbackResult.usage,
              },
            });

            this.tokenTracker.trackUsage("fallback", fallbackResult.usage); // Track against fallback model
            console.log("Distilled schema parse success!");
            return fallbackResult as unknown as GenerateObjectResult<T>;
          } catch (fallbackError) {
            trace.event({
              name: "fallback-generation-failed",
              level: "ERROR",
              metadata: {
                error:
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError),
                errorType:
                  fallbackError instanceof Error
                    ? fallbackError.constructor.name
                    : "unknown",
              },
            });

            // If fallback model also fails, try parsing its error response
            try {
              const lastChanceSpan = trace.span({
                name: "last-chance-parsing",
                metadata: {
                  attempt: "last-chance-parsing",
                },
              });

              const lastChanceResult = await this.handleGenerateObjectError<T>(
                fallbackError
              );

              lastChanceSpan.end({
                output: lastChanceResult.object,
                metadata: {
                  success: true,
                  usage: lastChanceResult.usage,
                },
              });

              trace.update({
                output: lastChanceResult.object,
                metadata: {
                  success: true,
                  finalAttempt: "last-chance-parsing",
                  usage: lastChanceResult.usage,
                },
              });

              this.tokenTracker.trackUsage("fallback", lastChanceResult.usage);
              return lastChanceResult as unknown as GenerateObjectResult<T>;
            } catch (finalError) {
              trace.event({
                name: "all-recovery-failed",
                level: "ERROR",
                metadata: {
                  error:
                    finalError instanceof Error
                      ? finalError.message
                      : String(finalError),
                  errorType:
                    finalError instanceof Error
                      ? finalError.constructor.name
                      : "unknown",
                },
              });

              trace.update({
                metadata: {
                  success: false,
                  finalAttempt: "failed",
                  allRecoveryMechanismsFailed: true,
                },
              });

              logger.error(`All recovery mechanisms failed`);
              throw error; // Throw original error for better debugging
            }
          }
        }
      }
    }
  }

  async generateText(
    options: GenerateTextOptions
  ): Promise<GenerateTextResult> {
    const {
      model,
      prompt,
      system,
      numRetries = 0,
    } = options;

    if (!model || !prompt) {
      throw new Error("Model and prompt are required parameters");
    }

    // Create a Langfuse trace for the text generation
    const trace = this.langfuse.trace({
      name: "text-generation",
      metadata: {
        model: getModel(model),
        toolName: model,
        numRetries,
        hasPrompt: !!prompt,
        hasSystem: !!system,
      },
      tags: ["text-generation", "safe-generator"],
    });

    try {
      // Create a generation for the primary attempt
      const primaryGeneration = trace.generation({
        name: "primary-text-generation",
        model: getModel(model),
        input: {
          prompt,
          system,
        },
        modelParameters: {
          maxOutputTokens: getToolConfig(model).maxTokens,
          temperature: getToolConfig(model).temperature,
        },
        metadata: {
          attempt: "primary",
          toolName: model,
        },
      });

      const result = await GoogleGenAIHelper.generateText({
        model: getModel(model),
        prompt,
        systemInstruction: system,
        maxOutputTokens: getToolConfig(model).maxTokens,
        temperature: getToolConfig(model).temperature,
        langfuseGeneration: primaryGeneration,
      });

      // End the generation with success
      primaryGeneration.end({
        output: result.text,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        },
      });

      // End the trace with success
      trace.update({
        output: result.text,
        metadata: {
          success: true,
          finalAttempt: "primary",
          usage: result.usage,
        },
      });

      this.tokenTracker.trackUsage(model, result.usage);
      return result;
    } catch (error) {
      // Log the primary failure
      trace.event({
        name: "primary-text-generation-failed",
        level: "WARNING",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          errorType:
            error instanceof Error ? error.constructor.name : "unknown",
        },
      });

      if (numRetries > 0) {
        logWarning(`${model} failed on text generation -> retry with ${numRetries - 1} retries remaining`);
        return this.generateText({
          model,
          prompt,
          system,
          numRetries: numRetries - 1,
        });
      } else {
        // Try with fallback model if primary fails
        logWarning(`${model} failed on text generation -> trying fallback`);
        try {
          const fallbackSpan = trace.span({
            name: "fallback-text-generation",
            metadata: {
              attempt: "fallback",
              fallbackModel: "fallback",
            },
          });

          const fallbackGeneration = fallbackSpan.generation({
            name: "fallback-text-generation",
            model: getModel("fallback"),
            input: {
              prompt,
              system,
            },
            modelParameters: {
              maxOutputTokens: getToolConfig("fallback").maxTokens,
              temperature: getToolConfig("fallback").temperature,
            },
            metadata: {
              attempt: "fallback",
            },
          });

          const fallbackResult = await GoogleGenAIHelper.generateText({
            model: getModel("fallback"),
            prompt,
            systemInstruction: system,
            maxOutputTokens: getToolConfig("fallback").maxTokens,
            temperature: getToolConfig("fallback").temperature,
            langfuseGeneration: fallbackGeneration,
          });

          fallbackGeneration.end({
            output: fallbackResult.text,
            usage: {
              promptTokens: fallbackResult.usage.promptTokens,
              completionTokens: fallbackResult.usage.completionTokens,
              totalTokens: fallbackResult.usage.totalTokens,
            },
          });

          fallbackSpan.end({
            output: fallbackResult.text,
            metadata: {
              success: true,
              usage: fallbackResult.usage,
            },
          });

          trace.update({
            output: fallbackResult.text,
            metadata: {
              success: true,
              finalAttempt: "fallback",
              usage: fallbackResult.usage,
            },
          });

          this.tokenTracker.trackUsage("fallback", fallbackResult.usage);
          console.log("Fallback text generation success!");
          return fallbackResult;
        } catch (fallbackError) {
          trace.event({
            name: "fallback-text-generation-failed",
            level: "ERROR",
            metadata: {
              error:
                fallbackError instanceof Error
                  ? fallbackError.message
                  : String(fallbackError),
              errorType:
                fallbackError instanceof Error
                  ? fallbackError.constructor.name
                  : "unknown",
            },
          });

          trace.update({
            metadata: {
              success: false,
              finalAttempt: "failed",
              allRecoveryMechanismsFailed: true,
            },
          });

          logger.error(`Text generation failed for both primary and fallback models`);
          throw error; // Throw original error for better debugging
        }
      }
    }
  }

  /**
   * Call this method to flush all pending Langfuse events
   * Should be called at application shutdown
   */
  async shutdown(): Promise<void> {
    if (this.ownLangfuse) {
      await this.langfuse.shutdownAsync();
    }
  }

  private async handleGenerateObjectError<T>(
    error: unknown
  ): Promise<GenerateObjectResult<T>> {
    if (NoObjectGeneratedError.isInstance(error)) {
      logWarning('Object not generated according to schema, fallback to manual parsing', { error });
      try {
        // First try standard JSON parsing
        const partialResponse = JSON.parse((error as any).text);
        logDebug('JSON parse success!');
        return {
          object: partialResponse as T,
          usage: (error as any).usage,
        };
      } catch (parseError) {
        // Use Hjson to parse the error response for more lenient parsing
        try {
          const hjsonResponse = Hjson.parse((error as any).text);
          logDebug('Hjson parse success!');
          return {
            object: hjsonResponse as T,
            usage: (error as any).usage,
          };
        } catch (hjsonError) {
          logError('Both JSON and Hjson parsing failed:', { error: hjsonError });
          throw error;
        }
      }
    }
    throw error;
  }
}
