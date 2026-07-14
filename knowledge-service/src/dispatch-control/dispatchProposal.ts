/**
 * Dispatch Proposal System — Phase 4 Conductor Orchestration
 *
 * Allows Conductor to propose session dispatches that Root can approve/reject.
 * This enables human-in-the-loop control while maintaining automation benefits.
 *
 * Flow:
 * 1. Conductor detects UNREAD inbox → proposes dispatch
 * 2. Root reviews proposal → approves/rejects
 * 3. On approval → session starts automatically
 * 4. On rejection → proposal archived, no session
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { telegram, log } from '../pipeline/common';
import { getDispatchMode, canDispatch, queueDispatch, markDispatchExecuting } from './tokenBudget';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DispatchProposal {
  proposalId: string;
  terminal: string;
  taskId: string;
  reason: string;
  estimatedTokens: number;
  proposedBy: string;
  proposedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy?: string;
  decidedAt?: string;
}

export interface ProposalCreateParams {
  terminal: string;
  taskId: string;
  reason: string;
  estimatedTokens?: number;
  proposedBy: string;
}

export interface ProposalDecision {
  proposalId: string;
  approved: boolean;
  decidedBy: string;
  reason?: string;
}

// ── Database Access ──────────────────────────────────────────────────────────

// Import db from tokenBudget (shared database)
let db: Database.Database | null = null;

export function setProposalDb(database: Database.Database): void {
  db = database;
}

function getDb(): Database.Database {
  if (!db) {
    throw new Error('Proposal database not initialized. Call setProposalDb first.');
  }
  return db;
}

// ── Proposal Creation ────────────────────────────────────────────────────────

export function createProposal(params: ProposalCreateParams): DispatchProposal {
  const proposalId = `PROP-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const estimatedTokens = params.estimatedTokens || 5000;
  const now = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO dispatch_proposals (proposal_id, terminal, task_id, reason, estimated_tokens, proposed_by, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(proposalId, params.terminal, params.taskId, params.reason, estimatedTokens, params.proposedBy);

  log(`[DispatchProposal] Created: ${proposalId} for ${params.terminal} (${params.taskId})`);

  return {
    proposalId,
    terminal: params.terminal,
    taskId: params.taskId,
    reason: params.reason,
    estimatedTokens,
    proposedBy: params.proposedBy,
    proposedAt: now,
    status: 'pending',
  };
}

// ── Proposal Queries ─────────────────────────────────────────────────────────

export function getPendingProposals(): DispatchProposal[] {
  const rows = getDb().prepare(`
    SELECT proposal_id, terminal, task_id, reason, estimated_tokens, proposed_by, proposed_at, status
    FROM dispatch_proposals
    WHERE status = 'pending'
    ORDER BY proposed_at ASC
  `).all() as Array<{
    proposal_id: string;
    terminal: string;
    task_id: string;
    reason: string;
    estimated_tokens: number;
    proposed_by: string;
    proposed_at: string;
    status: string;
  }>;

  return rows.map(row => ({
    proposalId: row.proposal_id,
    terminal: row.terminal,
    taskId: row.task_id,
    reason: row.reason,
    estimatedTokens: row.estimated_tokens,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    status: row.status as DispatchProposal['status'],
  }));
}

export function getProposal(proposalId: string): DispatchProposal | null {
  const row = getDb().prepare(`
    SELECT proposal_id, terminal, task_id, reason, estimated_tokens, proposed_by, proposed_at, status, decided_by, decided_at
    FROM dispatch_proposals
    WHERE proposal_id = ?
  `).get(proposalId) as {
    proposal_id: string;
    terminal: string;
    task_id: string;
    reason: string;
    estimated_tokens: number;
    proposed_by: string;
    proposed_at: string;
    status: string;
    decided_by: string | null;
    decided_at: string | null;
  } | undefined;

  if (!row) return null;

  return {
    proposalId: row.proposal_id,
    terminal: row.terminal,
    taskId: row.task_id,
    reason: row.reason,
    estimatedTokens: row.estimated_tokens,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    status: row.status as DispatchProposal['status'],
    decidedBy: row.decided_by || undefined,
    decidedAt: row.decided_at || undefined,
  };
}

// ── Proposal Decision ────────────────────────────────────────────────────────

export interface DecisionResult {
  success: boolean;
  proposal?: DispatchProposal;
  sessionStarted?: boolean;
  error?: string;
}

export async function decideProposal(decision: ProposalDecision): Promise<DecisionResult> {
  const proposal = getProposal(decision.proposalId);

  if (!proposal) {
    return { success: false, error: 'Proposal not found' };
  }

  if (proposal.status !== 'pending') {
    return { success: false, error: `Proposal already ${proposal.status}` };
  }

  const now = new Date().toISOString();
  const newStatus = decision.approved ? 'approved' : 'rejected';

  // Update proposal status
  getDb().prepare(`
    UPDATE dispatch_proposals
    SET status = ?, decided_by = ?, decided_at = datetime('now')
    WHERE proposal_id = ?
  `).run(newStatus, decision.decidedBy, decision.proposalId);

  const updatedProposal: DispatchProposal = {
    ...proposal,
    status: newStatus,
    decidedBy: decision.decidedBy,
    decidedAt: now,
  };

  // If approved, start the session
  let sessionStarted = false;
  if (decision.approved) {
    try {
      // Queue the dispatch
      queueDispatch(proposal.taskId, proposal.terminal, 'high', proposal.estimatedTokens);
      markDispatchExecuting(proposal.taskId, `proposal-${decision.proposalId}`);
      sessionStarted = true;

      await log(`[DispatchProposal] Approved: ${decision.proposalId} → session starting for ${proposal.terminal}`);
    } catch (err) {
      await log(`[DispatchProposal] Approved but session failed: ${err}`);
    }
  } else {
    await log(`[DispatchProposal] Rejected: ${decision.proposalId} by ${decision.decidedBy}`);
  }

  return {
    success: true,
    proposal: updatedProposal,
    sessionStarted,
  };
}

// ── Bulk Operations ──────────────────────────────────────────────────────────

export function approveAllPending(decidedBy: string): { approved: number; proposals: string[] } {
  const pending = getPendingProposals();
  const approvedIds: string[] = [];

  for (const proposal of pending) {
    getDb().prepare(`
      UPDATE dispatch_proposals
      SET status = 'approved', decided_by = ?, decided_at = datetime('now')
      WHERE proposal_id = ?
    `).run(decidedBy, proposal.proposalId);

    queueDispatch(proposal.taskId, proposal.terminal, 'high', proposal.estimatedTokens);
    approvedIds.push(proposal.proposalId);
  }

  log(`[DispatchProposal] Bulk approved ${approvedIds.length} proposals by ${decidedBy}`);

  return { approved: approvedIds.length, proposals: approvedIds };
}

export function expireOldProposals(maxAgeHours: number = 24): number {
  const result = getDb().prepare(`
    UPDATE dispatch_proposals
    SET status = 'expired'
    WHERE status = 'pending'
    AND proposed_at < datetime('now', '-' || ? || ' hours')
  `).run(maxAgeHours);

  if (result.changes > 0) {
    log(`[DispatchProposal] Expired ${result.changes} old proposals (>${maxAgeHours}h)`);
  }

  return result.changes;
}

// ── Notification ─────────────────────────────────────────────────────────────

export async function notifyNewProposal(proposal: DispatchProposal): Promise<void> {
  const message = `📋 *Dispatch Proposal*

*Terminal:* ${proposal.terminal}
*Task:* ${proposal.taskId}
*Reason:* ${proposal.reason}
*Tokens:* ~${proposal.estimatedTokens}
*Proposed by:* ${proposal.proposedBy}

Reply with proposal ID to approve/reject.`;

  try {
    await telegram(message);
  } catch (err) {
    console.error('[DispatchProposal] Failed to send notification:', err);
  }
}

// ── Statistics ───────────────────────────────────────────────────────────────

export interface ProposalStats {
  pending: number;
  approvedToday: number;
  rejectedToday: number;
  expiredToday: number;
  avgApprovalTimeMs: number;
}

export function getProposalStats(): ProposalStats {
  const pending = getDb().prepare(`
    SELECT COUNT(*) as count FROM dispatch_proposals WHERE status = 'pending'
  `).get() as { count: number };

  const approvedToday = getDb().prepare(`
    SELECT COUNT(*) as count FROM dispatch_proposals
    WHERE status = 'approved' AND DATE(decided_at) = DATE('now')
  `).get() as { count: number };

  const rejectedToday = getDb().prepare(`
    SELECT COUNT(*) as count FROM dispatch_proposals
    WHERE status = 'rejected' AND DATE(decided_at) = DATE('now')
  `).get() as { count: number };

  const expiredToday = getDb().prepare(`
    SELECT COUNT(*) as count FROM dispatch_proposals
    WHERE status = 'expired' AND DATE(decided_at) = DATE('now')
  `).get() as { count: number };

  // Average approval time (in milliseconds)
  const avgTime = getDb().prepare(`
    SELECT AVG(
      (julianday(decided_at) - julianday(proposed_at)) * 24 * 60 * 60 * 1000
    ) as avg_ms
    FROM dispatch_proposals
    WHERE status = 'approved' AND decided_at IS NOT NULL
  `).get() as { avg_ms: number | null };

  return {
    pending: pending.count,
    approvedToday: approvedToday.count,
    rejectedToday: rejectedToday.count,
    expiredToday: expiredToday.count,
    avgApprovalTimeMs: avgTime.avg_ms || 0,
  };
}
