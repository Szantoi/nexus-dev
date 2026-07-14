// conductorBriefing.ts - Intelligent Conductor Briefing System
// ADR-053: Mode #4 Program-Awareness (2026-07-02)
//
// Generates context-aware briefings for Conductor session startup
// Eliminates cold-start problem by providing:
// - Program status (epic + checkpoints)
// - Recent activity (2h window)
// - Priority actions
// - Blocker alerts

import * as fs from 'fs/promises';
import * as path from 'path';
import { loadActiveEpic, getEpicProgress, getNextCheckpoint } from './epicManager';
import { detectOperationMode, getModeDescription } from './modeDetection';
import type { Epic, Checkpoint } from './epicManager';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TERMINALS_DIR = process.env.TERMINALS_PATH || path.join(SPACEOS_ROOT, 'terminals');
const CONDUCTOR_INBOX = path.join(TERMINALS_DIR, 'conductor', 'inbox');
const TIME_WINDOW_HOURS = 2;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutboxEntry {
  terminal: string;
  messageId: string;
  type: 'done' | 'blocked' | 'info';
  title: string;
  timestamp: Date;
  ref?: string;
}

export interface BlockerAlert {
  terminal: string;
  messageId: string;
  title: string;
  age: string; // e.g., "2h ago"
  reason?: string;
}

export interface PriorityAction {
  priority: 'critical' | 'high' | 'medium' | 'low';
  action: string;
  context: string;
}

export interface BriefingData {
  activeEpic: Epic | null;
  checkpointProgress: Checkpoint[];
  recentOutbox: OutboxEntry[];
  nextPriority: PriorityAction[];
  blockers: BlockerAlert[];
  modeContext: {
    mode: string;
    description: string;
  };
  generatedAt: Date;
}

// ─── Recent Activity Aggregation ────────────────────────────────────────────

/**
 * Scan all terminal outboxes for messages in the last N hours
 */
async function aggregateRecentOutbox(hoursBack: number = TIME_WINDOW_HOURS): Promise<OutboxEntry[]> {
  const entries: OutboxEntry[] = [];
  const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);

  const terminals = ['backend', 'frontend', 'designer', 'architect', 'librarian', 'explorer', 'root'];

  for (const terminal of terminals) {
    const outboxDir = path.join(TERMINALS_DIR, terminal, 'outbox');
    
    try {
      const files = await fs.readdir(outboxDir);
      
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filepath = path.join(outboxDir, file);
        const stat = await fs.stat(filepath);

        // Only include files modified within time window
        if (stat.mtimeMs < cutoffTime) continue;

        try {
          const content = await fs.readFile(filepath, 'utf-8');
          const idMatch = content.match(/^id:\s*(.+)$/m);
          const typeMatch = content.match(/^type:\s*(.+)$/m);
          const refMatch = content.match(/^ref:\s*(.+)$/m);

          if (idMatch && typeMatch) {
            const messageId = idMatch[1].trim();
            const type = typeMatch[1].trim() as 'done' | 'blocked' | 'info';
            
            // Extract title from first heading
            const titleMatch = content.match(/^#\s+(.+)$/m);
            const title = titleMatch ? titleMatch[1].trim() : file.replace('.md', '');

            entries.push({
              terminal,
              messageId,
              type,
              title,
              timestamp: new Date(stat.mtime),
              ref: refMatch ? refMatch[1].trim() : undefined
            });
          }
        } catch (err) {
          // Skip files that can't be read
          continue;
        }
      }
    } catch (err) {
      // Terminal outbox doesn't exist or can't be read
      continue;
    }
  }

  // Sort by timestamp (newest first)
  return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

/**
 * Identify current blockers across all terminals
 */
async function identifyBlockers(): Promise<BlockerAlert[]> {
  const blockers: BlockerAlert[] = [];
  const terminals = ['backend', 'frontend', 'designer', 'architect', 'librarian', 'explorer'];

  for (const terminal of terminals) {
    const outboxDir = path.join(TERMINALS_DIR, terminal, 'outbox');
    
    try {
      const files = await fs.readdir(outboxDir);
      
      for (const file of files) {
        if (!file.endsWith('.md') || !file.includes('blocked')) continue;

        const filepath = path.join(outboxDir, file);
        
        try {
          const content = await fs.readFile(filepath, 'utf-8');
          const statusMatch = content.match(/^status:\s*(.+)$/m);
          
          // Only include UNREAD blocked messages
          if (!statusMatch || statusMatch[1].trim().toUpperCase() !== 'UNREAD') continue;

          const idMatch = content.match(/^id:\s*(.+)$/m);
          const titleMatch = content.match(/^#\s+(.+)$/m);
          const stat = await fs.stat(filepath);

          if (idMatch) {
            const ageHours = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60));
            const ageStr = ageHours < 1 ? '<1h ago' : `${ageHours}h ago`;

            // Extract blocker reason from content
            const reasonMatch = content.match(/##\s+Blocker[\s\S]*?(?:Reason|Problem):\s*(.+?)(?:\n|$)/mi);
            const reason = reasonMatch ? reasonMatch[1].trim() : undefined;

            blockers.push({
              terminal,
              messageId: idMatch[1].trim(),
              title: titleMatch ? titleMatch[1].trim() : file.replace('.md', ''),
              age: ageStr,
              reason
            });
          }
        } catch (err) {
          continue;
        }
      }
    } catch (err) {
      continue;
    }
  }

  return blockers;
}

/**
 * Determine next priority actions based on epic checkpoints and recent activity
 */
function determineNextPriorities(
  epic: Epic | null,
  recentOutbox: OutboxEntry[],
  blockers: BlockerAlert[]
): PriorityAction[] {
  const priorities: PriorityAction[] = [];

  // Priority 1: Active blockers
  if (blockers.length > 0) {
    priorities.push({
      priority: 'critical',
      action: `Resolve ${blockers.length} BLOCKED message(s)`,
      context: `${blockers.map(b => `${b.terminal}: ${b.messageId}`).join(', ')}`
    });
  }

  // Priority 2: Next pending checkpoint
  if (epic) {
    const nextCheckpoint = getNextCheckpoint(epic);
    if (nextCheckpoint) {
      priorities.push({
        priority: 'high',
        action: `Advance checkpoint: ${nextCheckpoint.id}`,
        context: `${nextCheckpoint.name} (condition: ${nextCheckpoint.condition})`
      });
    }
  }

  // Priority 3: Recent DONE messages needing acknowledgement
  const recentDone = recentOutbox.filter(e => e.type === 'done' && e.terminal !== 'root');
  if (recentDone.length > 0) {
    priorities.push({
      priority: 'medium',
      action: `Review ${recentDone.length} completed task(s)`,
      context: recentDone.slice(0, 3).map(d => `${d.terminal}: ${d.messageId}`).join(', ')
    });
  }

  // Priority 4: Epic completion check
  if (epic && epic.checkpoints) {
    const pending = epic.checkpoints.filter(cp => cp.status === 'pending');
    if (pending.length === 0) {
      priorities.push({
        priority: 'high',
        action: `Complete epic: ${epic.id}`,
        context: 'All checkpoints done - mark epic complete'
      });
    }
  }

  return priorities;
}

// ─── Briefing Generation ────────────────────────────────────────────────────

/**
 * Generate comprehensive Conductor briefing
 */
export async function generateConductorBriefing(): Promise<BriefingData> {
  const mode = detectOperationMode();
  const activeEpic = loadActiveEpic();
  const checkpoints = activeEpic ? (activeEpic.checkpoints || []) : [];
  const recentOutbox = await aggregateRecentOutbox(TIME_WINDOW_HOURS);
  const blockers = await identifyBlockers();
  const nextPriority = determineNextPriorities(activeEpic, recentOutbox, blockers);

  return {
    activeEpic,
    checkpointProgress: checkpoints,
    recentOutbox,
    nextPriority,
    blockers,
    modeContext: {
      mode,
      description: getModeDescription(mode)
    },
    generatedAt: new Date()
  };
}

/**
 * Format briefing data as markdown
 */
export function formatBriefingMarkdown(data: BriefingData): string {
  const timestamp = data.generatedAt.toISOString().replace('T', ' ').slice(0, 19);
  
  let md = `# Conductor Briefing — ${timestamp}\n\n`;

  // Program Status Section
  md += `## 📊 Program Status (${data.modeContext.mode})\n\n`;
  
  if (data.activeEpic) {
    const progress = getEpicProgress(data.activeEpic);
    const total = data.checkpointProgress.length;
    const done = data.checkpointProgress.filter(cp => cp.status === 'done').length;
    
    md += `**Active Epic:** ${data.activeEpic.id} - ${data.activeEpic.name}\n`;
    md += `**Progress:** ${done}/${total} checkpoints (${progress}%)\n\n`;

    if (data.checkpointProgress.length > 0) {
      md += `### Checkpoint Status\n`;
      const nextPending = getNextCheckpoint(data.activeEpic);

      for (const cp of data.checkpointProgress) {
        const checkbox = cp.status === 'done' ? 'x' : ' ';
        const statusEmoji = cp.status === 'done' ? '✅' : '⏳';
        const isNext = nextPending && cp.id === nextPending.id;
        const nextMarker = isNext ? ' ← **NEXT PRIORITY**' : '';

        md += `- [${checkbox}] ${statusEmoji} ${cp.id}: ${cp.name}${nextMarker}\n`;
      }
      md += '\n';
    }
  } else {
    md += `**Status:** No active epic (manual mode)\n\n`;
  }

  // Recent Activity Section
  md += `## 🔄 Recent Activity (Last ${TIME_WINDOW_HOURS}h)\n\n`;
  
  if (data.recentOutbox.length > 0) {
    const grouped = data.recentOutbox.reduce((acc, entry) => {
      if (!acc[entry.terminal]) acc[entry.terminal] = [];
      acc[entry.terminal].push(entry);
      return acc;
    }, {} as Record<string, OutboxEntry[]>);

    for (const [terminal, entries] of Object.entries(grouped)) {
      for (const entry of entries.slice(0, 3)) { // Top 3 per terminal
        const emoji = entry.type === 'done' ? '✅' : entry.type === 'blocked' ? '🔴' : 'ℹ️';
        md += `- ${emoji} **${terminal}:** ${entry.title}\n`;
      }
    }
    md += '\n';
  } else {
    md += `_No recent activity detected_\n\n`;
  }

  // Next Priority Actions Section
  md += `## 🎯 Next Priority Actions\n\n`;
  
  if (data.nextPriority.length > 0) {
    const priorityEmoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '⚪'
    };

    for (let i = 0; i < data.nextPriority.length && i < 5; i++) {
      const p = data.nextPriority[i];
      md += `${i + 1}. ${priorityEmoji[p.priority]} **${p.priority.toUpperCase()}:** ${p.action}\n`;
      md += `   _${p.context}_\n\n`;
    }
  } else {
    md += `_No priority actions identified_\n\n`;
  }

  // Blockers Section
  md += `## ⚠️ Blockers\n\n`;
  
  if (data.blockers.length > 0) {
    for (const blocker of data.blockers) {
      md += `- **${blocker.terminal}** (${blocker.age}): ${blocker.messageId}\n`;
      if (blocker.reason) {
        md += `  _${blocker.reason}_\n`;
      }
    }
    md += '\n';
  } else {
    md += `✅ _No active blockers_\n\n`;
  }

  // Footer
  md += `---\n\n`;
  md += `📍 **Mode:** ${data.modeContext.description}\n`;
  md += `⏰ **Generated:** ${timestamp}\n`;
  md += `🤖 **Auto-generated by Intelligent Briefing System**\n`;

  return md;
}

/**
 * Write briefing to Conductor inbox
 */
export async function deliverBriefingToInbox(briefingMarkdown: string): Promise<string> {
  const date = new Date().toISOString().split('T')[0];
  
  // Get next message number
  let num = 1;
  try {
    const files = await fs.readdir(CONDUCTOR_INBOX);
    const todayFiles = files.filter(f => f.startsWith(date) && f.includes('briefing'));
    num = todayFiles.length + 1;
  } catch {
    await fs.mkdir(CONDUCTOR_INBOX, { recursive: true });
  }

  const messageId = `MSG-CONDUCTOR-BRIEFING-${String(num).padStart(3, '0')}`;
  const filename = `${date}_${String(num).padStart(3, '0')}_briefing.md`;
  const filepath = path.join(CONDUCTOR_INBOX, filename);

  const frontmatter = `---
id: ${messageId}
from: system
to: conductor
type: briefing
priority: high
status: UNREAD
created: ${date}
---

`;

  const fullContent = frontmatter + briefingMarkdown;
  await fs.writeFile(filepath, fullContent, 'utf-8');

  return messageId;
}

/**
 * Full briefing generation and delivery workflow
 */
export async function generateAndDeliverBriefing(): Promise<{ messageId: string; briefingData: BriefingData }> {
  const briefingData = await generateConductorBriefing();
  const markdown = formatBriefingMarkdown(briefingData);
  const messageId = await deliverBriefingToInbox(markdown);

  console.log(`[conductorBriefing] Generated briefing: ${messageId}`);
  
  return { messageId, briefingData };
}
