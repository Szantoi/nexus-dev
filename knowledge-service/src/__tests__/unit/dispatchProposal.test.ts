import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Dispatch Proposal Tests — Phase 4 Conductor Orchestration
 *
 * Tests the proposal workflow where Conductor proposes dispatches
 * and Root can approve/reject them.
 */

// In-memory test database
let testDb: Database.Database;

// Mock the telegram function
vi.mock('../../pipeline/common', () => ({
  telegram: vi.fn().mockResolvedValue(undefined),
  log: vi.fn(),
}));

function resetTestDb() {
  testDb = new Database(':memory:');
  testDb.exec(`
    -- Token usage table
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      tokens_used INTEGER NOT NULL,
      model TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Dispatch mode configuration
    CREATE TABLE IF NOT EXISTS dispatch_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL DEFAULT 'manual',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    );

    INSERT OR IGNORE INTO dispatch_config (id, mode) VALUES (1, 'auto');

    -- Dispatch queue
    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE NOT NULL,
      terminal TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      estimated_tokens INTEGER,
      queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'queued',
      session_id TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      tokens_actual INTEGER,
      error_message TEXT
    );

    -- Budget configuration per terminal
    CREATE TABLE IF NOT EXISTS budget_config (
      terminal TEXT PRIMARY KEY,
      daily_limit INTEGER NOT NULL DEFAULT 10000,
      hourly_limit INTEGER,
      priority_reserve INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO budget_config (terminal, daily_limit, priority_reserve) VALUES
      ('root', 20000, 5000),
      ('conductor', 15000, 3000),
      ('backend', 10000, 2000),
      ('frontend', 10000, 2000);

    -- Dispatch proposals table
    CREATE TABLE IF NOT EXISTS dispatch_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT UNIQUE NOT NULL,
      terminal TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      estimated_tokens INTEGER DEFAULT 5000,
      proposed_by TEXT NOT NULL,
      proposed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending',
      decided_by TEXT,
      decided_at DATETIME
    );
  `);
}

// Helper functions for proposals
function createProposal(params: {
  terminal: string;
  taskId: string;
  reason: string;
  estimatedTokens?: number;
  proposedBy: string;
}) {
  const proposalId = `PROP-${Date.now()}-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
  const estimatedTokens = params.estimatedTokens || 5000;

  testDb.prepare(`
    INSERT INTO dispatch_proposals (proposal_id, terminal, task_id, reason, estimated_tokens, proposed_by, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(proposalId, params.terminal, params.taskId, params.reason, estimatedTokens, params.proposedBy);

  return {
    proposalId,
    terminal: params.terminal,
    taskId: params.taskId,
    reason: params.reason,
    estimatedTokens,
    proposedBy: params.proposedBy,
    status: 'pending' as const,
  };
}

function getPendingProposals() {
  const rows = testDb.prepare(`
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
    status: row.status,
  }));
}

function getProposal(proposalId: string) {
  const row = testDb.prepare(`
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
    status: row.status,
    decidedBy: row.decided_by || undefined,
    decidedAt: row.decided_at || undefined,
  };
}

function decideProposal(decision: {
  proposalId: string;
  approved: boolean;
  decidedBy: string;
  reason?: string;
}) {
  const proposal = getProposal(decision.proposalId);

  if (!proposal) {
    return { success: false, error: 'Proposal not found' };
  }

  if (proposal.status !== 'pending') {
    return { success: false, error: `Proposal already ${proposal.status}` };
  }

  const newStatus = decision.approved ? 'approved' : 'rejected';

  testDb.prepare(`
    UPDATE dispatch_proposals
    SET status = ?, decided_by = ?, decided_at = datetime('now')
    WHERE proposal_id = ?
  `).run(newStatus, decision.decidedBy, decision.proposalId);

  // If approved, queue the dispatch
  if (decision.approved) {
    testDb.prepare(`
      INSERT OR REPLACE INTO dispatch_queue (message_id, terminal, priority, estimated_tokens, status)
      VALUES (?, ?, 'high', ?, 'queued')
    `).run(proposal.taskId, proposal.terminal, proposal.estimatedTokens);
  }

  return {
    success: true,
    proposal: {
      ...proposal,
      status: newStatus,
      decidedBy: decision.decidedBy,
    },
    sessionStarted: decision.approved,
  };
}

function approveAllPending(decidedBy: string) {
  const pending = getPendingProposals();
  const approvedIds: string[] = [];

  for (const proposal of pending) {
    testDb.prepare(`
      UPDATE dispatch_proposals
      SET status = 'approved', decided_by = ?, decided_at = datetime('now')
      WHERE proposal_id = ?
    `).run(decidedBy, proposal.proposalId);

    testDb.prepare(`
      INSERT OR REPLACE INTO dispatch_queue (message_id, terminal, priority, estimated_tokens, status)
      VALUES (?, ?, 'high', ?, 'queued')
    `).run(proposal.taskId, proposal.terminal, proposal.estimatedTokens);

    approvedIds.push(proposal.proposalId);
  }

  return { approved: approvedIds.length, proposals: approvedIds };
}

function expireOldProposals(maxAgeHours: number = 24) {
  const result = testDb.prepare(`
    UPDATE dispatch_proposals
    SET status = 'expired'
    WHERE status = 'pending'
    AND proposed_at < datetime('now', '-' || ? || ' hours')
  `).run(maxAgeHours);

  return result.changes;
}

function getProposalStats() {
  const pending = testDb.prepare(`
    SELECT COUNT(*) as count FROM dispatch_proposals WHERE status = 'pending'
  `).get() as { count: number };

  const approvedToday = testDb.prepare(`
    SELECT COUNT(*) as count FROM dispatch_proposals
    WHERE status = 'approved' AND DATE(decided_at) = DATE('now')
  `).get() as { count: number };

  const rejectedToday = testDb.prepare(`
    SELECT COUNT(*) as count FROM dispatch_proposals
    WHERE status = 'rejected' AND DATE(decided_at) = DATE('now')
  `).get() as { count: number };

  return {
    pending: pending.count,
    approvedToday: approvedToday.count,
    rejectedToday: rejectedToday.count,
  };
}

function getDispatchQueue() {
  return testDb.prepare(`
    SELECT message_id, terminal, priority, estimated_tokens, status
    FROM dispatch_queue
    WHERE status IN ('queued', 'executing')
    ORDER BY queued_at ASC
  `).all();
}

describe('DispatchProposal', () => {
  beforeEach(() => {
    resetTestDb();
  });

  describe('Proposal Creation', () => {
    it('should create a new proposal', () => {
      const proposal = createProposal({
        terminal: 'backend',
        taskId: 'MSG-BACKEND-001',
        reason: 'UNREAD inbox message detected',
        proposedBy: 'conductor',
      });

      expect(proposal.proposalId).toMatch(/^PROP-/);
      expect(proposal.terminal).toBe('backend');
      expect(proposal.taskId).toBe('MSG-BACKEND-001');
      expect(proposal.status).toBe('pending');
      expect(proposal.estimatedTokens).toBe(5000);
    });

    it('should create proposal with custom token estimate', () => {
      const proposal = createProposal({
        terminal: 'frontend',
        taskId: 'MSG-FRONTEND-002',
        reason: 'Complex UI task',
        estimatedTokens: 10000,
        proposedBy: 'conductor',
      });

      expect(proposal.estimatedTokens).toBe(10000);
    });
  });

  describe('Proposal Queries', () => {
    it('should get pending proposals', () => {
      createProposal({
        terminal: 'backend',
        taskId: 'MSG-BACKEND-001',
        reason: 'Task 1',
        proposedBy: 'conductor',
      });

      createProposal({
        terminal: 'frontend',
        taskId: 'MSG-FRONTEND-001',
        reason: 'Task 2',
        proposedBy: 'conductor',
      });

      const pending = getPendingProposals();
      expect(pending.length).toBe(2);
      expect(pending[0].terminal).toBe('backend');
      expect(pending[1].terminal).toBe('frontend');
    });

    it('should get specific proposal', () => {
      const created = createProposal({
        terminal: 'backend',
        taskId: 'MSG-BACKEND-001',
        reason: 'Test task',
        proposedBy: 'conductor',
      });

      const retrieved = getProposal(created.proposalId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.taskId).toBe('MSG-BACKEND-001');
      expect(retrieved?.status).toBe('pending');
    });

    it('should return null for non-existent proposal', () => {
      const retrieved = getProposal('PROP-NONEXISTENT');
      expect(retrieved).toBeNull();
    });
  });

  describe('Proposal Decision', () => {
    it('should approve proposal and queue dispatch', () => {
      const proposal = createProposal({
        terminal: 'backend',
        taskId: 'MSG-BACKEND-001',
        reason: 'Test task',
        proposedBy: 'conductor',
      });

      const result = decideProposal({
        proposalId: proposal.proposalId,
        approved: true,
        decidedBy: 'root',
      });

      expect(result.success).toBe(true);
      expect(result.proposal?.status).toBe('approved');
      expect(result.sessionStarted).toBe(true);

      // Check dispatch was queued
      const queue = getDispatchQueue();
      expect(queue.length).toBe(1);
      expect((queue[0] as any).message_id).toBe('MSG-BACKEND-001');
    });

    it('should reject proposal without queuing', () => {
      const proposal = createProposal({
        terminal: 'backend',
        taskId: 'MSG-BACKEND-001',
        reason: 'Test task',
        proposedBy: 'conductor',
      });

      const result = decideProposal({
        proposalId: proposal.proposalId,
        approved: false,
        decidedBy: 'root',
        reason: 'Not needed now',
      });

      expect(result.success).toBe(true);
      expect(result.proposal?.status).toBe('rejected');
      expect(result.sessionStarted).toBe(false);

      // Check dispatch was NOT queued
      const queue = getDispatchQueue();
      expect(queue.length).toBe(0);
    });

    it('should fail for non-existent proposal', () => {
      const result = decideProposal({
        proposalId: 'PROP-NONEXISTENT',
        approved: true,
        decidedBy: 'root',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Proposal not found');
    });

    it('should fail for already decided proposal', () => {
      const proposal = createProposal({
        terminal: 'backend',
        taskId: 'MSG-BACKEND-001',
        reason: 'Test task',
        proposedBy: 'conductor',
      });

      // First decision
      decideProposal({
        proposalId: proposal.proposalId,
        approved: true,
        decidedBy: 'root',
      });

      // Second decision should fail
      const result = decideProposal({
        proposalId: proposal.proposalId,
        approved: false,
        decidedBy: 'root',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already');
    });
  });

  describe('Bulk Operations', () => {
    it('should approve all pending proposals', () => {
      createProposal({
        terminal: 'backend',
        taskId: 'MSG-BACKEND-001',
        reason: 'Task 1',
        proposedBy: 'conductor',
      });

      createProposal({
        terminal: 'frontend',
        taskId: 'MSG-FRONTEND-001',
        reason: 'Task 2',
        proposedBy: 'conductor',
      });

      createProposal({
        terminal: 'architect',
        taskId: 'MSG-ARCHITECT-001',
        reason: 'Task 3',
        proposedBy: 'conductor',
      });

      const result = approveAllPending('root');

      expect(result.approved).toBe(3);
      expect(result.proposals.length).toBe(3);

      // All should be approved
      const pending = getPendingProposals();
      expect(pending.length).toBe(0);

      // All should be queued
      const queue = getDispatchQueue();
      expect(queue.length).toBe(3);
    });

    it('should handle empty pending list', () => {
      const result = approveAllPending('root');

      expect(result.approved).toBe(0);
      expect(result.proposals.length).toBe(0);
    });
  });

  describe('Proposal Statistics', () => {
    it('should return correct stats', () => {
      // Create some proposals
      const p1 = createProposal({
        terminal: 'backend',
        taskId: 'MSG-1',
        reason: 'Task 1',
        proposedBy: 'conductor',
      });

      createProposal({
        terminal: 'frontend',
        taskId: 'MSG-2',
        reason: 'Task 2',
        proposedBy: 'conductor',
      });

      const p3 = createProposal({
        terminal: 'architect',
        taskId: 'MSG-3',
        reason: 'Task 3',
        proposedBy: 'conductor',
      });

      // Approve one
      decideProposal({
        proposalId: p1.proposalId,
        approved: true,
        decidedBy: 'root',
      });

      // Reject one
      decideProposal({
        proposalId: p3.proposalId,
        approved: false,
        decidedBy: 'root',
      });

      const stats = getProposalStats();

      expect(stats.pending).toBe(1);
      expect(stats.approvedToday).toBe(1);
      expect(stats.rejectedToday).toBe(1);
    });
  });

  describe('Proposal Expiration', () => {
    it('should not expire recent proposals', () => {
      createProposal({
        terminal: 'backend',
        taskId: 'MSG-1',
        reason: 'Fresh task',
        proposedBy: 'conductor',
      });

      const expired = expireOldProposals(24);

      expect(expired).toBe(0);

      const pending = getPendingProposals();
      expect(pending.length).toBe(1);
    });

    it('should expire old proposals (simulated)', () => {
      // Create proposal
      createProposal({
        terminal: 'backend',
        taskId: 'MSG-1',
        reason: 'Old task',
        proposedBy: 'conductor',
      });

      // Manually backdate the proposal
      testDb.prepare(`
        UPDATE dispatch_proposals
        SET proposed_at = datetime('now', '-25 hours')
        WHERE task_id = 'MSG-1'
      `).run();

      const expired = expireOldProposals(24);

      expect(expired).toBe(1);

      const pending = getPendingProposals();
      expect(pending.length).toBe(0);
    });
  });
});
