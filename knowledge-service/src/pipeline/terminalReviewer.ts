// terminalReviewer.ts - Architect + Librarian based review
// Replaces Anthropic API calls with Claude Code terminal sessions
//
// Architecture:
//   - Architect (haiku): "Does implementation match the plan?"
//   - Librarian (haiku): "Is it consistent with history?"
//
// Both run in parallel, results saved to MEMORY
// No ANTHROPIC_API_KEY needed - uses existing terminal infrastructure

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SPACEOS_ROOT, log, telegram } from './common';
import { sha256File, sha256String } from './hashUtils';
import {
  appendReviewDecision,
  generateReviewId,
  type ReviewDecision
} from './reviewLog';
import * as terminalsConfig from '../config/terminals';

const execAsync = promisify(exec);

// ── Types ───────────────────────────────────────────────────────────────────

export interface TerminalReviewResult {
  terminal: string;
  verdict: 'APPROVE' | 'REJECT' | 'ERROR';
  feedback: string;
  reviewedAt: string;
  sessionOutput?: string;
}

export interface DualTerminalReviewResult {
  approved: boolean;
  architectReview: TerminalReviewResult;
  librarianReview: TerminalReviewResult;
  terminal: string;
  doneFile: string;
  doneBase: string;
  reviewId: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

const TMUX_SOCKET = terminalsConfig.getTmuxSocket();
const REVIEW_TIMEOUT_MS = 120000; // 2 minutes max per review
const MODEL = 'haiku'; // Fast, cheap, sufficient for review

// ── Review Levels ───────────────────────────────────────────────────────────
//
// Review levels determine how strictly a DONE message is reviewed:
//
// none     - No review needed (info messages, acknowledgments)
// light    - Single reviewer (Librarian only - quick consistency check)
// standard - Dual review (Architect + Librarian) - default
// strict   - Dual review + both must APPROVE + detailed feedback required
//
// Set via frontmatter: review_level: none | light | standard | strict

export type ReviewLevel = 'none' | 'light' | 'standard' | 'strict';

// Message types that don't need review
const NO_REVIEW_TYPES = ['info', 'ack', 'acknowledgment', 'status', 'heartbeat'];

// ── Extract review configuration from DONE content ──────────────────────────

function extractReviewLevel(content: string): ReviewLevel {
  const match = content.match(/^review_level:\s*(.+)$/m);
  if (match) {
    const level = match[1].trim().toLowerCase();
    if (['none', 'light', 'standard', 'strict'].includes(level)) {
      return level as ReviewLevel;
    }
  }
  return 'standard'; // default
}

function extractMessageType(content: string): string {
  const match = content.match(/^type:\s*(.+)$/m);
  return match ? match[1].trim().toLowerCase() : 'done';
}

function shouldSkipReview(content: string): { skip: boolean; reason?: string } {
  const msgType = extractMessageType(content);
  const reviewLevel = extractReviewLevel(content);

  // Skip review for info/ack type messages
  if (NO_REVIEW_TYPES.includes(msgType)) {
    return { skip: true, reason: `Message type '${msgType}' does not require review` };
  }

  // Skip if explicitly set to none
  if (reviewLevel === 'none') {
    return { skip: true, reason: 'review_level: none' };
  }

  return { skip: false };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractTerminal(donePath: string): string {
  const newMatch = donePath.match(/terminals\/([^/]+)\//);
  if (newMatch) return newMatch[1];
  const legacyMatch = donePath.match(/mailbox\/([^/]+)\//);
  return legacyMatch ? legacyMatch[1] : 'unknown';
}

function extractRef(content: string): string {
  const match = content.match(/^ref:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

async function findInboxFile(terminal: string, msgRef: string): Promise<{ path: string; content: string } | null> {
  if (!msgRef || msgRef === '—') return null;

  const inboxPaths = [
    path.join(SPACEOS_ROOT, 'terminals', terminal, 'inbox'),
    path.join(SPACEOS_ROOT, 'docs/mailbox', terminal, 'inbox'),
  ];

  for (const inboxDir of inboxPaths) {
    try {
      const files = await fs.readdir(inboxDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(inboxDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        if (content.includes(`id: ${msgRef}`)) {
          return { path: filePath, content };
        }
      }
    } catch {
      // Inbox doesn't exist
    }
  }
  return null;
}

// ── Check if terminal is busy ───────────────────────────────────────────────

async function isTerminalBusy(terminal: string): Promise<boolean> {
  const sessionName = `spaceos-${terminal}`;

  try {
    // Check if session exists
    await execAsync(`tmux -S ${TMUX_SOCKET} has-session -t ${sessionName}`);

    // Session exists - check if it's actively processing
    const pane = execSync(`tmux -S ${TMUX_SOCKET} capture-pane -t ${sessionName} -p`, {
      timeout: 3000,
      encoding: 'utf-8'
    });

    // If pane shows active processing indicators, it's busy
    const busyIndicators = [
      'Thinking...',
      'Running tool',
      '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', // Spinner chars
    ];

    return busyIndicators.some(indicator => pane.includes(indicator));
  } catch {
    // Session doesn't exist = not busy
    return false;
  }
}

// ── Wait for terminal to be available ───────────────────────────────────────

async function waitForTerminal(terminal: string, maxWaitMs: number = 60000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (!await isTerminalBusy(terminal)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5s
  }

  return false;
}

// ── Run single terminal review ──────────────────────────────────────────────
//
// IMPORTANT: Reviews run in SEPARATE sessions (spaceos-review-architect, spaceos-review-librarian)
// NOT in the main terminal sessions. This prevents:
// 1. Architect/Librarian reviewing their own work in their own session
// 2. Review context polluting the main work session
// 3. Session conflicts when reviewer is also working on tasks
//
// Review sessions are ephemeral - created fresh for each review, killed after completion.

async function runTerminalReview(
  reviewerTerminal: 'architect' | 'librarian',
  donePath: string,
  doneContent: string,
  inboxPath: string | null,
  inboxContent: string | null
): Promise<TerminalReviewResult> {
  // Use SEPARATE review session - not the main terminal session!
  const sessionName = `spaceos-review-${reviewerTerminal}`;
  const reviewStarted = new Date().toISOString();

  // Build review prompt based on reviewer role
  const prompt = reviewerTerminal === 'architect'
    ? buildArchitectPrompt(donePath, doneContent, inboxPath, inboxContent)
    : buildLibrarianPrompt(donePath, doneContent, inboxPath, inboxContent);

  try {
    // Kill any existing review session (ensure clean state)
    try {
      await execAsync(`tmux -S ${TMUX_SOCKET} kill-session -t ${sessionName}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch {
      // Session doesn't exist, that's fine
    }

    // Create fresh review session with Haiku model
    const workdir = path.join(SPACEOS_ROOT, 'terminals', reviewerTerminal);
    await execAsync(`tmux -S ${TMUX_SOCKET} new-session -d -s ${sessionName} -c "${workdir}"`);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Start Claude with Haiku (fast, cheap, sufficient for review)
    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} "claude --model ${MODEL}" Enter`);
    await new Promise(resolve => setTimeout(resolve, 4000)); // Wait for Claude to start

    // Send review prompt
    const safePrompt = prompt.replace(/'/g, "'\\''").replace(/\n/g, ' ');
    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} -l '${safePrompt}'`);
    // Use -H 0d (hex carriage return) instead of Enter keyword to avoid bracketed paste mode issue
    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} -H 0d`);

    // Wait for response with timeout
    const result = await waitForReviewResponse(sessionName, REVIEW_TIMEOUT_MS);

    // Cleanup: kill review session after completion
    try {
      await execAsync(`tmux -S ${TMUX_SOCKET} kill-session -t ${sessionName}`);
    } catch {
      // Session already gone, that's fine
    }

    return {
      terminal: reviewerTerminal,
      verdict: result.verdict,
      feedback: result.feedback,
      reviewedAt: reviewStarted,
      sessionOutput: result.rawOutput,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log(`[TerminalReviewer] ${reviewerTerminal} review error: ${errorMsg}`);

    // Cleanup on error too
    try {
      await execAsync(`tmux -S ${TMUX_SOCKET} kill-session -t ${sessionName}`);
    } catch {
      // Ignore cleanup errors
    }

    return {
      terminal: reviewerTerminal,
      verdict: 'ERROR',
      feedback: `Review error: ${errorMsg}`,
      reviewedAt: reviewStarted,
    };
  }
}

// ── Build Architect review prompt ───────────────────────────────────────────

function buildArchitectPrompt(
  donePath: string,
  doneContent: string,
  inboxPath: string | null,
  inboxContent: string | null
): string {
  return `[REVIEW REQUEST - Architect]

Te az Architect terminál vagy. Egy DONE üzenetet kell review-znod.
Kérdés: A MEGVALÓSÍTÁS MEGFELEL-E A TERVNEK?

## Eredeti feladat (inbox)
${inboxPath ? `Fájl: ${inboxPath}` : '(nem található)'}
${inboxContent ? `\n${inboxContent.substring(0, 2000)}` : ''}

## DONE üzenet
Fájl: ${donePath}
${doneContent.substring(0, 3000)}

## Ellenőrizd:
1. A spec-ben kért funkcionalitás megvalósult?
2. API contract változás dokumentált?
3. Breaking change van? Ha igen, indokolt?
4. Architekturális minták betartva?

## Válasz formátum (KÖTELEZŐ):
VERDICT: APPROVE vagy REJECT
FEEDBACK: [1-3 mondat indoklás]

Csak ezt a formátumot használd, semmi mást!`;
}

// ── Build Librarian review prompt ───────────────────────────────────────────

function buildLibrarianPrompt(
  donePath: string,
  doneContent: string,
  inboxPath: string | null,
  inboxContent: string | null
): string {
  return `[REVIEW REQUEST - Librarian]

Te a Librarian terminál vagy. Egy DONE üzenetet kell review-znod.
Kérdés: KONZISZTENS-E A KORÁBBI MEGOLDÁSOKKAL?

## Eredeti feladat (inbox)
${inboxPath ? `Fájl: ${inboxPath}` : '(nem található)'}
${inboxContent ? `\n${inboxContent.substring(0, 2000)}` : ''}

## DONE üzenet
Fájl: ${donePath}
${doneContent.substring(0, 3000)}

## Ellenőrizd:
1. Hasonló feladat volt korábban? Ha igen, konzisztens a megoldás?
2. A knowledge base-ben dokumentált pattern-eket követi?
3. Volt hasonló hiba korábban amit most is elkövethetett?
4. Dokumentáció/comment elegendő?

## Válasz formátum (KÖTELEZŐ):
VERDICT: APPROVE vagy REJECT
FEEDBACK: [1-3 mondat indoklás]

Csak ezt a formátumot használd, semmi mást!`;
}

// ── Wait for review response ────────────────────────────────────────────────

async function waitForReviewResponse(
  sessionName: string,
  timeoutMs: number
): Promise<{ verdict: 'APPROVE' | 'REJECT' | 'ERROR'; feedback: string; rawOutput: string }> {
  const startTime = Date.now();
  let lastOutput = '';

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      // -S -500: capture last 500 lines (default 100 was too small for longer feedback)
      const pane = execSync(`tmux -S ${TMUX_SOCKET} capture-pane -t ${sessionName} -p -S -500`, {
        timeout: 5000,
        encoding: 'utf-8'
      });

      // Check if response is complete (no spinner, has VERDICT)
      const hasVerdict = /VERDICT:\s*(APPROVE|REJECT)/i.test(pane);
      const isProcessing = ['Thinking...', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'].some(s => pane.includes(s));

      if (hasVerdict && !isProcessing) {
        return parseReviewOutput(pane);
      }

      lastOutput = pane;
    } catch {
      // Capture failed, continue waiting
    }
  }

  // Timeout - try to parse whatever we have
  if (lastOutput) {
    const parsed = parseReviewOutput(lastOutput);
    if (parsed.verdict !== 'ERROR') {
      return parsed;
    }
  }

  return {
    verdict: 'ERROR',
    feedback: 'Review timeout - no response received',
    rawOutput: lastOutput,
  };
}

// ── Parse review output ─────────────────────────────────────────────────────

function parseReviewOutput(output: string): { verdict: 'APPROVE' | 'REJECT' | 'ERROR'; feedback: string; rawOutput: string } {
  const verdictMatch = output.match(/VERDICT:\s*(APPROVE|REJECT)/i);

  // Fix: Capture multi-line feedback using greedy match until end of content or next section
  // The [\s\S]* pattern captures everything including newlines
  const feedbackMatch = output.match(/FEEDBACK:\s*([\s\S]*?)(?:(?:\n\n---|\n\n##|\n\n\*\*|$))/i);

  if (!verdictMatch) {
    return {
      verdict: 'ERROR',
      feedback: 'Could not parse verdict from response',
      rawOutput: output,
    };
  }

  // Clean up feedback: remove trailing whitespace, limit to reasonable length
  let feedback = feedbackMatch ? feedbackMatch[1].trim() : '(no feedback)';

  // FIX 2026-06-30: Increased truncation limit from 500 to 2000 chars
  // Previous 500-char limit caused mid-sentence truncation in Architect feedback
  // 2000 chars = ~350 words = normal paragraph-length review feedback
  if (feedback.length > 2000) {
    feedback = feedback.substring(0, 1997) + '...';
  }

  return {
    verdict: verdictMatch[1].toUpperCase() as 'APPROVE' | 'REJECT',
    feedback,
    rawOutput: output,
  };
}

// ── Light review (Librarian only) ───────────────────────────────────────────

async function runLightReview(donePath: string): Promise<DualTerminalReviewResult> {
  const reviewId = generateReviewId();
  const doneContent = await fs.readFile(donePath, 'utf-8');
  const terminal = extractTerminal(donePath);
  const doneBase = path.basename(donePath, '.md');
  const msgRef = extractRef(doneContent);

  const inbox = await findInboxFile(terminal, msgRef);
  const inboxPath = inbox?.path || null;
  const inboxContent = inbox?.content || null;

  await log(`[TerminalReviewer] Starting LIGHT review: ${doneBase} (Librarian only, model: ${MODEL})`);

  // Only Librarian reviews
  const librarianReview = await runTerminalReview('librarian', donePath, doneContent, inboxPath, inboxContent);

  // Auto-approve architect for light review
  const architectReview: TerminalReviewResult = {
    terminal: 'architect',
    verdict: 'APPROVE',
    feedback: '(skipped - light review)',
    reviewedAt: new Date().toISOString(),
  };

  const approved = librarianReview.verdict === 'APPROVE';

  await log(`[TerminalReviewer] Light review result: Librarian=${librarianReview.verdict} → ${approved ? 'APPROVED' : 'REJECTED'}`);

  // Save to review log
  const inboxHash = inbox ? await sha256File(inbox.path) : 'sha256:unknown';
  const doneHash = await sha256File(donePath);

  await appendReviewDecision({
    timestamp: new Date().toISOString(),
    review_id: reviewId,
    inbox_file: inboxPath || '(unknown)',
    inbox_hash: inboxHash,
    done_file: donePath,
    done_hash: doneHash,
    task_type: 'TERMINAL_REVIEW_LIGHT',
    review_attempt: 1,
    reviewer_a: {
      model: 'skipped',
      verdict: 'APPROVE',
      feedback_hash: 'sha256:skipped',
    },
    reviewer_b: {
      model: `${MODEL}-librarian`,
      verdict: librarianReview.verdict,
      feedback_hash: sha256String(librarianReview.feedback),
    },
    final_verdict: approved ? 'APPROVED' : 'REJECTED',
  });

  await saveReviewToMemory(terminal, doneBase, architectReview, librarianReview, approved);

  await telegram(`${approved ? '✅' : '⚠️'} *${terminal.toUpperCase()} Light Review*
Librarian: ${librarianReview.verdict}
File: \`${doneBase}\``);

  return {
    approved,
    architectReview,
    librarianReview,
    terminal,
    doneFile: donePath,
    doneBase,
    reviewId,
  };
}

// ── Main dual terminal review ───────────────────────────────────────────────

export async function runDualTerminalReview(donePath: string, level: ReviewLevel = 'standard'): Promise<DualTerminalReviewResult> {
  const reviewId = generateReviewId();
  const doneContent = await fs.readFile(donePath, 'utf-8');
  const terminal = extractTerminal(donePath);
  const doneBase = path.basename(donePath, '.md');
  const msgRef = extractRef(doneContent);

  // Find original inbox
  const inbox = await findInboxFile(terminal, msgRef);
  const inboxPath = inbox?.path || null;
  const inboxContent = inbox?.content || null;

  await log(`[TerminalReviewer] Starting ${level.toUpperCase()} review: ${doneBase} (Architect + Librarian, model: ${MODEL})`);

  // Run both reviews in parallel
  const [architectReview, librarianReview] = await Promise.all([
    runTerminalReview('architect', donePath, doneContent, inboxPath, inboxContent),
    runTerminalReview('librarian', donePath, doneContent, inboxPath, inboxContent),
  ]);

  // Determine final verdict based on review level
  let approved: boolean;
  if (level === 'strict') {
    // Strict: both must APPROVE AND provide substantial feedback
    const hasSubstantialFeedback =
      architectReview.feedback.length > 20 &&
      librarianReview.feedback.length > 20 &&
      architectReview.feedback !== '(no feedback)' &&
      librarianReview.feedback !== '(no feedback)';

    approved = architectReview.verdict === 'APPROVE' &&
               librarianReview.verdict === 'APPROVE' &&
               hasSubstantialFeedback;

    if (!hasSubstantialFeedback && architectReview.verdict === 'APPROVE' && librarianReview.verdict === 'APPROVE') {
      await log(`[TerminalReviewer] STRICT review: Both approved but feedback insufficient, requiring re-review`);
    }
  } else {
    // Standard: both must APPROVE, BUT timeout fallback allowed
    // If one reviewer times out (ERROR) and the other APPROVES, accept it
    const architectOk = architectReview.verdict === 'APPROVE';
    const librarianOk = librarianReview.verdict === 'APPROVE';
    const architectTimeout = architectReview.verdict === 'ERROR' && architectReview.feedback.includes('timeout');
    const librarianTimeout = librarianReview.verdict === 'ERROR' && librarianReview.feedback.includes('timeout');

    if (architectOk && librarianOk) {
      approved = true;
    } else if (architectTimeout && librarianOk) {
      // Architect timed out but Librarian approved - accept with warning
      await log(`[TerminalReviewer] WARNING: Architect timeout, accepting Librarian-only APPROVE`);
      approved = true;
    } else if (librarianTimeout && architectOk) {
      // Librarian timed out but Architect approved - accept with warning
      await log(`[TerminalReviewer] WARNING: Librarian timeout, accepting Architect-only APPROVE`);
      approved = true;
    } else {
      approved = false;
    }
  }

  await log(`[TerminalReviewer] Results: Architect=${architectReview.verdict}, Librarian=${librarianReview.verdict} → ${approved ? 'APPROVED' : 'REJECTED'}`);

  // Save to review log
  const inboxHash = inbox ? await sha256File(inbox.path) : 'sha256:unknown';
  const doneHash = await sha256File(donePath);

  await appendReviewDecision({
    timestamp: new Date().toISOString(),
    review_id: reviewId,
    inbox_file: inboxPath || '(unknown)',
    inbox_hash: inboxHash,
    done_file: donePath,
    done_hash: doneHash,
    task_type: 'TERMINAL_REVIEW',
    review_attempt: 1,
    reviewer_a: {
      model: `${MODEL}-architect`,
      verdict: architectReview.verdict,
      feedback_hash: sha256String(architectReview.feedback),
    },
    reviewer_b: {
      model: `${MODEL}-librarian`,
      verdict: librarianReview.verdict,
      feedback_hash: sha256String(librarianReview.feedback),
    },
    final_verdict: approved ? 'APPROVED' : 'REJECTED',
  });

  // Save review details to MEMORY
  await saveReviewToMemory(terminal, doneBase, architectReview, librarianReview, approved);

  // Telegram notification
  const emoji = approved ? '✅' : '⚠️';
  await telegram(`${emoji} *${terminal.toUpperCase()} Terminal Review*
Architect: ${architectReview.verdict}
Librarian: ${librarianReview.verdict}
File: \`${doneBase}\``);

  return {
    approved,
    architectReview,
    librarianReview,
    terminal,
    doneFile: donePath,
    doneBase,
    reviewId,
  };
}

// ── Save review to MEMORY ───────────────────────────────────────────────────

async function saveReviewToMemory(
  terminal: string,
  doneBase: string,
  architectReview: TerminalReviewResult,
  librarianReview: TerminalReviewResult,
  approved: boolean
): Promise<void> {
  const date = new Date().toISOString().split('T')[0];

  // Save to Architect MEMORY
  const architectMemoryPath = path.join(SPACEOS_ROOT, 'terminals/architect/MEMORY.md');
  const architectEntry = `
## ${date} Review: ${doneBase}
- **Terminal:** ${terminal}
- **Verdict:** ${architectReview.verdict}
- **Feedback:** ${architectReview.feedback}
`;

  try {
    await fs.appendFile(architectMemoryPath, architectEntry);
  } catch {
    // Memory file might not exist
  }

  // Save to Librarian PROCESSED_LOG
  const librarianLogPath = path.join(SPACEOS_ROOT, 'terminals/librarian/PROCESSED_LOG.md');
  const librarianEntry = `
## ${date} Review: ${doneBase}
- **Terminal:** ${terminal}
- **Verdict:** ${librarianReview.verdict}
- **Feedback:** ${librarianReview.feedback}
- **Final:** ${approved ? 'APPROVED' : 'REJECTED'}
`;

  try {
    await fs.appendFile(librarianLogPath, librarianEntry);
  } catch {
    // Log file might not exist
  }
}

// ── Create reject inbox (reuse from reviewer.ts pattern) ───────────────────

export async function createTerminalRejectInbox(result: DualTerminalReviewResult): Promise<string> {
  const inboxDir = path.join(SPACEOS_ROOT, 'terminals', result.terminal, 'inbox');
  await fs.mkdir(inboxDir, { recursive: true });

  // Find next message number
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
  } catch { /* empty dir */ }

  const nextNum = String(lastNum + 1).padStart(3, '0');
  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}_${nextNum}_terminal-review-reject-${result.doneBase}.md`;
  const filePath = path.join(inboxDir, filename);

  const content = `---
id: MSG-${result.terminal.toUpperCase()}-${nextNum}-REVIEW-REJECT
from: terminal-reviewer
to: ${result.terminal}
type: task
priority: high
status: UNREAD
model: sonnet
ref: ${result.doneBase}
review_id: ${result.reviewId}
created: ${date}
---

# Terminal Review visszadobás: ${result.doneBase}

Az Architect és Librarian terminal review **nem fogadta el** a DONE-t.

## Architect verdict: ${result.architectReview.verdict}

${result.architectReview.feedback}

## Librarian verdict: ${result.librarianReview.verdict}

${result.librarianReview.feedback}

## Teendő

1. Olvasd el az eredeti feladatot
2. Javítsd a fenti pontokat
3. Küldd újra a DONE outbox üzenetet
`;

  await fs.writeFile(filePath, content);
  return filePath;
}

// ── Export for watchDone integration ────────────────────────────────────────

export interface TerminalReviewHandlerResult {
  approved: boolean;
  resultPath?: string;
  skipped?: boolean;
  skipReason?: string;
  reviewLevel?: ReviewLevel;
}

export async function handleTerminalReview(donePath: string): Promise<TerminalReviewHandlerResult> {
  try {
    // Read content to determine review strategy
    const doneContent = await fs.readFile(donePath, 'utf-8');
    const doneBase = path.basename(donePath, '.md');
    const terminal = extractTerminal(donePath);

    // Check if review should be skipped
    const skipCheck = shouldSkipReview(doneContent);
    if (skipCheck.skip) {
      await log(`[TerminalReviewer] SKIP: ${doneBase} - ${skipCheck.reason}`);
      await telegram(`⏭️ *${terminal.toUpperCase()} Review Skipped*
Reason: ${skipCheck.reason}
File: \`${doneBase}\``);

      return {
        approved: true,  // Auto-approve skipped reviews
        skipped: true,
        skipReason: skipCheck.reason,
      };
    }

    // Determine review level
    const reviewLevel = extractReviewLevel(doneContent);
    await log(`[TerminalReviewer] Review level: ${reviewLevel} for ${doneBase}`);

    // Route to appropriate review function
    let result: DualTerminalReviewResult;

    switch (reviewLevel) {
      case 'light':
        result = await runLightReview(donePath);
        break;

      case 'strict':
        result = await runDualTerminalReview(donePath, 'strict');
        break;

      case 'standard':
      default:
        result = await runDualTerminalReview(donePath, 'standard');
        break;
    }

    if (result.approved) {
      return { approved: true, reviewLevel };
    } else {
      const rejectPath = await createTerminalRejectInbox(result);
      return { approved: false, resultPath: rejectPath, reviewLevel };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log(`[TerminalReviewer] Error: ${errorMsg}`);
    return { approved: false };
  }
}

// ── MCP-based Review API (ADR-053 + MSG-122) ────────────────────────────────
//
// New MCP tool: request_review
// Replaces tmux send-keys with proper session management
// Returns structured review result for MCP consumption

export interface ReviewResponse {
  verdict: 'APPROVE' | 'REJECT' | 'PENDING_MANUAL';
  feedback: string;
  reviewer: string;
  timestamp: string;
  duration_ms?: number;
}

/**
 * Request review from architect or librarian terminal via MCP.
 *
 * This function:
 * 1. Spawns a review session using startWorkSession (NOT tmux send-keys)
 * 2. Injects the review prompt
 * 3. Waits for structured response (VERDICT: + FEEDBACK:)
 * 4. Returns structured review result
 * 5. Falls back to manual approval on timeout/error
 *
 * @param reviewer - 'architect' or 'librarian'
 * @param inboxMessageId - Original inbox task message ID (e.g., MSG-BACKEND-042)
 * @param doneMessageId - DONE outbox message ID to review
 * @returns ReviewResponse with verdict + feedback
 */
export async function requestReview(
  reviewer: 'architect' | 'librarian',
  inboxMessageId: string,
  doneMessageId: string
): Promise<ReviewResponse> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    await log(`[ReviewAPI] Starting ${reviewer} review: ${inboxMessageId} → ${doneMessageId}`);

    // 1. Find DONE message file
    const terminalMatch = doneMessageId.match(/^MSG-([A-Z]+)-/);
    if (!terminalMatch) {
      throw new Error(`Invalid DONE message ID format: ${doneMessageId}`);
    }
    const terminal = terminalMatch[1].toLowerCase();

    const outboxPaths = [
      path.join(SPACEOS_ROOT, 'terminals', terminal, 'outbox'),
      path.join(SPACEOS_ROOT, 'docs/mailbox', terminal, 'outbox'),
    ];

    let doneFile: string | null = null;
    let doneContent: string | null = null;

    for (const outboxDir of outboxPaths) {
      try {
        const files = await fs.readdir(outboxDir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(outboxDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          if (content.includes(`id: ${doneMessageId}`)) {
            doneFile = filePath;
            doneContent = content;
            break;
          }
        }
        if (doneFile) break;
      } catch {
        // Outbox doesn't exist
      }
    }

    if (!doneFile || !doneContent) {
      throw new Error(`DONE message not found: ${doneMessageId}`);
    }

    // 2. Find inbox message file (optional, for context)
    const inboxResult = await findInboxFile(terminal, inboxMessageId);
    const inboxFile = inboxResult?.path || null;
    const inboxContent = inboxResult?.content || null;

    // 3. Build review prompt
    const prompt = reviewer === 'architect'
      ? buildArchitectPrompt(doneFile, doneContent, inboxFile, inboxContent)
      : buildLibrarianPrompt(doneFile, doneContent, inboxFile, inboxContent);

    // 4. Start review session using MCP-compatible session starter
    // Import startWorkSession dynamically to avoid circular dependency
    const { startWorkSession } = await import('../sessionStarter');

    const sessionResult = await startWorkSession(
      reviewer,
      prompt,
      'haiku' // Fast, cheap model for reviews
    );

    if (!sessionResult.success || !sessionResult.sessionName) {
      throw new Error(`Failed to start ${reviewer} review session: ${sessionResult.message}`);
    }

    await log(`[ReviewAPI] ${reviewer} session started: ${sessionResult.sessionName}`);

    // 5. Wait for structured response with timeout
    const reviewResult = await waitForReviewResponse(
      sessionResult.sessionName,
      REVIEW_TIMEOUT_MS
    );

    // 6. Log audit trail
    const duration_ms = Date.now() - startTime;
    await logReviewAudit({
      timestamp,
      inbox_message_id: inboxMessageId,
      done_message_id: doneMessageId,
      reviewer,
      verdict: reviewResult.verdict,
      feedback: reviewResult.feedback,
      duration_ms,
    });

    await log(`[ReviewAPI] ${reviewer} review complete: ${reviewResult.verdict} (${duration_ms}ms)`);

    return {
      verdict: reviewResult.verdict === 'ERROR' ? 'REJECT' : reviewResult.verdict,
      feedback: reviewResult.feedback,
      reviewer,
      timestamp,
      duration_ms,
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log(`[ReviewAPI] ${reviewer} review error: ${errorMsg}`);

    // Fallback: create manual review request
    await createManualReviewRequest(reviewer, inboxMessageId, doneMessageId, errorMsg);

    return {
      verdict: 'PENDING_MANUAL',
      feedback: `Review timeout or error - manual approval required. Error: ${errorMsg}`,
      reviewer: 'manual',
      timestamp,
      duration_ms: Date.now() - startTime,
    };
  }
}

// ── Helper: Log review audit trail ──────────────────────────────────────────

interface ReviewAuditEntry {
  timestamp: string;
  inbox_message_id: string;
  done_message_id: string;
  reviewer: string;
  verdict: string;
  feedback: string;
  duration_ms: number;
}

async function logReviewAudit(entry: ReviewAuditEntry): Promise<void> {
  const logDir = path.join(SPACEOS_ROOT, 'logs/reviews');
  const logFile = path.join(logDir, `${entry.timestamp.split('T')[0]}-review.log`);

  try {
    await fs.mkdir(logDir, { recursive: true });
    const logLine = JSON.stringify(entry) + '\n';
    await fs.appendFile(logFile, logLine, 'utf-8');
  } catch (error) {
    console.error(`[ReviewAPI] Failed to write audit log:`, error);
  }
}

// ── Helper: Create manual review request ────────────────────────────────────

async function createManualReviewRequest(
  reviewer: string,
  inboxMessageId: string,
  doneMessageId: string,
  errorReason: string
): Promise<void> {
  const conductorInboxDir = path.join(SPACEOS_ROOT, 'terminals/conductor/inbox');

  try {
    await fs.mkdir(conductorInboxDir, { recursive: true });

    // Find next message number
    const files = await fs.readdir(conductorInboxDir);
    const msgNumbers = files
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}_\d+_/))
      .map(f => parseInt(f.split('_')[1], 10))
      .filter(n => !isNaN(n));
    const nextNum = msgNumbers.length > 0 ? Math.max(...msgNumbers) + 1 : 1;

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}_${String(nextNum).padStart(3, '0')}_manual-review-${reviewer}-${doneMessageId.toLowerCase()}.md`;
    const filePath = path.join(conductorInboxDir, filename);

    const content = `---
id: MSG-CONDUCTOR-${String(nextNum).padStart(3, '0')}
from: system
to: conductor
type: question
priority: high
status: UNREAD
created: ${date}
ref: ${doneMessageId}
---

# Manual Review Required: ${reviewer}

## Reason
Review session timeout or error for **${reviewer}** terminal.

**Error:** ${errorReason}

## Task
- **Inbox:** ${inboxMessageId}
- **DONE:** ${doneMessageId}

## Request
Please manually review the DONE message and approve/reject.

**Fallback triggered:** Automatic review system unavailable.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
`;

    await fs.writeFile(filePath, content, 'utf-8');
    await log(`[ReviewAPI] Manual review request created: ${filename}`);
  } catch (error) {
    console.error(`[ReviewAPI] Failed to create manual review request:`, error);
  }
}
