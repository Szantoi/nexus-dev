/**
 * Knowledge Loader - Domain-specific memory loading
 *
 * Automatically loads relevant domain memory files based on task content.
 * Part of ADR-049 Phase 3: Parallel Workers implementation.
 */

import * as fs from 'fs';
import * as path from 'path';

const TERMINALS_DIR = process.env.TERMINALS_DIR || '/opt/spaceos/terminals';

// Domain detection patterns - BACKEND
const BACKEND_DOMAIN_PATTERNS: Record<string, RegExp[]> = {
  'kernel': [
    /\bkernel\b/i,
    /\bauth\b/i,
    /\brbac\b/i,
    /\btenant/i,
    /\bfsm\b/i,
    /\baudit\b/i,
    /\bescrow\b/i,
    /\bmulti-tenant/i,
    /\bidentity\b/i,
    /\bkeycloak\b/i,
  ],
  'joinery': [
    /\bjoinery\b/i,
    /\bdoor\b/i,
    /\bajtó\b/i,
    /\bablak\b/i,
    /\bdoorstar\b/i,
    /\bparametric/i,
    /\bgyártási lap/i,
    /\bmanufacturing sheet/i,
  ],
  'cutting': [
    /\bcutting\b/i,
    /\bszabász/i,
    /\bquote/i,
    /\bnesting\b/i,
    /\bcnc\b/i,
    /\blap\b/i,
    /\banyag/i,
    /\bpublic.*request/i,
    /\btracking/i,
  ],
  'orchestrator': [
    /\borchestrator\b/i,
    /\bbff\b/i,
    /\btool.?call/i,
    /\bllm\b/i,
    /\bgateway\b/i,
    /\brouting\b/i,
    /\bnode\.?js\b/i,
  ],
  'nexus': [
    /\bnexus\b/i,
    /\bmcp\b/i,
    /\bknowledge.?service/i,
    /\bworker/i,
    /\bparallel/i,
    /\bsession/i,
    /\bterminal/i,
    /\bmailbox/i,
    /\bmemory.?store/i,
  ],
};

// Domain detection patterns - FRONTEND
const FRONTEND_DOMAIN_PATTERNS: Record<string, RegExp[]> = {
  'portal': [
    /\bportal\b/i,
    /\bquote\b/i,
    /\bform\b/i,
    /\bcustomer\b/i,
    /\btrack/i,
    /\bpublic/i,
    /\border/i,
    /\bügyfél/i,
  ],
  'datahaven': [
    /\bdatahaven\b/i,
    /\bdashboard\b/i,
    /\bterminal/i,
    /\bkanban\b/i,
    /\bsse\b/i,
    /\bplanning\b/i,
    /\bmonitoring\b/i,
    /\bagent/i,
  ],
  'industrial': [
    /\bindustrial\b/i,
    /\bflow\b/i,
    /\beditor\b/i,
    /\bcytoscape\b/i,
    /\bgraph\b/i,
    /\bworkflow\b/i,
    /\bdrag.?drop/i,
    /\bnode/i,
  ],
};

// Combined patterns by terminal
const DOMAIN_PATTERNS: Record<string, Record<string, RegExp[]>> = {
  'backend': BACKEND_DOMAIN_PATTERNS,
  'frontend': FRONTEND_DOMAIN_PATTERNS,
};

export interface DomainMemory {
  domain: string;
  content: string;
  path: string;
}

export interface LoadedKnowledge {
  memories: DomainMemory[];
  domains: string[];
  totalTokens: number; // Approximate
}

/**
 * Detect which domains are relevant for a given task
 * @param taskContent - The task description/content
 * @param terminal - The terminal name (backend, frontend, etc.)
 */
export function detectDomains(taskContent: string, terminal?: string): string[] {
  const detected: string[] = [];

  // Get terminal-specific patterns, or try all if terminal not specified
  const terminalPatterns = terminal ? DOMAIN_PATTERNS[terminal] : null;

  if (terminalPatterns) {
    // Use terminal-specific patterns
    for (const [domain, patterns] of Object.entries(terminalPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(taskContent)) {
          if (!detected.includes(domain)) {
            detected.push(domain);
          }
          break; // One match per domain is enough
        }
      }
    }
  } else {
    // Fallback: try all terminal patterns
    for (const termPatterns of Object.values(DOMAIN_PATTERNS)) {
      for (const [domain, patterns] of Object.entries(termPatterns)) {
        for (const pattern of patterns) {
          if (pattern.test(taskContent)) {
            if (!detected.includes(domain)) {
              detected.push(domain);
            }
            break;
          }
        }
      }
    }
  }

  return detected;
}

/**
 * Load domain memory file
 */
function loadMemoryFile(terminal: string, domain: string): DomainMemory | null {
  const memoryPath = path.join(TERMINALS_DIR, terminal, 'knowledge', `${domain}.memory.md`);

  if (!fs.existsSync(memoryPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(memoryPath, 'utf-8');
    return {
      domain,
      content,
      path: memoryPath,
    };
  } catch (error) {
    console.error(`[KnowledgeLoader] Failed to load ${memoryPath}:`, error);
    return null;
  }
}

/**
 * Load all relevant domain memories for a task
 */
export function loadDomainKnowledge(terminal: string, taskContent: string): LoadedKnowledge {
  const memories: DomainMemory[] = [];
  const domains: string[] = [];

  // Always load shared memory first
  const shared = loadMemoryFile(terminal, 'shared');
  if (shared) {
    memories.push(shared);
    domains.push('shared');
  }

  // Detect and load domain-specific memories (terminal-aware)
  const detectedDomains = detectDomains(taskContent, terminal);
  for (const domain of detectedDomains) {
    const memory = loadMemoryFile(terminal, domain);
    if (memory) {
      memories.push(memory);
      domains.push(domain);
    }
  }

  // Approximate token count (rough: 1 token ≈ 4 chars)
  const totalChars = memories.reduce((sum, m) => sum + m.content.length, 0);
  const totalTokens = Math.ceil(totalChars / 4);

  return {
    memories,
    domains,
    totalTokens,
  };
}

/**
 * Format loaded knowledge for session prompt
 */
export function formatKnowledgeForPrompt(knowledge: LoadedKnowledge): string {
  if (knowledge.memories.length === 0) {
    return '';
  }

  let prompt = '\n\n---\n## DOMAIN KNOWLEDGE (Auto-loaded)\n\n';
  prompt += `Loaded domains: ${knowledge.domains.join(', ')}\n`;
  prompt += `Approximate tokens: ${knowledge.totalTokens}\n\n`;

  for (const memory of knowledge.memories) {
    prompt += `### ${memory.domain.toUpperCase()} Memory\n\n`;
    prompt += memory.content;
    prompt += '\n\n';
  }

  prompt += '---\n';

  return prompt;
}

/**
 * Get knowledge summary (for logging)
 */
export function getKnowledgeSummary(knowledge: LoadedKnowledge): string {
  return `Loaded ${knowledge.memories.length} domain(s): [${knowledge.domains.join(', ')}] (~${knowledge.totalTokens} tokens)`;
}

/**
 * Check if knowledge folder exists for terminal
 */
export function hasKnowledgeFolder(terminal: string): boolean {
  const knowledgePath = path.join(TERMINALS_DIR, terminal, 'knowledge');
  return fs.existsSync(knowledgePath);
}

/**
 * List available domain memories for a terminal
 */
export function listAvailableMemories(terminal: string): string[] {
  const knowledgePath = path.join(TERMINALS_DIR, terminal, 'knowledge');

  if (!fs.existsSync(knowledgePath)) {
    return [];
  }

  try {
    const files = fs.readdirSync(knowledgePath);
    return files
      .filter(f => f.endsWith('.memory.md'))
      .map(f => f.replace('.memory.md', ''));
  } catch {
    return [];
  }
}
