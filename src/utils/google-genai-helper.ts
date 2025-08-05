import {
  ContentListUnion,
  GenerateContentConfig,
  GoogleGenAI,
  SchemaUnion,
} from "@google/genai";
import { GEMINI_API_KEY } from "../config";
import { logger } from "../winston-logger";
import { LanguageModelUsage } from "ai";

/**
 * Preprocesses input text to avoid tokenization issues
 */
function preprocessInput(input: string): string {
  if (!input || typeof input !== "string") return input || "";

  let processed = input;

  // 1. Fix common encoding issues first (before normalization)
  processed = processed
    // Fix common Windows-1252 characters that appear in UTF-8
    .replace(/â€™/g, "'") // Smart apostrophe
    .replace(/â€œ/g, '"') // Left smart quote
    .replace(/â€\u009D/g, '"') // Right smart quote
    .replace(/â€"/g, "-") // Em dash
    .replace(/â€¦/g, "...") // Ellipsis
    .replace(/Â/g, "") // Non-breaking space artifacts
    .replace(/\u00A0/g, " "); // Non-breaking space to regular space

  // 2. Normalize Unicode characters to standard forms
  processed = processed.normalize("NFKC");

  // 3. Remove or replace problematic characters (more efficient approach)
  processed = processed
    // Remove zero-width characters that can confuse tokenizers
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // Replace smart quotes with regular quotes
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    // Replace em/en dashes with regular hyphens
    .replace(/[–—]/g, "-")
    // Replace ellipsis character with three dots
    .replace(/…/g, "...");

  // 4. Handle excessive whitespace
  processed = processed.replace(/\s+/g, " ").trim();

  return processed;
}

/**
 * Helper function to deeply preprocess Content objects
 */
function preprocessContentObject(item: any): any {
  if (!item || typeof item !== "object") return item;

  const processed = { ...item };

  // Handle text content
  if (typeof item.text === "string") {
    processed.text = preprocessInput(item.text);
  }

  // Handle parts array (for multimodal content)
  if (Array.isArray(item.parts)) {
    processed.parts = item.parts.map((part: any) => {
      if (part && typeof part === "object" && typeof part.text === "string") {
        return { ...part, text: preprocessInput(part.text) };
      }
      return part;
    });
  }

  return processed;
}

/**
 * Helper class for Google Gen AI operations
 */
export class GoogleGenAIHelper {
  private static googleGenAI: any = null;

  private static async getGoogleGenAI() {
    if (!this.googleGenAI) {
      if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set");
      }
      this.googleGenAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY, location: "global" });
    }
    return this.googleGenAI as GoogleGenAI;
  }

  /**
   * Generate structured JSON object using Google Gen AI
   */
  static async generateObject<T>({
    model = "gemini-2.5-flash",
    prompt,
    systemInstruction,
    schema,
    maxOutputTokens = 1000,
    temperature = 0.2,
    providerOptions,
    langfuseGeneration,
  }: {
    model?: string;
    prompt: ContentListUnion;
    systemInstruction?: string;
    schema: SchemaUnion; // Google Gen AI schema format
    maxOutputTokens?: number;
    temperature?: number;
    providerOptions?: Record<string, any>;
    langfuseGeneration?: any; // Optional Langfuse generation for tracing
  }): Promise<{ object: T; usage: LanguageModelUsage }> {
    try {
      const ai = await this.getGoogleGenAI();

      // Preprocess prompt content based on its type
      let processedPrompt: ContentListUnion = prompt;
      if (typeof prompt === "string") {
        processedPrompt = preprocessInput(prompt);
      } else if (Array.isArray(prompt)) {
        // Handle array of content objects more comprehensively
        processedPrompt = prompt.map((item) => {
          if (typeof item === "string") {
            // Convert string to Content object with text property
            return { text: preprocessInput(item) };
          } else if (item && typeof item === "object") {
            // Handle complex Content objects (with parts, role, etc.)
            return preprocessContentObject(item);
          }
          return item;
        }) as ContentListUnion;
      } else if (prompt && typeof prompt === "object") {
        // Handle single Content object
        processedPrompt = preprocessContentObject(prompt) as ContentListUnion;
      }

      const config: GenerateContentConfig = {
        responseMimeType: "application/json",
        responseSchema: schema,
        maxOutputTokens,
        temperature,
      };

      // Apply provider options if provided, with support for Google-specific options
      if (providerOptions?.google) {
        // Merge Google-specific options directly into config
        Object.assign(config, providerOptions.google);
      } else {
        // Fallback to default thinkingConfig if no provider options
        config.thinkingConfig = {
          thinkingBudget: 0,
        };
      }

      // Preprocess system instruction if provided
      if (systemInstruction) {
        config.systemInstruction = preprocessInput(systemInstruction);
      }

      // Add metadata to langfuse generation if provided
      if (langfuseGeneration) {
        langfuseGeneration.update({
          metadata: {
            ...langfuseGeneration.metadata,
            actualModel: model,
            configUsed: {
              maxOutputTokens,
              temperature,
              responseMimeType: config.responseMimeType,
            },
            systemInstruction: config.systemInstruction,
          },
        });
      }

      const response = await ai.models.generateContent({
        model,
        contents: processedPrompt,
        config,
      });

      const responseText = response.text || "{}";

      let parsedObject: T;

      try {
        parsedObject = JSON.parse(responseText);
      } catch (parseError) {
        logger.error(
          "Failed to parse Google Gen AI response as JSON:",
          responseText
        );

        // Log parsing error to langfuse if available
        if (langfuseGeneration) {
          langfuseGeneration.event({
            name: "json-parse-error",
            level: "ERROR",
            metadata: {
              error:
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError),
              rawResponse: responseText.slice(0, 1000), // First 1000 chars
              responseLength: responseText.length,
            },
          });
        }

        throw new Error(`Invalid JSON response: ${responseText}`);
      }

      // Create usage estimate (Google Gen AI doesn't provide detailed usage info)
      const usage: LanguageModelUsage = {
        promptTokens: response.usageMetadata?.promptTokenCount || 0,
        completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata?.totalTokenCount || 0,
      };

      // Log successful parsing to langfuse if available
      if (langfuseGeneration) {
        langfuseGeneration.event({
          name: "successful-generation",
          level: "DEFAULT",
          metadata: {
            responseLength: responseText.length,
            parsedObjectType: typeof parsedObject,
            usage,
          },
        });
      }

      return {
        object: parsedObject,
        usage,
      };
    } catch (error) {
      logger.error("Google Gen AI generateObject failed:", error);

      // Log error to langfuse if available
      if (langfuseGeneration) {
        langfuseGeneration.event({
          name: "generation-error",
          level: "ERROR",
          metadata: {
            error: error instanceof Error ? error.message : String(error),
            errorType:
              error instanceof Error ? error.constructor.name : "unknown",
            model,
            temperature,
            maxOutputTokens,
            input: prompt,
            systemInstruction,
            schema,
          },
        });
      }

      throw error;
    }
  }

  /**
   * Generate text using Google Gen AI
   */
  static async generateText({
    model = "gemini-2.5-flash",
    prompt,
    systemInstruction,
    maxOutputTokens = 1000,
    temperature = 0.1,
    langfuseGeneration,
  }: {
    model?: string;
    prompt: string;
    systemInstruction?: string;
    maxOutputTokens?: number;
    temperature?: number;
    langfuseGeneration?: any; // Optional Langfuse generation for tracing
  }): Promise<{ text: string; usage: LanguageModelUsage }> {
    try {
      const ai = await this.getGoogleGenAI();

      // Preprocess the input prompt
      const processedPrompt = preprocessInput(prompt);

      const config: any = {
        maxOutputTokens,
        temperature,
      };

      // Preprocess system instruction if provided
      if (systemInstruction) {
        config.systemInstruction = preprocessInput(systemInstruction);
      }

      // Add metadata to langfuse generation if provided
      if (langfuseGeneration) {
        langfuseGeneration.update({
          metadata: {
            ...langfuseGeneration.metadata,
            actualModel: model,
            configUsed: {
              maxOutputTokens,
              temperature,
            },
            systemInstruction: config.systemInstruction,
          },
        });
      }

      const response = await ai.models.generateContent({
        model,
        contents: processedPrompt,
        config,
      });

      const responseText = response.text || "";

      // Create usage estimate
      const usage: LanguageModelUsage = {
        promptTokens: response.usageMetadata?.promptTokenCount || 0,
        completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata?.totalTokenCount || 0,
      };

      // Log successful generation to langfuse if available
      if (langfuseGeneration) {
        langfuseGeneration.event({
          name: "successful-text-generation",
          level: "DEFAULT",
          metadata: {
            responseLength: responseText.length,
            usage,
          },
        });
      }

      return {
        text: responseText,
        usage,
      };
    } catch (error) {
      logger.error("Google Gen AI generateText failed:", error);

      // Log error to langfuse if available
      if (langfuseGeneration) {
        langfuseGeneration.event({
          name: "text-generation-error",
          level: "ERROR",
          metadata: {
            error: error instanceof Error ? error.message : String(error),
            errorType:
              error instanceof Error ? error.constructor.name : "unknown",
            model,
            temperature,
            maxOutputTokens,
          },
        });
      }

      throw error;
    }
  }
}
