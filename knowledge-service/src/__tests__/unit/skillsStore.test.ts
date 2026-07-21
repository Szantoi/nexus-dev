/**
 * skills.ts unit tests — hermetic, temp SPACEOS_ROOT tree.
 *
 * PINS the skill/workflow/terminal-docs discovery contract:
 *  - listSkills scans <SPACEOS_ROOT>/.claude/skills (dirs only), extracts the
 *    frontmatter description, flags SKILL.md/references presence
 *  - getSkill returns SKILL.md + .md references (non-.md ignored), null if absent
 *  - getWorkflow / getTerminalsIndex / getProjectContext read fixed doc paths
 *    and return null per missing file instead of throwing
 *  - getTerminalSetup: CLAUDE.md + terminal-specific skill with generic
 *    "spaceos-terminal" fallback + truncated workflow + MCP config;
 *    unknown terminal throws
 *  - listTerminalDocs / getTerminalDocs merge docs/terminals/* dirs with the
 *    built-in port/type table (unknown dirs get on-demand defaults)
 *
 * SPACEOS_ROOT is read from env at import time by config/paths, so it is set
 * at module top level BEFORE the dynamic import in beforeAll. The "empty tree"
 * describe runs before fixtures are created to cover the missing-dir branches.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const runId = crypto.randomBytes(6).toString('hex');
const ROOT = path.join(os.tmpdir(), `skills-root-${runId}`);
process.env.SPACEOS_ROOT = ROOT;
process.env.DATA_DIR = path.join(os.tmpdir(), `skills-data-${runId}`);
process.env.TERMINALS_PATH = path.join(ROOT, 'terminals');

let skills: typeof import('../../skills');

const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');
const DOCS_DIR = path.join(ROOT, 'docs');
const TERMINAL_DOCS_DIR = path.join(DOCS_DIR, 'terminals');

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

beforeAll(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  skills = await import('../../skills');
});

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── Empty tree: every missing-dir/missing-file branch ──────────────────────

describe('empty SPACEOS_ROOT tree', () => {
  it('listSkills returns [] when the skills directory does not exist', async () => {
    expect(await skills.listSkills()).toEqual([]);
  });

  it('getSkill returns null for a missing skill', async () => {
    expect(await skills.getSkill('does-not-exist')).toBeNull();
  });

  it('getWorkflow and getTerminalsIndex return null when docs are absent', async () => {
    expect(await skills.getWorkflow()).toBeNull();
    expect(await skills.getTerminalsIndex()).toBeNull();
  });

  it('getProjectContext returns all nulls when docs are absent', async () => {
    expect(await skills.getProjectContext()).toEqual({
      vision: null, knowledgeIndex: null, codebaseStatus: null,
    });
  });

  it('listTerminalDocs returns [] and getTerminalDocs returns nulls', async () => {
    expect(await skills.listTerminalDocs()).toEqual([]);
    expect(await skills.getTerminalDocs('root')).toEqual({ name: 'root', readme: null, index: null });
  });

  it('getTerminalSetup on empty tree: nulls everywhere but a valid MCP config', async () => {
    const setup = await skills.getTerminalSetup('root');
    expect(setup.claudeMd).toBeNull();
    expect(setup.skill).toBeNull(); // neither spaceos-root nor spaceos-terminal exists
    expect(setup.workflow).toBeNull();
    expect(setup.mcpConfig).toHaveProperty('mcpServers');
    const mcp = setup.mcpConfig as { mcpServers: Record<string, { type: string }> };
    expect(mcp.mcpServers['spaceos-knowledge'].type).toBe('http');
  });

  it('getTerminalSetup throws for an unknown terminal', async () => {
    await expect(skills.getTerminalSetup('warp-drive')).rejects.toThrow('Unknown terminal: warp-drive');
  });
});

// ─── Populated tree ─────────────────────────────────────────────────────────

describe('populated SPACEOS_ROOT tree', () => {
  beforeAll(() => {
    // Skills
    write(path.join(SKILLS_DIR, 'alpha-skill', 'SKILL.md'), [
      '---',
      'name: alpha-skill',
      'description: >',
      '  Analyzes alpha things',
      '  across multiple lines',
      '---',
      '',
      '# Alpha Skill',
      'Alpha body text.',
    ].join('\n'));
    write(path.join(SKILLS_DIR, 'alpha-skill', 'references', 'ref1.md'), '# Ref One\nReference content.');
    write(path.join(SKILLS_DIR, 'alpha-skill', 'references', 'notes.txt'), 'not markdown, must be ignored');
    write(path.join(SKILLS_DIR, 'beta-skill', 'SKILL.md'), '# Beta\nNo frontmatter here.');
    write(path.join(SKILLS_DIR, 'stray-file.md'), 'files inside skills dir are skipped');
    write(path.join(SKILLS_DIR, 'spaceos-terminal', 'SKILL.md'), '# Generic Terminal Skill\nGENERIC-FALLBACK-MARKER');
    write(path.join(SKILLS_DIR, 'spaceos-conductor', 'SKILL.md'), '# Conductor Skill\nCONDUCTOR-SPECIFIC-MARKER');

    // Docs
    write(path.join(DOCS_DIR, 'WORKFLOW.md'), '# Workflow\nWORKFLOW-BODY-MARKER');
    write(path.join(DOCS_DIR, 'vision', 'SpaceOS_Vision_Master.md'), '# Vision\nVISION-MARKER');
    write(path.join(DOCS_DIR, 'knowledge', 'INDEX.md'), '# Knowledge Index\nKNOWLEDGE-MARKER');
    // Codebase_Status.md deliberately absent -> stays null

    // Terminal docs
    write(path.join(TERMINAL_DOCS_DIR, 'INDEX.md'), '# Terminals Index\nTERMINALS-INDEX-MARKER');
    write(path.join(TERMINAL_DOCS_DIR, 'root', 'README.md'), '# Root Terminal\nROOT-README-MARKER');
    fs.mkdirSync(path.join(TERMINAL_DOCS_DIR, 'kernel'), { recursive: true }); // known, no README
    fs.mkdirSync(path.join(TERMINAL_DOCS_DIR, 'mystery'), { recursive: true }); // unknown -> defaults

    // Root CLAUDE.md for getTerminalSetup('root')
    write(path.join(ROOT, 'CLAUDE.md'), '# Root CLAUDE\nCLAUDE-MD-MARKER');
  });

  it('listSkills finds skill dirs, flattens the folded description, skips plain files', async () => {
    const list = await skills.listSkills();
    const names = list.map(s => s.name);
    expect(names).toEqual(['alpha-skill', 'beta-skill', 'spaceos-conductor', 'spaceos-terminal']); // sorted, no stray-file.md

    const alpha = list.find(s => s.name === 'alpha-skill')!;
    expect(alpha.hasSkillMd).toBe(true);
    expect(alpha.hasReferences).toBe(true);
    expect(alpha.description).toBe('Analyzes alpha things across multiple lines');
    expect(alpha.path).toBe(path.join(SKILLS_DIR, 'alpha-skill'));

    const beta = list.find(s => s.name === 'beta-skill')!;
    expect(beta.hasSkillMd).toBe(true);
    expect(beta.hasReferences).toBe(false);
    expect(beta.description).toBeUndefined();
  });

  it('getSkill returns content plus .md references only', async () => {
    const skill = await skills.getSkill('alpha-skill');
    expect(skill).not.toBeNull();
    expect(skill!.content).toContain('Alpha body text.');
    expect(skill!.references).toHaveLength(1);
    expect(skill!.references![0].name).toBe('ref1.md');
    expect(skill!.references![0].content).toContain('Reference content.');

    const beta = await skills.getSkill('beta-skill');
    expect(beta!.references).toBeUndefined(); // no references dir -> field never set
  });

  it('getWorkflow returns the full document', async () => {
    const wf = await skills.getWorkflow();
    expect(wf).toContain('WORKFLOW-BODY-MARKER');
  });

  it('getTerminalSetup(root): CLAUDE.md + generic fallback skill + truncated workflow', async () => {
    const setup = await skills.getTerminalSetup('ROOT'); // case-insensitive
    expect(setup.claudeMd).toContain('CLAUDE-MD-MARKER');
    // no spaceos-root skill -> falls back to spaceos-terminal
    expect(setup.skill!.name).toBe('spaceos-terminal');
    expect(setup.skill!.content).toContain('GENERIC-FALLBACK-MARKER');
    expect(setup.workflow).toContain('WORKFLOW-BODY-MARKER');
    expect(setup.workflow).toContain('[... truncated ...]');
  });

  it('getTerminalSetup(conductor): terminal-specific skill wins over the fallback', async () => {
    const setup = await skills.getTerminalSetup('conductor');
    expect(setup.skill!.name).toBe('spaceos-conductor');
    expect(setup.skill!.content).toContain('CONDUCTOR-SPECIFIC-MARKER');
    expect(setup.claudeMd).toBeNull(); // ROOT/spaceos-conductor/CLAUDE.md does not exist
  });

  it('getProjectContext reads vision + knowledge index, missing status stays null', async () => {
    const ctx = await skills.getProjectContext();
    expect(ctx.vision).toContain('VISION-MARKER');
    expect(ctx.knowledgeIndex).toContain('KNOWLEDGE-MARKER');
    expect(ctx.codebaseStatus).toBeNull();
  });

  it('listTerminalDocs merges dirs with the port/type table, defaults for unknown dirs', async () => {
    const docs = await skills.listTerminalDocs();
    const names = docs.map(d => d.name);
    expect(names).toEqual(['kernel', 'mystery', 'root']); // sorted; INDEX.md file skipped

    const root = docs.find(d => d.name === 'root')!;
    expect(root.hasReadme).toBe(true);
    expect(root.type).toBe('persistent');
    expect(root.port).toBeNull();
    expect(root.directory.length).toBeGreaterThan(0);

    const kernel = docs.find(d => d.name === 'kernel')!;
    expect(kernel.hasReadme).toBe(false);
    expect(kernel.port).toBe('5000');
    expect(kernel.type).toBe('on-demand');

    const mystery = docs.find(d => d.name === 'mystery')!;
    expect(mystery.port).toBeNull();
    expect(mystery.type).toBe('on-demand');
    expect(mystery.directory).toBe('');
  });

  it('getTerminalDocs lowercases the name and returns README + INDEX', async () => {
    const d = await skills.getTerminalDocs('Root');
    expect(d.name).toBe('root');
    expect(d.readme).toContain('ROOT-README-MARKER');
    expect(d.index).toContain('TERMINALS-INDEX-MARKER');

    const m = await skills.getTerminalDocs('mystery');
    expect(m.readme).toBeNull(); // no README for this dir
    expect(m.index).toContain('TERMINALS-INDEX-MARKER'); // shared index still served
  });

  it('getTerminalsIndex returns the INDEX.md content', async () => {
    expect(await skills.getTerminalsIndex()).toContain('TERMINALS-INDEX-MARKER');
  });
});
