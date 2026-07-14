/**
 * Session Context Transfer
 *
 * Transfers context between terminals via inbox messages.
 * ROI: 30min per session
 * Response time: <200ms
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface ContextTransferParams {
  fromTerminal: string;
  toTerminal: string;
  contextType: 'research_summary' | 'code_audit' | 'knowledge_synthesis';
  includeFiles?: string[];
  summary?: string;
}

export interface ContextTransferResult {
  success: boolean;
  messageId?: string;
  summary?: string;
  inboxFile?: string;
  error?: string;
  fileCount: number;
  transferredBytes: number;
}

const VALID_TERMINALS = ['root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'];

async function createInboxMessage(
  toTerminal: string,
  messageId: string,
  content: string
): Promise<boolean> {
  try {
    const inboxDir = path.join('/opt/spaceos', 'terminals', toTerminal, 'inbox');
    await fs.mkdir(inboxDir, { recursive: true });
    const fileName = `${messageId}.md`;
    const filePath = path.join(inboxDir, fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    return true;
  } catch (err) {
    console.warn('[SessionContextTransfer] Failed to create inbox message:', err);
    return false;
  }
}

export async function transferSessionContext(params: ContextTransferParams): Promise<ContextTransferResult> {
  if (!VALID_TERMINALS.includes(params.fromTerminal) || !VALID_TERMINALS.includes(params.toTerminal)) {
    return {
      success: false,
      error: `Invalid terminal: ${params.fromTerminal} or ${params.toTerminal}`,
      fileCount: 0,
      transferredBytes: 0,
    };
  }

  if (params.fromTerminal === params.toTerminal) {
    return {
      success: false,
      error: 'Cannot transfer to same terminal',
      fileCount: 0,
      transferredBytes: 0,
    };
  }

  // Generate message ID and path
  const now = new Date();
  const timestamp = now.toISOString().split('T')[0];
  const messageSeq = Math.floor(Math.random() * 1000);
  const messageId = `${timestamp}_${messageSeq}_context-transfer`;
  const inboxFile = `terminals/${params.toTerminal}/inbox/${messageId}.md`;

  // Build message content with frontmatter
  const template = getContextTemplates()[params.contextType];
  const content = `---
id: ${messageId}
from: ${params.fromTerminal}
to: ${params.toTerminal}
type: info
status: UNREAD
created: ${now.toISOString()}
---

# Context Transfer: ${params.contextType}

**From:** ${params.fromTerminal}
**Type:** ${params.contextType}

## Summary

${params.summary || 'No summary provided'}

## Transferred Files

${params.includeFiles?.length ? params.includeFiles.map(f => `- \`${f}\``).join('\n') : 'No files transferred'}

## Template

\`\`\`
${template}
\`\`\`
`;

  const success = await createInboxMessage(params.toTerminal, messageId, content);
  const transferredBytes = content.length;

  return {
    success,
    messageId: success ? messageId : undefined,
    summary: success ? `Transferred context to ${params.toTerminal}` : undefined,
    inboxFile: success ? inboxFile : undefined,
    error: success ? undefined : 'Failed to create inbox message',
    fileCount: params.includeFiles?.length || 0,
    transferredBytes,
  };
}

export function getContextTemplates(): Record<string, string> {
  return {
    research_summary: `# Research Summary\n\n## Findings\n- [Finding 1]\n\n## Key Insights\n[Insights here]`,
    code_audit: `# Code Audit Report\n\n## Quality Metrics\n- [Metrics here]`,
    knowledge_synthesis: `# Knowledge Synthesis\n\n## Pattern Analysis\n- [Pattern 1]`,
  };
}

export function validateContextTransfer(params: ContextTransferParams): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!params.fromTerminal || !params.toTerminal) {
    errors.push('fromTerminal and toTerminal are required');
  }

  if (params.fromTerminal === params.toTerminal) {
    errors.push('Cannot transfer to same terminal');
  }

  const validTypes = ['research_summary', 'code_audit', 'knowledge_synthesis'];
  if (!validTypes.includes(params.contextType)) {
    errors.push(`Invalid contextType: ${params.contextType}`);
  }

  if (params.includeFiles && params.includeFiles.length > 20) {
    errors.push('Maximum 20 files can be transferred at once');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}
