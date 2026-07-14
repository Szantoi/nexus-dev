/**
 * Handoff Document Generation (ADR-046 Track C)
 *
 * Generates HANDOFF.md documents for session/task transfer.
 * Inspired by Marveen handoff skill.
 */

import { promises as fs } from 'node:fs';
import * as path from 'path';
import { queryByTier, type TieredMemory } from './pipeline/memoryStore';
import { log as pipelineLog } from './pipeline/common';

const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HandoffDocument {
  purpose: string;
  from: string;
  to: string;
  generatedAt: string;
  goal: string;
  currentProgress: string[];
  whatWorked: string[];
  whatDidntWork: string[];
  nextSteps: string[];
  relatedMemories: TieredMemory[];
  kanbanCards?: string[];
}

export interface GenerateHandoffInput {
  terminal: string;
  purpose: string;
  target?: string;
  output: 'file' | 'message';
  goal?: string;
  currentProgress?: string[];
  whatWorked?: string[];
  whatDidntWork?: string[];
  nextSteps?: string[];
}

export interface GenerateHandoffResult {
  success: boolean;
  filePath?: string;
  document: HandoffDocument;
  markdown: string;
}

// ─── Handoff Generation ──────────────────────────────────────────────────────

/**
 * Generate HANDOFF.md document (ADR-046 Track C)
 */
export async function generateHandoff(
  input: GenerateHandoffInput
): Promise<GenerateHandoffResult> {
  const {
    terminal,
    purpose,
    target,
    output,
    goal,
    currentProgress,
    whatWorked,
    whatDidntWork,
    nextSteps,
  } = input;

  log('handoff', `Generating handoff for ${terminal} (purpose=${purpose})`);

  // Query related memories (hot + warm)
  const relatedMemories = queryByTier(terminal, ['hot', 'warm'], 10);

  // Build handoff document
  const document: HandoffDocument = {
    purpose,
    from: terminal,
    to: target || 'next-session',
    generatedAt: new Date().toISOString(),
    goal: goal || 'Continue task from previous session',
    currentProgress: currentProgress || extractProgressFromMemories(relatedMemories),
    whatWorked: whatWorked || extractSuccessesFromMemories(relatedMemories),
    whatDidntWork: whatDidntWork || extractFailuresFromMemories(relatedMemories),
    nextSteps: nextSteps || extractNextStepsFromMemories(relatedMemories),
    relatedMemories,
  };

  // Generate markdown
  const markdown = buildHandoffMarkdown(document);

  // Save to file if requested
  let filePath: string | undefined;

  if (output === 'file') {
    const handoffDir = `/opt/spaceos/terminals/${terminal}/handoff`;
    await fs.mkdir(handoffDir, { recursive: true });

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `HANDOFF_${timestamp}_${sanitizeFilename(purpose)}.md`;
    filePath = path.join(handoffDir, filename);

    await fs.writeFile(filePath, markdown, 'utf-8');
    log('handoff', `Handoff saved to ${filePath}`);
  }

  return {
    success: true,
    filePath,
    document,
    markdown,
  };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function buildHandoffMarkdown(doc: HandoffDocument): string {
  const lines: string[] = [];

  lines.push(`# HANDOFF.md — ${doc.purpose}`);
  lines.push('');
  lines.push(`> **From:** ${doc.from}`);
  lines.push(`> **To:** ${doc.to}`);
  lines.push(`> **Generated:** ${doc.generatedAt}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Goal
  lines.push('## 🎯 Goal');
  lines.push('');
  lines.push(doc.goal);
  lines.push('');

  // Current Progress
  if (doc.currentProgress.length > 0) {
    lines.push('## ✅ Current Progress');
    lines.push('');
    for (const item of doc.currentProgress) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // What Worked
  if (doc.whatWorked.length > 0) {
    lines.push('## 👍 What Worked');
    lines.push('');
    for (const item of doc.whatWorked) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // What Didn't Work
  if (doc.whatDidntWork.length > 0) {
    lines.push('## 👎 What Didn\'t Work');
    lines.push('');
    for (const item of doc.whatDidntWork) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Next Steps
  if (doc.nextSteps.length > 0) {
    lines.push('## 🚀 Next Steps');
    lines.push('');
    for (const item of doc.nextSteps) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
  }

  // Related Memories
  if (doc.relatedMemories.length > 0) {
    lines.push('## 🧠 Related Memories');
    lines.push('');
    for (const memory of doc.relatedMemories.slice(0, 5)) {
      const typeEmoji = memory.type === 'semantic' ? '💡' : memory.type === 'episodic' ? '📝' : '🔧';
      const tierBadge = `[${memory.tier.toUpperCase()}]`;
      lines.push(`${typeEmoji} ${tierBadge} ${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}`);
      if (memory.context) {
        lines.push(`   _Context: ${memory.context}_`);
      }
      lines.push('');
    }
  }

  // Kanban Cards
  if (doc.kanbanCards && doc.kanbanCards.length > 0) {
    lines.push('## 📋 Kanban Cards');
    lines.push('');
    for (const card of doc.kanbanCards) {
      lines.push(`- ${card}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated by Nexus Knowledge Service (ADR-046 Track C)_');

  return lines.join('\n');
}

function extractProgressFromMemories(memories: TieredMemory[]): string[] {
  // Extract progress-related content from episodic memories
  return memories
    .filter(m => m.type === 'episodic' && m.content.match(/completed|finished|done|implemented/i))
    .slice(0, 3)
    .map(m => m.content.substring(0, 100));
}

function extractSuccessesFromMemories(memories: TieredMemory[]): string[] {
  // Extract success-related content
  return memories
    .filter(m => m.content.match(/success|worked|fixed|solved/i))
    .slice(0, 3)
    .map(m => m.content.substring(0, 100));
}

function extractFailuresFromMemories(memories: TieredMemory[]): string[] {
  // Extract failure-related content
  return memories
    .filter(m => m.content.match(/failed|error|blocked|issue|problem/i))
    .slice(0, 3)
    .map(m => m.content.substring(0, 100));
}

function extractNextStepsFromMemories(memories: TieredMemory[]): string[] {
  // Extract next-step-related content
  return memories
    .filter(m => m.content.match(/next|todo|pending|remaining/i))
    .slice(0, 3)
    .map(m => m.content.substring(0, 100));
}

function sanitizeFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}
