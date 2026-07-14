// Best-of-N Selection - Select best result from multiple raw workers
// Part of ADR-049 Phase 3: Parallel Workers

export interface RawResult {
  workerId: string;
  output: string;
  status: 'done' | 'running' | 'failed';
  completedAt?: string;
}

export interface SelectionResult {
  bestWorkerId: string;
  reason: string;
  allResults: RawResult[];
  selectionMethod: 'chat' | 'automatic';
}

/**
 * Select best result using chat session evaluation
 * Chat injects prompt and waits for JSON response
 */
export async function selectBestResultWithChat(
  terminal: string,
  results: RawResult[],
  criteria: string,
  injectPrompt: (session: string, prompt: string) => Promise<string>
): Promise<SelectionResult> {
  const doneResults = results.filter((r) => r.status === 'done');

  if (doneResults.length === 0) {
    throw new Error('No completed results to select from');
  }

  if (doneResults.length === 1) {
    return {
      bestWorkerId: doneResults[0].workerId,
      reason: 'Only one result available',
      allResults: results,
      selectionMethod: 'automatic',
    };
  }

  // Format results for chat evaluation
  const prompt = `
${doneResults.length} raw worker eredményt kaptam. Válaszd ki a legjobbat.

Kritérium: ${criteria}

${doneResults
  .map(
    (r, i) => `
### Worker ${i + 1} (${r.workerId})
\`\`\`
${r.output.slice(0, 2000)}${r.output.length > 2000 ? '\n... (truncated)' : ''}
\`\`\`
`
  )
  .join('\n')}

Válaszolj JSON formátumban:
{
  "bestWorkerId": "${doneResults[0].workerId}",
  "reason": "Miért ez a legjobb (1-2 mondat)"
}
`;

  const chatSession = `spaceos-${terminal}-chat`;
  const response = await injectPrompt(chatSession, prompt);

  try {
    const selection = extractJson(response);

    return {
      bestWorkerId: selection.bestWorkerId,
      reason: selection.reason,
      allResults: results,
      selectionMethod: 'chat',
    };
  } catch (err) {
    console.error('[BestOfN] Failed to parse chat response, using first result');
    return {
      bestWorkerId: doneResults[0].workerId,
      reason: `Chat selection failed: ${err}. Using first result as fallback.`,
      allResults: results,
      selectionMethod: 'automatic',
    };
  }
}

/**
 * Automatic selection based on simple heuristics
 * Used when chat selection is not available or fails
 */
export function selectBestResultAutomatic(
  results: RawResult[],
  criteria: string
): SelectionResult {
  const doneResults = results.filter((r) => r.status === 'done');

  if (doneResults.length === 0) {
    throw new Error('No completed results to select from');
  }

  if (doneResults.length === 1) {
    return {
      bestWorkerId: doneResults[0].workerId,
      reason: 'Only one result available',
      allResults: results,
      selectionMethod: 'automatic',
    };
  }

  // Simple heuristics based on criteria keywords
  let bestResult: RawResult;
  let reason: string;

  if (criteria.toLowerCase().includes('short') || criteria.toLowerCase().includes('concise')) {
    // Shortest output
    bestResult = doneResults.reduce((shortest, current) =>
      current.output.length < shortest.output.length ? current : shortest
    );
    reason = `Selected shortest output (${bestResult.output.length} chars)`;
  } else if (criteria.toLowerCase().includes('long') || criteria.toLowerCase().includes('detailed')) {
    // Longest output
    bestResult = doneResults.reduce((longest, current) =>
      current.output.length > longest.output.length ? current : longest
    );
    reason = `Selected longest output (${bestResult.output.length} chars)`;
  } else if (criteria.toLowerCase().includes('first') || criteria.toLowerCase().includes('fast')) {
    // First completed
    bestResult = doneResults.reduce((first, current) => {
      const firstTime = first.completedAt ? new Date(first.completedAt).getTime() : Infinity;
      const currentTime = current.completedAt ? new Date(current.completedAt).getTime() : Infinity;
      return currentTime < firstTime ? current : first;
    });
    reason = 'Selected first completed result';
  } else {
    // Default: use first result
    bestResult = doneResults[0];
    reason = 'Using first result (no specific criteria matched)';
  }

  return {
    bestWorkerId: bestResult.workerId,
    reason,
    allResults: results,
    selectionMethod: 'automatic',
  };
}

/**
 * Extract JSON from response (handles markdown code blocks)
 */
function extractJson(response: string): { bestWorkerId: string; reason: string } {
  // Try to find JSON in code blocks first
  const codeBlockMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    return JSON.parse(codeBlockMatch[1]);
  }

  // Try to find raw JSON
  const jsonMatch = response.match(/\{[\s\S]*?"bestWorkerId"[\s\S]*?\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }

  throw new Error('No valid JSON found in response');
}

/**
 * Extract code from worker output (handles [RAW-DONE] marker)
 */
export function extractCodeFromOutput(output: string): string {
  // Remove [RAW-DONE] marker if present
  const cleaned = output.replace(/\[RAW-DONE\]/g, '').trim();

  // Try to extract code blocks
  const codeBlocks = cleaned.match(/```[\s\S]*?```/g);
  if (codeBlocks && codeBlocks.length > 0) {
    return codeBlocks.map((block) => block.replace(/```[^\n]*\n?/g, '')).join('\n\n');
  }

  return cleaned;
}
