// planSelect.ts - TypeScript equivalent of plan-select.sh
// Sonnet selector that ranks ideas and creates a pending document

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SPACEOS_ROOT,
  log
} from './common';
import {
  loadPlanConfig,
  loadPromptTemplate,
  loadDomainFocus,
  loadScanState,
  saveScanState,
  getFullPath,
  PlanConfig,
  ScanState
} from './planConfig';

// ── Types ───────────────────────────────────────────────────────────────────

interface SelectResult {
  success: boolean;
  pendingCreated: boolean;
  ideasArchived: number;
  triggeredDebate: boolean;
  error?: string;
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

// ── Collect all ideas ───────────────────────────────────────────────────────

async function collectIdeas(ideasDir: string): Promise<{ content: string; files: string[] }> {
  let content = '';
  const files: string[] = [];

  try {
    const entries = await fs.readdir(ideasDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = path.join(ideasDir, entry);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;

      const fileContent = await fs.readFile(filePath, 'utf-8');
      content += `\n\n--- ${entry} ---\n${fileContent}`;
      files.push(entry);
    }
  } catch {
    // Directory doesn't exist or is empty
  }

  return { content, files };
}

// ── Update hotspots with decay ──────────────────────────────────────────────

async function updateHotspots(
  config: PlanConfig,
  state: ScanState,
  ideaFiles: string[],
  ideasDir: string
): Promise<void> {
  const decayFactor = config.strategy.hotspot_decay;

  // Apply decay to existing hotspots
  const newHotspots: Record<string, number> = {};
  for (const [segment, count] of Object.entries(state.hotspots)) {
    const decayed = Math.floor(count * decayFactor);
    if (decayed > 0) {
      newHotspots[segment] = decayed;
    }
  }

  // Add new segments from processed ideas
  for (const file of ideaFiles) {
    const filePath = path.join(ideasDir, file);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const segmentMatch = content.match(/^segment:\s*(.+)$/m);
      if (segmentMatch) {
        const segment = segmentMatch[1].trim();
        newHotspots[segment] = (newHotspots[segment] || 0) + 1;
      }
    } catch {
      // File may have been moved already
    }
  }

  state.hotspots = newHotspots;
  await saveScanState(config, state);

  const hotspotStr = Object.entries(newHotspots)
    .map(([seg, count]) => `${seg}:${count}`)
    .join(',');
  await log(`[PlanSelect] Hotspots updated: ${hotspotStr || '(empty)'}`);
}

// ── Archive processed ideas ─────────────────────────────────────────────────

async function archiveIdeas(ideasDir: string, files: string[]): Promise<number> {
  const archiveDir = path.join(ideasDir, 'archive');
  await fs.mkdir(archiveDir, { recursive: true });

  let archived = 0;
  for (const file of files) {
    const sourcePath = path.join(ideasDir, file);
    const destPath = path.join(archiveDir, file);
    try {
      await fs.rename(sourcePath, destPath);
      archived++;
    } catch {
      // File may not exist
    }
  }

  return archived;
}

// ── Extract pending content from response ───────────────────────────────────

function extractPendingContent(response: string): string {
  // Find the first --- block (YAML frontmatter) and everything after
  const frontmatterStart = response.indexOf('---');
  if (frontmatterStart === -1) {
    // No frontmatter found, return the whole response
    return response;
  }

  return response.substring(frontmatterStart);
}

// ── Main select function ────────────────────────────────────────────────────

export async function runPlanSelect(): Promise<SelectResult> {
  const config = await loadPlanConfig();
  const state = await loadScanState(config);

  const ideasDir = getFullPath(config, config.paths.ideas_dir);
  const selectedDir = getFullPath(config, config.paths.selected_dir);
  await fs.mkdir(selectedDir, { recursive: true });

  // ── Check if pending already exists ─────────────────────────────────────

  const pendingPath = path.join(selectedDir, 'pending.md');
  try {
    await fs.access(pendingPath);
    await log('[PlanSelect] Skip — pending.md already exists');
    return {
      success: true,
      pendingCreated: false,
      ideasArchived: 0,
      triggeredDebate: false
    };
  } catch {
    // File doesn't exist, proceed
  }

  // ── Collect ideas ───────────────────────────────────────────────────────

  const { content: allIdeas, files: ideaFiles } = await collectIdeas(ideasDir);

  if (!allIdeas.trim()) {
    await log('[PlanSelect] Skip — no ideas found');
    return {
      success: true,
      pendingCreated: false,
      ideasArchived: 0,
      triggeredDebate: false
    };
  }

  await log(`[PlanSelect] Processing ${ideaFiles.length} ideas`);

  // ── Build prompt ────────────────────────────────────────────────────────

  const template = await loadPromptTemplate(config, 'selector');
  const { content: domainFocus } = await loadDomainFocus(config);
  const date = new Date().toISOString().split('T')[0];
  const model = config.models.selector;

  const prompt = template
    .replace(/\{\{DOMAIN_FOCUS\}\}/g, domainFocus)
    .replace(/\{\{ALL_IDEAS\}\}/g, allIdeas)
    .replace(/\{\{DATE\}\}/g, date)
    .replace(/\{\{MODEL\}\}/g, model);

  // ── Call Anthropic API ──────────────────────────────────────────────────

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const fullModel = resolveModel(model);
  const timeoutMs = config.timing.selector_timeout * 1000;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: fullModel,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);

    const textContent = response.content.find(c => c.type === 'text');
    const rawResponse = textContent ? textContent.text : '';

    // Extract and save pending content
    const pendingContent = extractPendingContent(rawResponse);

    if (!pendingContent.trim()) {
      await log('[PlanSelect] Error: empty pending content');
      return {
        success: false,
        pendingCreated: false,
        ideasArchived: 0,
        triggeredDebate: false,
        error: 'Empty pending content'
      };
    }

    await fs.writeFile(pendingPath, pendingContent);
    await log(`[PlanSelect] Created pending.md (${pendingContent.length} bytes)`);

    // Wait for file to be written
    await new Promise(resolve => setTimeout(resolve, config.timing.file_wait * 1000));

    // Update hotspots
    await updateHotspots(config, state, ideaFiles, ideasDir);

    // Archive ideas
    const archived = await archiveIdeas(ideasDir, ideaFiles);
    await log(`[PlanSelect] Archived ${archived} ideas`);

    // Trigger debate
    await log('[PlanSelect] Triggering plan-debate');
    const { runPlanDebate } = await import('./planDebate');
    runPlanDebate().catch(e => log(`[PlanSelect] Debate error: ${e.message}`));

    return {
      success: true,
      pendingCreated: true,
      ideasArchived: archived,
      triggeredDebate: true
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await log(`[PlanSelect] Error: ${errorMsg}`);

    return {
      success: false,
      pendingCreated: false,
      ideasArchived: 0,
      triggeredDebate: false,
      error: errorMsg
    };
  }
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  runPlanSelect().then(result => {
    console.log('Select result:', JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  });
}
