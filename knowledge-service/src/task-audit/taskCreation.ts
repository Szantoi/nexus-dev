/**
 * Task Audit — Task Creation Service
 *
 * Programmatic task creation with:
 * - Token-based authentication
 * - SHA-256 hash of created inbox files
 * - Append-only JSONL audit log
 * - Git auto-commit (optional)
 *
 * Follows SpaceOS Rule #3: Immutability & Trust
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { authorizeScope, isValidTerminal, type Terminal } from './auth';
import { sha256File } from '../pipeline/hashUtils';

// ── Configuration ───────────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const CREATION_LOG_PATH = path.join(SPACEOS_ROOT, 'logs/tasks/creation.jsonl');
const MAX_CONTENT_LENGTH = 50000; // 50KB

// ── Types ───────────────────────────────────────────────────────────────────

export interface TaskCreateParams {
  title: string;
  content: string;
  assigned_to: Terminal;
  priority: 'critical' | 'high' | 'medium' | 'low';
  task_type?: string;
  review_type?: 'formal' | 'content' | 'manual';
  model?: 'haiku' | 'sonnet' | 'opus';
  ref?: string;
}

export interface TaskCreateResult {
  success: boolean;
  task_id?: string;
  inbox_path?: string;
  inbox_hash?: string;
  error?: string;
}

interface CreationLogEntry {
  timestamp: string;
  task_id: string;
  created_by: string;
  assigned_to: string;
  inbox_path: string;
  inbox_hash: string;
  priority: string;
  task_type: string;
  review_type: string;
  title_hash: string;  // Never log full title, hash it
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateParams(params: TaskCreateParams): string | null {
  if (!params.title || params.title.length === 0) {
    return 'Title is required';
  }
  if (params.title.length > 200) {
    return 'Title too long (max 200 chars)';
  }
  if (!params.content || params.content.length === 0) {
    return 'Content is required';
  }
  if (params.content.length > MAX_CONTENT_LENGTH) {
    return `Content too long (max ${MAX_CONTENT_LENGTH} chars)`;
  }
  if (!isValidTerminal(params.assigned_to)) {
    return `Invalid terminal: ${params.assigned_to}`;
  }
  if (!['critical', 'high', 'medium', 'low'].includes(params.priority)) {
    return `Invalid priority: ${params.priority}`;
  }
  return null;
}

// ── Generate Task ID ────────────────────────────────────────────────────────

function generateTaskId(): string {
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TASK-${date}-${random}`;
}

// ── Find Next Message Number ────────────────────────────────────────────────

async function findNextMessageNumber(inboxDir: string): Promise<string> {
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
  } catch {
    // Directory doesn't exist, will create
  }
  return String(lastNum + 1).padStart(3, '0');
}

// ── Append to Creation Log ──────────────────────────────────────────────────

async function appendCreationLog(entry: CreationLogEntry): Promise<void> {
  const logDir = path.dirname(CREATION_LOG_PATH);
  await fs.mkdir(logDir, { recursive: true });

  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(CREATION_LOG_PATH, line, 'utf-8');
}

// ── Main Create Function ────────────────────────────────────────────────────

export async function createTask(
  token: string,
  params: TaskCreateParams
): Promise<TaskCreateResult> {
  // 1. Validate parameters
  const validationError = validateParams(params);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // 2. Determine required scope
  const requiredScope = `task:create:${params.assigned_to}`;

  // 3. Authenticate and authorize
  const authResult = authorizeScope(token, requiredScope);
  if (!authResult.authenticated) {
    return { success: false, error: authResult.error || 'Unauthorized' };
  }

  // 4. Generate IDs
  const taskId = generateTaskId();
  const date = new Date().toISOString().split('T')[0];
  const inboxDir = path.join(SPACEOS_ROOT, 'terminals', params.assigned_to, 'inbox');
  await fs.mkdir(inboxDir, { recursive: true });

  const msgNum = await findNextMessageNumber(inboxDir);
  const slug = params.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  const filename = `${date}_${msgNum}_${slug}.md`;
  const inboxPath = path.join(inboxDir, filename);

  // 5. Build inbox file content
  const taskType = params.task_type || 'CODE';
  const reviewType = params.review_type || 'content';
  const model = params.model || 'sonnet';

  const content = `---
id: ${taskId}
from: ${authResult.holder}
to: ${params.assigned_to}
type: task
priority: ${params.priority}
status: UNREAD
model: ${model}
task_type: ${taskType}
review_type: ${reviewType}
${params.ref ? `ref: ${params.ref}` : ''}
created: ${date}
created_via: api
---

# ${params.title}

${params.content}
`;

  // 6. Write inbox file
  await fs.writeFile(inboxPath, content, 'utf-8');

  // 7. Compute hash
  const inboxHash = await sha256File(inboxPath);

  // 8. Append to audit log
  await appendCreationLog({
    timestamp: new Date().toISOString(),
    task_id: taskId,
    created_by: authResult.holder!,
    assigned_to: params.assigned_to,
    inbox_path: inboxPath.replace(SPACEOS_ROOT, ''),  // Relative path
    inbox_hash: inboxHash,
    priority: params.priority,
    task_type: taskType,
    review_type: reviewType,
    title_hash: crypto.createHash('sha256').update(params.title).digest('hex').substring(0, 16),
  });

  // 9. Return success
  return {
    success: true,
    task_id: taskId,
    inbox_path: inboxPath,
    inbox_hash: inboxHash,
  };
}

// ── Query Creation Log ──────────────────────────────────────────────────────

export interface CreationLogQuery {
  created_by?: string;
  assigned_to?: string;
  date?: string;  // YYYY-MM-DD
  limit?: number;
}

export async function queryCreationLog(query: CreationLogQuery = {}): Promise<CreationLogEntry[]> {
  try {
    const content = await fs.readFile(CREATION_LOG_PATH, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);

    let entries: CreationLogEntry[] = lines.map(line => JSON.parse(line));

    // Apply filters
    if (query.created_by) {
      entries = entries.filter(e => e.created_by === query.created_by);
    }
    if (query.assigned_to) {
      entries = entries.filter(e => e.assigned_to === query.assigned_to);
    }
    if (query.date) {
      entries = entries.filter(e => e.timestamp.startsWith(query.date!));
    }

    // Sort by timestamp descending (most recent first)
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Apply limit
    if (query.limit && query.limit > 0) {
      entries = entries.slice(0, query.limit);
    }

    return entries;
  } catch {
    return [];
  }
}

// ── Daily Summary ───────────────────────────────────────────────────────────

export interface DailySummary {
  date: string;
  total_tasks: number;
  by_terminal: Record<string, number>;
  by_priority: Record<string, number>;
  by_creator: Record<string, number>;
}

export async function getDailySummary(date?: string): Promise<DailySummary> {
  const targetDate = date || new Date().toISOString().split('T')[0];
  const entries = await queryCreationLog({ date: targetDate });

  const summary: DailySummary = {
    date: targetDate,
    total_tasks: entries.length,
    by_terminal: {},
    by_priority: {},
    by_creator: {},
  };

  for (const entry of entries) {
    // By terminal
    summary.by_terminal[entry.assigned_to] = (summary.by_terminal[entry.assigned_to] || 0) + 1;

    // By priority
    summary.by_priority[entry.priority] = (summary.by_priority[entry.priority] || 0) + 1;

    // By creator
    summary.by_creator[entry.created_by] = (summary.by_creator[entry.created_by] || 0) + 1;
  }

  return summary;
}
