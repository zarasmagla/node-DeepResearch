import { ContentListUnion, GenerateContentConfig, GoogleGenAI, SchemaUnion } from "@google/genai";
import { GEMINI_API_KEY } from "../config";
import { logger } from "../winston-logger";
import { LanguageModelUsage } from "ai";

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
            this.googleGenAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        }
        return this.googleGenAI as GoogleGenAI;
    }

    /**
     * Generate structured JSON object using Google Gen AI
     */
    static async generateObject<T>({
        model = "gemini-2.5-flash-preview-05-20",
        prompt,
        systemInstruction,
        schema,
        maxOutputTokens = 1000,
        temperature = 0,
    }: {
        model?: string;
        prompt: ContentListUnion;
        systemInstruction?: string;
        schema: SchemaUnion; // Google Gen AI schema format
        maxOutputTokens?: number;
        temperature?: number;
    }): Promise<{ object: T; usage: LanguageModelUsage }> {
        try {
            const ai = await this.getGoogleGenAI();

            const config: GenerateContentConfig = {
                responseMimeType: "application/json",
                responseSchema: schema,
                maxOutputTokens,
                temperature,
                thinkingConfig: {
                    thinkingBudget: 0,
                },
            };

            if (systemInstruction) {
                config.systemInstruction = systemInstruction;
            }
            console.log('--------------------------------');
            const response = await ai.models.generateContent({
                model,
                contents: prompt,
                config,
            });

            const responseText = response.text || "{}";

            let parsedObject: T;

            try {
                parsedObject = JSON.parse(responseText);
            } catch (parseError) {
                logger.error("Failed to parse Google Gen AI response as JSON:", responseText);
                throw new Error(`Invalid JSON response: ${responseText}`);
            }

            // Create usage estimate (Google Gen AI doesn't provide detailed usage info)
            const usage: LanguageModelUsage = {
                promptTokens: response.usageMetadata?.promptTokenCount || 0,
                completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
                totalTokens: response.usageMetadata?.totalTokenCount || 0
            };
            console.log('--------------------------------22222');
            return {
                object: parsedObject,
                usage
            };

        } catch (error) {
            logger.error("Google Gen AI generateObject failed:", error);
            throw error;
        }
    }

    /**
     * Generate text using Google Gen AI
     */
    static async generateText({
        model = "gemini-2.0-flash-lite",
        prompt,
        systemInstruction,
        maxOutputTokens = 1000,
        temperature = 0.1,
    }: {
        model?: string;
        prompt: string;
        systemInstruction?: string;
        maxOutputTokens?: number;
        temperature?: number;
    }): Promise<{ text: string; usage: LanguageModelUsage }> {
        try {
            const ai = await this.getGoogleGenAI();

            const config: any = {
                maxOutputTokens,
                temperature,
            };

            if (systemInstruction) {
                config.systemInstruction = systemInstruction;
            }

            const response = await ai.models.generateContent({
                model,
                contents: prompt,
                config,
            });

            const responseText = response.text || "";

            // Create usage estimate
            const usage: LanguageModelUsage = {
                promptTokens: response.usageMetadata?.promptTokenCount || 0,
                completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
                totalTokens: response.usageMetadata?.totalTokenCount || 0
            };

            return {
                text: responseText,
                usage
            };

        } catch (error) {
            logger.error("Google Gen AI generateText failed:", error);
            throw error;
        }
    }

} 