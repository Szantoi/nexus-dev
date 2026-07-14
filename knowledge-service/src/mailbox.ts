/**
 * SpaceOS Mailbox Service — MCP Phase 2 Tools
 *
 * Tools:
 *   - list_inbox: List inbox messages for a terminal
 *   - send_message: Create new inbox message
 *   - submit_done: Create DONE outbox message
 *   - get_task_status: Query task status from docs/tasks/
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';

// ─── Types ────────────────────────────────────────────────────────────────

interface MessageFrontmatter {
  id: string;
  from: string;
  to: string;
  type: 'task' | 'question' | 'done' | 'blocked';
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'UNREAD' | 'READ';
  model?: 'haiku' | 'sonnet' | 'opus';
  ref?: string;
  created: string;
  completed?: string;
  // Epic-aware fields (2026-06-24)
  epic_id?: string;      // e.g., "EPIC-CUTTING-Q3"
  project_id?: string;   // e.g., "spaceos/cutting"
  task_id?: string;      // e.g., "TASK-001"
}

interface InboxMessage {
  frontmatter: MessageFrontmatter;
  content: string;
  filePath: string;
}

// Lightweight inbox metadata (no content) - MCP optimization
interface InboxMessageMetadata {
  frontmatter: MessageFrontmatter;
  filename: string;
  filePath: string;
}

interface SendMessageParams {
  to: string;
  type: 'task' | 'question' | 'done' | 'blocked';
  content: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  ref?: string;
  model?: 'haiku' | 'sonnet' | 'opus';
  // Epic-aware fields (2026-06-24)
  epic_id?: string;      // e.g., "EPIC-CUTTING-Q3"
  project_id?: string;   // e.g., "spaceos/cutting"
  task_id?: string;      // e.g., "TASK-001"
  queue_only?: boolean;  // If true, add to queue instead of dispatching immediately
}

interface SubmitDoneParams {
  from: string;
  task_id: string;
  summary: string;
  files_changed: string[];
}

interface TaskStatus {
  id: string;
  title: string;
  status: 'new' | 'active' | 'archive';
  priority: 'high' | 'medium' | 'low';
  assignee?: string;
  epic?: string;
  blocked_by?: string;
  created: string;
  updated: string;
  filePath: string;
}

// ─── Constants ────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../../..');
// New terminal structure (2026-06-21) - each terminal has its own mailbox
const TERMINALS_ROOT = path.join(REPO_ROOT, 'terminals');
// Legacy mailbox root (symlink for backward compatibility)
const LEGACY_MAILBOX_ROOT = path.join(REPO_ROOT, 'docs/mailbox');
const TASKS_ROOT = path.join(REPO_ROOT, 'docs/tasks');

// Helper to get mailbox path for a terminal
function getMailboxPath(terminal: string): string {
  // Use new terminal structure
  return path.join(TERMINALS_ROOT, terminal);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Get the next message sequence number for a terminal's inbox/outbox
 */
async function getNextMessageNumber(
  terminal: string,
  box: 'inbox' | 'outbox'
): Promise<number> {
  const boxPath = path.join(getMailboxPath(terminal), box);

  try {
    const files = await fs.readdir(boxPath);
    const numbers = files
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}_(\d{3})_/))
      .map(f => {
        const match = f.match(/_(\d{3})_/);
        return match ? parseInt(match[1], 10) : 0;
      });

    return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  } catch (err) {
    // Directory doesn't exist or is empty
    return 1;
  }
}

/**
 * Generate slug from content (first heading or title)
 */
function generateSlug(content: string): string {
  // Try to extract first heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }

  // Fallback: use first few words
  const words = content
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');

  return words || 'message';
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Parse message file with frontmatter
 */
async function parseMessageFile(filePath: string): Promise<InboxMessage> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const { data, content } = matter(raw);

  return {
    frontmatter: data as MessageFrontmatter,
    content: content.trim(),
    filePath,
  };
}

// ─── API Functions ────────────────────────────────────────────────────────

/**
 * List inbox messages for a terminal
 */
export async function listInbox(
  terminal: string,
  status?: 'UNREAD' | 'READ' | 'all'
): Promise<InboxMessage[]> {
  const inboxPath = path.join(getMailboxPath(terminal), 'inbox');

  try {
    const files = await fs.readdir(inboxPath);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    const messages = await Promise.all(
      mdFiles.map(async file => {
        const filePath = path.join(inboxPath, file);
        return parseMessageFile(filePath);
      })
    );

    // Filter by status if specified
    if (status && status !== 'all') {
      return messages.filter(m => m.frontmatter.status === status);
    }

    return messages;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []; // Inbox doesn't exist
    }
    throw err;
  }
}

/**
 * List inbox metadata (lightweight, no content) - MCP optimization
 *
 * Use this for MCP list_inbox calls to reduce token usage:
 * - 63 messages with content: ~11k tokens
 * - 63 messages metadata only: ~1k tokens (10× reduction)
 */
export async function listInboxMetadata(
  terminal: string,
  status?: 'UNREAD' | 'READ' | 'all'
): Promise<InboxMessageMetadata[]> {
  const inboxPath = path.join(getMailboxPath(terminal), 'inbox');

  try {
    const files = await fs.readdir(inboxPath);
    const mdFiles = files.filter(f => f.endsWith('.md')).sort().reverse(); // Latest first

    const messages = await Promise.all(
      mdFiles.map(async file => {
        const filePath = path.join(inboxPath, file);
        const raw = await fs.readFile(filePath, 'utf-8');
        const { data } = matter(raw); // Parse frontmatter ONLY, skip content

        return {
          frontmatter: data as MessageFrontmatter,
          filename: file,
          filePath,
        };
      })
    );

    // Filter by status if specified
    if (status && status !== 'all') {
      return messages.filter(m => m.frontmatter.status === status);
    }

    return messages;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []; // Inbox doesn't exist
    }
    throw err;
  }
}

/**
 * Create a task for a terminal
 *
 * This is the PRIMARY way to create inbox tasks:
 * - Structured task format with title, description, acceptance criteria
 * - Tracks sender (from) terminal
 * - Generates content hash for integrity
 * - Supports epic/project linking
 */
export async function createTask(params: {
  from: string;           // Sender terminal (e.g., "root", "conductor")
  to: string;             // Target terminal
  title: string;          // Short task title
  description: string;    // Task description (markdown)
  acceptance_criteria?: string[];  // What defines "done"
  priority: 'critical' | 'high' | 'medium' | 'low';
  model?: 'haiku' | 'sonnet' | 'opus';
  ref?: string;           // Reference to related message
  epic_id?: string;       // Epic ID (e.g., "EPIC-CUTTING-Q3")
  project_id?: string;    // Project ID
  context?: string;       // Additional context
  queue_only?: boolean;   // Add to queue instead of immediate dispatch
}): Promise<{
  success: boolean;
  id?: string;
  path?: string;
  queued?: boolean;
  error?: string;
}> {
  const {
    from, to, title, description, acceptance_criteria,
    priority, model, ref, epic_id, project_id, context, queue_only
  } = params;

  try {
    // Ensure inbox directory exists
    const inboxPath = path.join(getMailboxPath(to), 'inbox');
    await fs.mkdir(inboxPath, { recursive: true });

    // Get next message number
    const num = await getNextMessageNumber(to, 'inbox');
    const msgId = `MSG-${to.toUpperCase()}-${num.toString().padStart(3, '0')}`;

    // Generate slug from title
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);

    // Create filename
    const date = formatDate();
    const filename = `${date}_${num.toString().padStart(3, '0')}_${slug}.md`;
    const filePath = path.join(inboxPath, filename);

    // Generate content hash
    const crypto = await import('crypto');
    const contentHash = crypto.createHash('sha256').update(title + description).digest('hex');

    // Build frontmatter
    const frontmatterFields: [string, string | undefined][] = [
      ['id', msgId],
      ['from', from],
      ['to', to],
      ['type', 'task'],
      ['priority', priority],
      ['status', 'UNREAD'],
      ['model', model],
      ['ref', ref],
      ['epic_id', epic_id],
      ['project_id', project_id],
      ['created', date],
      ['content_hash', contentHash],
    ];

    const frontmatterYaml = frontmatterFields
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    // Build task body
    let body = `# ${title}\n\n`;
    body += description;

    if (acceptance_criteria && acceptance_criteria.length > 0) {
      body += '\n\n## Acceptance Criteria\n\n';
      body += acceptance_criteria.map(c => `- [ ] ${c}`).join('\n');
    }

    if (context) {
      body += `\n\n## Context\n\n${context}`;
    }

    const fileContent = `---\n${frontmatterYaml}\n---\n\n${body}\n`;
    await fs.writeFile(filePath, fileContent, 'utf-8');

    // If queue_only, add to epic router queue instead of immediate dispatch
    if (queue_only) {
      try {
        const { queueTask } = await import('./pipeline/epicRouter');
        queueTask(msgId, to, epic_id || null, project_id || null, priority);
        return { success: true, id: msgId, path: filePath, queued: true };
      } catch (err) {
        console.warn('[Mailbox] Epic router not available, task will be dispatched normally');
      }
    }

    return { success: true, id: msgId, path: filePath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Send a message to a terminal's inbox (LEGACY - use createTask for tasks)
 *
 * If queue_only is true, the message is added to the epic-aware queue
 * and will be dispatched when the terminal is idle and in the right epic context.
 */
export async function sendMessage(
  params: SendMessageParams
): Promise<{ id: string; path: string; queued?: boolean }> {
  const { to, type, content, priority, ref, model, epic_id, project_id, task_id, queue_only } = params;

  // Ensure inbox directory exists
  const inboxPath = path.join(getMailboxPath(to), 'inbox');
  await fs.mkdir(inboxPath, { recursive: true });

  // Get next message number
  const num = await getNextMessageNumber(to, 'inbox');
  const msgId = `MSG-${to.toUpperCase()}-${num.toString().padStart(3, '0')}`;

  // Generate slug
  const slug = generateSlug(content);

  // Create filename
  const date = formatDate();
  const filename = `${date}_${num.toString().padStart(3, '0')}_${slug}.md`;
  const filePath = path.join(inboxPath, filename);

  // Build frontmatter
  const frontmatter: Partial<MessageFrontmatter> = {
    id: msgId,
    from: 'mcp-server', // or get from context
    to,
    type,
    priority,
    status: 'UNREAD',
    created: date,
  };

  if (ref) frontmatter.ref = ref;
  if (model) frontmatter.model = model;
  if (epic_id) frontmatter.epic_id = epic_id;
  if (project_id) frontmatter.project_id = project_id;
  if (task_id) frontmatter.task_id = task_id;

  // Write file
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const fileContent = `---\n${yaml}\n---\n\n${content}\n`;

  await fs.writeFile(filePath, fileContent, 'utf-8');

  // If queue_only, add to epic router queue instead of immediate dispatch
  if (queue_only && type === 'task') {
    try {
      const { queueTask } = await import('./pipeline/epicRouter');
      queueTask(msgId, to, epic_id || null, project_id || null, priority);
      return { id: msgId, path: filePath, queued: true };
    } catch (err) {
      // Epic router not available, fall back to normal dispatch
      console.warn('[Mailbox] Epic router not available, task will be dispatched normally');
    }
  }

  return { id: msgId, path: filePath };
}

/**
 * Submit a DONE outbox message
 */
export async function submitDone(
  params: SubmitDoneParams
): Promise<{ id: string; path: string }> {
  const { from, task_id, summary, files_changed } = params;

  // Ensure outbox directory exists
  const outboxPath = path.join(getMailboxPath(from), 'outbox');
  await fs.mkdir(outboxPath, { recursive: true });

  // Get next message number
  const num = await getNextMessageNumber(from, 'outbox');
  const msgId = `MSG-${from.toUpperCase()}-${num.toString().padStart(3, '0')}-DONE`;

  // Generate slug
  const slug = generateSlug(summary);

  // Create filename
  const date = formatDate();
  const filename = `${date}_${num.toString().padStart(3, '0')}_${slug}.md`;
  const filePath = path.join(outboxPath, filename);

  // Build frontmatter
  const frontmatter = {
    id: msgId,
    from,
    to: 'root',
    type: 'done',
    priority: 'high',
    status: 'UNREAD',
    ref: task_id,
    created: date,
    completed: date,
  };

  // Build content
  const filesSection = files_changed
    .map(f => `- ${f}`)
    .join('\n');

  const content = `# ${task_id} — DONE

## Summary

${summary}

## Files Changed

${filesSection}

---

**Timestamp:** ${new Date().toISOString()}
`;

  // Write file
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const fileContent = `---\n${yaml}\n---\n\n${content}`;

  await fs.writeFile(filePath, fileContent, 'utf-8');

  return { id: msgId, path: filePath };
}

/**
 * List outbox messages for a terminal
 */
export async function listOutbox(
  terminal: string,
  status?: 'UNREAD' | 'READ' | 'all'
): Promise<InboxMessage[]> {
  const outboxPath = path.join(getMailboxPath(terminal), 'outbox');

  try {
    const files = await fs.readdir(outboxPath);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    const messages = await Promise.all(
      mdFiles.map(async file => {
        const filePath = path.join(outboxPath, file);
        return parseMessageFile(filePath);
      })
    );

    // Filter by status if specified
    if (status && status !== 'all') {
      return messages.filter(m => m.frontmatter.status === status);
    }

    return messages;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []; // Outbox doesn't exist
    }
    throw err;
  }
}

/**
 * List all UNREAD outbox messages across all terminals
 * This is the Conductor's HIGH priority request
 */
export async function listAllUnreadOutbox(): Promise<{
  terminal: string;
  messages: InboxMessage[];
}[]> {
  // Get all terminal directories
  const terminals = await fs.readdir(TERMINALS_ROOT);
  const results: { terminal: string; messages: InboxMessage[] }[] = [];

  for (const terminal of terminals) {
    const terminalPath = path.join(TERMINALS_ROOT, terminal);

    try {
      const stat = await fs.stat(terminalPath);
      if (!stat.isDirectory()) continue;

      // Check if this is a valid terminal (has inbox or outbox)
      const outboxPath = path.join(terminalPath, 'outbox');
      try {
        await fs.access(outboxPath);
      } catch {
        continue; // No outbox, skip
      }

      const messages = await listOutbox(terminal, 'UNREAD');
      if (messages.length > 0) {
        results.push({ terminal, messages });
      }
    } catch {
      // Skip invalid terminals
    }
  }

  return results;
}

/**
 * Get inbox message counter across all terminals
 * Returns count per terminal: {"frontend": 0, "backend": 1, ...}
 */
export async function getInboxMessageCounter(): Promise<Record<string, { unread: number; total: number }>> {
  const terminals = await fs.readdir(TERMINALS_ROOT);
  const result: Record<string, { unread: number; total: number }> = {};

  for (const terminal of terminals) {
    const terminalPath = path.join(TERMINALS_ROOT, terminal);

    try {
      const stat = await fs.stat(terminalPath);
      if (!stat.isDirectory()) continue;

      const inboxPath = path.join(terminalPath, 'inbox');
      try {
        const files = await fs.readdir(inboxPath);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        let unread = 0;
        for (const file of mdFiles) {
          const content = await fs.readFile(path.join(inboxPath, file), 'utf-8');
          if (content.includes('status: UNREAD')) unread++;
        }

        result[terminal] = { unread, total: mdFiles.length };
      } catch {
        result[terminal] = { unread: 0, total: 0 };
      }
    } catch {
      // Skip invalid terminals
    }
  }

  return result;
}

/**
 * Mark a message as READ
 * Used for automatic READ marking when terminal processes inbox
 */
export async function markAsRead(
  terminal: string,
  messageId: string,
  box: 'inbox' | 'outbox' = 'inbox'
): Promise<boolean> {
  const boxPath = path.join(getMailboxPath(terminal), box);

  try {
    const files = await fs.readdir(boxPath);

    for (const file of files.filter(f => f.endsWith('.md'))) {
      const filePath = path.join(boxPath, file);
      const content = await fs.readFile(filePath, 'utf-8');

      // Check if this is the message we're looking for
      if (content.includes(`id: ${messageId}`) && content.includes('status: UNREAD')) {
        const newContent = content.replace('status: UNREAD', 'status: READ');
        await fs.writeFile(filePath, newContent, 'utf-8');
        return true;
      }
    }

    return false; // Message not found or already READ
  } catch {
    return false;
  }
}

// ─── New MCP Tools (2026-06-24) ─────────────────────────────────────────────

/**
 * Read a specific inbox message by ID
 * Returns full content including frontmatter
 */
export async function readInboxMessage(
  terminal: string,
  messageId: string
): Promise<{ success: boolean; message?: InboxMessage; error?: string }> {
  const inboxPath = path.join(getMailboxPath(terminal), 'inbox');

  try {
    const files = await fs.readdir(inboxPath);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    for (const file of mdFiles) {
      const filePath = path.join(inboxPath, file);
      const raw = await fs.readFile(filePath, 'utf-8');

      // Check if this is the message we're looking for
      if (raw.includes(`id: ${messageId}`)) {
        const { data, content } = matter(raw);

        // Mark as READ if UNREAD
        if (data.status === 'UNREAD') {
          const newRaw = raw.replace('status: UNREAD', 'status: READ');
          // Add processed timestamp
          const processedRaw = newRaw.includes('processed:')
            ? newRaw
            : newRaw.replace(/^---\n/, `---\nprocessed: ${formatDate()}\n`).replace(/\nprocessed: .*\n/, `\nprocessed: ${formatDate()}\n`);
          await fs.writeFile(filePath, processedRaw.includes('processed:') ? processedRaw : newRaw.replace(/---\n/, `---\nprocessed: ${formatDate()}\n`), 'utf-8');
          data.status = 'READ';
        }

        return {
          success: true,
          message: {
            frontmatter: data as MessageFrontmatter,
            content: content.trim(),
            filePath,
          },
        };
      }
    }

    return { success: false, error: `Message ${messageId} not found in ${terminal}/inbox` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Complete an inbox message with DONE/BLOCKED response
 *
 * This is the PRIMARY way for terminals to respond to tasks:
 * 1. Appends the response to the ORIGINAL inbox message (living document)
 * 2. Creates a summary outbox message for tracking
 * 3. Updates inbox status to COMPLETED/BLOCKED
 *
 * Terminal sends ONLY the response content - server handles all file operations
 */
export async function completeInboxMessage(params: {
  terminal: string;
  message_id: string;       // Original inbox message ID
  status: 'done' | 'blocked';
  summary: string;          // Short summary of what was done
  details?: string;         // Detailed implementation notes (optional)
  files_changed?: string[]; // List of changed files
  blocked_reason?: string;  // If blocked, why
  next_steps?: string;      // Suggested next steps
}): Promise<{
  success: boolean;
  inbox_updated?: string;   // Path to updated inbox file
  outbox_created?: string;  // Path to new outbox file
  outbox_id?: string;
  error?: string
}> {
  const { terminal, message_id, status, summary, details, files_changed, blocked_reason, next_steps } = params;

  try {
    // 1. Find and update the original inbox message
    const inboxPath = path.join(getMailboxPath(terminal), 'inbox');
    const files = await fs.readdir(inboxPath);
    let inboxFilePath: string | null = null;
    let inboxRaw: string | null = null;

    for (const file of files.filter(f => f.endsWith('.md'))) {
      const filePath = path.join(inboxPath, file);
      const raw = await fs.readFile(filePath, 'utf-8');
      if (raw.includes(`id: ${message_id}`)) {
        inboxFilePath = filePath;
        inboxRaw = raw;
        break;
      }
    }

    if (!inboxFilePath || !inboxRaw) {
      return { success: false, error: `Message ${message_id} not found in ${terminal}/inbox` };
    }

    // 2. Append completion details to inbox message
    const timestamp = new Date().toISOString();
    const date = formatDate();

    let appendContent = `\n\n---\n\n## ${status === 'done' ? 'Completion' : 'Blocked'} Report\n`;
    appendContent += `*${timestamp}*\n\n`;
    appendContent += `### Summary\n${summary}\n`;

    if (details) {
      appendContent += `\n### Implementation Details\n${details}\n`;
    }

    if (files_changed && files_changed.length > 0) {
      appendContent += `\n### Files Changed\n`;
      appendContent += files_changed.map(f => `- \`${f}\``).join('\n') + '\n';
    }

    if (blocked_reason) {
      appendContent += `\n### Blocked Reason\n${blocked_reason}\n`;
    }

    if (next_steps) {
      appendContent += `\n### Next Steps\n${next_steps}\n`;
    }

    // Update inbox frontmatter status
    let updatedInbox = inboxRaw
      .replace(/status: (UNREAD|READ)/, `status: ${status === 'done' ? 'COMPLETED' : 'BLOCKED'}`)
      .replace(/---\n/, `---\ncompleted: ${date}\n`);

    // Remove duplicate completed field if exists
    const completedMatches = updatedInbox.match(/completed: .*/g);
    if (completedMatches && completedMatches.length > 1) {
      updatedInbox = updatedInbox.replace(/completed: .*\n/, '');
      updatedInbox = updatedInbox.replace(/---\n/, `---\ncompleted: ${date}\n`);
    }

    updatedInbox = updatedInbox.trimEnd() + appendContent + '\n';
    await fs.writeFile(inboxFilePath, updatedInbox, 'utf-8');

    // 3. Create summary outbox message
    const outboxPath = path.join(getMailboxPath(terminal), 'outbox');
    await fs.mkdir(outboxPath, { recursive: true });

    const num = await getNextMessageNumber(terminal, 'outbox');
    const outboxId = `MSG-${terminal.toUpperCase()}-${num.toString().padStart(3, '0')}`;

    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);

    const outboxFilename = `${date}_${num.toString().padStart(3, '0')}_${slug}-${status}.md`;
    const outboxFilePath = path.join(outboxPath, outboxFilename);

    // Generate content hash
    const crypto = await import('crypto');
    const contentHash = crypto.createHash('sha256').update(summary + (details || '')).digest('hex');

    const outboxFrontmatter = [
      `id: ${outboxId}`,
      `from: ${terminal}`,
      `to: root`,
      `type: ${status}`,
      `priority: ${status === 'blocked' ? 'high' : 'medium'}`,
      `status: UNREAD`,
      `ref: ${message_id}`,
      `created: ${date}`,
      `content_hash: ${contentHash}`,
    ].join('\n');

    let outboxBody = `# ${status.toUpperCase()}: ${summary}\n\n`;
    outboxBody += `**Original Task:** ${message_id}\n\n`;

    if (details) {
      outboxBody += `## Details\n${details}\n\n`;
    }

    if (files_changed && files_changed.length > 0) {
      outboxBody += `## Files Changed\n`;
      outboxBody += files_changed.map(f => `- \`${f}\``).join('\n') + '\n\n';
    }

    if (blocked_reason) {
      outboxBody += `## Blocked Reason\n${blocked_reason}\n\n`;
    }

    if (next_steps) {
      outboxBody += `## Next Steps\n${next_steps}\n`;
    }

    const outboxContent = `---\n${outboxFrontmatter}\n---\n\n${outboxBody}`;
    await fs.writeFile(outboxFilePath, outboxContent, 'utf-8');

    return {
      success: true,
      inbox_updated: inboxFilePath,
      outbox_created: outboxFilePath,
      outbox_id: outboxId,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Append feedback/notes/implementation details to an existing message
 * This allows the task file to become a "living document" showing the full lifecycle
 */
export async function appendToMessage(params: {
  terminal: string;
  messageId: string;
  box: 'inbox' | 'outbox';
  section: 'notes' | 'implementation' | 'feedback' | 'blockers' | 'progress';
  content: string;
  author?: string;
}): Promise<{ success: boolean; path?: string; error?: string }> {
  const { terminal, messageId, box, section, content, author } = params;
  const boxPath = path.join(getMailboxPath(terminal), box);

  try {
    const files = await fs.readdir(boxPath);

    for (const file of files.filter(f => f.endsWith('.md'))) {
      const filePath = path.join(boxPath, file);
      const raw = await fs.readFile(filePath, 'utf-8');

      if (raw.includes(`id: ${messageId}`)) {
        // Format the new section
        const timestamp = new Date().toISOString();
        const authorLine = author ? ` (by ${author})` : '';
        const sectionHeader = `\n\n---\n\n## ${section.charAt(0).toUpperCase() + section.slice(1)}${authorLine}\n*Added: ${timestamp}*\n\n`;

        const appendContent = sectionHeader + content;
        const newRaw = raw.trimEnd() + appendContent + '\n';

        await fs.writeFile(filePath, newRaw, 'utf-8');
        return { success: true, path: filePath };
      }
    }

    return { success: false, error: `Message ${messageId} not found in ${terminal}/${box}` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get task status from docs/tasks/
 */
export async function getTaskStatus(
  task_id?: string
): Promise<TaskStatus[]> {
  const statuses: ('new' | 'active' | 'archive')[] = ['new', 'active', 'archive'];
  const tasks: TaskStatus[] = [];

  for (const status of statuses) {
    const tasksPath = path.join(TASKS_ROOT, status);

    try {
      const files = await fs.readdir(tasksPath, { recursive: true });
      const mdFiles = files.filter(f => typeof f === 'string' && f.endsWith('.md'));

      for (const file of mdFiles) {
        const filePath = path.join(tasksPath, file as string);
        const raw = await fs.readFile(filePath, 'utf-8');
        const { data } = matter(raw);

        const task: TaskStatus = {
          id: data.id || 'unknown',
          title: data.title || 'Untitled',
          status,
          priority: data.priority || 'medium',
          assignee: data.assignee,
          epic: data.epic,
          blocked_by: data.blocked_by,
          created: data.created || 'unknown',
          updated: data.updated || data.created || 'unknown',
          filePath,
        };

        // Filter by task_id if specified
        if (!task_id || task.id === task_id) {
          tasks.push(task);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // Directory doesn't exist, skip
    }
  }

  return tasks;
}
