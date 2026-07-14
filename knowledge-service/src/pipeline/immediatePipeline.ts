/**
 * Immediate Pipeline - Hybrid API trigger for DONE messages
 *
 * Pattern: Agent submits via API → Server writes file (artifact) →
 *          Server immediately triggers review/pipeline → Target terminal notified
 *          File watcher remains as backup defense
 *
 * This module provides the immediate trigger functionality:
 * 1. Runs dual review on the DONE file
 * 2. If approved, runs pipeline (archive, notify)
 * 3. Routes to next terminal based on task context
 * 4. Creates inbox for target terminal
 * 5. Injects notification to running session
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { handleDoneReview, runDualReview } from './reviewer';
import { runPipeline } from './pipeline';
import { log, telegram, SPACEOS_ROOT, TMUX_SOCKET } from './common';

const execAsync = promisify(exec);

// ─── Types ─────────────────────────────────────────────────────────────────

interface ImmediateResult {
  triggered: boolean;
  reviewed: boolean;
  approved: boolean;
  pipelineRan: boolean;
  nextTerminal?: string;
  nextInboxPath?: string;
  injected: boolean;
  error?: string;
}

interface TaskContext {
  from: string;
  taskId: string;
  summary: string;
  ref?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────
const TERMINALS_ROOT = path.join(SPACEOS_ROOT, 'terminals');

// ─── Router: Determine next terminal based on task context ─────────────────

/**
 * Simple router logic - can be extended based on task patterns
 * For now: DONE from any terminal → notify root/conductor
 */
async function routeNextTerminal(ctx: TaskContext): Promise<string | null> {
  // Default routing: DONE goes to root for coordination
  // Could be extended with:
  // - Task graph dependencies
  // - Epic-based routing (kernel → orchestrator → portal)
  // - Explicit next_terminal in task definition

  // Priority terminals don't need routing (they coordinate themselves)
  const priorityTerminals = ['root', 'conductor'];
  if (priorityTerminals.includes(ctx.from)) {
    return null; // No automatic next terminal
  }

  // For development terminals, notify conductor
  return 'conductor';
}

// ─── Create inbox message for target terminal ──────────────────────────────

async function createNextInbox(
  targetTerminal: string,
  ctx: TaskContext,
  reviewSummary: string
): Promise<string> {
  const inboxDir = path.join(TERMINALS_ROOT, targetTerminal, 'inbox');
  await fs.mkdir(inboxDir, { recursive: true });

  // Get next message number
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
  const slug = `done-notification-${ctx.from}`;
  const filename = `${date}_${nextNum}_${slug}.md`;
  const filePath = path.join(inboxDir, filename);

  const content = `---
id: MSG-${targetTerminal.toUpperCase()}-${nextNum}-AUTO
from: pipeline
to: ${targetTerminal}
type: notification
priority: medium
status: UNREAD
ref: ${ctx.taskId}
created: ${date}
---

# DONE feldolgozva: ${ctx.taskId}

**Terminál:** ${ctx.from}
**Feladat:** ${ctx.taskId}
**Összefoglaló:** ${ctx.summary}

## Review eredmény

${reviewSummary}

---
*Automatikusan generálva az Immediate Pipeline által*
`;

  await fs.writeFile(filePath, content);
  return filePath;
}

// ─── Inject notification to running tmux session ───────────────────────────

async function injectToSession(terminal: string, message: string): Promise<boolean> {
  const sessionName = `spaceos-${terminal}`;

  try {
    // Check if session is running
    await execAsync(`tmux -S ${TMUX_SOCKET} has-session -t ${sessionName} 2>/dev/null`);

    // Session exists - inject notification
    const safeMsg = message.replace(/'/g, "'\\''").replace(/\n/g, ' ');
    await execAsync(
      `tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} -l '[PIPELINE] ${safeMsg}'`
    );
    // Use -H 0d (hex carriage return) instead of Enter keyword to avoid bracketed paste mode issue
    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} -H 0d`);

    return true;
  } catch {
    // Session not running - that's OK, inbox will be picked up later
    return false;
  }
}

// ─── Main: Trigger immediate pipeline ──────────────────────────────────────

/**
 * Trigger immediate pipeline for a DONE file
 * Called after submitDone() writes the artifact file
 * Runs asynchronously - doesn't block the API response
 */
export async function triggerImmediatePipeline(
  donePath: string,
  ctx: TaskContext
): Promise<ImmediateResult> {
  const result: ImmediateResult = {
    triggered: true,
    reviewed: false,
    approved: false,
    pipelineRan: false,
    injected: false,
  };

  try {
    await log(`[ImmediatePipeline] Triggered for ${path.basename(donePath)}`);

    // Step 1: Run dual review
    const reviewResult = await handleDoneReview(donePath);
    result.reviewed = true;
    result.approved = reviewResult.approved;

    if (!reviewResult.approved) {
      await log(`[ImmediatePipeline] REJECTED: ${ctx.taskId}`);
      // Reject inbox already created by reviewer
      return result;
    }

    await log(`[ImmediatePipeline] APPROVED: ${ctx.taskId}`);

    // Step 2: Run pipeline (archive, notify, etc.)
    const pipelineResult = await runPipeline(donePath);
    result.pipelineRan = true;

    // Step 3: Route to next terminal
    const nextTerminal = await routeNextTerminal(ctx);
    if (nextTerminal) {
      result.nextTerminal = nextTerminal;

      // Step 4: Create inbox for next terminal
      const reviewSummary = `APPROVED - Task elfogadva a dual review által.`;
      result.nextInboxPath = await createNextInbox(nextTerminal, ctx, reviewSummary);

      await log(`[ImmediatePipeline] Next inbox created: ${result.nextInboxPath}`);

      // Step 5: Inject notification to running session
      result.injected = await injectToSession(
        nextTerminal,
        `${ctx.from} DONE: ${ctx.taskId} - Új inbox: ${path.basename(result.nextInboxPath)}`
      );

      if (result.injected) {
        await log(`[ImmediatePipeline] Injected to ${nextTerminal}`);
      }
    }

    // SSE event is already emitted by the API endpoint
    // This provides the immediate trigger layer

    return result;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.error = errorMsg;
    await log(`[ImmediatePipeline] Error: ${errorMsg}`);
    return result;
  }
}

/**
 * Fire-and-forget wrapper for API usage
 * Doesn't block the response, logs results
 */
export function triggerImmediatePipelineAsync(
  donePath: string,
  ctx: TaskContext
): void {
  // Run in background - don't await
  triggerImmediatePipeline(donePath, ctx)
    .then(result => {
      if (result.error) {
        console.error(`[ImmediatePipeline] Failed: ${result.error}`);
      } else {
        console.log(`[ImmediatePipeline] Complete: approved=${result.approved}, injected=${result.injected}`);
      }
    })
    .catch(err => {
      console.error(`[ImmediatePipeline] Unhandled error:`, err);
    });
}
