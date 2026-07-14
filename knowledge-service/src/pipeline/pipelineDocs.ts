// pipelineDocs.ts - TypeScript equivalent of pipeline-docs.sh
// Updates documentation after approved DONE and determines next task

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SPACEOS_ROOT, log } from './common';
import {
  loadPipelineConfig,
  loadPipelinePrompt,
  getPipelinePath,
  determineInbox,
  getNextMessageNum,
  PipelineConfig
} from './pipelineConfig';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PipelineResult {
  done: boolean;
  nextFile: string | null;
  testCount: number;
  error?: string;
}

interface DocsUpdateResponse {
  readmeUpdates?: string;
  statusUpdates?: string;
  nextInbox?: {
    terminal: string;
    slug: string;
    priority: string;
    content: string;
  } | null;
  testCount: number;
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

// ── Load source files ───────────────────────────────────────────────────────

async function loadSourceFiles(config: PipelineConfig, donePath: string): Promise<{
  doneContent: string;
  readmeContent: string;
  statusContent: string;
  domainMatrix: string;
}> {
  const doneContent = await fs.readFile(donePath, 'utf-8');

  const readmePath = getPipelinePath(config.paths.tasks_readme);
  const readmeContent = await fs.readFile(readmePath, 'utf-8').catch(() => '');

  const statusPath = getPipelinePath(config.paths.codebase_status);
  const statusContent = await fs.readFile(statusPath, 'utf-8')
    .then(c => c.split('\n').slice(0, 10).join('\n'))
    .catch(() => '');

  const matrixPath = getPipelinePath(config.paths.domain_matrix);
  const domainMatrix = await fs.readFile(matrixPath, 'utf-8')
    .then(c => c.split('\n').slice(0, 50).join('\n'))
    .catch(() => '');

  return { doneContent, readmeContent, statusContent, domainMatrix };
}

// ── Build prompt ────────────────────────────────────────────────────────────

function buildPrompt(
  config: PipelineConfig,
  template: string,
  donePath: string,
  doneContent: string,
  readmeContent: string,
  statusContent: string,
  domainMatrix: string
): string {
  const inboxDir = determineInbox(config, doneContent);

  return template
    .replace(/\{\{DONE_PATH\}\}/g, donePath)
    .replace(/\{\{DONE_CONTENT\}\}/g, doneContent)
    .replace(/\{\{README_CONTENT\}\}/g, readmeContent)
    .replace(/\{\{STATUS_CONTENT\}\}/g, statusContent)
    .replace(/\{\{DOMAIN_MATRIX\}\}/g, domainMatrix)
    .replace(/\{\{TASKS_README\}\}/g, getPipelinePath(config.paths.tasks_readme))
    .replace(/\{\{CODEBASE_STATUS\}\}/g, getPipelinePath(config.paths.codebase_status))
    .replace(/\{\{NEXUS_INBOX\}\}/g, getPipelinePath('docs/mailbox/nexus/inbox'))
    .replace(/\{\{DEFAULT_INBOX\}\}/g, getPipelinePath(config.routing.default_inbox))
    .replace(/\{\{DEFAULT_MODEL\}\}/g, config.next_task.default_model);
}

// ── Parse LLM response ──────────────────────────────────────────────────────

function parseResponse(response: string): DocsUpdateResponse {
  const result: DocsUpdateResponse = { testCount: 0 };

  // Extract README updates (between markdown blocks)
  const readmeMatch = response.match(/## README\.md frissítés[\s\S]*?```markdown\n([\s\S]*?)```/);
  if (readmeMatch) {
    result.readmeUpdates = readmeMatch[1].trim();
  }

  // Extract status updates
  const statusMatch = response.match(/## Codebase_Status[\s\S]*?```\n([\s\S]*?)```/);
  if (statusMatch) {
    result.statusUpdates = statusMatch[1].trim();
  }

  // Extract PIPELINE_RESULT line
  const resultMatch = response.match(/PIPELINE_RESULT:\s*DONE\|NEXT:([^|]+)\|TESTS:(\d+)/);
  if (resultMatch) {
    const nextValue = resultMatch[1].trim();
    result.testCount = parseInt(resultMatch[2], 10) || 0;

    if (nextValue !== 'NONE' && nextValue !== 'none') {
      // Parse next inbox info from the response
      const nextInboxMatch = response.match(/## Következő inbox[\s\S]*?```yaml\n([\s\S]*?)```[\s\S]*?```markdown\n([\s\S]*?)```/);
      if (nextInboxMatch) {
        const frontmatter = nextInboxMatch[1];
        const content = nextInboxMatch[2];

        // Extract fields from frontmatter
        const toMatch = frontmatter.match(/to:\s*(\w+)/);
        const priorityMatch = frontmatter.match(/priority:\s*(\w+)/);
        const slugMatch = nextValue.match(/\d{4}-\d{2}-\d{2}_\d{3}_(.+)\.md/);

        result.nextInbox = {
          terminal: toMatch ? toMatch[1] : 'conductor',
          slug: slugMatch ? slugMatch[1] : 'next-task',
          priority: priorityMatch ? priorityMatch[1] : 'medium',
          content: `---\n${frontmatter}---\n\n${content}`
        };
      }
    }
  }

  return result;
}

// ── Apply updates ───────────────────────────────────────────────────────────

async function applyUpdates(
  config: PipelineConfig,
  updates: DocsUpdateResponse,
  doneContent: string
): Promise<string | null> {
  const date = new Date().toISOString().split('T')[0];
  let nextFilePath: string | null = null;

  // Note: For safety, we're not automatically modifying README.md and Codebase_Status.md
  // The LLM should output the suggested changes, but manual review is safer
  // If you want automatic updates, uncomment the code below:

  /*
  // Update README.md
  if (updates.readmeUpdates) {
    const readmePath = getFullPath(config.paths.tasks_readme);
    await fs.writeFile(readmePath, updates.readmeUpdates);
    await log('[PipelineDocs] README.md updated');
  }

  // Update Codebase_Status.md
  if (updates.statusUpdates) {
    const statusPath = getFullPath(config.paths.codebase_status);
    const currentStatus = await fs.readFile(statusPath, 'utf-8');
    const lines = currentStatus.split('\n');
    // Replace first line with new date/summary
    lines[0] = updates.statusUpdates.split('\n')[0];
    await fs.writeFile(statusPath, lines.join('\n'));
    await log('[PipelineDocs] Codebase_Status.md updated');
  }
  */

  // Create next inbox message if specified
  if (updates.nextInbox) {
    const inboxDir = determineInbox(config, doneContent);
    await fs.mkdir(inboxDir, { recursive: true });

    const nextNum = await getNextMessageNum(inboxDir);
    const numStr = String(nextNum).padStart(3, '0');
    const filename = `${date}_${numStr}_${updates.nextInbox.slug}.md`;
    nextFilePath = path.join(inboxDir, filename);

    await fs.writeFile(nextFilePath, updates.nextInbox.content);
    await log(`[PipelineDocs] Next inbox created: ${filename}`);
  }

  return nextFilePath;
}

// ── Main function ───────────────────────────────────────────────────────────

export async function runPipelineDocs(donePath: string, terminal: string): Promise<PipelineResult> {
  const config = await loadPipelineConfig();

  try {
    // Load source files
    const { doneContent, readmeContent, statusContent, domainMatrix } =
      await loadSourceFiles(config, donePath);

    // Load prompt template
    const template = await loadPipelinePrompt(config, 'docs_updater');

    // Build prompt
    const prompt = buildPrompt(
      config, template, donePath,
      doneContent, readmeContent, statusContent, domainMatrix
    );

    // Add structured output instruction
    const enhancedPrompt = `${prompt}

---

**FONTOS:** Válaszod végén KÖTELEZŐEN add meg ezt a sort (a pipeline parsing-hoz):

\`PIPELINE_RESULT: DONE|NEXT:<inbox_fajlnev_vagy_NONE>|TESTS:<tesztszam>\`

Ha nincs következő task, akkor: \`PIPELINE_RESULT: DONE|NEXT:NONE|TESTS:0\``;

    // Call LLM
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = resolveModel(config.models.docs_updater);
    const timeoutMs = config.timing.docs_timeout * 1000;

    const response = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: enhancedPrompt }]
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);

    const textContent = response.content.find(c => c.type === 'text');
    const rawResponse = textContent ? textContent.text : '';

    // Parse response
    const updates = parseResponse(rawResponse);

    // Apply updates
    const nextFile = await applyUpdates(config, updates, doneContent);

    await log(`[PipelineDocs] Completed: terminal=${terminal}, tests=${updates.testCount}, next=${nextFile || 'NONE'}`);

    return {
      done: true,
      nextFile,
      testCount: updates.testCount
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await log(`[PipelineDocs] Error: ${errorMsg}`);

    return {
      done: false,
      nextFile: null,
      testCount: 0,
      error: errorMsg
    };
  }
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  const donePath = process.argv[2];
  const terminal = process.argv[3];

  if (!donePath || !terminal) {
    console.error('Usage: npx ts-node pipelineDocs.ts <done_file_path> <terminal>');
    process.exit(1);
  }

  runPipelineDocs(donePath, terminal).then(result => {
    console.log(`PIPELINE_RESULT: DONE|NEXT:${result.nextFile || 'NONE'}|TESTS:${result.testCount}`);
    process.exit(result.done ? 0 : 1);
  });
}
