/**
 * Skills & Workflow Management for SpaceOS
 *
 * Handles skill discovery, reading, and workflow documentation.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

// Base paths
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const SKILLS_DIR = path.join(SPACEOS_ROOT, '.claude/skills');
const DOCS_DIR = path.join(SPACEOS_ROOT, 'docs');

// ─── Skill Functions ────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  path: string;
  hasSkillMd: boolean;
  hasReferences: boolean;
  description?: string;
}

export interface SkillContent {
  name: string;
  path: string;
  content: string;
  references?: Array<{ name: string; content: string }>;
}

/**
 * List all SpaceOS skills
 */
export async function listSkills(): Promise<SkillInfo[]> {
  const results: SkillInfo[] = [];

  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(SKILLS_DIR, entry.name);
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      const refsPath = path.join(skillPath, 'references');

      let hasSkillMd = false;
      let hasReferences = false;
      let description: string | undefined;

      try {
        const content = await fs.readFile(skillMdPath, 'utf-8');
        hasSkillMd = true;
        // Extract description from frontmatter
        const match = content.match(/description:\s*>?\s*\n?\s*([^\n]+(?:\n\s+[^\n]+)*)/);
        if (match) {
          description = match[1].replace(/\n\s+/g, ' ').trim();
        }
      } catch {}

      try {
        await fs.access(refsPath);
        hasReferences = true;
      } catch {}

      results.push({
        name: entry.name,
        path: skillPath,
        hasSkillMd,
        hasReferences,
        description,
      });
    }
  } catch (err) {
    // Skills directory doesn't exist
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get full skill content including references
 */
export async function getSkill(skillName: string): Promise<SkillContent | null> {
  const skillPath = path.join(SKILLS_DIR, skillName);
  const skillMdPath = path.join(skillPath, 'SKILL.md');

  try {
    const content = await fs.readFile(skillMdPath, 'utf-8');
    const result: SkillContent = {
      name: skillName,
      path: skillPath,
      content,
    };

    // Try to load references
    const refsPath = path.join(skillPath, 'references');
    try {
      const refEntries = await fs.readdir(refsPath);
      result.references = [];

      for (const refFile of refEntries) {
        if (!refFile.endsWith('.md')) continue;
        try {
          const refContent = await fs.readFile(path.join(refsPath, refFile), 'utf-8');
          result.references.push({
            name: refFile,
            content: refContent,
          });
        } catch {}
      }
    } catch {}

    return result;
  } catch {
    return null;
  }
}

// ─── Workflow Functions ─────────────────────────────────────────────────────

export interface WorkflowInfo {
  workflow: string;
  architecture: string;
  mailboxStructure: string;
  terminals: Array<{
    name: string;
    directory: string;
    port: string | null;
    type: 'persistent' | 'on-demand';
    role: string;
  }>;
}

/**
 * Get the full WORKFLOW.md content
 */
export async function getWorkflow(): Promise<string | null> {
  const workflowPath = path.join(DOCS_DIR, 'WORKFLOW.md');
  try {
    return await fs.readFile(workflowPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get terminal setup instructions for a specific terminal
 */
export async function getTerminalSetup(terminal: string): Promise<{
  claudeMd: string | null;
  skill: SkillContent | null;
  workflow: string | null;
  mcpConfig: object;
}> {
  const TERMINAL_PATHS: Record<string, string> = {
    root: SPACEOS_ROOT,
    conductor: path.join(SPACEOS_ROOT, 'spaceos-conductor'),
    architect: path.join(SPACEOS_ROOT, 'spaceos-architect'),
    librarian: path.join(SPACEOS_ROOT, 'spaceos-librarian'),
    nexus: path.join(SPACEOS_ROOT, 'spaceos-nexus'),
    kernel: path.join(SPACEOS_ROOT, 'backend/spaceos-kernel'),
    orch: path.join(SPACEOS_ROOT, 'backend/spaceos-orchestrator'),
    orchestrator: path.join(SPACEOS_ROOT, 'backend/spaceos-orchestrator'),
    fe: path.join(SPACEOS_ROOT, process.env.FRONTEND_PORTAL_PATH || 'frontend/portal'),
    portal: path.join(SPACEOS_ROOT, process.env.FRONTEND_PORTAL_PATH || 'frontend/portal'),
    joinery: path.join(SPACEOS_ROOT, 'backend/spaceos-modules-joinery'),
    abstractions: path.join(SPACEOS_ROOT, 'backend/spaceos-modules-abstractions'),
    cutting: path.join(SPACEOS_ROOT, 'backend/spaceos-modules-cutting'),
    inventory: path.join(SPACEOS_ROOT, 'backend/spaceos-modules-inventory'),
    procurement: path.join(SPACEOS_ROOT, 'backend/spaceos-modules-procurement'),
    sales: path.join(SPACEOS_ROOT, 'backend/spaceos-modules-sales'),
    identity: path.join(SPACEOS_ROOT, 'backend/spaceos-modules-identity'),
    infra: path.join(SPACEOS_ROOT, 'infra'),
    e2e: path.join(SPACEOS_ROOT, 'e2e'),
  };

  const normalizedTerminal = terminal.toLowerCase();
  const terminalPath = TERMINAL_PATHS[normalizedTerminal];

  if (!terminalPath) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  // Get CLAUDE.md
  let claudeMd: string | null = null;
  try {
    claudeMd = await fs.readFile(path.join(terminalPath, 'CLAUDE.md'), 'utf-8');
  } catch {}

  // Get terminal-specific skill if exists
  const skillName = `spaceos-${normalizedTerminal}`;
  let skill = await getSkill(skillName);
  // Fall back to generic terminal skill
  if (!skill) {
    skill = await getSkill('spaceos-terminal');
  }

  // Get workflow section (abbreviated)
  const fullWorkflow = await getWorkflow();
  const workflow = fullWorkflow ? fullWorkflow.substring(0, 5000) + '\n\n[... truncated ...]' : null;

  // MCP config for remote access
  const mcpConfig = {
    mcpServers: {
      'spaceos-knowledge': {
        type: 'http',
        url: process.env.MCP_SERVER_URL || 'http://localhost:3456/mcp',
        timeout: 60000,
        headers: {
          Authorization: 'Bearer <TOKEN>',
        },
      },
    },
  };

  return {
    claudeMd,
    skill,
    workflow,
    mcpConfig,
  };
}

/**
 * Get project context - vision, architecture, knowledge index
 */
export async function getProjectContext(): Promise<{
  vision: string | null;
  knowledgeIndex: string | null;
  codebaseStatus: string | null;
}> {
  let vision: string | null = null;
  let knowledgeIndex: string | null = null;
  let codebaseStatus: string | null = null;

  try {
    vision = await fs.readFile(path.join(DOCS_DIR, 'vision/SpaceOS_Vision_Master.md'), 'utf-8');
  } catch {}

  try {
    knowledgeIndex = await fs.readFile(path.join(DOCS_DIR, 'knowledge/INDEX.md'), 'utf-8');
  } catch {}

  try {
    codebaseStatus = await fs.readFile(path.join(DOCS_DIR, 'Codebase_Status.md'), 'utf-8');
  } catch {}

  return {
    vision,
    knowledgeIndex,
    codebaseStatus,
  };
}

// ─── Terminal Docs Functions ─────────────────────────────────────────────────

const TERMINALS_DOCS_DIR = path.join(DOCS_DIR, 'terminals');

export interface TerminalDocsInfo {
  name: string;
  hasReadme: boolean;
  port: string | null;
  type: 'persistent' | 'on-demand';
  directory: string;
}

/**
 * List all terminals with their docs
 */
export async function listTerminalDocs(): Promise<TerminalDocsInfo[]> {
  const results: TerminalDocsInfo[] = [];

  // Terminal info - uses SPACEOS_ROOT env var for portability
  const ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
  const PORTAL_PATH = process.env.FRONTEND_PORTAL_PATH || 'frontend/portal';
  const TERMINAL_INFO: Record<string, { port: string | null; type: 'persistent' | 'on-demand'; directory: string }> = {
    root: { port: null, type: 'persistent', directory: `${ROOT}/` },
    conductor: { port: null, type: 'persistent', directory: `${ROOT}/spaceos-conductor/` },
    architect: { port: null, type: 'persistent', directory: `${ROOT}/spaceos-architect/` },
    librarian: { port: null, type: 'on-demand', directory: `${ROOT}/spaceos-librarian/` },
    nexus: { port: '3456', type: 'on-demand', directory: `${ROOT}/spaceos-nexus/` },
    kernel: { port: '5000', type: 'on-demand', directory: `${ROOT}/backend/spaceos-kernel/` },
    orch: { port: '3000', type: 'on-demand', directory: `${ROOT}/backend/spaceos-orchestrator/` },
    fe: { port: '5173', type: 'on-demand', directory: `${ROOT}/${PORTAL_PATH}/` },
    joinery: { port: '5002', type: 'on-demand', directory: `${ROOT}/backend/spaceos-modules-joinery/` },
    abstractions: { port: '5003', type: 'on-demand', directory: `${ROOT}/backend/spaceos-modules-abstractions/` },
    cutting: { port: '5005', type: 'on-demand', directory: `${ROOT}/backend/spaceos-modules-cutting/` },
    inventory: { port: '5004', type: 'on-demand', directory: `${ROOT}/backend/spaceos-modules-inventory/` },
    procurement: { port: '5006', type: 'on-demand', directory: `${ROOT}/backend/spaceos-modules-procurement/` },
    sales: { port: '5007', type: 'on-demand', directory: `${ROOT}/backend/spaceos-modules-sales/` },
    identity: { port: '5008', type: 'on-demand', directory: `${ROOT}/backend/spaceos-modules-identity/` },
    infra: { port: null, type: 'on-demand', directory: `${ROOT}/infra/` },
    e2e: { port: null, type: 'on-demand', directory: `${ROOT}/e2e/` },
  };

  try {
    const entries = await fs.readdir(TERMINALS_DOCS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const terminalPath = path.join(TERMINALS_DOCS_DIR, entry.name);
      const readmePath = path.join(terminalPath, 'README.md');

      let hasReadme = false;
      try {
        await fs.access(readmePath);
        hasReadme = true;
      } catch {}

      const info = TERMINAL_INFO[entry.name] || { port: null, type: 'on-demand' as const, directory: '' };

      results.push({
        name: entry.name,
        hasReadme,
        port: info.port,
        type: info.type,
        directory: info.directory,
      });
    }
  } catch {}

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get terminal docs README content
 */
export async function getTerminalDocs(terminal: string): Promise<{
  name: string;
  readme: string | null;
  index: string | null;
}> {
  const normalizedTerminal = terminal.toLowerCase();
  const terminalPath = path.join(TERMINALS_DOCS_DIR, normalizedTerminal);
  const readmePath = path.join(terminalPath, 'README.md');
  const indexPath = path.join(TERMINALS_DOCS_DIR, 'INDEX.md');

  let readme: string | null = null;
  let index: string | null = null;

  try {
    readme = await fs.readFile(readmePath, 'utf-8');
  } catch {}

  try {
    index = await fs.readFile(indexPath, 'utf-8');
  } catch {}

  return {
    name: normalizedTerminal,
    readme,
    index,
  };
}

/**
 * Get terminals index - the main INDEX.md
 */
export async function getTerminalsIndex(): Promise<string | null> {
  try {
    return await fs.readFile(path.join(TERMINALS_DOCS_DIR, 'INDEX.md'), 'utf-8');
  } catch {
    return null;
  }
}
