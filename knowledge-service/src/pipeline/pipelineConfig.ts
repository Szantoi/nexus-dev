// pipelineConfig.ts - Configuration loader for pipeline-docs and cron-librarian
// Reads pipeline-config.yaml

import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SPACEOS_ROOT } from './common';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SpecialRoute {
  keywords: string[];
  inbox: string;
}

export interface MemoryFile {
  path: string;
  terminal: string;
}

export interface KnowledgeTargets {
  gotchas: string;
  adr: string;
  security: string;
  database: string;
  testing: string;
}

export interface KnowledgeServiceConfig {
  enabled: boolean;
  url: string;
  source: string;
}

export interface PipelineConfig {
  models: {
    docs_updater: string;
    librarian: string;
  };
  timing: {
    docs_timeout: number;
    librarian_interval: number;
    file_wait: number;
  };
  paths: {
    tasks_readme: string;
    codebase_status: string;
    domain_matrix: string;
    knowledge_dir: string;
    knowledge_index: string;
  };
  prompts: {
    docs_updater: string;
    librarian_sync: string;
  };
  routing: {
    default_inbox: string;
    special_routes: SpecialRoute[];
  };
  next_task: {
    default_model: string;
    default_priority: string;
  };
  librarian: {
    memory_files: MemoryFile[];
    knowledge_targets: KnowledgeTargets;
    knowledge_service: KnowledgeServiceConfig;
  };
  notifications: {
    on_docs_update: boolean;
    on_librarian_start: boolean;
    on_librarian_done: boolean;
  };
}

// ── Load config ─────────────────────────────────────────────────────────────

let cachedConfig: PipelineConfig | null = null;

export async function loadPipelineConfig(): Promise<PipelineConfig> {
  if (cachedConfig) return cachedConfig;

  const configPath = path.join(SPACEOS_ROOT, 'scripts/pipeline-config.yaml');
  const content = await fs.readFile(configPath, 'utf-8');
  cachedConfig = yaml.load(content) as PipelineConfig;
  return cachedConfig;
}

// ── Path helpers ────────────────────────────────────────────────────────────

export function getPipelinePath(relativePath: string): string {
  return path.join(SPACEOS_ROOT, relativePath);
}

export async function loadPipelinePrompt(config: PipelineConfig, key: keyof PipelineConfig['prompts']): Promise<string> {
  const promptPath = getPipelinePath(config.prompts[key]);
  return fs.readFile(promptPath, 'utf-8');
}

// ── Routing helper ──────────────────────────────────────────────────────────

export function determineInbox(config: PipelineConfig, doneContent: string): string {
  const contentLower = doneContent.toLowerCase();

  for (const route of config.routing.special_routes) {
    for (const keyword of route.keywords) {
      if (contentLower.includes(keyword.toLowerCase())) {
        return getPipelinePath(route.inbox);
      }
    }
  }

  return getPipelinePath(config.routing.default_inbox);
}

// ── Next message number helper ──────────────────────────────────────────────

export async function getNextMessageNum(inboxDir: string): Promise<number> {
  let lastNum = 0;

  try {
    const files = await fs.readdir(inboxDir);
    for (const file of files) {
      const match = file.match(/_(\d{3})_/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > lastNum) lastNum = num;
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return lastNum + 1;
}
