import {AnswerAction} from "../types";

export function buildMdFromAnswer(answer: AnswerAction) {
  // Standard footnote regex
  const footnoteRegex = /\[\^(\d+)]/g;

  // New regex to catch grouped footnotes like [^1, ^2, ^3] or [^1,^2,^3]
  const groupedFootnoteRegex = /\[\^(\d+)(?:,\s*\^(\d+))+]/g;

  // Helper function to format references
  const formatReferences = (refs: typeof answer.references) => {
    return refs.map((ref, i) => {
      const cleanQuote = ref.exactQuote
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ');

      const citation = `[^${i + 1}]: ${cleanQuote}`;

      if (!ref.url?.startsWith('http')) return citation;

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

  // Fix grouped footnotes first
  const processedAnswer = answer.answer.replace(groupedFootnoteRegex, (match) => {
    // Extract all numbers from the grouped footnote
    const numbers = match.match(/\d+/g) || [];
    return numbers.map(num => `[^${num}]`).join(', ');
  });

  // Now extract all footnotes from the processed answer
  const footnotes: string[] = [];
  let match;
  while ((match = footnoteRegex.exec(processedAnswer)) !== null) {
    footnotes.push(match[1]);
  }

  // No footnotes in answer but we have references - append them at the end
  if (footnotes.length === 0) {
    const appendedCitations = Array.from(
      {length: answer.references.length},
      (_, i) => `[^${i + 1}]`
    ).join('');

    const references = formatReferences(answer.references);

    return `
${processedAnswer}

⁜${appendedCitations}

${references}
`.trim();
  }

  // Check if correction is needed
  const needsCorrection =
    (footnotes.length === answer.references.length && footnotes.every(n => n === footnotes[0])) ||
    (footnotes.every(n => n === footnotes[0]) && parseInt(footnotes[0]) > answer.references.length) ||
    (footnotes.length > 0 && footnotes.every(n => parseInt(n) > answer.references.length));

  // New case: we have more references than footnotes
  if (answer.references.length > footnotes.length && !needsCorrection) {
    // Get the used indices
    const usedIndices = new Set(footnotes.map(n => parseInt(n)));

    // Create citations for unused references
    const unusedReferences = Array.from(
      {length: answer.references.length},
      (_, i) => !usedIndices.has(i + 1) ? `[^${i + 1}]` : ''
    ).join('');

    return `
${processedAnswer} 

⁜${unusedReferences}

${formatReferences(answer.references)}
`.trim();
  }

  if (!needsCorrection) {
    return `
${processedAnswer}

${formatReferences(answer.references)}
`.trim();
  }

  // Apply correction: sequentially number the footnotes
  let currentIndex = 0;
  const correctedAnswer = processedAnswer.replace(footnoteRegex, () =>
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
