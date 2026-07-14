/**
 * workSessionLog.ts - Immutable append-only work session request/spawn log
 *
 * ADR-049 Phase 2: Tracks all work session requests and spawns for audit trail
 */
import { promises as fs } from 'fs';
import * as path from 'path';

// Use environment variable for testability
const getSpaceOSRoot = () => process.env.SPACEOS_ROOT || '/opt/spaceos';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkSessionRequest {
  timestamp: string;
  request_id: string;
  type: 'request' | 'spawn';
  from_terminal: string;
  to_terminal?: string;           // Only for spawn
  task_summary: string;
  task_hash: string;              // SHA-256 of full task
  priority: 'critical' | 'high' | 'medium' | 'low';
  suggested_terminal?: string;    // Only for request
  conductor_inbox_file?: string;  // Only for request
  model?: string;                 // Only for spawn
  session_name?: string;          // Only for spawn
  success: boolean;
  error?: string;
}

export interface WorkSessionSpawn {
  timestamp: string;
  spawn_id: string;
  request_id?: string;            // Link to original request if any
  terminal: string;
  session_name: string;
  model: string;
  task_summary: string;
  task_hash: string;
  spawned_by: string;             // 'conductor' | 'root'
  success: boolean;
  error?: string;
  session_pid?: number;
}

// ─── Log Paths ───────────────────────────────────────────────────────────────

const getWorkSessionLogPath = () => path.join(getSpaceOSRoot(), 'logs/work-sessions/requests.jsonl');
const getWorkSpawnLogPath = () => path.join(getSpaceOSRoot(), 'logs/work-sessions/spawns.jsonl');

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Generate SHA-256 hash of task content
 */
export async function hashTask(task: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(task).digest('hex').slice(0, 16);
}

/**
 * Generate unique request ID
 */
export function generateRequestId(): string {
  const date = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `WORK-REQ-${date}-${timestamp}-${random}`;
}

/**
 * Generate unique spawn ID
 */
export function generateSpawnId(): string {
  const date = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `WORK-SPAWN-${date}-${timestamp}-${random}`;
}

// ─── Logging Functions ───────────────────────────────────────────────────────

/**
 * Append work session request to immutable log
 */
export async function logWorkSessionRequest(entry: Omit<WorkSessionRequest, 'request_id' | 'timestamp' | 'type'>): Promise<WorkSessionRequest> {
  const logPath = getWorkSessionLogPath();
  const logDir = path.dirname(logPath);
  await fs.mkdir(logDir, { recursive: true });

  const fullEntry: WorkSessionRequest = {
    ...entry,
    timestamp: new Date().toISOString(),
    request_id: generateRequestId(),
    type: 'request',
  };

  const line = JSON.stringify(fullEntry) + '\n';
  await fs.appendFile(logPath, line, 'utf-8');

  console.log(`[WorkSessionLog] Request logged: ${fullEntry.request_id} from ${fullEntry.from_terminal}`);
  return fullEntry;
}

/**
 * Append work session spawn to immutable log
 */
export async function logWorkSessionSpawn(entry: Omit<WorkSessionSpawn, 'spawn_id' | 'timestamp'>): Promise<WorkSessionSpawn> {
  const logPath = getWorkSpawnLogPath();
  const logDir = path.dirname(logPath);
  await fs.mkdir(logDir, { recursive: true });

  const fullEntry: WorkSessionSpawn = {
    ...entry,
    timestamp: new Date().toISOString(),
    spawn_id: generateSpawnId(),
  };

  const line = JSON.stringify(fullEntry) + '\n';
  await fs.appendFile(logPath, line, 'utf-8');

  console.log(`[WorkSessionLog] Spawn logged: ${fullEntry.spawn_id} for ${fullEntry.terminal} (${fullEntry.model})`);
  return fullEntry;
}

// ─── Query Functions ─────────────────────────────────────────────────────────

/**
 * Query work session requests
 */
export async function queryWorkRequests(query?: {
  from_terminal?: string;
  request_id?: string;
  since?: Date;
}): Promise<WorkSessionRequest[]> {
  try {
    const content = await fs.readFile(getWorkSessionLogPath(), 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);

    const entries: WorkSessionRequest[] = lines.map(line => JSON.parse(line));

    return entries.filter(e => {
      if (query?.from_terminal && e.from_terminal !== query.from_terminal) return false;
      if (query?.request_id && e.request_id !== query.request_id) return false;
      if (query?.since && new Date(e.timestamp) < query.since) return false;
      return true;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Query work session spawns
 */
export async function queryWorkSpawns(query?: {
  terminal?: string;
  spawn_id?: string;
  request_id?: string;
  spawned_by?: string;
  since?: Date;
}): Promise<WorkSessionSpawn[]> {
  try {
    const content = await fs.readFile(getWorkSpawnLogPath(), 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);

    const entries: WorkSessionSpawn[] = lines.map(line => JSON.parse(line));

    return entries.filter(e => {
      if (query?.terminal && e.terminal !== query.terminal) return false;
      if (query?.spawn_id && e.spawn_id !== query.spawn_id) return false;
      if (query?.request_id && e.request_id !== query.request_id) return false;
      if (query?.spawned_by && e.spawned_by !== query.spawned_by) return false;
      if (query?.since && new Date(e.timestamp) < query.since) return false;
      return true;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Get statistics for work sessions
 */
export async function getWorkSessionStats(since?: Date): Promise<{
  total_requests: number;
  total_spawns: number;
  by_terminal: Record<string, { requests: number; spawns: number }>;
  success_rate: number;
}> {
  const requests = await queryWorkRequests(since ? { since } : undefined);
  const spawns = await queryWorkSpawns(since ? { since } : undefined);

  const byTerminal: Record<string, { requests: number; spawns: number }> = {};

  for (const req of requests) {
    if (!byTerminal[req.from_terminal]) {
      byTerminal[req.from_terminal] = { requests: 0, spawns: 0 };
    }
    byTerminal[req.from_terminal].requests++;
  }

  for (const spawn of spawns) {
    if (!byTerminal[spawn.terminal]) {
      byTerminal[spawn.terminal] = { requests: 0, spawns: 0 };
    }
    byTerminal[spawn.terminal].spawns++;
  }

  const totalOps = requests.length + spawns.length;
  const successfulOps = requests.filter(r => r.success).length + spawns.filter(s => s.success).length;

  return {
    total_requests: requests.length,
    total_spawns: spawns.length,
    by_terminal: byTerminal,
    success_rate: totalOps > 0 ? successfulOps / totalOps : 1,
  };
}
