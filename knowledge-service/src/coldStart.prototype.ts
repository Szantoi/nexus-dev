/**
 * Cold Start Context Builder for SpaceOS Terminals
 *
 * Implements Marveen-style cold start strategy:
 * - No session history reload
 * - Instead: intelligent memory system + knowledge retrieval
 *
 * Session Start Flow:
 *   1. Read CLAUDE.md + NEXUS_USAGE.md
 *   2. Query Memory API (hot/warm memories)
 *   3. Build context from relevant memories
 *   4. Inject context into session
 *
 * Memory Tiers:
 *   - hot: 24-48 hours (active task context)
 *   - warm: 1-2 weeks (stable preferences)
 *   - cold: long-term (architectural decisions)
 *   - shared: eternal (cross-agent knowledge)
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { readMemory, getIdentity, PRIMARY_TERMINALS } from './identity';

// Base paths
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const MEMORY_DIR = path.join(SPACEOS_ROOT, 'docs/memory');
const KNOWLEDGE_DIR = path.join(SPACEOS_ROOT, 'docs/knowledge');
const SHARED_MEMORY_PATH = path.join(MEMORY_DIR, '_shared.md');

// Memory tier configuration
export interface MemoryTier {
  name: 'hot' | 'warm' | 'cold' | 'shared';
  maxAge: number; // hours
  priority: number; // higher = more important
}

export const MEMORY_TIERS: MemoryTier[] = [
  { name: 'hot', maxAge: 48, priority: 100 },
  { name: 'warm', maxAge: 336, priority: 50 }, // 2 weeks
  { name: 'cold', maxAge: 8760, priority: 25 }, // 1 year
  { name: 'shared', maxAge: Infinity, priority: 75 },
];

// Memory entry structure
export interface MemoryEntry {
  content: string;
  timestamp: Date;
  tier: 'hot' | 'warm' | 'cold' | 'shared';
  terminal: string;
  type: 'semantic' | 'episodic' | 'procedural';
}

// Cold start context structure
export interface ColdStartContext {
  terminal: string;
  timestamp: Date;
  memories: MemoryEntry[];
  knowledgeDocs: string[];
  contextBlock: string;
  tokenEstimate: number;
}

/**
 * Parse memory file into entries with tier classification
 */
export function parseMemoryContent(content: string, terminal: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const now = new Date();

  // Split by separator (---)
  const sections = content.split(/\n---\n/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract timestamp if present
    const timestampMatch = trimmed.match(/_Updated:\s*(\d{4}-\d{2}-\d{2})/);
    const timestamp = timestampMatch
      ? new Date(timestampMatch[1])
      : new Date(now.getTime() - 24 * 60 * 60 * 1000); // Default: 1 day ago

    // Calculate age in hours
    const ageHours = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

    // Determine tier based on age
    let tier: 'hot' | 'warm' | 'cold' = 'cold';
    if (ageHours <= 48) {
      tier = 'hot';
    } else if (ageHours <= 336) {
      tier = 'warm';
    }

    // Detect memory type from content
    let type: 'semantic' | 'episodic' | 'procedural' = 'semantic';
    if (trimmed.includes('Session') || trimmed.includes('session') || trimmed.includes('completed')) {
      type = 'episodic';
    } else if (trimmed.includes('To deploy') || trimmed.includes('run ') || trimmed.includes('command')) {
      type = 'procedural';
    }

    entries.push({
      content: trimmed,
      timestamp,
      tier,
      terminal,
      type,
    });
  }

  return entries;
}

/**
 * Read shared memory (cross-agent knowledge)
 */
export async function readSharedMemory(): Promise<MemoryEntry[]> {
  try {
    const content = await fs.readFile(SHARED_MEMORY_PATH, 'utf-8');
    const entries = parseMemoryContent(content, '_shared');
    // Override tier to 'shared'
    return entries.map(e => ({ ...e, tier: 'shared' as const }));
  } catch {
    return [];
  }
}

/**
 * Get relevant knowledge docs for a terminal
 */
export async function getRelevantKnowledge(terminal: string): Promise<string[]> {
  const docs: string[] = [];

  // Terminal-specific context
  const contextPath = path.join(KNOWLEDGE_DIR, 'context', `${terminal.toUpperCase()}_CONTEXT.md`);
  try {
    const content = await fs.readFile(contextPath, 'utf-8');
    docs.push(`## ${terminal.toUpperCase()} Context\n\n${content.slice(0, 2000)}`);
  } catch {
    // Context file doesn't exist
  }

  // Knowledge index (always include summary)
  const indexPath = path.join(KNOWLEDGE_DIR, 'INDEX.md');
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    // Only include first 1000 chars of index
    docs.push(`## Knowledge Index\n\n${content.slice(0, 1000)}`);
  } catch {
    // Index doesn't exist
  }

  return docs;
}

/**
 * Build cold start context for a terminal
 * This is the main entry point for session initialization
 */
export async function buildColdStartContext(terminal: string): Promise<ColdStartContext> {
  const now = new Date();
  const memories: MemoryEntry[] = [];

  // 1. Read terminal memory
  const terminalMemory = await readMemory(terminal);
  if (terminalMemory) {
    const entries = parseMemoryContent(terminalMemory, terminal);
    memories.push(...entries);
  }

  // 2. Read shared memory
  const sharedMemories = await readSharedMemory();
  memories.push(...sharedMemories);

  // 3. Filter and sort by tier priority and recency
  const sortedMemories = memories
    .filter(m => {
      // Only include hot and warm for session start
      // Cold and shared are lower priority
      const tier = MEMORY_TIERS.find(t => t.name === m.tier);
      return tier && (m.tier === 'hot' || m.tier === 'warm' || m.tier === 'shared');
    })
    .sort((a, b) => {
      const tierA = MEMORY_TIERS.find(t => t.name === a.tier);
      const tierB = MEMORY_TIERS.find(t => t.name === b.tier);
      // Sort by tier priority (desc), then by timestamp (desc)
      const priorityDiff = (tierB?.priority || 0) - (tierA?.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return b.timestamp.getTime() - a.timestamp.getTime();
    });

  // 4. Get relevant knowledge docs
  const knowledgeDocs = await getRelevantKnowledge(terminal);

  // 5. Build context block
  const contextBlock = buildContextBlock(terminal, sortedMemories, knowledgeDocs);

  // 6. Estimate tokens (rough: 1 token ~ 4 chars)
  const tokenEstimate = Math.ceil(contextBlock.length / 4);

  return {
    terminal,
    timestamp: now,
    memories: sortedMemories,
    knowledgeDocs,
    contextBlock,
    tokenEstimate,
  };
}

/**
 * Build the actual context block to inject into session
 */
function buildContextBlock(
  terminal: string,
  memories: MemoryEntry[],
  knowledgeDocs: string[]
): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Cold Start Context for ${terminal.toUpperCase()}`);
  sections.push(`_Generated: ${new Date().toISOString()}_`);
  sections.push('');

  // Hot memories (most important)
  const hotMemories = memories.filter(m => m.tier === 'hot');
  if (hotMemories.length > 0) {
    sections.push('## Hot Memories (Active Context)');
    sections.push('');
    for (const mem of hotMemories.slice(0, 5)) { // Max 5 hot memories
      sections.push(mem.content);
      sections.push('');
    }
  }

  // Warm memories
  const warmMemories = memories.filter(m => m.tier === 'warm');
  if (warmMemories.length > 0) {
    sections.push('## Warm Memories (Stable Preferences)');
    sections.push('');
    for (const mem of warmMemories.slice(0, 3)) { // Max 3 warm memories
      sections.push(mem.content);
      sections.push('');
    }
  }

  // Shared memories
  const sharedMemories = memories.filter(m => m.tier === 'shared');
  if (sharedMemories.length > 0) {
    sections.push('## Shared Knowledge (Cross-Agent)');
    sections.push('');
    for (const mem of sharedMemories.slice(0, 3)) { // Max 3 shared memories
      sections.push(mem.content);
      sections.push('');
    }
  }

  // Knowledge docs
  if (knowledgeDocs.length > 0) {
    sections.push('## Relevant Knowledge');
    sections.push('');
    for (const doc of knowledgeDocs) {
      sections.push(doc);
      sections.push('');
    }
  }

  return sections.join('\n');
}

/**
 * Get cold start context formatted for injection
 * Returns a compact version suitable for tmux send-keys
 */
export async function getColdStartInjection(terminal: string): Promise<string> {
  const context = await buildColdStartContext(terminal);

  // If no memories, return minimal context
  if (context.memories.length === 0 && context.knowledgeDocs.length === 0) {
    return `[COLD START] ${terminal.toUpperCase()} session initialized. No prior memories found.`;
  }

  // Build injection message
  const lines: string[] = [
    `[COLD START] ${terminal.toUpperCase()} session context loaded.`,
    `Memories: ${context.memories.length} (hot: ${context.memories.filter(m => m.tier === 'hot').length}, warm: ${context.memories.filter(m => m.tier === 'warm').length})`,
  ];

  // Add hot memory summaries (keep it short for injection)
  const hotMemories = context.memories.filter(m => m.tier === 'hot');
  if (hotMemories.length > 0) {
    lines.push('Recent context:');
    for (const mem of hotMemories.slice(0, 3)) {
      // Truncate each memory to first 100 chars
      const summary = mem.content.replace(/\n/g, ' ').slice(0, 100);
      lines.push(`- ${summary}...`);
    }
  }

  return lines.join(' | ');
}

/**
 * Save a memory entry with proper tier assignment
 */
export async function saveMemory(
  terminal: string,
  content: string,
  type: 'semantic' | 'episodic' | 'procedural' = 'semantic'
): Promise<{ success: boolean; tier: string }> {
  const now = new Date();
  const timestamp = now.toISOString().split('T')[0];

  // Format entry
  const entry = `_Updated: ${timestamp}_\n_Type: ${type}_\n\n${content}`;

  // Read existing memory
  const memoryPath = path.join(MEMORY_DIR, `${terminal}.md`);
  let existing = '';
  try {
    existing = await fs.readFile(memoryPath, 'utf-8');
  } catch {
    // No existing memory
  }

  // Append new entry
  const newContent = existing.trim() + '\n\n---\n\n' + entry;

  // Ensure directory exists
  await fs.mkdir(MEMORY_DIR, { recursive: true });

  // Write
  await fs.writeFile(memoryPath, newContent, 'utf-8');

  return {
    success: true,
    tier: 'hot', // New memories start as hot
  };
}

/**
 * Run memory decay - promote hot to warm, warm to cold
 * Should be called periodically (e.g., daily)
 */
export async function runMemoryDecay(): Promise<{ processed: number; decayed: number }> {
  let processed = 0;
  let decayed = 0;

  for (const terminal of PRIMARY_TERMINALS) {
    const memory = await readMemory(terminal);
    if (!memory) continue;

    const entries = parseMemoryContent(memory, terminal);
    processed += entries.length;

    // Count entries that have decayed
    const hotCount = entries.filter(e => e.tier === 'hot').length;
    const coldCount = entries.filter(e => e.tier === 'cold').length;
    decayed += coldCount;
  }

  return { processed, decayed };
}

/**
 * Generate daily digest from recent memories
 */
export async function generateDailyDigest(terminal: string): Promise<string | null> {
  const memory = await readMemory(terminal);
  if (!memory) return null;

  const entries = parseMemoryContent(memory, terminal);
  const hotEntries = entries.filter(e => e.tier === 'hot');

  if (hotEntries.length === 0) return null;

  const digest = [
    `# Daily Digest for ${terminal.toUpperCase()}`,
    `_Generated: ${new Date().toISOString().split('T')[0]}_`,
    '',
    '## Recent Activity',
    '',
  ];

  for (const entry of hotEntries.slice(0, 5)) {
    const summary = entry.content.split('\n')[0].slice(0, 80);
    digest.push(`- ${summary}`);
  }

  return digest.join('\n');
}
