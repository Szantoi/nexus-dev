// pipeline.ts - TypeScript equivalent of pipeline.sh
// Post-review actions for APPROVED DONE messages

import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SPACEOS_ROOT, log, telegram } from './common';
import { runPipelineDocs } from './pipelineDocs';

const execAsync = promisify(exec);

// ── Types ───────────────────────────────────────────────────────────────────

interface PipelineResult {
  archived: boolean;
  notified: boolean;
  reindexed: boolean;
  nextTask?: string;
}

// ── Helper: Extract terminal from path ──────────────────────────────────────

function extractTerminal(donePath: string): string {
  // Support both new (terminals/) and legacy (docs/mailbox/) paths
  const newMatch = donePath.match(/terminals\/([^/]+)\//);
  if (newMatch) return newMatch[1];

  const legacyMatch = donePath.match(/mailbox\/([^/]+)\//);
  return legacyMatch ? legacyMatch[1] : 'unknown';
}

// ── Step 1: Archive - Mark outbox as READ ───────────────────────────────────

async function archiveDone(donePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(donePath, 'utf-8');
    const updatedContent = content.replace(/status:\s*UNREAD/i, 'status: READ');
    await fs.writeFile(donePath, updatedContent);
    return true;
  } catch (error) {
    await log(`[Pipeline] Archive error: ${error}`);
    return false;
  }
}

// ── Step 2: Cleanup stale reject inbox messages ─────────────────────────────

async function cleanupStaleRejects(terminal: string, doneBase: string): Promise<number> {
  const inboxDir = path.join(SPACEOS_ROOT, 'docs/mailbox', terminal, 'inbox');
  let cleaned = 0;

  try {
    const files = await fs.readdir(inboxDir);
    for (const file of files) {
      // Find review-reject files that reference this DONE
      if (file.includes('review-reject') && file.includes(doneBase.replace(/^[0-9-_]+/, ''))) {
        const filePath = path.join(inboxDir, file);
        // Mark as READ instead of deleting
        const content = await fs.readFile(filePath, 'utf-8');
        if (content.includes('status: UNREAD')) {
          const updated = content.replace(/status:\s*UNREAD/i, 'status: READ');
          await fs.writeFile(filePath, updated);
          cleaned++;
        }
      }
    }
  } catch {
    // Inbox doesn't exist or empty
  }

  return cleaned;
}

// ── Step 3: Notify via Telegram ─────────────────────────────────────────────

async function notifyCompletion(
  terminal: string,
  doneBase: string,
  testCount?: number
): Promise<boolean> {
  try {
    let message = `✅ *${terminal.toUpperCase()} DONE elfogadva*\n\`${doneBase}\``;
    if (testCount !== undefined && testCount > 0) {
      message += `\n📊 Tesztek: ${testCount}`;
    }
    await telegram(message);
    return true;
  } catch {
    return false;
  }
}

// ── Step 4: Trigger knowledge reindex if librarian ──────────────────────────

async function triggerReindexIfNeeded(terminal: string): Promise<boolean> {
  if (terminal !== 'librarian') {
    return false;
  }

  try {
    await log('[Pipeline] Knowledge reindex trigger (librarian DONE)');
    await execAsync('curl -s -X POST http://localhost:3456/api/knowledge/index -H "Content-Type: application/json" -d "{}"');
    return true;
  } catch {
    return false;
  }
}

// ── Step 5: Run docs update (TypeScript version) ────────────────────────────

async function runDocsUpdate(donePath: string, terminal: string): Promise<string | undefined> {
  try {
    const result = await runPipelineDocs(donePath, terminal);
    return result.nextFile || undefined;
  } catch (error) {
    await log(`[Pipeline] Docs update error: ${error}`);
  }
  return undefined;
}

// ── Main pipeline handler ───────────────────────────────────────────────────

export async function runPipeline(donePath: string): Promise<PipelineResult> {
  const terminal = extractTerminal(donePath);
  const doneBase = path.basename(donePath, '.md');

  await log(`[Pipeline] Starting: ${doneBase} (terminal: ${terminal})`);

  // Step 1: Archive
  const archived = await archiveDone(donePath);

  // Step 2: Cleanup stale rejects
  const cleaned = await cleanupStaleRejects(terminal, doneBase);
  if (cleaned > 0) {
    await log(`[Pipeline] Cleaned ${cleaned} stale reject messages`);
  }

  // Step 3: Run docs update (bash, optional)
  let nextTask: string | undefined;
  try {
    nextTask = await runDocsUpdate(donePath, terminal);
  } catch {
    // Docs update is optional, continue
  }

  // Step 4: Notify
  const notified = await notifyCompletion(terminal, doneBase);

  // Step 5: Reindex if librarian
  const reindexed = await triggerReindexIfNeeded(terminal);

  await log(`[Pipeline] Complete: ${doneBase} (archived=${archived}, notified=${notified}, reindexed=${reindexed})`);

  return {
    archived,
    notified,
    reindexed,
    nextTask
  };
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  const donePath = process.argv[2];
  if (!donePath) {
    console.error('Usage: npx ts-node pipeline.ts <done_file_path>');
    process.exit(1);
  }

  runPipeline(donePath).then(result => {
    console.log('Pipeline result:', result);
    process.exit(0);
  });
}
