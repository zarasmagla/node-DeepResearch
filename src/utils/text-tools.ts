import {AnswerAction, KnowledgeItem} from "../types";
import i18nJSON from './i18n.json';

export function buildMdFromAnswer(answer: AnswerAction) {
  // Standard footnote regex - updated to handle [^1], [1^], and [1] formats
  const footnoteRegex = /\[(\^(\d+)|(\d+)\^|(\d+))]/g;

  // New regex to catch grouped footnotes like [^1, ^2, ^3] or [^1,^2,^3]
  const groupedFootnoteRegex = /\[\^(\d+)(?:,\s*\^(\d+))+]/g;

  // Helper function to format references
  const formatReferences = (refs: typeof answer.references) => {
    return refs.map((ref, i) => {
      const cleanQuote = ref.exactQuote
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ');

      const citation = `[^${i + 1}]: ${cleanQuote}`;

      if (!ref.url) return citation;

      const domainName = new URL(ref.url).hostname.replace('www.', '');
      return `${citation} [${domainName}](${ref.url})`;
    }).join('\n\n');
  };

  // First case: no references - remove any footnote citations
  if (!answer.references?.length) {
    return answer.answer
      .replace(groupedFootnoteRegex, (match) => {
        // Extract all numbers from the grouped footnote
        const numbers = match.match(/\d+/g) || [];
        return numbers.map(num => `[^${num}]`).join(', ');
      })
      .replace(footnoteRegex, '');
  }

  // Normalize footnotes first (convert [1^] to [^1] format and [1] to [^1] format)
  let processedAnswer = answer.answer
    .replace(/\[(\d+)\^]/g, (_, num) => `[^${num}]`)
    .replace(/\[(\d+)]/g, (_, num) => `[^${num}]`);

  // Fix grouped footnotes
  processedAnswer = processedAnswer.replace(groupedFootnoteRegex, (match) => {
    // Extract all numbers from the grouped footnote
    const numbers = match.match(/\d+/g) || [];
    return numbers.map(num => `[^${num}]`).join(', ');
  });

  // Now extract all footnotes from the processed answer
  const footnotes: string[] = [];
  let match;
  const standardFootnoteRegex = /\[\^(\d+)]/g; // Use standard format after normalization
  while ((match = standardFootnoteRegex.exec(processedAnswer)) !== null) {
    footnotes.push(match[1]);
  }

  // Remove footnote markers that don't have corresponding references
  let cleanedAnswer = processedAnswer;
  footnotes.forEach(footnote => {
    const footnoteNumber = parseInt(footnote);
    if (footnoteNumber > answer.references.length) {
      const footnoteRegexExact = new RegExp(`\\[\\^${footnoteNumber}\\]`, 'g');
      cleanedAnswer = cleanedAnswer.replace(footnoteRegexExact, '');
    }
  });

  // Get valid footnotes after cleaning
  const validFootnotes: string[] = [];
  while ((match = standardFootnoteRegex.exec(cleanedAnswer)) !== null) {
    validFootnotes.push(match[1]);
  }

  // No footnotes in answer but we have references - append them at the end
  if (validFootnotes.length === 0) {
    const appendedCitations = Array.from(
      {length: answer.references.length},
      (_, i) => `[^${i + 1}]`
    ).join('');

    const references = formatReferences(answer.references);

    return `
${cleanedAnswer}

⁜${appendedCitations}

${references}
`.trim();
  }

  // Check if correction is needed
  const needsCorrection =
    (validFootnotes.length === answer.references.length && validFootnotes.every(n => n === validFootnotes[0])) ||
    (validFootnotes.every(n => n === validFootnotes[0]) && parseInt(validFootnotes[0]) > answer.references.length) ||
    (validFootnotes.length > 0 && validFootnotes.every(n => parseInt(n) > answer.references.length));

  // New case: we have more references than footnotes
  if (answer.references.length > validFootnotes.length && !needsCorrection) {
    // Get the used indices
    const usedIndices = new Set(validFootnotes.map(n => parseInt(n)));

    // Create citations for unused references
    const unusedReferences = Array.from(
      {length: answer.references.length},
      (_, i) => !usedIndices.has(i + 1) ? `[^${i + 1}]` : ''
    ).join('');

    return `
${cleanedAnswer} 

⁜${unusedReferences}

${formatReferences(answer.references)}
`.trim();
  }

  if (!needsCorrection) {
    return `
${cleanedAnswer}

${formatReferences(answer.references)}
`.trim();
  }

  // Apply correction: sequentially number the footnotes
  let currentIndex = 0;
  const correctedAnswer = cleanedAnswer.replace(standardFootnoteRegex, () =>
    `[^${++currentIndex}]`
  );

  return `
${correctedAnswer}

${formatReferences(answer.references)}
`.trim();
}

export const removeExtraLineBreaks = (text: string) => {
  return text.replace(/\n{2,}/gm, '\n\n');
}

export function chooseK(a: string[], k: number) {
  // randomly sample k from `a` without repitition
  return a.sort(() => 0.5 - Math.random()).slice(0, k);
}

export function removeHTMLtags(text: string) {
  return text.replace(/<[^>]*>?/gm, '');
}

export function removeAllLineBreaks(text: string) {
  return text.replace(/(\r\n|\n|\r)/gm, " ");
}

export function getI18nText(key: string, lang = 'en', params: Record<string, string> = {}) {
  // 获取i18n数据
  const i18nData = i18nJSON as Record<string, any>;
  // 确保语言代码存在，如果不存在则使用英语作为后备
  if (!i18nData[lang]) {
    console.error(`Language '${lang}' not found, falling back to English.`);
    lang = 'en';
  }

  // 获取对应语言的文本
  let text = i18nData[lang][key];

  // 如果文本不存在，则使用英语作为后备
  if (!text) {
    console.error(`Key '${key}' not found for language '${lang}', falling back to English.`);
    text = i18nData['en'][key];

    // 如果英语版本也不存在，则返回键名
    if (!text) {
      console.error(`Key '${key}' not found for English either.`);
      return key;
    }
  }

  // 替换模板中的变量
  if (params) {
    Object.keys(params).forEach(paramKey => {
      text = text.replace(`\${${paramKey}}`, params[paramKey]);
    });
  }

  return text;
}

export function smartMergeStrings(str1: string, str2: string): string {
  // If either string is empty, return the other
  if (!str1) return str2;
  if (!str2) return str1;

  // Check if one string is entirely contained within the other
  if (str1.includes(str2)) return str1;
  if (str2.includes(str1)) return str2;

  // Find the maximum possible overlap length
  const maxOverlap = Math.min(str1.length, str2.length);
  let bestOverlapLength = 0;

  // Check for overlaps starting from the largest possible
  for (let overlapLength = maxOverlap; overlapLength > 0; overlapLength--) {
    // Get the end of first string with the current overlap length
    const endOfStr1 = str1.slice(str1.length - overlapLength);
    // Get the beginning of second string with the current overlap length
    const startOfStr2 = str2.slice(0, overlapLength);

    // If they match, we've found our overlap
    if (endOfStr1 === startOfStr2) {
      bestOverlapLength = overlapLength;
      break;
    }
  }

  // Merge the strings using the best overlap
  if (bestOverlapLength > 0) {
    return str1.slice(0, str1.length - bestOverlapLength) + str2;
  } else {
    // No overlap found, concatenate normally
    return str1 + str2;
  }
}


export function fixCodeBlockIndentation(markdownText: string): string {
  // Track the state of code blocks and their indentation
  const lines = markdownText.split('\n');
  const result: string[] = [];

  // Track open code blocks and their indentation
  const codeBlockStack: { indent: string; language: string; listIndent: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if the line potentially contains a code fence marker
    if (line.trimStart().startsWith('```')) {
      const indent = line.substring(0, line.indexOf('```'));
      const restOfLine = line.trimStart().substring(3).trim();

      if (codeBlockStack.length === 0) {
        // This is an opening code fence

        // Determine if we're in a list context by looking at previous lines
        let listIndent = "";
        if (i > 0) {
          // Look back up to 3 lines to find list markers
          for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
            const prevLine = lines[j];
            // Check for list markers like *, -, 1., etc.
            if (/^\s*(?:[*\-+]|\d+\.)\s/.test(prevLine)) {
              // Extract the list's base indentation
              const match = prevLine.match(/^(\s*)/);
              if (match) {
                listIndent = match[1];
                break;
              }
            }
          }
        }

        codeBlockStack.push({indent, language: restOfLine, listIndent});
        result.push(line);
      } else {
        // This is a closing code fence
        const openingBlock = codeBlockStack.pop();

        if (openingBlock) {
          // Replace the indentation with the one from the opening fence
          result.push(`${openingBlock.indent}\`\`\``);
        } else {
          // Something went wrong, just keep the line as is
          result.push(line);
        }
      }
    } else if (codeBlockStack.length > 0) {
      // Inside a code block - handle indentation
      const openingBlock = codeBlockStack[codeBlockStack.length - 1];

      if (line.trim().length > 0) {
        // For non-empty lines
        const trimmedLine = line.trimStart();

        // If we're in a list context, maintain proper indentation
        if (openingBlock.listIndent) {
          // For code blocks in lists, we need to preserve the list indentation plus the code fence indentation
          // The total indentation should be at least listIndent + some standard indentation (usually 4 spaces)
          const codeIndent = openingBlock.indent.length > openingBlock.listIndent.length ?
            openingBlock.indent :
            openingBlock.listIndent + "    ";

          result.push(`${codeIndent}${trimmedLine}`);
        } else {
          // Not in a list, use the opening fence indentation
          result.push(`${openingBlock.indent}${trimmedLine}`);
        }
      } else {
        // For empty lines, just keep them as is
        result.push(line);
      }
    } else {
      // Not in a code block, just add it as is
      result.push(line);
    }
  }

  return result.join('\n');
}

export function getKnowledgeStr(allKnowledge: KnowledgeItem[]) {
  return allKnowledge.map((k, idx) => {
    const aMsg = `
<knowledge-${idx + 1}>
${k.question}

${k.updated && (k.type === 'url' || k.type === 'side-info') ? `
<knowledge-datetime>
${k.updated}
</knowledge-datetime>
` : ''}

${k.references && k.type === 'url' ? `
<knowledge-url>
${k.references[0]}
</knowledge-url>
` : ''}


${k.answer}
</knowledge-${idx + 1}>
      `.trim();

    return removeExtraLineBreaks(aMsg);
  })
}

