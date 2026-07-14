// planScan.ts - TypeScript equivalent of plan-scan.sh
// Haiku scanner for segment-based idea generation

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SPACEOS_ROOT,
  log,
  telegram
} from './common';
import {
  loadPlanConfig,
  loadPromptTemplate,
  loadDomainFocus,
  loadSegmentContent,
  loadScanState,
  saveScanState,
  getFullPath,
  PlanConfig,
  ScanState
} from './planConfig';

// ── Types ───────────────────────────────────────────────────────────────────

interface IdeaOutput {
  filename: string;
  content: string;
}

interface ScanResult {
  segment: string;
  ideasCreated: number;
  skipped: boolean;
  skipReason?: string;
  triggeredSelect: boolean;
}

// ── Model mapping ───────────────────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  'haiku': 'claude-haiku-4-20250514',
  'sonnet': 'claude-sonnet-4-5-20250929',
  'opus': 'claude-opus-4-5-20251101',
};

function resolveModel(model: string): string {
  return MODEL_MAP[model] || model;
}

// ── Segment selection strategy ──────────────────────────────────────────────

function pickSegmentIndex(
  config: PlanConfig,
  state: ScanState
): { index: number; strategy: 'rotating' | 'hotspot' | 'exploration' } {
  const segmentCount = config.segments.length;
  const roll = Math.floor(Math.random() * 100);

  const explorationThreshold = 100 - config.strategy.rotating_percent - config.strategy.hotspot_percent;

  // Exploration: random segment
  if (roll < explorationThreshold) {
    return {
      index: Math.floor(Math.random() * segmentCount),
      strategy: 'exploration'
    };
  }

  // Hotspot: pick highest scoring segment
  if (roll < explorationThreshold + config.strategy.hotspot_percent) {
    const hotspotEntries = Object.entries(state.hotspots);
    if (hotspotEntries.length > 0) {
      // Sort by score descending
      hotspotEntries.sort((a, b) => b[1] - a[1]);
      const bestSegment = hotspotEntries[0][0];
      const idx = config.segments.findIndex(s => s.name === bestSegment);
      if (idx >= 0) {
        return { index: idx, strategy: 'hotspot' };
      }
    }
  }

  // Rotating: next in sequence
  const nextIndex = (state.last_segment + 1) % segmentCount;
  return { index: nextIndex, strategy: 'rotating' };
}

// ── Count ideas in directory ────────────────────────────────────────────────

async function countIdeas(ideasDir: string): Promise<number> {
  try {
    const files = await fs.readdir(ideasDir);
    return files.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

// ── Get recent ideas ────────────────────────────────────────────────────────

async function getRecentIdeas(ideasDir: string, limit: number = 10): Promise<string> {
  try {
    const files = await fs.readdir(ideasDir);
    const mdFiles = files.filter(f => f.endsWith('.md')).sort().slice(-limit);
    return mdFiles.join(', ') || 'nincs még';
  } catch {
    return 'nincs még';
  }
}

// ── Parse LLM response for ideas ────────────────────────────────────────────

function parseIdeasFromResponse(response: string, ideasDir: string, date: string, nextNum: number): IdeaOutput[] {
  const ideas: IdeaOutput[] = [];

  // Look for file blocks in format:
  // **Fájlnév:** `filename.md` or similar patterns
  // followed by content

  // Pattern 1: Explicit filename with code block
  const fileBlockRegex = /(?:\*\*Fájlnév:\*\*|Fájl:|File:)\s*[`']?([^\n`']+\.md)[`']?\s*\n+```(?:yaml|markdown|md)?\n([\s\S]*?)```/gi;

  let match;
  while ((match = fileBlockRegex.exec(response)) !== null) {
    const filename = match[1].trim();
    const content = match[2].trim();
    if (filename && content) {
      ideas.push({ filename, content });
    }
  }

  // Pattern 2: Frontmatter blocks with slug extraction
  if (ideas.length === 0) {
    const frontmatterRegex = /---\n([\s\S]*?)\n---\n([\s\S]*?)(?=---\n|$)/g;
    let num = nextNum;

    while ((match = frontmatterRegex.exec(response)) !== null) {
      const frontmatter = match[1];
      const body = match[2].trim();

      // Extract slug from first heading or generate one
      const headingMatch = body.match(/^#\s+(.+)/m);
      const slug = headingMatch
        ? headingMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40)
        : `idea-${num}`;

      const filename = `${date}_${String(num).padStart(3, '0')}_${slug}.md`;
      const content = `---\n${frontmatter}\n---\n\n${body}`;

      ideas.push({ filename, content });
      num++;
    }
  }

  return ideas;
}

// ── Main scan function ──────────────────────────────────────────────────────

export async function runPlanScan(): Promise<ScanResult> {
  const config = await loadPlanConfig();
  const state = await loadScanState(config);

  const ideasDir = getFullPath(config, config.paths.ideas_dir);
  await fs.mkdir(ideasDir, { recursive: true });

  // ── Throttling check ────────────────────────────────────────────────────

  const ideaCount = await countIdeas(ideasDir);

  // If at threshold, trigger select
  if (ideaCount >= config.throttling.ideas_threshold) {
    await log(`[PlanScan] Skip: ${ideaCount} ötlet van, select trigger`);
    // Import dynamically to avoid circular deps
    const { runPlanSelect } = await import('./planSelect');
    runPlanSelect().catch(e => log(`[PlanScan] Select hiba: ${e.message}`));
    return {
      segment: '',
      ideasCreated: 0,
      skipped: true,
      skipReason: 'threshold_reached_trigger_select',
      triggeredSelect: true
    };
  }

  // Random skip if near threshold
  if (ideaCount >= config.throttling.skip_threshold) {
    if (Math.random() < 0.5) {
      await log(`[PlanScan] Throttle skip: ${ideaCount} ötlet, 50% skip`);
      return {
        segment: '',
        ideasCreated: 0,
        skipped: true,
        skipReason: 'throttle_skip',
        triggeredSelect: false
      };
    }
  }

  // ── Segment selection ───────────────────────────────────────────────────

  const { index, strategy } = pickSegmentIndex(config, state);
  const segment = config.segments[index];

  await log(`[PlanScan] ${strategy.toUpperCase()}: ${segment.name} (ideas: ${ideaCount})`);

  // Update state
  state.last_segment = index;
  state.last_run = Date.now();
  await saveScanState(config, state);

  // ── Load segment content ────────────────────────────────────────────────

  const { label, content: segmentContent } = await loadSegmentContent(config, segment.name);

  if (!segmentContent.trim()) {
    await log(`[PlanScan] Skip: ${segment.name} üres`);
    return {
      segment: segment.name,
      ideasCreated: 0,
      skipped: true,
      skipReason: 'empty_segment',
      triggeredSelect: false
    };
  }

  // ── Build prompt ────────────────────────────────────────────────────────

  const template = await loadPromptTemplate(config, 'scanner');
  const { domain, content: domainFocus } = await loadDomainFocus(config);
  const recentIdeas = await getRecentIdeas(ideasDir);

  const date = new Date().toISOString().split('T')[0];
  const nextNum = ideaCount + 1;

  const prompt = template
    .replace(/\{\{SEGMENT_NAME\}\}/g, segment.name)
    .replace(/\{\{SEGMENT_LABEL\}\}/g, label)
    .replace(/\{\{SEGMENT_CONTENT\}\}/g, segmentContent)
    .replace(/\{\{DOMAIN_FOCUS\}\}/g, domainFocus)
    .replace(/\{\{DOMAIN\}\}/g, domain)
    .replace(/\{\{RECENT_IDEAS\}\}/g, recentIdeas)
    .replace(/\{\{IDEAS_DIR\}\}/g, ideasDir)
    .replace(/\{\{DATE\}\}/g, date)
    .replace(/\{\{NEXT_NUM\}\}/g, String(nextNum).padStart(3, '0'));

  // ── Call Anthropic API ──────────────────────────────────────────────────

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = resolveModel(config.models.scanner);
  const timeoutMs = config.timing.scanner_timeout * 1000;

  try {
    const response = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);

    const textContent = response.content.find(c => c.type === 'text');
    const rawResponse = textContent ? textContent.text : '';

    // Parse and write ideas
    const ideas = parseIdeasFromResponse(rawResponse, ideasDir, date, nextNum);

    for (const idea of ideas) {
      const filePath = path.join(ideasDir, idea.filename);
      await fs.writeFile(filePath, idea.content);
      await log(`[PlanScan] Idea created: ${idea.filename}`);
    }

    // Check if threshold reached after writing
    const newIdeaCount = await countIdeas(ideasDir);
    let triggeredSelect = false;

    if (newIdeaCount >= config.throttling.ideas_threshold) {
      await log(`[PlanScan] Threshold reached: ${newIdeaCount} ideas, triggering select`);
      const { runPlanSelect } = await import('./planSelect');
      runPlanSelect().catch(e => log(`[PlanScan] Select hiba: ${e.message}`));
      triggeredSelect = true;
    }

    await log(`[PlanScan] Kész: ${ideas.length} ötlet (segment: ${segment.name}, model: ${model})`);

    return {
      segment: segment.name,
      ideasCreated: ideas.length,
      skipped: false,
      triggeredSelect
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await log(`[PlanScan] Error: ${errorMsg}`);

    return {
      segment: segment.name,
      ideasCreated: 0,
      skipped: true,
      skipReason: `error: ${errorMsg}`,
      triggeredSelect: false
    };
  }
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  runPlanScan().then(result => {
    console.log('Scan result:', JSON.stringify(result, null, 2));
    process.exit(result.skipped && result.skipReason?.startsWith('error') ? 1 : 0);
  });
}
