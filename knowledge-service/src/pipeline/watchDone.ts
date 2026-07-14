// Watch Done - TypeScript equivalent of watch-done.sh
// Scans for DONE outbox messages and triggers reviewer
// 2026-06-24: Optimized to use messageRegistry DB instead of filesystem scan
// 2026-06-24: Switched to terminal-based review (Architect + Librarian) instead of API calls
// 2026-07-04: Added Dense Milestone Feedback (Goal Persistence Pattern)
// 2026-07-04: Added Subagent Output Filtering (Goal Persistence Pattern)

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  getState,
  setState,
  log,
  TMUX_SOCKET,
} from './common';
import { handleDoneReview } from './reviewer';
import { handleTerminalReview } from './terminalReviewer';
import { runPipeline } from './pipeline';
import { loadActiveEpic, getEpicProgress } from '../conductor/epicManager';
import { filterDoneOutput } from '../conductor/outputFiltering';

// Use terminal-based review by default (no API key needed)
// Set REVIEW_MODE=api to use old Anthropic API based review
const USE_TERMINAL_REVIEW = process.env.REVIEW_MODE !== 'api';
import { queryMessages } from '../messageRegistry';

// ─── Dense Milestone Feedback (Goal Persistence Pattern 2026-07-04) ───────────
/**
 * Generate and inject dense feedback to Conductor after each successful task completion.
 * This prevents goal drift by providing immediate progress signals (not just phase-level).
 *
 * Research basis: MiRA Framework shows 6.4% → 43.0% performance improvement with dense rewards.
 *
 * Also applies Subagent Output Filtering to prevent inherited drift from detailed DONE content.
 */
async function generateDenseMilestoneFeedback(taskId: string, terminal: string, donePath: string): Promise<void> {
  try {
    const activeEpic = loadActiveEpic();
    if (!activeEpic) {
      await log('[watchDone] No active epic for dense feedback');
      return;
    }

    const progress = getEpicProgress(activeEpic);
    const doneCount = activeEpic.checkpoints?.filter(cp => cp.status === 'done').length || 0;
    const totalCount = activeEpic.checkpoints?.length || 0;

    // Find next pending checkpoint
    const nextCheckpoint = activeEpic.checkpoints?.find(cp => cp.status === 'pending');

    // ─── Subagent Output Filtering (Goal Persistence Phase 3) ───
    // Read DONE content and filter if too detailed
    let doneContentSummary = '';
    try {
      const doneContent = fs.readFileSync(donePath, 'utf-8');
      const { filtered, content } = filterDoneOutput(doneContent, taskId, terminal);
      if (filtered) {
        doneContentSummary = `\n${content}\n`;
        await log(`[watchDone] DONE content filtered (inherited drift prevention)`);
      }
    } catch {
      // Ignore read errors, proceed without summary
    }

    const feedbackMessage = `📊 [DENSE MILESTONE FEEDBACK] Task Complete!

## ✅ Task Completed
- **Task:** \`${taskId}\`
- **Terminal:** \`${terminal}\`

## 🎯 Epic Progress Update
| Metrika | Érték |
|---------|-------|
| **Epic** | \`${activeEpic.id}\` |
| **Progress** | **${progress}%** (${doneCount}/${totalCount} checkpoints) |
| **Status** | \`${activeEpic.status}\` |
${doneContentSummary}
${nextCheckpoint ? `## ⏭️ Next Milestone
\`${nextCheckpoint.id}\`: ${nextCheckpoint.name}

**Feltétel:** \`${nextCheckpoint.condition}\`

---
**IMMEDIATE ACTION:** Ellenőrizd a következő checkpoint feltételét és haladj tovább!` : `## ✅ ALL CHECKPOINTS DONE!
Az epic teljesült, zárd le és jelezz Root-nak.`}

---
*Dense Feedback + Output Filtering: Goal Persistence Pattern (2026-07-04)*`;

    // Inject to Conductor session if running (using tmux send-keys)
    try {
      // Check if Conductor session is running
      const sessionCheck = execSync(`tmux -S ${TMUX_SOCKET} has-session -t spaceos-conductor 2>/dev/null && echo "running"`, { encoding: 'utf-8' }).trim();

      if (sessionCheck === 'running') {
        // Escape special characters for tmux send-keys
        const escapedMessage = feedbackMessage
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\$/g, '\\$')
          .replace(/`/g, '\\`');

        execSync(`tmux -S ${TMUX_SOCKET} send-keys -t spaceos-conductor -H 0x0D 0x0D "${escapedMessage}"`, { encoding: 'utf-8' });
        await log(`[watchDone] ✓ Dense milestone feedback injected for ${taskId}`);
      } else {
        await log(`[watchDone] Dense feedback not injected (Conductor not running)`);
      }
    } catch {
      await log(`[watchDone] Dense feedback not injected (Conductor not running or tmux error)`);
    }
  } catch (error) {
    await log(`[watchDone] Dense feedback error: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}

/**
 * Find UNREAD DONE messages using DB query instead of filesystem scan.
 * This reduces ~50 fs.readFile operations per cycle to 1 DB query.
 *
 * FIX 2026-06-30: Exclude Conductor's own outbox messages to prevent meta-loop!
 * Conductor response messages should NOT be reviewed by Architect/Librarian.
 */
function findUnreadDones(): string[] {
  // Query DB for UNREAD messages of type 'done' in outbox
  const messages = queryMessages({
    box: 'outbox',
    type: 'done',
    status: 'UNREAD',
  });

  // Return file paths for compatibility with existing review pipeline
  // IMPORTANT: Exclude Conductor's own outbox to prevent meta-loop (review of review responses)
  return messages
    .filter(m => m.filePath) // Ensure filePath exists
    .filter(m => !m.filePath.includes('terminals/conductor/outbox')) // FIX: Exclude Conductor's own messages
    .map(m => m.filePath);
}

export async function watchDone(): Promise<{ found: number; triggered: string[] }> {
  const now = Math.floor(Date.now() / 1000);
  const triggered: string[] = [];

  const unreadDones = findUnreadDones(); // Now synchronous DB query

  if (unreadDones.length === 0) {
    return { found: 0, triggered: [] };
  }

  for (const donePath of unreadDones) {
    const basename = path.basename(donePath, '.md');
    const reviewKey = `review_${basename}`;
    const lastReview = await getState(reviewKey);

    // Review only triggers once per DONE file
    if (!lastReview || lastReview === '0') {
      await log(`[watchDone] Review triggerelve: ${basename}`);
      await setState(reviewKey, String(now));

      // Run reviewer - terminal-based (Architect + Librarian) or API-based
      try {
        const reviewResult = USE_TERMINAL_REVIEW
          ? await handleTerminalReview(donePath)
          : await handleDoneReview(donePath);

        await log(`[watchDone] Review mode: ${USE_TERMINAL_REVIEW ? 'terminal' : 'api'}`);

        if (reviewResult.approved) {
          await log(`[watchDone] APPROVED: ${basename} → running pipeline`);

          // Run post-review pipeline
          const pipelineResult = await runPipeline(donePath);
          await log(`[watchDone] Pipeline complete: archived=${pipelineResult.archived}, notified=${pipelineResult.notified}`);

          // ─── Dense Milestone Feedback (Goal Persistence 2026-07-04) ───
          // Extract terminal from path (terminals/<terminal>/outbox/...)
          const pathParts = donePath.split('/');
          const terminalIdx = pathParts.indexOf('terminals');
          const fromTerminal = terminalIdx >= 0 ? pathParts[terminalIdx + 1] : 'unknown';

          await generateDenseMilestoneFeedback(basename, fromTerminal, donePath);
        } else {
          await log(`[watchDone] REJECTED: ${basename} → reject inbox created at ${reviewResult.resultPath}`);
        }

        triggered.push(basename);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await log(`[watchDone] Reviewer hiba: ${errorMsg}`);
        // Clear state so it can retry on next run
        await setState(reviewKey, '0');
      }
    }
  }

  return { found: unreadDones.length, triggered };
}

// ─── UI Review Loop (2026-07-11) ───────────────────────────────────────────────
/**
 * Watch Frontend DONE outbox and trigger Designer review for UI-related tasks.
 * Replaces watch-ui-review.sh bash script with MCP-based, type-safe solution.
 *
 * Benefits:
 * - Type-safe enum usage (no grep/regex fragility)
 * - DB-based state tracking (not file-based)
 * - Audit trail via messageRegistry
 * - Unified with existing watchDone pipeline
 */
export async function watchFrontendUiDone(): Promise<{ found: number; triggered: string[] }> {
  const triggered: string[] = [];

  // Query DB for Frontend DONE messages (type-safe)
  const frontendDones = queryMessages({
    box: 'outbox',
    type: 'done',
    status: 'UNREAD',
  }).filter(m => m.filePath && m.filePath.includes('terminals/frontend/outbox'));

  if (frontendDones.length === 0) {
    return { found: 0, triggered: [] };
  }

  // UI-related keywords (same as bash script)
  const UI_KEYWORDS = [
    'joinerytech', 'component', 'page', 'ui', 'dashboard',
    'crm', 'ehs', 'hr', 'kontrolling', 'maintenance', 'qa', 'dms'
  ];

  for (const done of frontendDones) {
    const doneId = done.messageId; // Use messageId (string), not id (number)
    const reviewKey = `ui_review_${doneId}`;
    const lastReview = await getState(reviewKey);

    // Skip if already processed
    if (lastReview && lastReview !== '0') {
      continue;
    }

    // Read file content to check for UI keywords
    try {
      const content = fs.readFileSync(done.filePath, 'utf-8').toLowerCase();
      const isUiRelated = UI_KEYWORDS.some(keyword => content.includes(keyword));

      if (!isUiRelated) {
        continue; // Not UI-related, skip
      }

      await log(`[watchFrontendUiDone] UI DONE detected: ${doneId}`);

      // Create Designer review task using sendMessage (type-safe MCP)
      const { sendMessage } = await import('../mailbox');

      const reviewContent = `# UI Review Required

Frontend completed: **${doneId}**

## Review Checklist

1. **Capture Screenshots**
   \`\`\`bash
   npx playwright screenshot --wait-for-timeout=5000 "http://localhost:5173/dashboard/crm/leads" /tmp/review-crm.png
   npx playwright screenshot --wait-for-timeout=5000 "http://localhost:5173/dashboard/ehs" /tmp/review-ehs.png
   \`\`\`

2. **Compare with Prototypes**
   - Check \`docs/tasks/new/joinerytech/\` for design specs
   - Verify: Layout, colors, spacing, typography

3. **Known Issues to Verify**
   - Mock API integration (Loading states)
   - SSE connection ("Kapcsolat megszakadt")
   - Hungarian localization

4. **Action Required**
   - If issues: Create feedback task for Frontend
   - If OK: DONE outbox with APPROVED

Use skill: \`ui-review-loop\``;

      const result = await sendMessage({
        to: 'designer',
        type: 'task',
        priority: 'high',
        model: 'sonnet',
        ref: doneId,
        content: reviewContent,
      });

      // Mark as processed (DB state)
      await setState(reviewKey, String(Math.floor(Date.now() / 1000)));
      await log(`[watchFrontendUiDone] Created Designer review task: ${result.id}`);

      triggered.push(doneId);

      // Optional: Telegram notification (reuse existing pattern)
      try {
        const { sendTelegramMessage } = await import('./telegramBot');
        await sendTelegramMessage('designer', `UI Review task created for ${doneId}`);
      } catch {
        // Telegram optional, ignore errors
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await log(`[watchFrontendUiDone] Error processing ${doneId}: ${errorMsg}`);
    }
  }

  return { found: frontendDones.length, triggered };
}

// Run standalone
if (require.main === module) {
  watchDone().then(result => {
    console.log(`[watchDone] Found: ${result.found}, Triggered: ${result.triggered.length}`);
    result.triggered.forEach(t => console.log(`  - ${t}`));
  });
}
