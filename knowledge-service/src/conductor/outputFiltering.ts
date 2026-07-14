// outputFiltering.ts - Subagent Output Filtering
// Goal Persistence Pattern Phase 3 (2026-07-04)
//
// Extracts goal-relevant summaries from terminal DONE outbox messages.
// Prevents "inherited drift" where detailed technical content distracts
// the Conductor from the main epic goal.

import * as fs from 'fs';
import { loadActiveEpic, getEpicProgress } from './epicManager';

/**
 * Extract goal-relevant summary from DONE outbox content
 *
 * Full DONE content is preserved in the file, but Conductor only sees
 * a filtered summary that focuses on:
 * - What was accomplished (task completion)
 * - Epic progress impact
 * - Next steps (if any)
 *
 * Technical details are filtered out to prevent context pollution.
 */
export function extractGoalRelevantSummary(
  doneContent: string,
  taskId: string,
  terminal: string
): string {
  // Parse frontmatter to get basic info
  const summaryMatch = doneContent.match(/##\s*(?:Summary|Összefoglaló|Eredmény)[:\s]*\n([\s\S]*?)(?:\n##|\n---|\n\*\*|$)/i);
  const filesChangedMatch = doneContent.match(/##\s*(?:Files Changed|Módosított fájlok)[:\s]*\n([\s\S]*?)(?:\n##|\n---|\n\*\*|$)/i);
  const nextStepsMatch = doneContent.match(/##\s*(?:Next Steps|Következő lépések)[:\s]*\n([\s\S]*?)(?:\n##|\n---|\n\*\*|$)/i);

  // Get epic context
  const activeEpic = loadActiveEpic();
  const progress = activeEpic ? getEpicProgress(activeEpic) : 0;

  // Build filtered summary
  let summary = `## ✅ DONE Summary (Filtered)

**Task:** \`${taskId}\`
**Terminal:** \`${terminal}\`
`;

  if (activeEpic) {
    summary += `**Epic:** \`${activeEpic.id}\` (${progress}%)\n`;
  }

  summary += '\n---\n\n';

  // Extract summary (max 200 chars to prevent context pollution)
  if (summaryMatch && summaryMatch[1]) {
    const cleanSummary = summaryMatch[1]
      .trim()
      .replace(/\n+/g, ' ')
      .substring(0, 200);
    summary += `### Mi történt\n${cleanSummary}${cleanSummary.length >= 200 ? '...' : ''}\n\n`;
  } else {
    summary += `### Mi történt\nTask \`${taskId}\` befejezve.\n\n`;
  }

  // Files changed (just count, not full list)
  if (filesChangedMatch && filesChangedMatch[1]) {
    const files = filesChangedMatch[1]
      .split('\n')
      .filter(line => line.trim().startsWith('-') || line.trim().match(/^\d+\./));
    summary += `### Változások\n${files.length} fájl módosítva\n\n`;
  }

  // Next steps (if any, max 150 chars)
  if (nextStepsMatch && nextStepsMatch[1]) {
    const cleanNext = nextStepsMatch[1]
      .trim()
      .replace(/\n+/g, ' ')
      .substring(0, 150);
    summary += `### Következő\n${cleanNext}${cleanNext.length >= 150 ? '...' : ''}\n\n`;
  }

  summary += `---
*Filtered Output — Goal Persistence Pattern*
*Teljes részletek: \`terminals/${terminal}/outbox/\`*`;

  return summary;
}

/**
 * Check if content should be filtered
 * Returns true if content is longer than threshold and contains technical details
 */
export function shouldFilterContent(content: string): boolean {
  // Filter if content is > 500 chars
  if (content.length < 500) {
    return false;
  }

  // Filter if contains code blocks (technical details)
  if (content.includes('```')) {
    return true;
  }

  // Filter if contains many file paths
  const filePathCount = (content.match(/[a-zA-Z0-9_/-]+\.(ts|js|cs|md|json|yaml|tsx|jsx)/g) || []).length;
  if (filePathCount > 5) {
    return true;
  }

  // Filter if very long
  if (content.length > 1500) {
    return true;
  }

  return false;
}

/**
 * Process DONE content and return filtered version if needed
 */
export function filterDoneOutput(
  doneContent: string,
  taskId: string,
  terminal: string
): { filtered: boolean; content: string } {
  if (!shouldFilterContent(doneContent)) {
    return { filtered: false, content: doneContent };
  }

  const filteredSummary = extractGoalRelevantSummary(doneContent, taskId, terminal);
  return { filtered: true, content: filteredSummary };
}
