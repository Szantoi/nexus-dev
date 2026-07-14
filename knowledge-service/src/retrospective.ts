/**
 * Retrospective Integration (ADR-046 Track C)
 *
 * Analyzes session history and generates proposals for:
 * - Skills (create, patch, delete)
 * - Memory management (save, retier)
 * - Workflow improvements
 *
 * Inspired by Marveen retrospective skill
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { promises as fs } from 'node:fs';
import { saveTieredMemory, promoteMemory, type MemoryTier } from './pipeline/memoryStore';
import { log as pipelineLog } from './pipeline/common';

const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export type RetrospectiveScope = 'session' | 'last-task' | 'last-hour';
export type RetrospectiveFocus = 'skills' | 'memory' | 'workflow' | 'all';
export type ProposalType = 'skill' | 'memory' | 'workflow';
export type ProposalAction = 'create' | 'patch' | 'delete' | 'save' | 'retier';

export interface RetrospectiveProposal {
  id: number;
  type: ProposalType;
  action: ProposalAction;
  target: string;
  reason: string;
  content?: string;
  newTier?: MemoryTier;
  priority: 'high' | 'medium' | 'low';
}

export interface RetrospectiveAnalysisInput {
  terminal: string;
  scope: RetrospectiveScope;
  focus: RetrospectiveFocus;
  sessionId?: number;
}

export interface RetrospectiveResult {
  sessionSummary: string;
  proposals: RetrospectiveProposal[];
  approved: boolean;
  executedCount: number;
}

export interface ApplyRetrospectiveInput {
  terminal: string;
  approvedProposals: number[];
}

export interface ApplyRetrospectiveResult {
  executedCount: number;
  errors: string[];
  skillsCreated: number;
  memoriesSaved: number;
  workflowsUpdated: number;
}

// ─── Database Path ───────────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const DATA_DIR = process.env.DATA_DIR || `${SPACEOS_ROOT}/spaceos-nexus/knowledge-service/data`;
const DB_PATH = path.join(DATA_DIR, 'memory.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    ensureRetrospectiveTables();
  }
  return db;
}

function ensureRetrospectiveTables(): void {
  const database = db!;

  // Retrospective proposals table
  database.exec(`
    CREATE TABLE IF NOT EXISTS retrospective_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal TEXT NOT NULL,
      session_id INTEGER,
      type TEXT NOT NULL CHECK (type IN ('skill', 'memory', 'workflow')),
      action TEXT NOT NULL CHECK (action IN ('create', 'patch', 'delete', 'save', 'retier')),
      target TEXT NOT NULL,
      reason TEXT NOT NULL,
      content TEXT,
      new_tier TEXT,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
      approved BOOLEAN NOT NULL DEFAULT 0,
      executed BOOLEAN NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_retrospective_terminal ON retrospective_proposals(terminal);
    CREATE INDEX IF NOT EXISTS idx_retrospective_session ON retrospective_proposals(session_id);
    CREATE INDEX IF NOT EXISTS idx_retrospective_approved ON retrospective_proposals(approved);
  `);

  log('retrospective', 'Retrospective tables initialized');
}

// ─── Retrospective Analysis ──────────────────────────────────────────────────

/**
 * Analyze session and generate improvement proposals (ADR-046 Track C)
 */
export async function runRetrospective(
  input: RetrospectiveAnalysisInput
): Promise<RetrospectiveResult> {
  const { terminal, scope, focus, sessionId } = input;

  log('retrospective', `Running retrospective for ${terminal} (scope=${scope}, focus=${focus})`);

  const database = getDb();
  const proposals: RetrospectiveProposal[] = [];

  // Get session history for analysis
  let sessions: Array<Record<string, unknown>> = [];

  if (scope === 'session' && sessionId) {
    const stmt = database.prepare('SELECT * FROM session_history WHERE id = ?');
    const session = stmt.get(sessionId);
    if (session) sessions = [session as Record<string, unknown>];
  } else if (scope === 'last-task') {
    const stmt = database.prepare(`
      SELECT * FROM session_history
      WHERE terminal = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const session = stmt.get(terminal);
    if (session) sessions = [session as Record<string, unknown>];
  } else if (scope === 'last-hour') {
    const stmt = database.prepare(`
      SELECT * FROM session_history
      WHERE terminal = ?
        AND started_at > datetime('now', '-1 hour')
      ORDER BY started_at DESC
    `);
    sessions = stmt.all(terminal) as Array<Record<string, unknown>>;
  }

  if (sessions.length === 0) {
    log('retrospective', 'No sessions found for analysis');
    return {
      sessionSummary: 'No sessions found',
      proposals: [],
      approved: false,
      executedCount: 0,
    };
  }

  // Analyze sessions and generate proposals
  const sessionSummary = buildSessionSummary(sessions);

  // Generate proposals based on focus
  if (focus === 'skills' || focus === 'all') {
    proposals.push(...generateSkillProposals(sessions, terminal));
  }

  if (focus === 'memory' || focus === 'all') {
    proposals.push(...generateMemoryProposals(sessions, terminal));
  }

  if (focus === 'workflow' || focus === 'all') {
    proposals.push(...generateWorkflowProposals(sessions, terminal));
  }

  // Save proposals to database
  for (const proposal of proposals) {
    const stmt = database.prepare(`
      INSERT INTO retrospective_proposals (
        terminal, session_id, type, action, target, reason, content, new_tier, priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      terminal,
      sessionId || null,
      proposal.type,
      proposal.action,
      proposal.target,
      proposal.reason,
      proposal.content || null,
      proposal.newTier || null,
      proposal.priority
    );

    proposal.id = result.lastInsertRowid as number;
  }

  log('retrospective', `Generated ${proposals.length} proposals for ${terminal}`);

  return {
    sessionSummary,
    proposals,
    approved: false, // User must approve manually
    executedCount: 0,
  };
}

/**
 * Apply approved retrospective proposals (ADR-046 Track C)
 */
export async function applyRetrospective(
  input: ApplyRetrospectiveInput
): Promise<ApplyRetrospectiveResult> {
  const { terminal, approvedProposals } = input;

  log('retrospective', `Applying ${approvedProposals.length} approved proposals for ${terminal}`);

  const database = getDb();
  const errors: string[] = [];
  let skillsCreated = 0;
  let memoriesSaved = 0;
  let workflowsUpdated = 0;

  for (const proposalId of approvedProposals) {
    try {
      // Get proposal
      const stmt = database.prepare('SELECT * FROM retrospective_proposals WHERE id = ?');
      const proposal = stmt.get(proposalId) as Record<string, unknown> | undefined;

      if (!proposal) {
        errors.push(`Proposal #${proposalId} not found`);
        continue;
      }

      // Execute based on type and action
      if (proposal.type === 'skill' && proposal.action === 'create') {
        await executeSkillCreate(proposal);
        skillsCreated++;
      } else if (proposal.type === 'memory' && proposal.action === 'save') {
        await executeMemorySave(proposal);
        memoriesSaved++;
      } else if (proposal.type === 'memory' && proposal.action === 'retier') {
        await executeMemoryRetier(proposal);
        memoriesSaved++;
      } else if (proposal.type === 'workflow') {
        // Placeholder for workflow updates
        workflowsUpdated++;
      }

      // Mark as approved and executed
      const updateStmt = database.prepare(`
        UPDATE retrospective_proposals
        SET approved = 1, executed = 1
        WHERE id = ?
      `);
      updateStmt.run(proposalId);

      log('retrospective', `Executed proposal #${proposalId}: ${proposal.type}/${proposal.action}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Proposal #${proposalId}: ${msg}`);
      log('retrospective', `Error executing proposal #${proposalId}: ${msg}`);
    }
  }

  const executedCount = skillsCreated + memoriesSaved + workflowsUpdated;

  log('retrospective', `Applied ${executedCount} proposals (${errors.length} errors)`);

  return {
    executedCount,
    errors,
    skillsCreated,
    memoriesSaved,
    workflowsUpdated,
  };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function buildSessionSummary(sessions: Array<Record<string, unknown>>): string {
  const count = sessions.length;
  const terminals = [...new Set(sessions.map(s => s.terminal as string))];
  const endReasons = sessions.map(s => s.end_reason as string).filter(Boolean);
  const totalToolCalls = sessions.reduce((sum, s) => sum + ((s.tool_calls as number) || 0), 0);

  return `Analyzed ${count} session(s) from ${terminals.join(', ')}. End reasons: ${endReasons.join(', ')}. Total tool calls: ${totalToolCalls}.`;
}

function generateSkillProposals(
  sessions: Array<Record<string, unknown>>,
  terminal: string
): RetrospectiveProposal[] {
  const proposals: RetrospectiveProposal[] = [];

  // Heuristic: if had_corrections, suggest skill improvement
  for (const session of sessions) {
    if (session.had_corrections) {
      proposals.push({
        id: 0, // Will be set when saved to DB
        type: 'skill',
        action: 'create',
        target: `${terminal}-error-recovery`,
        reason: 'Session had corrections - suggest creating error recovery skill',
        content: '# Error Recovery Skill\n\nCapture common error patterns and fixes.',
        priority: 'medium',
      });
      break; // Only suggest once
    }
  }

  return proposals;
}

function generateMemoryProposals(
  sessions: Array<Record<string, unknown>>,
  terminal: string
): RetrospectiveProposal[] {
  const proposals: RetrospectiveProposal[] = [];

  // Heuristic: if session ended successfully, save summary as warm memory
  for (const session of sessions) {
    if (session.end_reason === 'done' && session.task_id) {
      proposals.push({
        id: 0,
        type: 'memory',
        action: 'save',
        target: `task-${session.task_id}`,
        reason: 'Successful task completion - save as warm memory',
        content: `Completed task ${session.task_id} successfully`,
        newTier: 'warm',
        priority: 'low',
      });
    }
  }

  return proposals;
}

function generateWorkflowProposals(
  sessions: Array<Record<string, unknown>>,
  terminal: string
): RetrospectiveProposal[] {
  const proposals: RetrospectiveProposal[] = [];

  // Heuristic: if many tool calls, suggest workflow optimization
  const avgToolCalls =
    sessions.reduce((sum, s) => sum + ((s.tool_calls as number) || 0), 0) / sessions.length;

  if (avgToolCalls > 20) {
    proposals.push({
      id: 0,
      type: 'workflow',
      action: 'create',
      target: `${terminal}-workflow-optimization`,
      reason: `High avg tool calls (${avgToolCalls.toFixed(1)}) - suggest workflow optimization`,
      priority: 'high',
    });
  }

  return proposals;
}

async function executeSkillCreate(proposal: Record<string, unknown>): Promise<void> {
  const skillDir = `/home/${process.env.USER}/.claude/skills/${proposal.target}`;
  await fs.mkdir(skillDir, { recursive: true });

  const skillContent = (proposal.content as string) || '# New Skill\n\nTODO: Add skill content';
  await fs.writeFile(`${skillDir}/SKILL.md`, skillContent, 'utf-8');

  log('retrospective', `Created skill: ${proposal.target}`);
}

async function executeMemorySave(proposal: Record<string, unknown>): Promise<void> {
  const terminal = proposal.terminal as string;
  const content = proposal.content as string;
  const tier = (proposal.new_tier as MemoryTier) || 'warm';

  await saveTieredMemory({
    tier,
    type: 'episodic',
    source: 'skill',
    content,
    terminal,
    salience: 0.6,
  });

  log('retrospective', `Saved memory: ${proposal.target} (tier=${tier})`);
}

async function executeMemoryRetier(proposal: Record<string, unknown>): Promise<void> {
  // Extract memory ID from target (format: "memory-123")
  const target = proposal.target as string;
  const match = target.match(/memory-(\d+)/);
  if (!match) {
    throw new Error(`Invalid memory target: ${target}`);
  }

  const memoryId = parseInt(match[1], 10);
  const newTier = proposal.new_tier as MemoryTier;
  const reason = proposal.reason as string;

  await promoteMemory(memoryId, newTier, reason);

  log('retrospective', `Retiered memory #${memoryId} to ${newTier}`);
}

/**
 * Close database connection
 */
export function closeRetrospective(): void {
  if (db) {
    db.close();
    db = null;
    log('retrospective', 'Database connection closed');
  }
}
