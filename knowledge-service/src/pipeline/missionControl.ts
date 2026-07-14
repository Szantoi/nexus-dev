/**
 * missionControl.ts — Marveen-compatible Mission Control layer for SpaceOS
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Provides a unified interface for:
 * 1. Agent fleet management (SpaceOS terminals as agents)
 * 2. Cross-platform dashboard sync (Datahaven ↔ Marveen)
 * 3. Task orchestration and delegation
 * 4. Real-time status monitoring
 *
 * Marveen runs on port 3420, SpaceOS Datahaven on 3457.
 * This module bridges the two.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { log as pipelineLog } from './common';
import { detectPaneState, PaneState, PaneStateResult } from './paneState';

const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  type: 'priority' | 'developer' | 'support';
  status: AgentStatus;
  currentTask?: string;
  lastActivity: string;
  sessionId?: string;
  paneState: PaneState;
  metrics: AgentMetrics;
}

export type AgentStatus = 'working' | 'idle' | 'error' | 'offline';

export interface AgentMetrics {
  inboxCount: number;
  outboxCount: number;
  unreadInbox: number;
  completedToday: number;
  errorCount: number;
}

export interface FleetSnapshot {
  timestamp: string;
  agents: Agent[];
  summary: FleetSummary;
}

export interface FleetSummary {
  total: number;
  working: number;
  idle: number;
  error: number;
  offline: number;
  totalInbox: number;
  totalUnread: number;
}

export interface TaskDelegation {
  id: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'pending' | 'accepted' | 'rejected' | 'completed';
  createdAt: string;
  completedAt?: string;
}

export interface MissionControlConfig {
  datehavenUrl: string;
  datehavenToken: string;
  marveenUrl?: string;
  marveenToken?: string;
  syncInterval: number;
  enableCrossSync: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TERMINALS_DIR = process.env.TERMINALS_PATH || '/opt/spaceos/terminals';
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';

// Terminal definitions matching SpaceOS 7-terminal architecture
const TERMINAL_DEFINITIONS: Array<{ id: string; name: string; type: Agent['type'] }> = [
  { id: 'root', name: 'Root', type: 'priority' },
  { id: 'conductor', name: 'Conductor', type: 'priority' },
  { id: 'backend', name: 'Backend', type: 'developer' },
  { id: 'frontend', name: 'Frontend', type: 'developer' },
  { id: 'designer', name: 'Designer', type: 'developer' },
  { id: 'architect', name: 'Architect', type: 'support' },
  { id: 'librarian', name: 'Librarian', type: 'support' },
  { id: 'explorer', name: 'Explorer', type: 'support' },
];

const DEFAULT_CONFIG: MissionControlConfig = {
  datehavenUrl: process.env.DATAHAVEN_URL || 'https://datahaven.joinerytech.hu',
  datehavenToken: process.env.DATAHAVEN_TOKEN || 'dev-token-spaceos-dashboard-2026',
  syncInterval: 30000, // 30 seconds
  enableCrossSync: false,
};

// ─── Agent Status Detection ──────────────────────────────────────────────────

async function countFiles(dir: string, pattern?: RegExp): Promise<number> {
  try {
    const files = await fs.readdir(dir);
    if (pattern) {
      return files.filter(f => pattern.test(f)).length;
    }
    return files.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

async function countUnread(dir: string): Promise<number> {
  try {
    const files = await fs.readdir(dir);
    let unread = 0;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        if (/status:\s*UNREAD/i.test(content)) {
          unread++;
        }
      } catch {
        // Skip unreadable files
      }
    }

    return unread;
  } catch {
    return 0;
  }
}

async function getAgentMetrics(terminalId: string): Promise<AgentMetrics> {
  const terminalDir = terminalId === 'root'
    ? SPACEOS_ROOT
    : path.join(TERMINALS_DIR, terminalId);

  const inboxDir = path.join(terminalDir, 'inbox');
  const outboxDir = path.join(terminalDir, 'outbox');

  const [inboxCount, outboxCount, unreadInbox] = await Promise.all([
    countFiles(inboxDir),
    countFiles(outboxDir),
    countUnread(inboxDir),
  ]);

  return {
    inboxCount,
    outboxCount,
    unreadInbox,
    completedToday: 0, // TODO: track from outbox timestamps
    errorCount: 0,
  };
}

async function getAgentStatus(terminalId: string): Promise<{ status: AgentStatus; currentTask?: string; paneState: PaneState }> {
  const sessionName = `spaceos-${terminalId}`;

  // Check pane state - returns PaneStateResult object
  const paneStateResult = await detectPaneState(sessionName);
  const paneState: PaneState = paneStateResult.state;

  // Map pane state to agent status
  let status: AgentStatus;
  switch (paneState) {
    case 'busy':
    case 'typing':
      status = 'working';
      break;
    case 'idle':
      status = 'idle';
      break;
    case 'error':
      status = 'error';
      break;
    default:
      status = 'offline';
  }

  // Try to get current task from Datahaven
  let currentTask: string | undefined;
  try {
    const response = await fetch(`${DEFAULT_CONFIG.datehavenUrl}/api/dashboard`, {
      headers: {
        'Authorization': `Bearer ${DEFAULT_CONFIG.datehavenToken}`,
      },
    });

    if (response.ok) {
      const data = await response.json() as { terminals?: Array<{ terminal: string; currentTask?: string; status?: string }> };
      const terminal = data.terminals?.find(t => t.terminal === terminalId);
      if (terminal) {
        currentTask = terminal.currentTask;
        // Override with Datahaven status if more accurate
        if (terminal.status === 'working') {
          status = 'working';
        }
      }
    }
  } catch {
    // Datahaven not available, use local detection
  }

  return { status, currentTask, paneState };
}

// ─── Fleet Management ────────────────────────────────────────────────────────

/**
 * Get full fleet snapshot
 */
export async function getFleetSnapshot(): Promise<FleetSnapshot> {
  const agents: Agent[] = [];

  for (const def of TERMINAL_DEFINITIONS) {
    const [metrics, statusInfo] = await Promise.all([
      getAgentMetrics(def.id),
      getAgentStatus(def.id),
    ]);

    agents.push({
      id: def.id,
      name: def.name,
      type: def.type,
      status: statusInfo.status,
      currentTask: statusInfo.currentTask,
      lastActivity: new Date().toISOString(),
      paneState: statusInfo.paneState,
      metrics,
    });
  }

  const summary: FleetSummary = {
    total: agents.length,
    working: agents.filter(a => a.status === 'working').length,
    idle: agents.filter(a => a.status === 'idle').length,
    error: agents.filter(a => a.status === 'error').length,
    offline: agents.filter(a => a.status === 'offline').length,
    totalInbox: agents.reduce((sum, a) => sum + a.metrics.inboxCount, 0),
    totalUnread: agents.reduce((sum, a) => sum + a.metrics.unreadInbox, 0),
  };

  return {
    timestamp: new Date().toISOString(),
    agents,
    summary,
  };
}

/**
 * Get single agent status
 */
export async function getAgent(agentId: string): Promise<Agent | null> {
  const def = TERMINAL_DEFINITIONS.find(d => d.id === agentId);
  if (!def) return null;

  const [metrics, statusInfo] = await Promise.all([
    getAgentMetrics(def.id),
    getAgentStatus(def.id),
  ]);

  return {
    id: def.id,
    name: def.name,
    type: def.type,
    status: statusInfo.status,
    currentTask: statusInfo.currentTask,
    lastActivity: new Date().toISOString(),
    paneState: statusInfo.paneState,
    metrics,
  };
}

/**
 * Update agent status in Datahaven
 */
export async function updateAgentStatus(
  agentId: string,
  status: AgentStatus,
  currentTask?: string
): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_CONFIG.datehavenUrl}/api/terminal/status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEFAULT_CONFIG.datehavenToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        terminal: agentId,
        status,
        currentTask,
      }),
    });

    return response.ok;
  } catch (err) {
    log('missionControl', `Failed to update agent status: ${err}`);
    return false;
  }
}

// ─── Task Delegation ─────────────────────────────────────────────────────────

const delegations: Map<string, TaskDelegation> = new Map();

/**
 * Delegate a task from one agent to another
 */
export async function delegateTask(
  fromAgent: string,
  toAgent: string,
  task: string,
  priority: TaskDelegation['priority'] = 'medium'
): Promise<TaskDelegation> {
  const delegation: TaskDelegation = {
    id: `del_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    fromAgent,
    toAgent,
    task,
    priority,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  delegations.set(delegation.id, delegation);

  // Write inbox message to target agent
  const targetDir = toAgent === 'root'
    ? path.join(SPACEOS_ROOT, 'inbox')
    : path.join(TERMINALS_DIR, toAgent, 'inbox');

  // Find next message number
  let msgNum = 1;
  try {
    const files = await fs.readdir(targetDir);
    const nums = files
      .map(f => parseInt(f.match(/_(\d{3})_/)?.[1] || '0'))
      .filter(n => !isNaN(n));
    if (nums.length > 0) {
      msgNum = Math.max(...nums) + 1;
    }
  } catch {
    await fs.mkdir(targetDir, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}_${String(msgNum).padStart(3, '0')}_delegated-task.md`;

  const content = `---
id: MSG-${toAgent.toUpperCase()}-${msgNum}
from: ${fromAgent}
to: ${toAgent}
type: task
priority: ${priority}
status: UNREAD
model: sonnet
ref: ${delegation.id}
created: ${date}
---

# Delegated Task

**From:** ${fromAgent}
**Priority:** ${priority}

## Task

${task}

---

*This task was delegated via Mission Control.*
`;

  await fs.writeFile(path.join(targetDir, filename), content);
  log('missionControl', `Delegated task from ${fromAgent} to ${toAgent}: ${delegation.id}`);

  return delegation;
}

/**
 * Get pending delegations for an agent
 */
export function getPendingDelegations(agentId: string): TaskDelegation[] {
  return Array.from(delegations.values()).filter(
    d => d.toAgent === agentId && d.status === 'pending'
  );
}

/**
 * Accept a delegation
 */
export function acceptDelegation(delegationId: string): boolean {
  const delegation = delegations.get(delegationId);
  if (!delegation || delegation.status !== 'pending') return false;

  delegation.status = 'accepted';
  return true;
}

/**
 * Complete a delegation
 */
export function completeDelegation(delegationId: string): boolean {
  const delegation = delegations.get(delegationId);
  if (!delegation) return false;

  delegation.status = 'completed';
  delegation.completedAt = new Date().toISOString();
  return true;
}

// ─── Cross-Platform Sync ─────────────────────────────────────────────────────

/**
 * Sync fleet status to Marveen Mission Control (if configured)
 */
export async function syncToMarveen(config: MissionControlConfig): Promise<boolean> {
  if (!config.enableCrossSync || !config.marveenUrl || !config.marveenToken) {
    return false;
  }

  try {
    const snapshot = await getFleetSnapshot();

    // Transform to Marveen-compatible format
    const marveenData = {
      agents: snapshot.agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        currentTask: a.currentTask,
        paneState: a.paneState,
        inboxCount: a.metrics.inboxCount,
        unreadCount: a.metrics.unreadInbox,
      })),
      timestamp: snapshot.timestamp,
    };

    const response = await fetch(`${config.marveenUrl}/api/external/sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.marveenToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(marveenData),
    });

    return response.ok;
  } catch (err) {
    log('missionControl', `Marveen sync failed: ${err}`);
    return false;
  }
}

/**
 * Fetch Marveen agent status (if configured)
 */
export async function fetchFromMarveen(config: MissionControlConfig): Promise<Agent[] | null> {
  if (!config.enableCrossSync || !config.marveenUrl || !config.marveenToken) {
    return null;
  }

  try {
    const response = await fetch(`${config.marveenUrl}/api/agents`, {
      headers: {
        'Authorization': `Bearer ${config.marveenToken}`,
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as { agents?: Array<Record<string, unknown>> };
    return (data.agents || []).map(a => ({
      id: a.id as string,
      name: a.name as string,
      type: 'support' as const,
      status: (a.status as AgentStatus) || 'offline',
      currentTask: a.currentTask as string | undefined,
      lastActivity: a.lastActivity as string || new Date().toISOString(),
      paneState: (a.paneState as PaneState) || 'unknown',
      metrics: {
        inboxCount: (a.inboxCount as number) || 0,
        outboxCount: 0,
        unreadInbox: (a.unreadCount as number) || 0,
        completedToday: 0,
        errorCount: 0,
      },
    }));
  } catch (err) {
    log('missionControl', `Marveen fetch failed: ${err}`);
    return null;
  }
}

// ─── Sync Loop ───────────────────────────────────────────────────────────────

let syncInterval: NodeJS.Timeout | null = null;

/**
 * Start the Mission Control sync loop
 */
export function startMissionControl(config: MissionControlConfig = DEFAULT_CONFIG): { stop: () => void } {
  if (syncInterval) {
    clearInterval(syncInterval);
  }

  const sync = async () => {
    try {
      const snapshot = await getFleetSnapshot();
      log('missionControl', `Fleet status: ${snapshot.summary.working} working, ${snapshot.summary.idle} idle, ${snapshot.summary.totalUnread} unread`);

      if (config.enableCrossSync) {
        await syncToMarveen(config);
      }
    } catch (err) {
      log('missionControl', `Sync error: ${err}`);
    }
  };

  // Initial sync
  sync();

  // Periodic sync
  syncInterval = setInterval(sync, config.syncInterval);

  return {
    stop: () => {
      if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
      }
    },
  };
}

// ─── Marveen-Compatible API Format ───────────────────────────────────────────

/**
 * Get fleet data in Marveen API format
 */
export async function getMarveenCompatibleSnapshot(): Promise<{
  agents: Array<{
    id: string;
    name: string;
    status: string;
    alive: boolean;
    paneState: string;
    currentTask: string | null;
    messages: { inbox: number; unread: number };
  }>;
  timestamp: string;
}> {
  const snapshot = await getFleetSnapshot();

  return {
    agents: snapshot.agents.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      alive: a.status !== 'offline',
      paneState: a.paneState,
      currentTask: a.currentTask || null,
      messages: {
        inbox: a.metrics.inboxCount,
        unread: a.metrics.unreadInbox,
      },
    })),
    timestamp: snapshot.timestamp,
  };
}

/**
 * Health check for Mission Control
 */
export async function healthCheck(): Promise<{
  healthy: boolean;
  datahaven: boolean;
  marveen: boolean;
  agentsOnline: number;
  lastSync: string;
}> {
  let datahaven = false;
  let marveen = false;

  // Check Datahaven
  try {
    const response = await fetch(`${DEFAULT_CONFIG.datehavenUrl}/health`);
    datahaven = response.ok;
  } catch {
    // Not available
  }

  // Check Marveen (if configured)
  if (DEFAULT_CONFIG.enableCrossSync && process.env.MARVEEN_URL) {
    try {
      const response = await fetch(`${process.env.MARVEEN_URL}/health`);
      marveen = response.ok;
    } catch {
      // Not available
    }
  }

  const snapshot = await getFleetSnapshot();
  const online = snapshot.agents.filter(a => a.status !== 'offline').length;

  return {
    healthy: datahaven && online > 0,
    datahaven,
    marveen,
    agentsOnline: online,
    lastSync: new Date().toISOString(),
  };
}
