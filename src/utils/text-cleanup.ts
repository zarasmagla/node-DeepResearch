/**
 * Cleans up excessive line breaks from text responses
 * This fixes the known issue where Gemini generates responses with hundreds of unnecessary line breaks
 */
export function cleanupLineBreaks(text: string): string {
    if (!text) return text;

    // Replace multiple consecutive line breaks (more than 2) with just 2 line breaks
    // This preserves intentional paragraph breaks while removing excessive ones
    let cleaned = text.replace(/\n{3,}/g, '\n\n');

    // Also handle cases where there are spaces between line breaks
    cleaned = cleaned.replace(/(\n\s*){3,}/g, '\n\n');

    // Remove trailing whitespace from each line
    cleaned = cleaned.replace(/[ \t]+$/gm, '');

    // Remove leading/trailing whitespace from the entire text
    cleaned = cleaned.trim();

    return cleaned;
}

/**
 * Normalizes whitespace in text while preserving intentional formatting
 */
export function normalizeWhitespace(text: string): string {
    if (!text) return text;

    // Clean up line breaks first
    let normalized = cleanupLineBreaks(text);

    // Remove excessive spaces (more than 2 consecutive spaces)
    normalized = normalized.replace(/[ ]{3,}/g, '  ');

    // Remove tabs and replace with spaces
    normalized = normalized.replace(/\t/g, '  ');

    return normalized;
}

/**
 * Cleans up JSON strings that might have formatting issues
 */
export function cleanupJsonString(jsonString: string): string {
    if (!jsonString) return jsonString;

    // Remove excessive line breaks that might break JSON parsing
    let cleaned = jsonString.replace(/\n{2,}/g, '\n');

    // Remove line breaks inside JSON strings that shouldn't be there
    cleaned = cleaned.replace(/("\w+"):\s*\n\s*"/g, '$1: "');

    // Fix spacing around JSON syntax
    cleaned = cleaned.replace(/\s*{\s*/g, '{ ');
    cleaned = cleaned.replace(/\s*}\s*/g, ' }');
    cleaned = cleaned.replace(/\s*\[\s*/g, '[ ');
    cleaned = cleaned.replace(/\s*\]\s*/g, ' ]');

    return cleaned.trim();
} 