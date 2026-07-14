// planConfig.ts - Planning pipeline configuration loader
// Reads plan-config.yaml for all planning modules

import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SPACEOS_ROOT } from './common';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlanConfig {
  models: {
    scanner: string;
    selector: string;
    planner_a: string;
    planner_b: string;
    reviewer: string;
    consensus: string;
  };
  timing: {
    scanner_timeout: number;
    selector_timeout: number;
    planner_timeout: number;
    reviewer_timeout: number;
    consensus_timeout: number;
    file_wait: number;
  };
  throttling: {
    ideas_threshold: number;
    skip_threshold: number;
    queue_notify_threshold: number;
    max_queue_size: number;
  };
  segments: Array<{
    name: string;
    label: string;
    source?: string;
    sources?: string[];
  }>;
  strategy: {
    rotating_percent: number;
    hotspot_percent: number;
    exploration_percent: number;
    hotspot_decay: number;
  };
  paths: {
    planning_dir: string;
    ideas_dir: string;
    selected_dir: string;
    plans_dir: string;
    consensus_dir: string;
    queue_dir: string;
    archive_dir: string;
    domain_focus: string;
    codebase_status: string;
    log_dir: string;
    scan_state: string;
  };
  prompts: {
    scanner: string;
    selector: string;
    planner: string;
    reviewer: string;
    consensus: string;
  };
  notifications: {
    on_select: boolean;
    on_consensus: boolean;
    on_queue_ready: boolean;
    on_error: boolean;
  };
}

// ── Load config ───────────────────────────────────────────────────────────────

let cachedConfig: PlanConfig | null = null;

export async function loadPlanConfig(): Promise<PlanConfig> {
  if (cachedConfig) return cachedConfig;

  const configPath = path.join(SPACEOS_ROOT, 'scripts/plan-config.yaml');
  const content = await fs.readFile(configPath, 'utf-8');
  cachedConfig = yaml.load(content) as PlanConfig;
  return cachedConfig;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

export function getFullPath(config: PlanConfig, relativePath: string): string {
  return path.join(SPACEOS_ROOT, relativePath);
}

export async function loadPromptTemplate(config: PlanConfig, promptKey: keyof PlanConfig['prompts']): Promise<string> {
  const promptPath = getFullPath(config, config.prompts[promptKey]);
  return fs.readFile(promptPath, 'utf-8');
}

export async function loadDomainFocus(config: PlanConfig): Promise<{ domain: string; content: string }> {
  const focusPath = getFullPath(config, config.paths.domain_focus);
  try {
    const content = await fs.readFile(focusPath, 'utf-8');
    const domainMatch = content.match(/^domain:\s*(.+)$/m);
    const domain = domainMatch ? domainMatch[1].trim() : 'all';
    return { domain, content };
  } catch {
    return { domain: 'all', content: '' };
  }
}

// ── Segment helpers ───────────────────────────────────────────────────────────

export async function loadSegmentContent(config: PlanConfig, segmentName: string): Promise<{ label: string; content: string }> {
  const segment = config.segments.find(s => s.name === segmentName);
  if (!segment) {
    return { label: segmentName, content: '' };
  }

  const sources = segment.sources || (segment.source ? [segment.source] : []);
  let content = '';

  for (const sourcePath of sources) {
    const fullPath = getFullPath(config, sourcePath);
    try {
      const fileContent = await fs.readFile(fullPath, 'utf-8');
      content += `\n\n--- ${path.basename(sourcePath)} ---\n${fileContent}`;
    } catch {
      // File doesn't exist
    }
  }

  return { label: segment.label, content };
}

// ── State file helpers ────────────────────────────────────────────────────────

export interface ScanState {
  last_segment: number;
  last_run: number;
  hotspots: Record<string, number>;
}

export async function loadScanState(config: PlanConfig): Promise<ScanState> {
  const statePath = getFullPath(config, config.paths.scan_state);
  const defaultState: ScanState = { last_segment: -1, last_run: 0, hotspots: {} };

  try {
    const content = await fs.readFile(statePath, 'utf-8');
    const lines = content.split('\n');
    const state: ScanState = { ...defaultState };

    for (const line of lines) {
      if (line.startsWith('last_segment=')) {
        state.last_segment = parseInt(line.split('=')[1], 10);
      } else if (line.startsWith('last_run=')) {
        state.last_run = parseInt(line.split('=')[1], 10);
      } else if (line.startsWith('hotspots=')) {
        const hotspotsStr = line.split('=')[1];
        if (hotspotsStr) {
          const pairs = hotspotsStr.split(',');
          for (const pair of pairs) {
            const [seg, count] = pair.split(':');
            if (seg && count) {
              state.hotspots[seg] = parseInt(count, 10);
            }
          }
        }
      }
    }

    return state;
  } catch {
    return defaultState;
  }
}

export async function saveScanState(config: PlanConfig, state: ScanState): Promise<void> {
  const statePath = getFullPath(config, config.paths.scan_state);

  const hotspotStr = Object.entries(state.hotspots)
    .filter(([, count]) => count > 0)
    .map(([seg, count]) => `${seg}:${count}`)
    .join(',');

  const content = [
    `last_segment=${state.last_segment}`,
    `last_run=${state.last_run}`,
    `hotspots=${hotspotStr}`
  ].join('\n');

  await fs.writeFile(statePath, content);
}
