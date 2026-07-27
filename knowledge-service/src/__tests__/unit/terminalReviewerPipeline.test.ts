/**
 * terminalReviewer pipeline unit tests — hermetic (TASK-QC-006).
 *
 * PINS the tmux-based dual review contract of src/pipeline/terminalReviewer.ts:
 *  - handleTerminalReview: skip rules (info-type messages, review_level: none),
 *    level routing (light / standard / strict), reject inbox on rejection,
 *    approved:false on unreadable input.
 *  - runDualTerminalReview: standard requires both APPROVE but tolerates a
 *    single reviewer timeout; strict additionally requires substantial
 *    feedback; results land in the JSONL decision log + Architect MEMORY +
 *    Librarian PROCESSED_LOG; tmux failure → ERROR verdict.
 *  - waitForReviewResponse: VERDICT parsing from captured pane, 2000-char
 *    feedback truncation, timeout when no verdict ever appears.
 *  - requestReview (MCP path): invalid/missing DONE id and session-start
 *    failure fall back to PENDING_MANUAL + conductor inbox message; success
 *    path returns the parsed verdict and writes the audit log.
 *
 * Hermetic setup: child_process is fully mocked (exec via the
 * promisify.custom symbol, execSync as the pane-capture stub — no real tmux),
 * './common' is mocked with a temp SPACEOS_ROOT + no-op log/telegram,
 * '../config/terminals' and '../sessionStarter' are mocked. The module's real
 * sleeps (0.5s/1s/4s startup + 2s poll + 120s timeout) are driven with fake
 * timers: only setTimeout/Date are faked, and each drive() iteration yields a
 * real setImmediate turn so real fs IO on the temp tree can complete.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';

const H = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const nodePath = require('path');
  const nodeOs = require('os');
  const nodeFs = require('fs');
  const runId = require('crypto').randomBytes(6).toString('hex');

  // Forward slashes so /terminals\/(...)/ and /mailbox\/(...)/ match on Windows.
  const root = nodePath.join(nodeOs.tmpdir(), `termrev-root-${runId}`).replace(/\\/g, '/');
  nodeFs.mkdirSync(root, { recursive: true });
  process.env.DATA_DIR = nodePath.join(nodeOs.tmpdir(), `termrev-data-${runId}`);

  const execAsyncMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const execSyncMock = vi.fn(() => '');
  const exec = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execAsyncMock,
  });
  const startWorkSessionMock = vi.fn();

  return { root, execAsyncMock, execSyncMock, exec, startWorkSessionMock };
});

vi.mock('child_process', () => ({ exec: H.exec, execSync: H.execSyncMock }));
vi.mock('../../core/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../pipeline/common', () => ({
  SPACEOS_ROOT: H.root,
  log: vi.fn(async () => {}),
  telegram: vi.fn(async () => {}),
}));
import * as os from 'os';
import * as path from 'path';

vi.mock('../../config/terminals', () => ({
  getTmuxSocket: () => path.join(os.tmpdir(), 'test-spaceos.tmux'),
}));
vi.mock('../../sessionStarter', () => ({ startWorkSession: H.startWorkSessionMock }));

import {
  runDualTerminalReview,
  createTerminalRejectInbox,
  handleTerminalReview,
  requestReview,
} from '../../pipeline/terminalReviewer';
import { log, telegram } from '../../pipeline/common';

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ROOT = H.root;
const OUTBOX = `${ROOT}/terminals/backend/outbox`;
const INBOX = `${ROOT}/terminals/backend/inbox`;
const DECISIONS_LOG = `${ROOT}/logs/reviews/decisions.jsonl`;
const ARCHITECT_MEMORY = `${ROOT}/terminals/architect/MEMORY.md`;
const LIBRARIAN_LOG = `${ROOT}/terminals/librarian/PROCESSED_LOG.md`;

const APPROVE_PANE =
  'VERDICT: APPROVE\nFEEDBACK: A megvalositas megfelel a tervnek es a korabbi mintaknak.';
const REJECT_PANE =
  'VERDICT: REJECT\nFEEDBACK: Hianyzik a hibakezeles es a teszt lefedettseg.';
const NO_VERDICT_PANE = 'meg gondolkodom a valaszon, semmi hasznos kimenet';

const mockedTelegram = vi.mocked(telegram);
const mockedLog = vi.mocked(log);

function writeDone(name: string, content: string): string {
  const p = `${OUTBOX}/${name}`;
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** Route the pane capture by review session name. */
function setPanes(architect: string, librarian: string): void {
  H.execSyncMock.mockImplementation((cmd: string) => {
    if (cmd.includes('spaceos-review-architect')) return architect;
    return librarian;
  });
}

/**
 * Drive a promise to completion under fake timers. Each iteration fires the
 * next pending fake timer (module sleeps/polls/timeouts jump instantly) and
 * then ALWAYS yields one REAL setImmediate turn so pending real fs IO can
 * complete between virtual-clock steps. Budgeted on the REAL wall clock
 * (performance.now is not faked) instead of an iteration count, so slow IO
 * cannot lose a race against the virtual clock.
 */
async function drive<T>(promise: Promise<T>, maxWallMs = 10000): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const wallStart = performance.now();
  while (!settled) {
    if (performance.now() - wallStart > maxWallMs) {
      throw new Error('drive(): promise did not settle within the wall-clock budget');
    }
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return promise;
}

function useDriverTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

beforeAll(() => {
  fs.mkdirSync(OUTBOX, { recursive: true });
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(`${ROOT}/terminals/architect`, { recursive: true });
  fs.mkdirSync(`${ROOT}/terminals/librarian`, { recursive: true });
  fs.writeFileSync(ARCHITECT_MEMORY, '# Architect MEMORY\n', 'utf-8');
  fs.writeFileSync(LIBRARIAN_LOG, '# Librarian PROCESSED_LOG\n', 'utf-8');

  // Original inbox task referenced by the DONE messages
  fs.writeFileSync(
    `${INBOX}/2026-07-18_001_task.md`,
    '---\nid: MSG-BACKEND-001\ntype: task\nstatus: UNREAD\nmodel: haiku\n---\n# Feladat\nCsinald meg.\n',
    'utf-8'
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  H.execAsyncMock.mockImplementation(async () => ({ stdout: '', stderr: '' }));
  H.execSyncMock.mockImplementation(() => '');
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ─── handleTerminalReview: skip rules + errors ───────────────────────────────

describe('handleTerminalReview — skip rules', () => {
  it('auto-approves info-type messages without any review session', async () => {
    const donePath = writeDone(
      '2026-07-18_030_info.md',
      '---\nid: MSG-BACKEND-030\ntype: info\nstatus: DONE\n---\nCsak tajekoztatas.\n'
    );

    const result = await handleTerminalReview(donePath);

    expect(result.approved).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("Message type 'info' does not require review");
    expect(H.execAsyncMock).not.toHaveBeenCalled();
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('Review Skipped'));
  });

  it('auto-approves when review_level is none', async () => {
    const donePath = writeDone(
      '2026-07-18_031_none.md',
      '---\nid: MSG-BACKEND-031\ntype: done\nstatus: DONE\nreview_level: none\n---\nKesz.\n'
    );

    const result = await handleTerminalReview(donePath);

    expect(result.approved).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('review_level: none');
    expect(H.execAsyncMock).not.toHaveBeenCalled();
  });

  it('returns approved:false when the DONE file cannot be read', async () => {
    const result = await handleTerminalReview(`${OUTBOX}/does-not-exist.md`);

    expect(result).toEqual({ approved: false });
    expect(mockedLog).toHaveBeenCalledWith(expect.stringContaining('[TerminalReviewer] Error:'));
  });
});

// ─── Standard dual review ─────────────────────────────────────────────────────

describe('runDualTerminalReview — standard', () => {
  it('approves when Architect and Librarian both APPROVE, and persists log + memory', async () => {
    const donePath = writeDone(
      '2026-07-18_032_done-ok.md',
      '---\nid: MSG-BACKEND-032\ntype: done\nstatus: DONE\nref: MSG-BACKEND-001\n---\nKesz a feladat.\n'
    );
    setPanes(APPROVE_PANE, APPROVE_PANE);
    useDriverTimers();

    const result = await drive(handleTerminalReview(donePath));

    expect(result.approved).toBe(true);
    expect(result.reviewLevel).toBe('standard');
    expect(result.skipped).toBeUndefined();

    // Both ephemeral review sessions were driven over the mocked tmux
    const cmds = H.execAsyncMock.mock.calls.map((c) => String(c[0]));
    expect(cmds.some((c) => c.includes('new-session') && c.includes('spaceos-review-architect'))).toBe(true);
    expect(cmds.some((c) => c.includes('new-session') && c.includes('spaceos-review-librarian'))).toBe(true);
    expect(cmds.some((c) => c.includes('[REVIEW REQUEST - Architect]'))).toBe(true);
    expect(cmds.some((c) => c.includes('[REVIEW REQUEST - Librarian]'))).toBe(true);

    // Decision log + memory files updated
    const decisions = fs.readFileSync(DECISIONS_LOG, 'utf-8');
    expect(decisions).toContain('"task_type":"TERMINAL_REVIEW"');
    expect(decisions).toContain('"final_verdict":"APPROVED"');
    expect(fs.readFileSync(ARCHITECT_MEMORY, 'utf-8')).toContain('**Verdict:** APPROVE');
    expect(fs.readFileSync(LIBRARIAN_LOG, 'utf-8')).toContain('**Final:** APPROVED');
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('Terminal Review'));
  });

  it('rejects when both reviewers REJECT; createTerminalRejectInbox writes the reject message', async () => {
    // Legacy docs/mailbox path also pins the mailbox/-based terminal extraction.
    const legacyOutbox = `${ROOT}/docs/mailbox/backend/outbox`;
    fs.mkdirSync(legacyOutbox, { recursive: true });
    const donePath = `${legacyOutbox}/2026-07-18_033_done-bad.md`;
    fs.writeFileSync(
      donePath,
      '---\nid: MSG-BACKEND-033\ntype: done\nstatus: DONE\n---\nKesz, szerintem.\n',
      'utf-8'
    );
    setPanes(REJECT_PANE, REJECT_PANE);
    useDriverTimers();

    const result = await drive(runDualTerminalReview(donePath, 'standard'));

    expect(result.approved).toBe(false);
    expect(result.terminal).toBe('backend');
    expect(result.architectReview.verdict).toBe('REJECT');
    expect(result.librarianReview.verdict).toBe('REJECT');
    expect(result.reviewId).toMatch(/^REV-/);

    vi.useRealTimers();
    const rejectPath = await createTerminalRejectInbox(result);
    expect(rejectPath).toContain('terminal-review-reject');
    const content = fs.readFileSync(rejectPath, 'utf-8');
    expect(content).toContain('# Terminal Review visszadobás: 2026-07-18_033_done-bad');
    expect(content).toContain('## Architect verdict: REJECT');
    expect(content).toContain('## Librarian verdict: REJECT');
    expect(content).toContain('Hianyzik a hibakezeles es a teszt lefedettseg.');
    expect(content).toContain(`review_id: ${result.reviewId}`);
    expect(content).toContain('to: backend');
  });

  it('accepts a Librarian-only APPROVE when the Architect review times out', async () => {
    const donePath = writeDone(
      '2026-07-18_034_done-timeout.md',
      '---\nid: MSG-BACKEND-034\ntype: done\nstatus: DONE\n---\nKesz.\n'
    );
    // Architect pane never shows a VERDICT → 120s timeout → ERROR('timeout')
    setPanes(NO_VERDICT_PANE, APPROVE_PANE);
    useDriverTimers();

    const result = await drive(runDualTerminalReview(donePath, 'standard'));

    expect(result.architectReview.verdict).toBe('ERROR');
    expect(result.architectReview.feedback).toBe('Review timeout - no response received');
    expect(result.librarianReview.verdict).toBe('APPROVE');
    expect(result.approved).toBe(true);
    expect(mockedLog).toHaveBeenCalledWith(
      expect.stringContaining('Architect timeout, accepting Librarian-only APPROVE')
    );
  });

  it('returns ERROR verdicts (→ rejected) when the tmux session cannot be created', async () => {
    const donePath = writeDone(
      '2026-07-18_035_done-tmuxfail.md',
      '---\nid: MSG-BACKEND-035\ntype: done\nstatus: DONE\n---\nKesz.\n'
    );
    H.execAsyncMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes('new-session')) throw new Error('tmux failed');
      return { stdout: '', stderr: '' };
    });
    useDriverTimers();

    const result = await drive(runDualTerminalReview(donePath, 'standard'));

    expect(result.approved).toBe(false);
    expect(result.architectReview.verdict).toBe('ERROR');
    expect(result.architectReview.feedback).toBe('Review error: tmux failed');
    expect(result.librarianReview.verdict).toBe('ERROR');
  });
});

// ─── Strict + light levels ────────────────────────────────────────────────────

describe('review levels', () => {
  it('strict rejects a dual APPROVE when the feedback is not substantial', async () => {
    const donePath = writeDone(
      '2026-07-18_036_done-strict-thin.md',
      '---\nid: MSG-BACKEND-036\ntype: done\nstatus: DONE\n---\nKesz.\n'
    );
    setPanes('VERDICT: APPROVE\nFEEDBACK: ok', 'VERDICT: APPROVE\nFEEDBACK: ok');
    useDriverTimers();

    const result = await drive(runDualTerminalReview(donePath, 'strict'));

    expect(result.architectReview.verdict).toBe('APPROVE');
    expect(result.librarianReview.verdict).toBe('APPROVE');
    expect(result.approved).toBe(false);
    expect(mockedLog).toHaveBeenCalledWith(
      expect.stringContaining('feedback insufficient')
    );
  });

  it('strict approves a dual APPROVE with substantial feedback', async () => {
    const donePath = writeDone(
      '2026-07-18_037_done-strict-ok.md',
      '---\nid: MSG-BACKEND-037\ntype: done\nstatus: DONE\n---\nKesz.\n'
    );
    setPanes(APPROVE_PANE, APPROVE_PANE);
    useDriverTimers();

    const result = await drive(runDualTerminalReview(donePath, 'strict'));

    expect(result.approved).toBe(true);
  });

  it('light review consults only the Librarian and auto-approves the Architect slot', async () => {
    const donePath = writeDone(
      '2026-07-18_038_done-light.md',
      '---\nid: MSG-BACKEND-038\ntype: done\nstatus: DONE\nreview_level: light\nref: MSG-BACKEND-001\n---\nKesz.\n'
    );
    setPanes(NO_VERDICT_PANE, APPROVE_PANE);
    useDriverTimers();

    const result = await drive(handleTerminalReview(donePath));

    expect(result.approved).toBe(true);
    expect(result.reviewLevel).toBe('light');
    // No architect review session was ever created
    const cmds = H.execAsyncMock.mock.calls.map((c) => String(c[0]));
    expect(cmds.some((c) => c.includes('spaceos-review-architect'))).toBe(false);
    expect(cmds.some((c) => c.includes('spaceos-review-librarian'))).toBe(true);

    const decisions = fs.readFileSync(DECISIONS_LOG, 'utf-8');
    expect(decisions).toContain('"task_type":"TERMINAL_REVIEW_LIGHT"');
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('Light Review'));
  });
});

// ─── requestReview (MCP path) ─────────────────────────────────────────────────

describe('requestReview', () => {
  it('falls back to PENDING_MANUAL + conductor inbox on an invalid DONE message id', async () => {
    const result = await requestReview('architect', 'MSG-BACKEND-001', 'not-a-valid-id');

    expect(result.verdict).toBe('PENDING_MANUAL');
    expect(result.reviewer).toBe('manual');
    expect(result.feedback).toContain('Invalid DONE message ID format: not-a-valid-id');
    expect(typeof result.duration_ms).toBe('number');
    expect(H.startWorkSessionMock).not.toHaveBeenCalled();

    const conductorInbox = `${ROOT}/terminals/conductor/inbox`;
    const files = fs.readdirSync(conductorInbox).filter((f) => f.includes('manual-review-architect'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(`${conductorInbox}/${files[0]}`, 'utf-8');
    expect(content).toContain('# Manual Review Required: architect');
    expect(content).toContain('Invalid DONE message ID format');
  });

  it('falls back to PENDING_MANUAL when the DONE message cannot be found', async () => {
    const result = await requestReview('librarian', 'MSG-BACKEND-001', 'MSG-BACKEND-999');

    expect(result.verdict).toBe('PENDING_MANUAL');
    expect(result.feedback).toContain('DONE message not found: MSG-BACKEND-999');
    expect(H.startWorkSessionMock).not.toHaveBeenCalled();
  });

  it('falls back to PENDING_MANUAL when the review session fails to start', async () => {
    writeDone(
      '2026-07-18_040_done-msg42.md',
      '---\nid: MSG-BACKEND-042\ntype: done\nstatus: DONE\n---\nKesz.\n'
    );
    H.startWorkSessionMock.mockResolvedValue({ success: false, message: 'spawn failed' });

    const result = await requestReview('architect', 'MSG-BACKEND-001', 'MSG-BACKEND-042');

    expect(result.verdict).toBe('PENDING_MANUAL');
    expect(result.feedback).toContain('Failed to start architect review session: spawn failed');
  });

  it('returns the parsed verdict, truncates over-long feedback and writes the audit log on success', async () => {
    writeDone(
      '2026-07-18_041_done-msg43.md',
      '---\nid: MSG-BACKEND-043\ntype: done\nstatus: DONE\nref: MSG-BACKEND-001\n---\nKesz.\n'
    );
    H.startWorkSessionMock.mockResolvedValue({
      success: true,
      sessionName: 'spaceos-review-architect',
      message: 'ok',
    });
    // 2500-char feedback → must be truncated to 2000 chars ending with '...'
    setPanes(`VERDICT: APPROVE\nFEEDBACK: ${'x'.repeat(2500)}`, '');
    useDriverTimers();

    const result = await drive(requestReview('architect', 'MSG-BACKEND-001', 'MSG-BACKEND-043'));

    expect(result.verdict).toBe('APPROVE');
    expect(result.reviewer).toBe('architect');
    expect(result.feedback).toHaveLength(2000);
    expect(result.feedback.endsWith('...')).toBe(true);
    expect(typeof result.duration_ms).toBe('number');
    expect(H.startWorkSessionMock).toHaveBeenCalledWith(
      'architect',
      expect.stringContaining('[REVIEW REQUEST - Architect]'),
      'haiku'
    );

    // Audit trail written under logs/reviews/<date>-review.log
    const auditDir = `${ROOT}/logs/reviews`;
    const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith('-review.log'));
    expect(auditFiles.length).toBeGreaterThan(0);
    const audit = fs.readFileSync(`${auditDir}/${auditFiles[0]}`, 'utf-8');
    expect(audit).toContain('"done_message_id":"MSG-BACKEND-043"');
    expect(audit).toContain('"verdict":"APPROVE"');
  });
});
