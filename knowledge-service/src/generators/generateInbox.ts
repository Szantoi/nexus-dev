/**
 * Inbox Message Template Generator (Track B)
 *
 * Generates inbox messages for terminals based on task definitions.
 * Used by projectDispatcher for auto-dispatch.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { toSlug } from './utils/casing';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TERMINALS_DIR = process.env.TERMINALS_PATH || `${SPACEOS_ROOT}/terminals`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GenerateInboxParams {
  terminal: string;         // backend, frontend, architect
  project: string;          // supplier-complaint
  task: Task;
  ref?: string;             // MSG-BACKEND-003 (previous task)
}

export interface Task {
  id: string;               // T1, T2, T3
  name: string;             // "Implement Domain Layer"
  description?: string;
  terminal: string;
  model?: string;           // sonnet, opus, haiku
  priority?: string;        // low, medium, high, critical
  auto_generate?: boolean;
  generator?: string;
  generator_params?: Record<string, any>;
}

export interface GenerateInboxResult {
  success: boolean;
  filePath: string;
  msgId: string;
  error?: string;
}

// ─── Main Generator Function ────────────────────────────────────────────────

/**
 * Generate inbox message for a task
 */
export async function generateInbox(params: GenerateInboxParams): Promise<GenerateInboxResult> {
  const { terminal, project, task, ref } = params;

  try {
    const date = new Date().toISOString().split('T')[0];
    const msgNum = await getNextMsgNumber(terminal);
    const slug = toSlug(task.name);

    const fileName = `${date}_${msgNum.toString().padStart(3, '0')}_${slug}.md`;
    const filePath = `${TERMINALS_DIR}/${terminal}/inbox/${fileName}`;

    const msgId = `MSG-${terminal.toUpperCase()}-${msgNum.toString().padStart(3, '0')}`;

    const content = generateInboxContent({
      msgId,
      terminal,
      project,
      task,
      ref,
      date,
    });

    // Ensure inbox directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write inbox file
    await fs.writeFile(filePath, content, 'utf-8');

    console.log(`[GenerateInbox] Created ${msgId} at ${filePath}`);

    return {
      success: true,
      filePath,
      msgId,
    };
  } catch (error) {
    console.error('[GenerateInbox] Error:', error);
    return {
      success: false,
      filePath: '',
      msgId: '',
      error: String(error),
    };
  }
}

// ─── Template Generation ────────────────────────────────────────────────────

interface InboxContentParams {
  msgId: string;
  terminal: string;
  project: string;
  task: Task;
  ref?: string;
  date: string;
}

function generateInboxContent(params: InboxContentParams): string {
  const { msgId, terminal, project, task, ref, date } = params;

  return `---
id: ${msgId}
from: conductor
to: ${terminal}
type: task
priority: ${task.priority || 'medium'}
status: UNREAD
model: ${task.model || 'sonnet'}
ref: ${ref || ''}
project: ${project}
task_id: ${task.id}
created: ${date}
---

# ${task.name}

## Feladat

**Projekt:** ${project}
**Prioritás:** ${(task.priority || 'medium').toUpperCase()}

### Kontextus

${task.description || 'Lásd a projekt specifikációt.'}

${task.auto_generate ? `
> ⚙️ **Automatikusan generált skeleton fájlok:**
> Generator: \`${task.generator}\`
> A fájlok már létrejöttek, ellenőrizd és egészítsd ki.
` : ''}

### Teendők

1. Olvasd el a projekt specifikációt: \`docs/projects/${project}/PLAN.md\`
2. Implementáld a feladatot
3. Futtasd a teszteket
4. Készíts DONE outbox üzenetet

### Definition of Done

- [ ] Kód implementálva
- [ ] Tesztek zöldek
- [ ] Nincs lint warning
- [ ] DONE outbox üzenet elküldve

### Referenciák

- Projekt spec: \`docs/projects/${project}/PLAN.md\`
- TASKS.yaml: \`docs/projects/${project}/TASKS.yaml\`
${ref ? `- Előző task: \`${ref}\`` : ''}
`;
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Get next message number for terminal
 */
async function getNextMsgNumber(terminal: string): Promise<number> {
  const inboxDir = `${TERMINALS_DIR}/${terminal}/inbox`;

  try {
    const files = await fs.readdir(inboxDir);
    const numbers = files
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const match = f.match(/^\d{4}-\d{2}-\d{2}_(\d{3})_/);
        return match ? parseInt(match[1], 10) : 0;
      });

    return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  } catch {
    return 1;
  }
}

/**
 * Generate inbox message ID from file path
 */
export function extractMsgIdFromPath(filePath: string): string {
  const fileName = path.basename(filePath);
  const match = fileName.match(/^\d{4}-\d{2}-\d{2}_(\d{3})_/);
  const num = match ? match[1] : '001';
  const terminal = path.basename(path.dirname(path.dirname(filePath)));
  return `MSG-${terminal.toUpperCase()}-${num}`;
}

/**
 * Bulk generate inbox messages for multiple tasks
 */
export async function generateInboxBulk(
  params: GenerateInboxParams[]
): Promise<GenerateInboxResult[]> {
  const results: GenerateInboxResult[] = [];

  for (const param of params) {
    const result = await generateInbox(param);
    results.push(result);
  }

  return results;
}

/**
 * Generate inbox message template (for manual customization)
 */
export function generateInboxTemplate(params: Partial<GenerateInboxParams>): string {
  return generateInboxContent({
    msgId: 'MSG-{TERMINAL}-XXX',
    terminal: params.terminal || '{terminal}',
    project: params.project || '{project}',
    task: params.task || {
      id: '{task_id}',
      name: '{task_name}',
      description: '{task_description}',
      terminal: '{terminal}',
      model: 'sonnet',
      priority: 'medium',
    },
    ref: params.ref,
    date: new Date().toISOString().split('T')[0],
  });
}
