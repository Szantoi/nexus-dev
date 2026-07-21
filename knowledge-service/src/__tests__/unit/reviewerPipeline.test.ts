/**
 * reviewer pipeline unit tests — hermetic (TASK-QC-006).
 *
 * PINS the DONE-review contract of src/pipeline/reviewer.ts:
 *  - runDualReview: graceful skip without ANTHROPIC_API_KEY, dual-LLM
 *    approve/reject with require_both semantics, UNKNOWN on unparseable
 *    responses, ERROR on API failure, raw responses persisted, decisions
 *    appended to the JSONL review log, and MAX_ATTEMPTS escalation to
 *    terminals/root/inbox.
 *  - createRejectInbox: reject message written under docs/mailbox with the
 *    original inbox model and both reviewer verdicts/feedback.
 *  - handleDoneReview routing: manual → escalate (no gate, no LLM);
 *    pre-review gate failure → prereview-reject inbox (no LLM); formal →
 *    deterministic checks (frontmatter, git, tsc/build/lint/tests via mocked
 *    exec); content → dual LLM review; broken input file → approved:false.
 *
 * Hermetic setup: '@anthropic-ai/sdk' is a mock class (messages.create is a
 * vi.fn), './common' is mocked with a temp SPACEOS_ROOT + no-op log/telegram,
 * './preReviewGate' is mocked, and child_process.exec is mocked via the
 * promisify.custom symbol (runFormalReview imports it dynamically). All file
 * IO happens under os.tmpdir(); paths are built with forward slashes so the
 * /terminals\/(...)\// terminal-extraction regexes match on Windows too.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';

const H = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const nodePath = require('path');
  const nodeOs = require('os');
  const nodeFs = require('fs');
  const runId = require('crypto').randomBytes(6).toString('hex');

  // Forward slashes: reviewer.ts extracts the terminal with /terminals\/(...)/.
  const root = nodePath.join(nodeOs.tmpdir(), `reviewer-root-${runId}`).replace(/\\/g, '/');
  nodeFs.mkdirSync(root, { recursive: true });

  process.env.DATA_DIR = nodePath.join(nodeOs.tmpdir(), `reviewer-data-${runId}`);
  process.env.ANTHROPIC_API_KEY = 'test-key-hermetic-never-real';

  const createMock = vi.fn(); // Anthropic client.messages.create
  const gateMock = vi.fn(); // runPreReviewGate
  const execAsyncMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const exec = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execAsyncMock,
  });

  return { root, createMock, gateMock, execAsyncMock, exec };
});

vi.mock('child_process', () => ({ exec: H.exec, execSync: vi.fn() }));
vi.mock('../../core/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../pipeline/common', () => ({
  SPACEOS_ROOT: H.root,
  log: vi.fn(async () => {}),
  telegram: vi.fn(async () => {}),
}));
vi.mock('../../pipeline/preReviewGate', () => ({ runPreReviewGate: H.gateMock }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: H.createMock };
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_opts: unknown) {}
  },
}));

import { runDualReview, createRejectInbox, handleDoneReview } from '../../pipeline/reviewer';
import { log, telegram } from '../../pipeline/common';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ROOT = H.root;
const OUTBOX = `${ROOT}/terminals/backend/outbox`;
const INBOX = `${ROOT}/terminals/backend/inbox`;
const TASK_TYPE_DIR = `${ROOT}/config/task-types`;
const DECISIONS_LOG = `${ROOT}/logs/reviews/decisions.jsonl`;

const APPROVE_TEXT = 'VERDICT: APPROVE\nFEEDBACK: Minden rendben, a feladat teljesult.';
const REJECT_TEXT = 'VERDICT: REJECT\nFEEDBACK: Hianyzik a teszt lefedettseg.';

const apiResponse = (text: string) => ({ content: [{ type: 'text', text }] });

function writeDone(name: string, content: string): string {
  const p = `${OUTBOX}/${name}`;
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

const mockedTelegram = vi.mocked(telegram);
const mockedLog = vi.mocked(log);

beforeAll(() => {
  fs.mkdirSync(OUTBOX, { recursive: true });
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(`${ROOT}/scripts`, { recursive: true });

  fs.writeFileSync(
    `${ROOT}/scripts/reviewer-config.yaml`,
    [
      'reviewer:',
      '  model_a: haiku',
      '  model_b: haiku',
      '  parallel: true',
      '  require_both: true',
      'timing:',
      '  review_timeout: 1',
      '  file_wait: 1',
      'verdict:',
      '  approve_keywords: [APPROVE]',
      '  reject_keywords: [REJECT]',
      'paths:',
      '  prompt_template: scripts/review-prompt.md',
      '  context_file: scripts/review-context.md',
      '  log_dir: logs/dispatcher',
      '  review_dir: logs/reviews/raw',
      'reject_inbox:',
      '  priority: high',
      '  model_fallback: sonnet',
      'notifications:',
      '  on_approve: true',
      '  on_reject: true',
      '  on_error: true',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    `${ROOT}/scripts/review-prompt.md`,
    'CTX:{{CONTEXT}}|IN:{{INBOX_PATH}}|INC:{{INBOX_CONTENT}}|DP:{{DONE_PATH}}|DC:{{DONE_CONTENT}}',
    'utf-8'
  );
  fs.writeFileSync(`${ROOT}/scripts/review-context.md`, 'Review context here.', 'utf-8');

  // Original inbox task referenced by ref: MSG-BACKEND-007 (model + task_type source)
  fs.writeFileSync(
    `${INBOX}/2026-07-18_001_task.md`,
    [
      '---',
      'id: MSG-BACKEND-007',
      'type: task',
      'status: UNREAD',
      'model: haiku',
      'task_type: FEATURE',
      '---',
      '# Feladat',
      'Implementald a funkciot.',
      '',
    ].join('\n'),
    'utf-8'
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key-hermetic-never-real';
  H.execAsyncMock.mockImplementation(async () => ({ stdout: '', stderr: '' }));
});

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ─── runDualReview ────────────────────────────────────────────────────────────

describe('runDualReview', () => {
  it('skips gracefully with ERROR verdicts when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const donePath = `${ROOT}/terminals/backend/outbox/2026-07-18_011_done-nokey.md`;

    const result = await runDualReview(donePath);

    expect(result.approved).toBe(false);
    expect(result.terminal).toBe('backend');
    expect(result.doneBase).toBe('2026-07-18_011_done-nokey');
    expect(result.reviewA.verdict).toBe('ERROR');
    expect(result.reviewA.feedback).toBe('ANTHROPIC_API_KEY not configured - manual review required');
    expect(result.reviewB.verdict).toBe('ERROR');
    expect(H.createMock).not.toHaveBeenCalled();
  });

  it('approves when both reviewers APPROVE, persists raw responses and logs the decision', async () => {
    const donePath = writeDone(
      '2026-07-18_010_done-task.md',
      '---\nid: MSG-BACKEND-010\ntype: done\nstatus: DONE\nref: MSG-BACKEND-007\n---\n# Kesz\n'
    );
    H.createMock.mockResolvedValue(apiResponse(APPROVE_TEXT));

    const result = await runDualReview(donePath);

    expect(result.approved).toBe(true);
    expect(result.reviewA.verdict).toBe('APPROVE');
    expect(result.reviewA.feedback).toBe('Minden rendben, a feladat teljesult.');
    expect(result.reviewB.verdict).toBe('APPROVE');
    expect(result.reviewId).toMatch(/^REV-/);

    // Prompt was built from the template + inbox + done content, model mapped
    expect(H.createMock).toHaveBeenCalledTimes(2);
    const call = H.createMock.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5');
    expect(call.messages[0].content).toContain('CTX:Review context here.');
    expect(call.messages[0].content).toContain('id: MSG-BACKEND-007');
    expect(call.messages[0].content).toContain(`DP:${donePath}`);

    // Raw reviewer outputs saved
    const rawA = fs.readFileSync(`${ROOT}/logs/reviews/raw/2026-07-18_010_done-task_reviewer_a.txt`, 'utf-8');
    expect(rawA).toBe(APPROVE_TEXT);

    // Decision appended to the JSONL log
    const logContent = fs.readFileSync(DECISIONS_LOG, 'utf-8');
    expect(logContent).toContain('"final_verdict":"APPROVED"');
    expect(logContent).toContain(result.reviewId as string);
  });

  it('rejects under require_both when only one reviewer approves; createRejectInbox writes the reject message', async () => {
    const donePath = writeDone(
      '2026-07-18_012_done-split.md',
      '---\nid: MSG-BACKEND-012\ntype: done\nstatus: DONE\nref: MSG-BACKEND-007\n---\n# Kesz\n'
    );
    H.createMock
      .mockResolvedValueOnce(apiResponse(APPROVE_TEXT))
      .mockResolvedValueOnce(apiResponse(REJECT_TEXT));

    const result = await runDualReview(donePath);
    expect(result.approved).toBe(false);
    expect(result.reviewA.verdict).toBe('APPROVE');
    expect(result.reviewB.verdict).toBe('REJECT');

    const rejectPath = await createRejectInbox(result);
    expect(rejectPath).toContain('review-reject');
    const content = fs.readFileSync(rejectPath, 'utf-8');
    expect(content).toContain('# Review visszadobás: 2026-07-18_012_done-split');
    expect(content).toContain('## Reviewer-A verdict: APPROVE');
    expect(content).toContain('## Reviewer-B verdict: REJECT');
    expect(content).toContain('Hianyzik a teszt lefedettseg.');
    expect(content).toContain('priority: high');
    // model taken from the original inbox message
    expect(content).toContain('model: haiku');
    expect(content).toContain('to: backend');
  });

  it('honors require_both: false from the task-type config (single APPROVE suffices)', async () => {
    fs.mkdirSync(TASK_TYPE_DIR, { recursive: true });
    fs.writeFileSync(
      `${TASK_TYPE_DIR}/CODE.yaml`,
      [
        'type: CODE',
        'description: test',
        'strictness: medium',
        'require_both: false',
        'escalation_policy:',
        '  max_attempts: 99',
        '  escalate_to: root',
        '  notify: root',
        'version: "1"',
        '',
      ].join('\n'),
      'utf-8'
    );
    try {
      // No ref → no inbox → default task type CODE
      const donePath = writeDone(
        '2026-07-18_013_done-single.md',
        '---\nid: MSG-BACKEND-013\ntype: done\nstatus: DONE\n---\n# Kesz\n'
      );
      H.createMock
        .mockResolvedValueOnce(apiResponse(REJECT_TEXT))
        .mockResolvedValueOnce(apiResponse(APPROVE_TEXT));

      const result = await runDualReview(donePath);

      expect(result.approved).toBe(true);
      expect(result.reviewA.verdict).toBe('REJECT');
      expect(result.reviewB.verdict).toBe('APPROVE');
    } finally {
      fs.rmSync(`${TASK_TYPE_DIR}/CODE.yaml`, { force: true });
    }
  });

  it('returns UNKNOWN verdicts (→ rejected) when the response has no parseable VERDICT', async () => {
    const donePath = writeDone(
      '2026-07-18_014_done-garbage.md',
      '---\nid: MSG-BACKEND-014\ntype: done\nstatus: DONE\n---\n# Kesz\n'
    );
    H.createMock.mockResolvedValue(apiResponse('semmi ertelmes valasz, formatum nelkul'));

    const result = await runDualReview(donePath);

    expect(result.approved).toBe(false);
    expect(result.reviewA.verdict).toBe('UNKNOWN');
    expect(result.reviewB.verdict).toBe('UNKNOWN');
  });

  it('returns ERROR verdicts with the API error message when the SDK call fails', async () => {
    const donePath = writeDone(
      '2026-07-18_015_done-apierror.md',
      '---\nid: MSG-BACKEND-015\ntype: done\nstatus: DONE\n---\n# Kesz\n'
    );
    H.createMock.mockRejectedValue(new Error('boom'));

    const result = await runDualReview(donePath);

    expect(result.approved).toBe(false);
    expect(result.reviewA.verdict).toBe('ERROR');
    expect(result.reviewA.feedback).toBe('Review hiba: boom');
    expect(result.reviewB.verdict).toBe('ERROR');
  });

  it('escalates to terminals/root/inbox when max review attempts are exceeded', async () => {
    fs.mkdirSync(TASK_TYPE_DIR, { recursive: true });
    fs.writeFileSync(
      `${TASK_TYPE_DIR}/CODE.yaml`,
      [
        'type: CODE',
        'description: test',
        'strictness: high',
        'require_both: true',
        'escalation_policy:',
        '  max_attempts: 1',
        '  escalate_to: root',
        '  notify: root',
        'version: "1"',
        '',
      ].join('\n'),
      'utf-8'
    );
    // Seed a previous attempt for the no-inbox hash so attempt > max_attempts.
    fs.mkdirSync(`${ROOT}/logs/reviews`, { recursive: true });
    const seed = {
      timestamp: new Date().toISOString(),
      review_id: 'REV-SEED-1',
      inbox_file: '(nem található)',
      inbox_hash: 'sha256:unknown',
      done_file: 'x',
      done_hash: 'sha256:x',
      task_type: 'CODE',
      review_attempt: 1,
      reviewer_a: { model: 'haiku', verdict: 'REJECT', feedback_hash: 'sha256:a' },
      reviewer_b: { model: 'haiku', verdict: 'REJECT', feedback_hash: 'sha256:b' },
      final_verdict: 'REJECTED',
    };
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify(seed) + '\n', 'utf-8');

    try {
      const donePath = writeDone(
        '2026-07-18_016_done-escalate.md',
        '---\nid: MSG-BACKEND-016\ntype: done\nstatus: DONE\n---\n# Kesz\n'
      );

      const result = await runDualReview(donePath);

      expect(result.approved).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.reviewA.feedback).toBe('Max attempts exceeded');
      expect(result.reviewId).toMatch(/^REV-/);
      // No LLM call on escalation
      expect(H.createMock).not.toHaveBeenCalled();

      // Escalation message landed in root's inbox
      const rootInbox = `${ROOT}/terminals/root/inbox`;
      const files = fs.readdirSync(rootInbox).filter((f) => f.includes('escalation-backend'));
      expect(files.length).toBeGreaterThan(0);
      const content = fs.readFileSync(`${rootInbox}/${files[0]}`, 'utf-8');
      expect(content).toContain('escalation_reason: MAX_ATTEMPTS_EXCEEDED');
      expect(content).toContain('task_type: MANUAL_REVIEW');
      expect(content).toContain('priority: critical');
      expect(content).toContain(result.reviewId as string);

      // Escalation was recorded and announced
      const logContent = fs.readFileSync(DECISIONS_LOG, 'utf-8');
      expect(logContent).toContain('"escalated":true');
      expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('ESCALATION to Root'));
    } finally {
      fs.rmSync(`${TASK_TYPE_DIR}/CODE.yaml`, { force: true });
    }
  });
});

// ─── handleDoneReview routing ─────────────────────────────────────────────────

describe('handleDoneReview', () => {
  it('escalates manual reviews without running the gate or any LLM review', async () => {
    const donePath = writeDone(
      '2026-07-18_020_done-manual.md',
      '---\nid: MSG-BACKEND-020\ntype: done\nstatus: DONE\nreview_type: manual\n---\n# Manualis\n'
    );

    const result = await handleDoneReview(donePath);

    expect(result).toEqual({ approved: false, reviewType: 'manual' });
    expect(H.gateMock).not.toHaveBeenCalled();
    expect(H.createMock).not.toHaveBeenCalled();
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('Manual review requested'));
  });

  it('rejects via prereview-reject inbox when the pre-review gate fails (no LLM call)', async () => {
    const donePath = writeDone(
      '2026-07-18_021_done-gatefail.md',
      '---\nid: MSG-BACKEND-021\ntype: done\nstatus: DONE\n---\n# Kesz\nA knowledge-service modositasa.\n'
    );
    H.gateMock.mockResolvedValue({
      passed: false,
      checks: [
        {
          name: 'TypeScript (Backend)',
          passed: false,
          duration_ms: 5,
          error: 'TypeScript errors found: 3 errors',
        },
        { name: 'Unit Tests', passed: true, duration_ms: 5 },
      ],
      summary: '❌ 1/3 checks failed',
      duration_ms: 10,
      project: 'knowledge-service',
    });

    const result = await handleDoneReview(donePath);

    expect(result.approved).toBe(false);
    expect(result.reviewType).toBe('pre-review');
    expect(H.gateMock).toHaveBeenCalledWith('knowledge-service');
    expect(H.createMock).not.toHaveBeenCalled();

    expect(result.resultPath).toBeDefined();
    const content = fs.readFileSync(result.resultPath as string, 'utf-8');
    expect(content).toContain('# Pre-Review Failed: 2026-07-18_021_done-gatefail');
    expect(content).toContain('- **TypeScript (Backend)**: TypeScript errors found: 3 errors');
    expect(content).toContain('❌ 1/3 checks failed');
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('Pre-Review FAILED'));
  });

  it('approves a formal review when the gate passes and the deterministic checks are green', async () => {
    const donePath = writeDone(
      '2026-07-18_022_done-formal-ok.md',
      '---\nid: MSG-BACKEND-022\ntype: done\nstatus: DONE\nreview_type: formal\ntask_type: DOCS\n---\nDokumentacio frissitve a knowledge-service modulhoz.\n'
    );
    H.gateMock.mockResolvedValue({
      passed: true,
      checks: [],
      summary: '✅ All 3 checks passed (10ms)',
      duration_ms: 10,
      project: 'knowledge-service',
    });

    const result = await handleDoneReview(donePath);

    expect(result).toEqual({ approved: true, reviewType: 'formal' });
    expect(H.gateMock).toHaveBeenCalledWith('knowledge-service');
    expect(H.createMock).not.toHaveBeenCalled();
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('FORMAL review passed'));
  });

  it('runs formal code checks (tsc/build/lint) via exec for CODE task types and approves on green', async () => {
    const donePath = writeDone(
      '2026-07-18_023_done-formal-code.md',
      '---\nid: MSG-BACKEND-023\ntype: done\nstatus: DONE\nreview_type: formal\ntask_type: CODE\n---\nSemleges kodvaltozas.\n'
    );
    H.execAsyncMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes('npm ls eslint')) return { stdout: 'svc@1.0.0\n└── eslint@9.0.0', stderr: '' };
      return { stdout: '', stderr: '' }; // tsc --noEmit, npm run build, npx eslint all green
    });

    const result = await handleDoneReview(donePath);

    expect(result).toEqual({ approved: true, reviewType: 'formal' });
    const cmds = H.execAsyncMock.mock.calls.map((c) => String(c[0]));
    expect(cmds.some((c) => c.includes('tsc --noEmit'))).toBe(true);
    expect(cmds.some((c) => c.includes('npm run build'))).toBe(true);
    expect(cmds.some((c) => c.includes('npx eslint'))).toBe(true);
    // not strict + not BUGFIX → no test run
    expect(cmds.some((c) => c === 'npm test')).toBe(false);
  });

  it('rejects a formal review with a formal-review-reject inbox when frontmatter is incomplete', async () => {
    // status: missing → frontmatter check fails; no project keywords → gate skipped
    const donePath = writeDone(
      '2026-07-18_024_done-formal-bad.md',
      '---\nid: MSG-BACKEND-024\ntype: done\nreview_type: formal\ntask_type: DOCS\n---\nSemleges szoveg.\n'
    );

    const result = await handleDoneReview(donePath);

    expect(result.approved).toBe(false);
    expect(result.reviewType).toBe('formal');
    expect(H.gateMock).not.toHaveBeenCalled();

    expect(result.resultPath).toBeDefined();
    expect(result.resultPath).toContain('formal-review-reject');
    const content = fs.readFileSync(result.resultPath as string, 'utf-8');
    expect(content).toContain('# Formal Review visszadobás: 2026-07-18_024_done-formal-bad');
    expect(content).toContain('| frontmatter | ❌ |');
    expect(content).toContain('Frontmatter missing or incomplete (required: id, type, status)');
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('FORMAL review failed'));
  });

  it('fails the formal git check when files_changed are still uncommitted', async () => {
    const donePath = writeDone(
      '2026-07-18_025_done-formal-git.md',
      [
        '---',
        'id: MSG-BACKEND-025',
        'type: done',
        'status: DONE',
        'review_type: formal',
        'task_type: DOCS',
        'files_changed:',
        '  - src/foo.ts',
        '---',
        'Semleges szoveg.',
        '',
      ].join('\n')
    );
    H.execAsyncMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes('git status')) return { stdout: ' M src/foo.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await handleDoneReview(donePath);

    expect(result.approved).toBe(false);
    const content = fs.readFileSync(result.resultPath as string, 'utf-8');
    expect(content).toContain('| gitCommit | ❌ |');
    expect(content).toContain('Files marked as changed are not committed to git');
  });

  it('collects tsc/build/lint/test failures in the formal reject message (strict CODE)', async () => {
    const donePath = writeDone(
      '2026-07-18_026_done-formal-fails.md',
      '---\nid: MSG-BACKEND-026\ntype: done\nstatus: DONE\nreview_type: formal\ntask_type: CODE\nreview_level: strict\n---\nSemleges kod.\n'
    );
    H.execAsyncMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes('tsc --noEmit')) {
        throw Object.assign(new Error('tsc failed'), { stderr: 'src/x.ts(1,1): error TS2304: boom' });
      }
      if (cmd.includes('npm run build')) throw new Error('build failed');
      if (cmd.includes('npm ls eslint')) return { stdout: 'svc@1.0.0\n└── eslint@9.0.0', stderr: '' };
      if (cmd.includes('npx eslint')) {
        throw Object.assign(new Error('lint failed'), { stdout: 'src/x.ts 1:1 error no-unused-vars' });
      }
      if (cmd.includes('npm test')) {
        throw Object.assign(new Error('tests failed'), { stdout: 'Tests: 3 failed, 10 passed' });
      }
      return { stdout: '', stderr: '' };
    });

    const result = await handleDoneReview(donePath);

    expect(result.approved).toBe(false);
    const content = fs.readFileSync(result.resultPath as string, 'utf-8');
    expect(content).toContain('| typeCheck | ❌ |');
    expect(content).toContain('| buildSuccess | ❌ |');
    expect(content).toContain('| lintPass | ❌ |');
    expect(content).toContain('| testsPass | ❌ |');
    expect(content).toContain('Type check failed: src/x.ts(1,1): error TS2304: boom');
    expect(content).toContain('Build failed (npm run build)');
    expect(content).toContain('Lint failed: src/x.ts 1:1 error no-unused-vars');
    expect(content).toContain('Tests failed (3 failures)');
  });

  it('routes default (content) reviews through the dual LLM review and approves', async () => {
    // No project keywords → the pre-review gate is skipped entirely.
    const donePath = writeDone(
      '2026-07-18_027_done-content-ok.md',
      '---\nid: MSG-BACKEND-027\ntype: done\nstatus: DONE\n---\nSemleges tartalom.\n'
    );
    H.createMock.mockResolvedValue(apiResponse(APPROVE_TEXT));

    const result = await handleDoneReview(donePath);

    expect(result).toEqual({ approved: true, reviewType: 'content' });
    expect(H.gateMock).not.toHaveBeenCalled();
    expect(H.createMock).toHaveBeenCalledTimes(2);
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('DONE elfogadva'));
  });

  it('creates a reject inbox when the content review rejects', async () => {
    const donePath = writeDone(
      '2026-07-18_028_done-content-rej.md',
      '---\nid: MSG-BACKEND-028\ntype: done\nstatus: DONE\n---\nSemleges tartalom.\n'
    );
    H.createMock.mockResolvedValue(apiResponse(REJECT_TEXT));

    const result = await handleDoneReview(donePath);

    expect(result.approved).toBe(false);
    expect(result.reviewType).toBe('content');
    expect(result.resultPath).toBeDefined();
    const content = fs.readFileSync(result.resultPath as string, 'utf-8');
    expect(content).toContain('## Reviewer-A verdict: REJECT');
    expect(content).toContain('## Reviewer-B verdict: REJECT');
  });

  it('returns approved:false and reports the error when the DONE file cannot be read', async () => {
    const result = await handleDoneReview(`${ROOT}/terminals/backend/outbox/does-not-exist.md`);

    expect(result).toEqual({ approved: false });
    expect(mockedLog).toHaveBeenCalledWith(expect.stringContaining('[Reviewer] Error:'));
    expect(mockedTelegram).toHaveBeenCalledWith(expect.stringContaining('Reviewer hiba'));
  });
});
