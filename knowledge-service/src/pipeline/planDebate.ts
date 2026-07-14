// planDebate.ts - TypeScript equivalent of plan-debate.sh
// Dual Sonnet parallel planning + cross-review + consensus synthesis

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SPACEOS_ROOT,
  log,
  telegram
} from './common';
import {
  loadPlanConfig,
  loadDomainFocus,
  getFullPath,
  PlanConfig
} from './planConfig';

// ── Types ───────────────────────────────────────────────────────────────────

interface DebateResult {
  success: boolean;
  planA?: string;
  planB?: string;
  reviewA?: string;
  reviewB?: string;
  consensusFile?: string;
  queueFile?: string;
  conductorNotified: boolean;
  error?: string;
}

// ── Model mapping ───────────────────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  'haiku': 'claude-haiku-4-20250514',
  'sonnet': 'claude-sonnet-4-5-20250929',
  'opus': 'claude-opus-4-5-20251101',
};

function resolveModel(model: string): string {
  return MODEL_MAP[model] || model;
}

// ── Load prompt templates ───────────────────────────────────────────────────

async function loadPrompt(config: PlanConfig, key: 'planner' | 'reviewer' | 'consensus'): Promise<string> {
  const promptPath = getFullPath(config, config.prompts[key]);
  return fs.readFile(promptPath, 'utf-8');
}

// ── Load codebase status ────────────────────────────────────────────────────

async function loadCodebaseStatus(config: PlanConfig): Promise<string> {
  const statusPath = getFullPath(config, config.paths.codebase_status);
  try {
    const content = await fs.readFile(statusPath, 'utf-8');
    // Return first 30 lines
    return content.split('\n').slice(0, 30).join('\n');
  } catch {
    return '';
  }
}

// ── Call LLM with timeout ───────────────────────────────────────────────────

async function callLLM(
  client: Anthropic,
  model: string,
  prompt: string,
  timeoutMs: number,
  maxTokens: number = 2048
): Promise<string> {
  const response = await Promise.race([
    client.messages.create({
      model: resolveModel(model),
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    )
  ]);

  const textContent = response.content.find(c => c.type === 'text');
  return textContent ? textContent.text : '';
}

// ── Phase 1: Parallel Independent Plans ─────────────────────────────────────

async function runPhase1(
  client: Anthropic,
  config: PlanConfig,
  plannerPrompt: string,
  codebaseStatus: string,
  domainFocus: string,
  selectedContent: string,
  plansDir: string,
  date: string
): Promise<{ planA: string; planB: string; planAContent: string; planBContent: string }> {
  await log('[PlanDebate] Phase 1: Parallel independent plans starting...');

  // Planner-A prompt (incremental, safe approach)
  const promptA = plannerPrompt
    .replace(/\{\{CODEBASE_STATUS\}\}/g, codebaseStatus)
    .replace(/\{\{DOMAIN_FOCUS\}\}/g, domainFocus)
    .replace(/\{\{SELECTED_CONTENT\}\}/g, selectedContent)
    .replace(/\{\{PLANNER_ID\}\}/g, 'Planner-A')
    .replace(/\{\{PLANNER_STYLE\}\}/g, 'Fókuszálj az inkrementális, biztonságos megközelítésre.');

  // Planner-B prompt (bold, innovative approach)
  const promptB = plannerPrompt
    .replace(/\{\{CODEBASE_STATUS\}\}/g, codebaseStatus)
    .replace(/\{\{DOMAIN_FOCUS\}\}/g, domainFocus)
    .replace(/\{\{SELECTED_CONTENT\}\}/g, selectedContent)
    .replace(/\{\{PLANNER_ID\}\}/g, 'Planner-B')
    .replace(/\{\{PLANNER_STYLE\}\}/g, 'Fókuszálj a merészebb, innovatívabb megközelítésre.');

  const timeoutMs = config.timing.planner_timeout * 1000;

  // Run in parallel
  const [contentA, contentB] = await Promise.all([
    callLLM(client, config.models.planner_a, promptA, timeoutMs),
    callLLM(client, config.models.planner_b, promptB, timeoutMs)
  ]);

  // Save plans
  const planA = path.join(plansDir, `${date}_plan-a.md`);
  const planB = path.join(plansDir, `${date}_plan-b.md`);

  await fs.writeFile(planA, contentA);
  await fs.writeFile(planB, contentB);

  await log('[PlanDebate] Phase 1 complete: Plans created');

  return { planA, planB, planAContent: contentA, planBContent: contentB };
}

// ── Phase 2: Cross-Review ───────────────────────────────────────────────────

async function runPhase2(
  client: Anthropic,
  config: PlanConfig,
  reviewerPrompt: string,
  planAContent: string,
  planBContent: string,
  plansDir: string,
  date: string
): Promise<{ reviewA: string; reviewB: string; reviewAContent: string; reviewBContent: string }> {
  await log('[PlanDebate] Phase 2: Cross-review starting...');

  // A reviews B
  const promptAReviewsB = reviewerPrompt
    .replace(/\{\{REVIEWER_ID\}\}/g, 'Planner-A')
    .replace(/\{\{OTHER_ID\}\}/g, 'Planner-B')
    .replace(/\{\{OTHER_PLAN\}\}/g, planBContent)
    .replace(/\{\{OWN_PLAN\}\}/g, planAContent);

  // B reviews A
  const promptBReviewsA = reviewerPrompt
    .replace(/\{\{REVIEWER_ID\}\}/g, 'Planner-B')
    .replace(/\{\{OTHER_ID\}\}/g, 'Planner-A')
    .replace(/\{\{OTHER_PLAN\}\}/g, planAContent)
    .replace(/\{\{OWN_PLAN\}\}/g, planBContent);

  const timeoutMs = config.timing.reviewer_timeout * 1000;

  // Run in parallel
  const [contentA, contentB] = await Promise.all([
    callLLM(client, config.models.reviewer, promptAReviewsB, timeoutMs, 1024),
    callLLM(client, config.models.reviewer, promptBReviewsA, timeoutMs, 1024)
  ]);

  // Save reviews
  const reviewA = path.join(plansDir, `${date}_review-a-on-b.md`);
  const reviewB = path.join(plansDir, `${date}_review-b-on-a.md`);

  await fs.writeFile(reviewA, contentA);
  await fs.writeFile(reviewB, contentB);

  await log('[PlanDebate] Phase 2 complete: Reviews created');

  return { reviewA, reviewB, reviewAContent: contentA, reviewBContent: contentB };
}

// ── Phase 3: Consensus Synthesis ────────────────────────────────────────────

async function runPhase3(
  client: Anthropic,
  config: PlanConfig,
  consensusPrompt: string,
  planAContent: string,
  planBContent: string,
  reviewAContent: string,
  reviewBContent: string,
  planAPath: string,
  planBPath: string,
  consensusDir: string,
  date: string
): Promise<{ consensusFile: string; consensusContent: string }> {
  await log('[PlanDebate] Phase 3: Consensus synthesis starting...');

  const prompt = consensusPrompt
    .replace(/\{\{PLAN_A_CONTENT\}\}/g, planAContent)
    .replace(/\{\{PLAN_B_CONTENT\}\}/g, planBContent)
    .replace(/\{\{REVIEW_A_CONTENT\}\}/g, reviewAContent)
    .replace(/\{\{REVIEW_B_CONTENT\}\}/g, reviewBContent)
    .replace(/\{\{DATE\}\}/g, date)
    .replace(/\{\{PLAN_A_PATH\}\}/g, planAPath)
    .replace(/\{\{PLAN_B_PATH\}\}/g, planBPath);

  const timeoutMs = config.timing.consensus_timeout * 1000;
  const content = await callLLM(client, config.models.consensus, prompt, timeoutMs, 3000);

  const consensusFile = path.join(consensusDir, `${date}_consensus.md`);
  await fs.writeFile(consensusFile, content);

  await log(`[PlanDebate] Phase 3 complete: Consensus created (${consensusFile})`);

  return { consensusFile, consensusContent: content };
}

// ── Queue management ────────────────────────────────────────────────────────

async function addToQueue(
  config: PlanConfig,
  consensusFile: string,
  queueDir: string,
  date: string
): Promise<string> {
  const time = new Date().toTimeString().slice(0, 5).replace(':', '');
  const queueFile = path.join(queueDir, `${date}_${time}_consensus.md`);

  await fs.copyFile(consensusFile, queueFile);
  await log(`[PlanDebate] Consensus added to queue: ${path.basename(queueFile)}`);

  return queueFile;
}

async function countQueueItems(queueDir: string): Promise<number> {
  try {
    const files = await fs.readdir(queueDir);
    return files.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

// ── Conductor notification ──────────────────────────────────────────────────

async function notifyConductor(
  config: PlanConfig,
  queueCount: number,
  queueDir: string,
  date: string
): Promise<boolean> {
  const conductorInbox = path.join(SPACEOS_ROOT, 'docs/mailbox/conductor/inbox');
  await fs.mkdir(conductorInbox, { recursive: true });

  // Check for existing UNREAD messages
  try {
    const files = await fs.readdir(conductorInbox);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(conductorInbox, file), 'utf-8');
      if (content.includes('status: UNREAD')) {
        await log('[PlanDebate] Conductor already has UNREAD inbox, skip notification');
        return false;
      }
    }
  } catch {
    // Directory doesn't exist or empty
  }

  // Find next message number
  let lastNum = 0;
  try {
    const files = await fs.readdir(conductorInbox);
    for (const file of files) {
      const match = file.match(/_(\d{3})_/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > lastNum) lastNum = num;
      }
    }
  } catch { /* empty */ }

  const nextNum = String(lastNum + 1).padStart(3, '0');

  // Get queue file list
  let queueFiles = '';
  try {
    const files = await fs.readdir(queueDir);
    queueFiles = files.filter(f => f.endsWith('.md')).join('\n');
  } catch { /* empty */ }

  const filename = `${date}_${nextNum}_planning-queue-ready.md`;
  const filePath = path.join(conductorInbox, filename);

  const content = `---
id: MSG-COND-${nextNum}
from: planning-pipeline
to: conductor
type: task
priority: high
status: UNREAD
model: sonnet
created: ${date}
---

# Conductor — Tervezési queue feldolgozás

A planning pipeline ${queueCount} kész konsenzus tervet pufferelt.
A te feladatod ezeket feldolgozni és termináloknak kiadni.

## Queue tartalom

\`\`\`
${queueFiles}
\`\`\`

## Teendők

1. Olvasd el a queue-ban lévő konsenzusokat: \`docs/planning/queue/\`
2. Minden konsenzushoz:
   - Használd a \`spaceos-arch-planner\` skill-t a v1→v4 pipeline-hoz
   - Verifikáld az API feltételezéseket a kódbázis ellen
   - Határozd meg melyik terminál valósítsa meg
   - Írd ki a terminálnak inbox üzenetet
3. Feldolgozott konsenzust mozgasd \`docs/planning/archive/\`-ba
4. Küldj DONE outbox-ot a feldolgozás végeztével
`;

  await fs.writeFile(filePath, content);
  await log(`[PlanDebate] Conductor inbox created: ${filename}`);

  return true;
}

// ── Main debate function ────────────────────────────────────────────────────

export async function runPlanDebate(): Promise<DebateResult> {
  const config = await loadPlanConfig();

  const selectedDir = getFullPath(config, config.paths.selected_dir);
  const plansDir = getFullPath(config, config.paths.plans_dir);
  const consensusDir = getFullPath(config, config.paths.consensus_dir);
  const queueDir = getFullPath(config, config.paths.queue_dir);

  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(consensusDir, { recursive: true });
  await fs.mkdir(queueDir, { recursive: true });

  const selectedFile = path.join(selectedDir, 'pending.md');

  // Check if selected file exists
  try {
    await fs.access(selectedFile);
  } catch {
    await log('[PlanDebate] No pending.md found, exiting');
    return {
      success: false,
      conductorNotified: false,
      error: 'No pending.md file'
    };
  }

  // Load inputs
  const selectedContent = await fs.readFile(selectedFile, 'utf-8');
  const codebaseStatus = await loadCodebaseStatus(config);
  const { content: domainFocus, domain } = await loadDomainFocus(config);

  // Load prompt templates
  const plannerPrompt = await loadPrompt(config, 'planner');
  const reviewerPrompt = await loadPrompt(config, 'reviewer');
  const consensusPrompt = await loadPrompt(config, 'consensus');

  const date = new Date().toISOString().split('T')[0];
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // Phase 1: Parallel independent plans
    const phase1 = await runPhase1(
      client, config, plannerPrompt,
      codebaseStatus, domainFocus, selectedContent,
      plansDir, date
    );

    if (!phase1.planAContent || !phase1.planBContent) {
      throw new Error('Empty plan(s) generated');
    }

    // Wait for file writes
    await new Promise(resolve => setTimeout(resolve, config.timing.file_wait * 1000));

    // Phase 2: Cross-review
    const phase2 = await runPhase2(
      client, config, reviewerPrompt,
      phase1.planAContent, phase1.planBContent,
      plansDir, date
    );

    // Wait for file writes
    await new Promise(resolve => setTimeout(resolve, config.timing.file_wait * 1000));

    // Phase 3: Consensus synthesis
    const phase3 = await runPhase3(
      client, config, consensusPrompt,
      phase1.planAContent, phase1.planBContent,
      phase2.reviewAContent, phase2.reviewBContent,
      phase1.planA, phase1.planB,
      consensusDir, date
    );

    if (!phase3.consensusContent.trim()) {
      throw new Error('Empty consensus generated');
    }

    // Wait for file writes
    await new Promise(resolve => setTimeout(resolve, config.timing.file_wait * 1000));

    // Rename processed pending.md
    const donePath = path.join(selectedDir, `${date}_selected-done.md`);
    await fs.rename(selectedFile, donePath);

    // Add to queue
    const queueFile = await addToQueue(config, phase3.consensusFile, queueDir, date);

    // Telegram notification
    if (config.notifications.on_consensus) {
      await telegram(`🧠 *Konsenzus kész*\nDomain: \`${domain}\`\nFile: \`${path.basename(queueFile)}\``);
    }

    // Check queue threshold and notify conductor
    const queueCount = await countQueueItems(queueDir);
    let conductorNotified = false;

    if (queueCount >= config.throttling.queue_notify_threshold) {
      conductorNotified = await notifyConductor(config, queueCount, queueDir, date);

      if (conductorNotified && config.notifications.on_queue_ready) {
        await telegram(`📋 *Planning queue: ${queueCount} terv*\nConductor-nak kiadva\nDomain: \`${domain}\``);
      }
    } else {
      await log(`[PlanDebate] Queue: ${queueCount} plans (< ${config.throttling.queue_notify_threshold}, Conductor not notified yet)`);
    }

    return {
      success: true,
      planA: phase1.planA,
      planB: phase1.planB,
      reviewA: phase2.reviewA,
      reviewB: phase2.reviewB,
      consensusFile: phase3.consensusFile,
      queueFile,
      conductorNotified
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await log(`[PlanDebate] Error: ${errorMsg}`);

    if (config.notifications.on_error) {
      await telegram(`❌ *Plan-debate hiba*\n${errorMsg}`);
    }

    return {
      success: false,
      conductorNotified: false,
      error: errorMsg
    };
  }
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  runPlanDebate().then(result => {
    console.log('Debate result:', JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  });
}
