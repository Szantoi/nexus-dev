/**
 * Memory Management MCP Tools
 *
 * Automated fleet-wide memory health monitoring, compression, and pattern extraction.
 *
 * Tools:
 * 1. memory_health_report - Fleet-wide memory status in one call
 * 2. compress_memory - Automatic memory compression with pattern detection
 * 3. extract_patterns - Cross-terminal pattern mining for knowledge extraction
 *
 * @module memoryTools
 */

import * as fs from 'fs';
import * as path from 'path';

const MEMORY_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'memory');
const MEMORY_ARCHIVE_DIR = path.join(MEMORY_DIR, 'archive');
const DEFAULT_THRESHOLD_KB = 200;
const WARNING_RATIO = 0.80; // 80% of threshold
const CRITICAL_RATIO = 0.95; // 95% of threshold

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TerminalHealthStatus {
  name: string;
  size_kb: number;
  threshold_kb: number;
  status: 'ok' | 'warning' | 'critical';
  staleness_days: number;
  duplicate_ratio: number;
  suggested_action: 'none' | 'compress' | 'archive' | 'cleanup';
}

export interface MemoryHealthReport {
  terminals: TerminalHealthStatus[];
  system_total_kb: number;
  warnings: string[];
}

export interface CompressMemoryParams {
  terminal: string;
  strategy: 'aggressive' | 'moderate' | 'conservative';
  preserve_sections?: string[];
  dry_run?: boolean;
}

export interface CompressMemoryResult {
  success: boolean;
  original_size_kb: number;
  compressed_size_kb: number;
  reduction_ratio: number;
  archived_content_summary: string;
  preview: string;
  dry_run: boolean;
}

export interface ExtractPatternsParams {
  terminal: string | 'all';
  min_frequency?: number;
  pattern_types: Array<'workflow' | 'decision' | 'error_resolution'>;
}

export interface Pattern {
  type: 'workflow' | 'decision' | 'error_resolution';
  content: string;
  frequency: number;
  terminals: string[];
  suggested_tier: 'shared' | 'warm' | 'cold';
  suggested_doc: string;
}

export interface ExtractPatternsResult {
  patterns: Pattern[];
  total_patterns_found: number;
  terminals_scanned: string[];
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Get all terminal names from memory directory
 */
function getAllTerminals(): string[] {
  if (!fs.existsSync(MEMORY_DIR)) {
    return [];
  }

  return fs.readdirSync(MEMORY_DIR)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY_FORMAT.md')
    .map(f => f.replace('.md', ''));
}

/**
 * Calculate file size in KB
 */
function getFileSizeKb(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const stats = fs.statSync(filePath);
  return stats.size / 1024;
}

/**
 * Calculate staleness in days since last modification
 */
function getStalenessDays(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const stats = fs.statSync(filePath);
  const now = Date.now();
  const mtime = stats.mtimeMs;
  return Math.floor((now - mtime) / (1000 * 60 * 60 * 24));
}

/**
 * Estimate duplicate ratio using simple pattern detection
 */
function estimateDuplicateRatio(content: string): number {
  // Simple heuristic: look for repeated patterns (lines appearing >3 times)
  const lines = content.split('\n');
  const lineCounts = new Map<string, number>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 20) { // Only count substantial lines
      lineCounts.set(trimmed, (lineCounts.get(trimmed) || 0) + 1);
    }
  }

  let duplicateLines = 0;
  let totalLines = 0;

  for (const [line, count] of lineCounts.entries()) {
    totalLines++;
    if (count > 3) {
      duplicateLines++;
    }
  }

  return totalLines > 0 ? duplicateLines / totalLines : 0;
}

/**
 * Determine suggested action based on status, staleness, and duplicates
 */
function suggestAction(
  status: 'ok' | 'warning' | 'critical',
  stalenessDays: number,
  duplicateRatio: number
): 'none' | 'compress' | 'archive' | 'cleanup' {
  if (status === 'critical') {
    return 'cleanup';
  }
  if (status === 'warning') {
    if (duplicateRatio > 0.3 || stalenessDays > 30) {
      return 'compress';
    }
    return 'cleanup';
  }
  if (stalenessDays > 60) {
    return 'archive';
  }
  if (duplicateRatio > 0.2) {
    return 'compress';
  }
  return 'none';
}

// ─── Tool #1: memory_health_report ─────────────────────────────────────────

/**
 * Get fleet-wide memory health status
 *
 * @example
 * const report = await getMemoryHealthReport();
 * console.log(`Total size: ${report.system_total_kb} KB`);
 * console.log(`Warnings: ${report.warnings.length}`);
 */
export async function getMemoryHealthReport(): Promise<MemoryHealthReport> {
  const terminals = getAllTerminals();
  const healthStatuses: TerminalHealthStatus[] = [];
  let systemTotalKb = 0;
  const warnings: string[] = [];

  for (const terminal of terminals) {
    const filePath = path.join(MEMORY_DIR, `${terminal}.md`);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    const sizeKb = getFileSizeKb(filePath);
    const stalenessDays = getStalenessDays(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const duplicateRatio = estimateDuplicateRatio(content);
    const thresholdKb = DEFAULT_THRESHOLD_KB;

    // Determine status
    let status: 'ok' | 'warning' | 'critical' = 'ok';
    if (sizeKb >= thresholdKb * CRITICAL_RATIO) {
      status = 'critical';
    } else if (sizeKb >= thresholdKb * WARNING_RATIO) {
      status = 'warning';
    }

    const suggestedAction = suggestAction(status, stalenessDays, duplicateRatio);

    healthStatuses.push({
      name: terminal,
      size_kb: Math.round(sizeKb * 10) / 10,
      threshold_kb: thresholdKb,
      status,
      staleness_days: stalenessDays,
      duplicate_ratio: Math.round(duplicateRatio * 100) / 100,
      suggested_action: suggestedAction,
    });

    systemTotalKb += sizeKb;

    // Generate warnings
    if (status === 'critical') {
      warnings.push(`${terminal} CRITICAL: ${Math.round(sizeKb)}KB (>${Math.round(thresholdKb * CRITICAL_RATIO)}KB threshold)`);
    } else if (status === 'warning') {
      warnings.push(`${terminal} approaching threshold: ${Math.round(sizeKb)}KB / ${thresholdKb}KB`);
    }

    if (stalenessDays > 14 && status !== 'critical') {
      warnings.push(`${terminal} has stale content (${stalenessDays} days since update)`);
    }
  }

  return {
    terminals: healthStatuses,
    system_total_kb: Math.round(systemTotalKb * 10) / 10,
    warnings,
  };
}

// ─── Tool #2: compress_memory ──────────────────────────────────────────────

// Garbage patterns to remove
const GARBAGE_PATTERNS: Record<string, RegExp[]> = {
  aggressive: [
    /## Nightwatch Cycle #\d+.*?(?=##|$)/gs,           // Nightwatch logs
    /## Review Log.*?(?=##|$)/gs,                      // Review logs
    /\*\*Task:\*\* MSG-\w+-\d+ \(completed.*?\)/g,     // Completed task refs
    /\[DONE\].*?MSG-\w+-\d+.*?(?=\n\n)/gs,             // DONE outbox logs
    /## Cycle.*?(?=##|$)/gs,                           // Cycle logs
    /## Session \d{4}-\d{2}-\d{2}.*?(?=##|$)/gs,       // Old session logs
  ],
  moderate: [
    /## Nightwatch Cycle #\d+.*?(?=##|$)/gs,
    /## Review Log.*?(?=##|$)/gs,
    /\*\*Task:\*\* MSG-\w+-\d+ \(completed.*?\)/g,
  ],
  conservative: [
    /## Nightwatch Cycle #\d+.*?(?=##|$)/gs,
  ],
};

// Always preserve these sections
const PRESERVE_HEADERS = [
  '## Session Start Ritual',
  '## Active Tasks',
  '## Key Decisions',
  '## Strategic Context',
  '## ROLE & IDENTITY',
  '## KEY PATTERNS',
];

/**
 * Compress terminal memory file using pattern detection
 *
 * @param params - Compression parameters
 * @returns Compression result with statistics
 *
 * @example
 * const result = await compressMemory({
 *   terminal: 'backend',
 *   strategy: 'moderate',
 *   dry_run: true
 * });
 * console.log(`Reduction: ${result.reduction_ratio * 100}%`);
 */
export async function compressMemory(params: CompressMemoryParams): Promise<CompressMemoryResult> {
  const { terminal, strategy, preserve_sections = [], dry_run = true } = params;
  const filePath = path.join(MEMORY_DIR, `${terminal}.md`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Memory file not found for terminal: ${terminal}`);
  }

  const originalContent = fs.readFileSync(filePath, 'utf-8');
  const originalSizeKb = Buffer.byteLength(originalContent, 'utf-8') / 1024;

  let compressedContent = originalContent;
  const archivedSections: string[] = [];

  // Apply patterns for the strategy
  const patterns = GARBAGE_PATTERNS[strategy] || [];
  for (const pattern of patterns) {
    const matches = compressedContent.match(pattern);
    if (matches) {
      archivedSections.push(...matches);
      compressedContent = compressedContent.replace(pattern, '');
    }
  }

  // Remove duplicate empty lines
  compressedContent = compressedContent.replace(/\n{3,}/g, '\n\n');

  const compressedSizeKb = Buffer.byteLength(compressedContent, 'utf-8') / 1024;
  const reductionRatio = originalSizeKb > 0 ? (originalSizeKb - compressedSizeKb) / originalSizeKb : 0;

  const preview = compressedContent.substring(0, 500) + '...';
  const archivedContentSummary = `Removed ${archivedSections.length} sections (${strategy} strategy)`;

  // If not dry run, write the compressed content
  if (!dry_run) {
    // Backup original to archive
    if (!fs.existsSync(MEMORY_ARCHIVE_DIR)) {
      fs.mkdirSync(MEMORY_ARCHIVE_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().split('T')[0];
    const archivePath = path.join(MEMORY_ARCHIVE_DIR, `${terminal}_${timestamp}.md`);
    fs.writeFileSync(archivePath, originalContent, 'utf-8');

    // Write compressed content
    fs.writeFileSync(filePath, compressedContent, 'utf-8');
  }

  return {
    success: true,
    original_size_kb: Math.round(originalSizeKb * 10) / 10,
    compressed_size_kb: Math.round(compressedSizeKb * 10) / 10,
    reduction_ratio: Math.round(reductionRatio * 100) / 100,
    archived_content_summary: archivedContentSummary,
    preview,
    dry_run,
  };
}

// ─── Tool #3: extract_patterns ─────────────────────────────────────────────

const PATTERN_REGEXES: Record<string, RegExp> = {
  workflow: /(?:##\s*Workflow|^\d+\.\s+.*\n(?:\d+\.\s+.*\n)*)/gim,
  decision: /(?:Decision:|Chosen:|APPROVE|REJECT).*$/gim,
  error_resolution: /(?:Error:|Problem:).*?(?:Fix:|Solution:).*$/gims,
};

/**
 * Extract repeating patterns from terminal memory files
 *
 * @param params - Pattern extraction parameters
 * @returns Extracted patterns with frequency and terminal info
 *
 * @example
 * const result = await extractPatterns({
 *   terminal: 'all',
 *   min_frequency: 3,
 *   pattern_types: ['workflow', 'decision']
 * });
 * console.log(`Found ${result.total_patterns_found} patterns`);
 */
export async function extractPatterns(params: ExtractPatternsParams): Promise<ExtractPatternsResult> {
  const { terminal, min_frequency = 3, pattern_types } = params;

  const terminalsToScan = terminal === 'all' ? getAllTerminals() : [terminal];
  const patternMap = new Map<string, { type: string; content: string; frequency: number; terminals: Set<string> }>();

  for (const term of terminalsToScan) {
    const filePath = path.join(MEMORY_DIR, `${term}.md`);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    for (const patternType of pattern_types) {
      const regex = PATTERN_REGEXES[patternType];
      if (!regex) continue;

      const matches = content.match(regex);
      if (matches) {
        for (const match of matches) {
          const normalized = match.trim().substring(0, 200); // Normalize and truncate
          const key = `${patternType}:${normalized}`;

          const existing = patternMap.get(key);
          if (existing) {
            existing.frequency++;
            existing.terminals.add(term);
          } else {
            patternMap.set(key, {
              type: patternType,
              content: normalized,
              frequency: 1,
              terminals: new Set([term]),
            });
          }
        }
      }
    }
  }

  // Filter by min_frequency and convert to result format
  const patterns: Pattern[] = [];
  for (const [, pattern] of patternMap.entries()) {
    if (pattern.frequency >= min_frequency) {
      // Suggest tier based on frequency
      let suggested_tier: 'shared' | 'warm' | 'cold' = 'cold';
      if (pattern.frequency > 5) {
        suggested_tier = 'shared';
      } else if (pattern.frequency >= 3) {
        suggested_tier = 'warm';
      }

      // Generate suggested doc name
      const words = pattern.content.match(/\b[A-Z][a-z]+\b/g) || [];
      const suggested_doc = words.slice(0, 3).join('_').toUpperCase() + '_PATTERN.md';

      patterns.push({
        type: pattern.type as 'workflow' | 'decision' | 'error_resolution',
        content: pattern.content,
        frequency: pattern.frequency,
        terminals: Array.from(pattern.terminals),
        suggested_tier,
        suggested_doc: suggested_doc || 'PATTERN.md',
      });
    }
  }

  // Sort by frequency descending
  patterns.sort((a, b) => b.frequency - a.frequency);

  return {
    patterns,
    total_patterns_found: patterns.length,
    terminals_scanned: terminalsToScan,
  };
}
