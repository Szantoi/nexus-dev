// reviewer.ts - TypeScript equivalent of reviewer.sh
// Dual Haiku review for DONE messages with Anthropic SDK
// Enhanced with task types, SHA-256 hash verification, and escalation

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SPACEOS_ROOT, log, telegram } from './common';
import { sha256File, sha256String } from './hashUtils';
import {
  appendReviewDecision,
  queryReviewLog,
  generateReviewId,
  getReviewAttemptCount,
  type ReviewDecision
} from './reviewLog';
import { runPreReviewGate, type ProjectType } from './preReviewGate';

// ── Types ───────────────────────────────────────────────────────────────────

interface ReviewConfig {
  reviewer: {
    model_a: string;
    model_b: string;
    parallel: boolean;
    require_both: boolean;
  };
  timing: {
    review_timeout: number;
    file_wait: number;
  };
  verdict: {
    approve_keywords: string[];
    reject_keywords: string[];
  };
  paths: {
    prompt_template: string;
    context_file: string;
    log_dir: string;
    review_dir: string;
  };
  reject_inbox: {
    priority: string;
    model_fallback: string;
  };
  notifications: {
    on_approve: boolean;
    on_reject: boolean;
    on_error: boolean;
  };
}

interface ReviewResult {
  verdict: 'APPROVE' | 'REJECT' | 'ERROR' | 'UNKNOWN';
  feedback: string;
  rawResponse: string;
}

interface DualReviewResult {
  approved: boolean;
  reviewA: ReviewResult;
  reviewB: ReviewResult;
  terminal: string;
  doneFile: string;
  doneBase: string;
  reviewId?: string;
  escalated?: boolean;
}

interface TaskTypeConfig {
  type: string;
  description: string;
  strictness: 'low' | 'medium' | 'high' | 'critical';
  require_both: boolean;
  escalation_policy: {
    max_attempts: number;
    escalate_to: string;
    notify: string;
  };
  version: string;
}

// ── Configuration Loading ───────────────────────────────────────────────────

async function loadConfig(): Promise<ReviewConfig> {
  const configPath = path.join(SPACEOS_ROOT, 'scripts/reviewer-config.yaml');
  const content = await fs.readFile(configPath, 'utf-8');
  return yaml.load(content) as ReviewConfig;
}

async function loadPromptTemplate(config: ReviewConfig): Promise<string> {
  const templatePath = path.join(SPACEOS_ROOT, config.paths.prompt_template);
  return fs.readFile(templatePath, 'utf-8');
}

async function loadContext(config: ReviewConfig): Promise<string> {
  const contextPath = path.join(SPACEOS_ROOT, config.paths.context_file);
  try {
    return await fs.readFile(contextPath, 'utf-8');
  } catch {
    return '';
  }
}

async function loadTaskTypeConfig(taskType: string): Promise<TaskTypeConfig | null> {
  const configPath = path.join(SPACEOS_ROOT, `config/task-types/${taskType}.yaml`);
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return yaml.load(content) as TaskTypeConfig;
  } catch {
    await log(`[Reviewer] Task type config not found: ${taskType}, using defaults`);
    return null;
  }
}

// ── Parse DONE file metadata ────────────────────────────────────────────────

function extractTerminal(donePath: string): string {
  // Support both new (terminals/) and legacy (docs/mailbox/) paths
  const newMatch = donePath.match(/terminals\/([^/]+)\//);
  if (newMatch) return newMatch[1];

  const legacyMatch = donePath.match(/mailbox\/([^/]+)\//);
  return legacyMatch ? legacyMatch[1] : 'unknown';
}

function extractRef(content: string): string {
  const match = content.match(/^ref:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

function extractModel(content: string): string {
  const match = content.match(/^model:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

function extractTaskType(content: string): string {
  const match = content.match(/^task_type:\s*(.+)$/m);
  return match ? match[1].trim() : 'CODE';  // default to CODE
}

function extractReviewType(content: string): 'formal' | 'content' | 'manual' {
  const match = content.match(/^review_type:\s*(.+)$/m);
  const reviewType = match ? match[1].trim().toLowerCase() : 'content';

  if (reviewType === 'formal') return 'formal';
  if (reviewType === 'manual') return 'manual';
  return 'content';  // default - backward compatible
}

// ── Find original inbox file ────────────────────────────────────────────────

async function findInboxFile(terminal: string, msgRef: string): Promise<{ path: string; content: string } | null> {
  if (!msgRef || msgRef === '—') return null;

  // Try new terminals/ path first, then legacy docs/mailbox/
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
      // Inbox doesn't exist, try next
    }
  }

  return null;
}

// ── Build review prompt ─────────────────────────────────────────────────────

function buildPrompt(
  template: string,
  context: string,
  inboxPath: string,
  inboxContent: string,
  donePath: string,
  doneContent: string
): string {
  return template
    .replace('{{CONTEXT}}', context)
    .replace('{{INBOX_PATH}}', inboxPath)
    .replace('{{INBOX_CONTENT}}', inboxContent || '(nem található)')
    .replace('{{DONE_PATH}}', donePath)
    .replace('{{DONE_CONTENT}}', doneContent);
}

// ── Single review execution ─────────────────────────────────────────────────

async function runSingleReview(
  client: Anthropic,
  model: string,
  prompt: string,
  timeoutMs: number
): Promise<ReviewResult> {
  // Model name mapping (use latest models - June 2026)
  // Dateless model IDs are canonical for 4.5+ generation
  const modelMap: Record<string, string> = {
    'haiku': 'claude-haiku-4-5',
    'sonnet': 'claude-sonnet-4-5',
    'opus': 'claude-opus-4-5',
  };

  const fullModel = modelMap[model] || model;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: fullModel,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: prompt
        }]
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);

    const textContent = response.content.find(c => c.type === 'text');
    const rawResponse = textContent ? textContent.text : '';

    return parseReviewResponse(rawResponse);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Reviewer] API call failed for ${model}: ${errorMsg}`);
    return {
      verdict: 'ERROR',
      feedback: `Review hiba: ${errorMsg}`,
      rawResponse: ''
    };
  }
}

// ── Parse review response ───────────────────────────────────────────────────

function parseReviewResponse(response: string): ReviewResult {
  // Extract verdict
  const verdictMatch = response.match(/VERDICT:\s*(\w+)/i);
  const rawVerdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'UNKNOWN';

  // Normalize verdict
  const approveKeywords = ['APPROVE', 'APPROVED', 'JÓVÁHAGYVA'];
  const rejectKeywords = ['REJECT', 'REJECTED', 'VISSZADOBVA'];

  let verdict: 'APPROVE' | 'REJECT' | 'ERROR' | 'UNKNOWN' = 'UNKNOWN';
  if (approveKeywords.includes(rawVerdict)) {
    verdict = 'APPROVE';
  } else if (rejectKeywords.includes(rawVerdict)) {
    verdict = 'REJECT';
  }

  // Extract feedback
  const feedbackMatch = response.match(/FEEDBACK:\s*([\s\S]*?)(?:$|---)/i);
  const feedback = feedbackMatch ? feedbackMatch[1].trim() : '';

  return { verdict, feedback, rawResponse: response };
}

// ── Dual review execution ───────────────────────────────────────────────────

export async function runDualReview(donePath: string): Promise<DualReviewResult> {
  // Check for API key first - skip review gracefully if not configured
  if (!process.env.ANTHROPIC_API_KEY) {
    await log('[Reviewer] ANTHROPIC_API_KEY not configured - skipping automated review');
    const doneBase = path.basename(donePath, '.md');
    const terminal = extractTerminal(donePath);
    return {
      approved: false,
      reviewA: { verdict: 'ERROR', feedback: 'ANTHROPIC_API_KEY not configured - manual review required', rawResponse: '' },
      reviewB: { verdict: 'ERROR', feedback: 'ANTHROPIC_API_KEY not configured - manual review required', rawResponse: '' },
      terminal,
      doneFile: donePath,
      doneBase,
    };
  }

  const config = await loadConfig();
  const template = await loadPromptTemplate(config);
  const context = await loadContext(config);

  // Read DONE file
  const doneContent = await fs.readFile(donePath, 'utf-8');
  const terminal = extractTerminal(donePath);
  const doneBase = path.basename(donePath, '.md');
  const msgRef = extractRef(doneContent);

  // Find original inbox
  const inbox = await findInboxFile(terminal, msgRef);
  const inboxPath = inbox?.path || '(nem található)';
  const inboxContent = inbox?.content || '';

  // ── NEW: Compute hashes for integrity ──
  const inboxHash = inbox ? await sha256File(inbox.path) : 'sha256:unknown';
  const doneHash = await sha256File(donePath);

  // ── NEW: Extract task type ──
  const taskType = extractTaskType(inboxContent);
  const taskTypeConfig = await loadTaskTypeConfig(taskType);

  // ── NEW: Check previous review attempts ──
  const previousReviews = await queryReviewLog({ inbox_hash: inboxHash });
  const reviewAttempt = previousReviews.length + 1;

  await log(`[Reviewer] Task type: ${taskType}, Attempt: ${reviewAttempt}/${taskTypeConfig?.escalation_policy.max_attempts || 2}`);

  // ── NEW: Escalate if max attempts exceeded ──
  if (taskTypeConfig && reviewAttempt > taskTypeConfig.escalation_policy.max_attempts) {
    await log(`[Reviewer] MAX ATTEMPTS EXCEEDED (${reviewAttempt} > ${taskTypeConfig.escalation_policy.max_attempts}) → ESCALATING to ${taskTypeConfig.escalation_policy.escalate_to}`);

    const escalationResult = await createEscalationMessage({
      terminal,
      inboxHash,
      doneHash,
      taskType,
      reviewAttempt,
      previousReviews,
      doneBase,
      inboxPath,
      donePath
    });

    return {
      approved: false,
      reviewA: { verdict: 'ERROR', feedback: 'Max attempts exceeded', rawResponse: '' },
      reviewB: { verdict: 'ERROR', feedback: 'Max attempts exceeded', rawResponse: '' },
      terminal,
      doneFile: donePath,
      doneBase,
      escalated: true,
      reviewId: escalationResult.reviewId
    };
  }

  // Build prompt
  const prompt = buildPrompt(template, context, inboxPath, inboxContent, donePath, doneContent);

  // Initialize Anthropic client
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const timeoutMs = config.timing.review_timeout * 1000;

  await log(`[Reviewer] Starting dual review: ${doneBase} (A: ${config.reviewer.model_a}, B: ${config.reviewer.model_b})`);

  // Run reviews in parallel
  const [reviewA, reviewB] = await Promise.all([
    runSingleReview(client, config.reviewer.model_a, prompt, timeoutMs),
    runSingleReview(client, config.reviewer.model_b, prompt, timeoutMs),
  ]);

  // Save review results
  const reviewDir = path.join(SPACEOS_ROOT, config.paths.review_dir);
  await fs.mkdir(reviewDir, { recursive: true });
  await fs.writeFile(
    path.join(reviewDir, `${doneBase}_reviewer_a.txt`),
    reviewA.rawResponse
  );
  await fs.writeFile(
    path.join(reviewDir, `${doneBase}_reviewer_b.txt`),
    reviewB.rawResponse
  );

  // ── NEW: Task type based approval logic ──
  let approved = false;
  const requireBoth = taskTypeConfig?.require_both ?? config.reviewer.require_both;

  if (requireBoth) {
    approved = reviewA.verdict === 'APPROVE' && reviewB.verdict === 'APPROVE';
  } else {
    approved = reviewA.verdict === 'APPROVE' || reviewB.verdict === 'APPROVE';
  }

  await log(`[Reviewer] Results: A=${reviewA.verdict}, B=${reviewB.verdict} → ${approved ? 'APPROVED' : 'REJECTED'} (require_both: ${requireBoth})`);

  // ── NEW: Append to review decision log ──
  const reviewId = generateReviewId();
  await appendReviewDecision({
    timestamp: new Date().toISOString(),
    review_id: reviewId,
    inbox_file: inboxPath,
    inbox_hash: inboxHash,
    done_file: donePath,
    done_hash: doneHash,
    task_type: taskType,
    review_attempt: reviewAttempt,
    reviewer_a: {
      model: config.reviewer.model_a,
      verdict: reviewA.verdict,
      feedback_hash: sha256String(reviewA.feedback)
    },
    reviewer_b: {
      model: config.reviewer.model_b,
      verdict: reviewB.verdict,
      feedback_hash: sha256String(reviewB.feedback)
    },
    final_verdict: approved ? 'APPROVED' : 'REJECTED'
  });

  return {
    approved,
    reviewA,
    reviewB,
    terminal,
    doneFile: donePath,
    doneBase,
    reviewId
  };
}

// ── Create escalation message to Root ───────────────────────────────────────

async function createEscalationMessage(params: {
  terminal: string;
  inboxHash: string;
  doneHash: string;
  taskType: string;
  reviewAttempt: number;
  previousReviews: ReviewDecision[];
  doneBase: string;
  inboxPath: string;
  donePath: string;
}): Promise<{ reviewId: string; escalationPath: string }> {
  const reviewId = generateReviewId();

  // Create escalation inbox for root
  const rootInboxDir = path.join(SPACEOS_ROOT, 'terminals/root/inbox');
  await fs.mkdir(rootInboxDir, { recursive: true });

  // Find next message number
  let lastNum = 0;
  try {
    const files = await fs.readdir(rootInboxDir);
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
  const filename = `${date}_${nextNum}_escalation-${params.terminal}-${params.doneBase}.md`;
  const escalationPath = path.join(rootInboxDir, filename);

  // Build review history summary
  const reviewHistory = params.previousReviews.map((r, idx) => {
    return `### Attempt ${idx + 1} (${r.timestamp.split('T')[0]})
- **Reviewer A:** ${r.reviewer_a.verdict}
- **Reviewer B:** ${r.reviewer_b.verdict}
- **Final:** ${r.final_verdict}
${r.reject_inbox_created ? `- Reject inbox: \`${r.reject_inbox_created}\`` : ''}`;
  }).join('\n\n');

  const content = `---
id: MSG-ROOT-${nextNum}
from: reviewer
to: root
type: escalation
priority: critical
status: UNREAD
model: opus
review_id: ${reviewId}
task_type: MANUAL_REVIEW
escalation_reason: MAX_ATTEMPTS_EXCEEDED
created: ${date}
---

# ⚠️ Manual Review szükséges: ${params.terminal.toUpperCase()}

## Escalation Context

**Review ID:** ${reviewId}
**Task type:** ${params.taskType}
**Attempts:** ${params.reviewAttempt} (max exceeded)
**Terminal:** ${params.terminal}

## File Integrity

| File | SHA-256 Hash | Status |
|---|---|---|
| Inbox | \`${params.inboxHash}\` | ✅ Verified |
| DONE (latest) | \`${params.doneHash}\` | ✅ Verified |

## Review History

${reviewHistory}

## Root döntési opciók

**1. OVERRIDE APPROVE**
- Elfogadod a DONE-t, reviewer túl szigorú volt
- Action: Review log manuális update + pipeline folytatása

**2. MANUAL REJECT + detailed guidance**
- Konkrét útmutatást adsz a terminálnak
- Action: Új inbox üzenet részletes instrukcióval

**3. REASSIGN task**
- Másik terminálnak adod a feladatot
- Action: Task reassignment + notification

## Files

- **Inbox:** \`${params.inboxPath}\`
- **DONE:** \`${params.donePath}\`
- **Review log:** \`logs/reviews/decisions.jsonl\`

## Next Steps

Root válaszoljon erre az escalation-re, vagy használja az API-t:
\`\`\`bash
# Override approve
POST /api/reviews/override/${reviewId} --verdict=APPROVED --reason="..."

# Manual reject
POST /api/reviews/manual-reject/${reviewId} --guidance="..."
\`\`\`
`;

  await fs.writeFile(escalationPath, content);

  // Log escalation
  await appendReviewDecision({
    timestamp: new Date().toISOString(),
    review_id: reviewId,
    inbox_file: params.inboxPath,
    inbox_hash: params.inboxHash,
    done_file: params.donePath,
    done_hash: params.doneHash,
    task_type: params.taskType,
    review_attempt: params.reviewAttempt,
    reviewer_a: {
      model: 'escalation',
      verdict: 'ERROR',
      feedback_hash: 'sha256:escalated'
    },
    reviewer_b: {
      model: 'escalation',
      verdict: 'ERROR',
      feedback_hash: 'sha256:escalated'
    },
    final_verdict: 'ERROR',
    escalated: true,
    escalation_msg: `MSG-ROOT-${nextNum}`
  });

  // Telegram notification
  await telegram(`🚨 *ESCALATION to Root*\nTerminal: ${params.terminal}\nAttempts: ${params.reviewAttempt}\nReview ID: ${reviewId}\nFile: \`${escalationPath}\``);

  await log(`[Reviewer] Escalation created: ${escalationPath}`);

  return { reviewId, escalationPath };
}

// ── Create reject inbox message ─────────────────────────────────────────────

export async function createRejectInbox(result: DualReviewResult): Promise<string> {
  const config = await loadConfig();

  const inboxDir = path.join(SPACEOS_ROOT, 'docs/mailbox', result.terminal, 'inbox');
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
  const filename = `${date}_${nextNum}_review-reject-${result.doneBase}.md`;
  const filePath = path.join(inboxDir, filename);

  // Get original model from inbox
  const msgRef = extractRef(await fs.readFile(result.doneFile, 'utf-8'));
  const inbox = await findInboxFile(result.terminal, msgRef);
  const origModel = inbox ? extractModel(inbox.content) : config.reject_inbox.model_fallback;

  const content = `---
id: MSG-${result.terminal.toUpperCase()}-${nextNum}-REVIEW-REJECT
from: reviewer
to: ${result.terminal}
type: task
priority: ${config.reject_inbox.priority}
status: UNREAD
model: ${origModel || config.reject_inbox.model_fallback}
ref: ${result.doneBase}
created: ${date}
---

# Review visszadobás: ${result.doneBase}

A dual review **nem fogadta el** a DONE-t. Az alábbi pontokat kell javítani, majd új DONE-t kell küldeni.

## Reviewer-A verdict: ${result.reviewA.verdict}

${result.reviewA.feedback || '(nincs feedback)'}

## Reviewer-B verdict: ${result.reviewB.verdict}

${result.reviewB.feedback || '(nincs feedback)'}

## Teendő

1. Olvasd el az eredeti feladatot
2. Javítsd a fenti pontokat
3. Küldd újra a DONE outbox üzenetet
`;

  await fs.writeFile(filePath, content);

  // Telegram notification
  if (config.notifications.on_reject) {
    await telegram(`⚠️ *${result.terminal.toUpperCase()} DONE visszadobva*\nA: ${result.reviewA.verdict}\nB: ${result.reviewB.verdict}\n\`${result.doneBase}\``);
  }

  return filePath;
}

// ── Formal Review (no LLM, just automated checks) ─────────────────────────────

interface FormalReviewResult {
  approved: boolean;
  checks: {
    frontmatter: boolean;
    gitCommit: boolean;
    buildSuccess?: boolean;
    lintPass?: boolean;
    testsPass?: boolean;
    typeCheck?: boolean;
  };
  errors: string[];
  duration: number; // milliseconds
}

async function runFormalReview(donePath: string, taskType: string): Promise<FormalReviewResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const checks = {
    frontmatter: false,
    gitCommit: false,
    buildSuccess: undefined as boolean | undefined,
    lintPass: undefined as boolean | undefined,
    testsPass: undefined as boolean | undefined,
    typeCheck: undefined as boolean | undefined,
  };

  // Read DONE content
  const doneContent = await fs.readFile(donePath, 'utf-8');
  const terminal = extractTerminal(donePath);

  // 1. Frontmatter validation (always required)
  const hasFrontmatter = doneContent.startsWith('---');
  const hasRequiredFields = /^id:\s*.+$/m.test(doneContent) &&
                            /^type:\s*.+$/m.test(doneContent) &&
                            /^status:\s*.+$/m.test(doneContent);

  checks.frontmatter = hasFrontmatter && hasRequiredFields;
  if (!checks.frontmatter) {
    errors.push('Frontmatter missing or incomplete (required: id, type, status)');
  }

  // 2. Git commit check (always required)
  const filesChanged = doneContent.match(/files_changed:\s*\n((?:\s+-\s+.+\n?)+)/);
  if (filesChanged) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      // Check if there are uncommitted changes
      const { stdout } = await execAsync('git status --porcelain', {
        cwd: SPACEOS_ROOT
      });

      // If files_changed are listed but still uncommitted, fail
      const changedFiles = filesChanged[1].split('\n')
        .map(f => f.replace(/^\s*-\s*/, '').trim())
        .filter(f => f.length > 0);

      const uncommittedFiles = stdout.split('\n')
        .map(line => line.substring(3).trim())
        .filter(f => f.length > 0);

      const hasUncommitted = changedFiles.some(cf =>
        uncommittedFiles.some(uf => uf.includes(cf) || cf.includes(uf))
      );

      checks.gitCommit = !hasUncommitted;
      if (hasUncommitted) {
        errors.push('Files marked as changed are not committed to git');
      }
    } catch (e) {
      checks.gitCommit = true; // Git check failed, assume OK
    }
  } else {
    checks.gitCommit = true; // No files_changed specified
  }

  // 3. Code quality checks (only for CODE, BUGFIX, FEATURE task types)
  const needsCodeChecks = ['CODE', 'BUGFIX', 'FEATURE'].includes(taskType.toUpperCase());
  const knowledgeServiceDir = path.join(SPACEOS_ROOT, 'spaceos-nexus/knowledge-service');

  if (needsCodeChecks) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // 3a. TypeScript type check (fast, catches type errors without full build)
    try {
      await execAsync('npx tsc --noEmit', {
        cwd: knowledgeServiceDir,
        timeout: 60000
      });
      checks.typeCheck = true;
    } catch (e) {
      checks.typeCheck = false;
      const err = e as { stderr?: string };
      const shortError = err.stderr?.split('\n').slice(0, 3).join('\n') || 'Type check failed';
      errors.push(`Type check failed: ${shortError}`);
    }

    // 3b. Build check (full compilation)
    try {
      await execAsync('npm run build', {
        cwd: knowledgeServiceDir,
        timeout: 60000
      });
      checks.buildSuccess = true;
    } catch (e) {
      checks.buildSuccess = false;
      errors.push('Build failed (npm run build)');
    }

    // 3c. Lint check (eslint if available, skip if not configured)
    try {
      // Check if eslint is available
      const { stdout: hasEslint } = await execAsync('npm ls eslint --depth=0 2>/dev/null || true', {
        cwd: knowledgeServiceDir,
        timeout: 10000
      });
      if (hasEslint.includes('eslint')) {
        await execAsync('npx eslint src/ --max-warnings=0', {
          cwd: knowledgeServiceDir,
          timeout: 60000
        });
        checks.lintPass = true;
      } else {
        // No eslint configured, skip
        checks.lintPass = undefined;
      }
    } catch (e) {
      checks.lintPass = false;
      const err = e as { stderr?: string; stdout?: string };
      const errorOutput = err.stdout || err.stderr || 'Lint failed';
      const shortError = errorOutput.split('\n').slice(0, 5).join('\n');
      errors.push(`Lint failed: ${shortError}`);
    }

    // 3d. Test check (only if review_level is 'strict' or task_type is BUGFIX)
    const needsTests = taskType.toUpperCase() === 'BUGFIX' ||
                       doneContent.includes('review_level: strict');
    if (needsTests) {
      try {
        await execAsync('npm test', {
          cwd: knowledgeServiceDir,
          timeout: 120000 // 2 minutes for tests
        });
        checks.testsPass = true;
      } catch (e) {
        checks.testsPass = false;
        const err = e as { stderr?: string; stdout?: string };
        // Extract test failure summary
        const output = err.stdout || err.stderr || '';
        const failMatch = output.match(/(\d+) failed/);
        const failCount = failMatch ? failMatch[1] : 'unknown';
        errors.push(`Tests failed (${failCount} failures)`);
      }
    }
  }

  // Calculate final approval
  const requiredPassed = checks.frontmatter && checks.gitCommit;
  // Optional checks: only fail if explicitly false (undefined = not applicable)
  const optionalPassed = checks.buildSuccess !== false &&
                         checks.lintPass !== false &&
                         checks.testsPass !== false &&
                         checks.typeCheck !== false;
  const approved = requiredPassed && optionalPassed;

  const duration = Date.now() - startTime;
  await log(`[Reviewer] Formal review (${duration}ms): frontmatter=${checks.frontmatter}, git=${checks.gitCommit}, typecheck=${checks.typeCheck}, build=${checks.buildSuccess}, lint=${checks.lintPass}, tests=${checks.testsPass} → ${approved ? 'APPROVED' : 'REJECTED'}`);

  return { approved, checks, errors, duration };
}

// ── Main review handler (called by watchDone) ───────────────────────────────

export async function handleDoneReview(donePath: string): Promise<{ approved: boolean; resultPath?: string; reviewType?: string }> {
  try {
    // Read DONE to determine review type
    const doneContent = await fs.readFile(donePath, 'utf-8');
    const reviewType = extractReviewType(doneContent);
    const taskType = extractTaskType(doneContent);
    const terminal = extractTerminal(donePath);
    const doneBase = path.basename(donePath, '.md');

    await log(`[Reviewer] Processing ${doneBase}: review_type=${reviewType}, task_type=${taskType}`);

    // MSG-NEXUS-010: Pre-review gate (fast deterministic checks before expensive AI review)
    const preReviewEnabled = process.env.PRE_REVIEW_ENABLED !== 'false'; // Enabled by default

    if (preReviewEnabled && reviewType !== 'manual') {
      // Detect project type from terminal or files_changed
      let projectType: ProjectType | null = null;

      if (doneContent.includes('datahaven-web') || doneContent.includes('client/src') || terminal === 'frontend') {
        projectType = 'datahaven-web';
      } else if (doneContent.includes('knowledge-service') || doneContent.includes('spaceos-nexus') || terminal === 'nexus') {
        projectType = 'knowledge-service';
      }

      if (projectType) {
        await log(`[PreReview] Running pre-review gate for: ${projectType}`);
        const preReviewResult = await runPreReviewGate(projectType);

        if (!preReviewResult.passed) {
          // Pre-review failed - skip expensive AI review
          await log(`[PreReview] ❌ FAILED (${preReviewResult.duration_ms}ms): ${preReviewResult.summary}`);

          const failedChecks = preReviewResult.checks
            .filter(c => !c.passed)
            .map(c => `- **${c.name}**: ${c.error || 'Failed'}`)
            .join('\n');

          const rejectContent = `---
id: ${doneBase}-PREREVIEW-REJECT
from: reviewer
to: ${terminal}
type: blocked
ref: ${doneBase}
status: UNREAD
created: ${new Date().toISOString().split('T')[0]}
---

# Pre-Review Failed: ${doneBase}

The automated pre-review gate detected issues that must be fixed before AI review.

## Failed Checks

${failedChecks}

## Summary

${preReviewResult.summary}

## Next Steps

1. Fix the failed checks above
2. Re-submit the DONE outbox message
3. The pre-review gate will run again automatically

---

**Pre-Review Gate Duration:** ${preReviewResult.duration_ms}ms
`;

          const rejectPath = path.join(SPACEOS_ROOT, 'terminals', terminal, 'inbox', `${new Date().toISOString().split('T')[0]}_${doneBase}-prereview-reject.md`);
          await fs.writeFile(rejectPath, rejectContent);

          await telegram(`❌ *${terminal.toUpperCase()} Pre-Review FAILED*\n\`${doneBase}\`\n${failedChecks}`);

          return { approved: false, resultPath: rejectPath, reviewType: 'pre-review' };
        } else {
          await log(`[PreReview] ✅ PASSED (${preReviewResult.duration_ms}ms): ${preReviewResult.summary}`);
        }
      }
    }

    // Route based on review_type
    if (reviewType === 'manual') {
      // Skip automated review, escalate to root
      await log(`[Reviewer] Manual review requested → escalating to root`);
      await telegram(`📋 *Manual review requested*\nTerminal: ${terminal}\nFile: \`${doneBase}\``);
      return { approved: false, reviewType: 'manual' };
    }

    if (reviewType === 'formal') {
      // Run formal review (no LLM)
      const formalResult = await runFormalReview(donePath, taskType);

      if (formalResult.approved) {
        const checkList = [
          '✓ Frontmatter',
          '✓ Git commit',
          formalResult.checks.typeCheck ? '✓ Type check' : null,
          formalResult.checks.buildSuccess ? '✓ Build' : null,
          formalResult.checks.lintPass ? '✓ Lint' : null,
          formalResult.checks.testsPass ? '✓ Tests' : null,
        ].filter(Boolean).join('\n');
        await telegram(`✅ *${terminal.toUpperCase()} FORMAL review passed* (${formalResult.duration}ms)\n\`${doneBase}\`\n${checkList}`);
        return { approved: true, reviewType: 'formal' };
      } else {
        // Create reject inbox with formal review errors
        const rejectPath = await createFormalRejectInbox(donePath, terminal, doneBase, formalResult);
        return { approved: false, resultPath: rejectPath, reviewType: 'formal' };
      }
    }

    // Default: content review (dual LLM)
    const result = await runDualReview(donePath);

    if (result.approved) {
      const config = await loadConfig();
      if (config.notifications.on_approve) {
        await telegram(`✅ *${result.terminal.toUpperCase()} DONE elfogadva*\n\`${result.doneBase}\``);
      }
      return { approved: true, reviewType: 'content' };
    } else {
      const rejectPath = await createRejectInbox(result);
      return { approved: false, resultPath: rejectPath, reviewType: 'content' };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await log(`[Reviewer] Error: ${errorMsg}`);
    await telegram(`❌ *Reviewer hiba*\n${errorMsg}`);
    return { approved: false };
  }
}

// ── Create formal reject inbox ─────────────────────────────────────────────

async function createFormalRejectInbox(
  donePath: string,
  terminal: string,
  doneBase: string,
  result: FormalReviewResult
): Promise<string> {
  const config = await loadConfig();

  // Use new terminals/ path
  const inboxDir = path.join(SPACEOS_ROOT, 'terminals', terminal, 'inbox');
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
  const filename = `${date}_${nextNum}_formal-review-reject-${doneBase}.md`;
  const filePath = path.join(inboxDir, filename);

  const checksTable = Object.entries(result.checks)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `| ${k} | ${v ? '✅' : '❌'} |`)
    .join('\n');

  const content = `---
id: MSG-${terminal.toUpperCase()}-${nextNum}-FORMAL-REJECT
from: reviewer
to: ${terminal}
type: task
priority: high
status: UNREAD
model: sonnet
ref: ${doneBase}
review_type: formal
created: ${date}
---

# Formal Review visszadobás: ${doneBase}

A **formal review** nem fogadta el a DONE-t. Az alábbi ellenőrzések sikertelenek:

## Ellenőrzések

| Check | Status |
|---|---|
${checksTable}

## Hibák

${result.errors.map(e => `- ❌ ${e}`).join('\n')}

## Teendő

1. Javítsd a fenti hibákat
2. Commitold a változtatásokat git-be
3. Küldd újra a DONE outbox üzenetet
`;

  await fs.writeFile(filePath, content);

  if (config.notifications.on_reject) {
    await telegram(`⚠️ *${terminal.toUpperCase()} FORMAL review failed*\n${result.errors.join('\n')}`);
  }

  return filePath;
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  const donePath = process.argv[2];
  if (!donePath) {
    console.error('Usage: npx ts-node reviewer.ts <done_file_path>');
    process.exit(1);
  }

  handleDoneReview(donePath).then(result => {
    console.log(`Review result: ${result.approved ? 'APPROVED' : 'REJECTED'}`);
    if (result.resultPath) {
      console.log(`Reject inbox: ${result.resultPath}`);
    }
    process.exit(result.approved ? 0 : 1);
  });
}
