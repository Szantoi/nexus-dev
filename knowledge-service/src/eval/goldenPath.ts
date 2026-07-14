/**
 * Golden Path Recording (agent-eval suite, Q3 roadmap brought forward).
 *
 * WHY: per the agent-testing research (AGENT_BEHAVIOR_TESTING_2026.md), the most
 * reliable way to evaluate agent behavior is to record a KNOWN-GOOD session as a
 * reference ("golden path") and score later runs against it (TrajectoryAccuracy).
 * Our substrate is the canonical task-message-box: a message's status_history IS
 * its lifecycle trajectory, recorded transition-by-transition with actor + time.
 *
 * A golden path here = the curated reference trajectory of one successfully
 * completed task: its type, terminal route, and the ordered lifecycle steps.
 * Recorded golden paths are stored as JSON files in GOLDEN_PATHS_DIR
 * (config-driven, env-overridable) so they are inspectable, diffable, and
 * version-controllable — no black box.
 */
import * as fs from 'fs';
import * as path from 'path';
import { join } from 'path';
import { DATA_DIR } from '../config/paths';
import { getMessage, getStatusHistory } from '../task-message-box/store';
import { StatusHistoryEntry } from '../task-message-box/types';

// Config-driven storage location (default under the island's DATA_DIR).
export const GOLDEN_PATHS_DIR = process.env.GOLDEN_PATHS_DIR || join(DATA_DIR, 'golden-paths');

const log = (msg: string) => console.log(`[GoldenPath] ${msg}`);

export interface GoldenPath {
  name: string;                 // stable id, e.g. "backend-implement-task"
  recorded_from: string;        // source message id (or legacy id when migrated)
  recorded_at: string;          // ISO timestamp
  type: string;                 // canonical message type
  from_terminal: string;
  to_terminal: string;
  trajectory: string[];         // ordered CANONICAL STATUS steps — what the comparator
                                // scores against a run's status_history. This is the
                                // one field that must use the canonical status vocabulary.
  history?: StatusHistoryEntry[]; // full audit entries (recorded runs); optional for migrated

  // ── Provenance + richer (optional) data ────────────────────────────────────
  source?: 'recorded' | 'migrated';   // recorded = live run; migrated = from legacy data
  sample_count?: number;              // how many legacy runs this golden summarizes
  // Finer semantic action steps (task_received, tests_run, implementation, ...) —
  // NOT the scored trajectory (runtime doesn't capture these yet). Kept for the
  // future execution-based layer.
  semantic_steps?: string[];
  // Expected outputs (e.g. "*.ts files", "tests passing", "security review") — the
  // input to execution-based verification when that layer lands.
  expected_deliverables?: string[];
}

// The canonical statuses a golden-path trajectory may contain (kept in sync with
// config/message-model.yaml; imported paths are validated against this).
const CANONICAL_TRAJECTORY_STEPS = ['unread', 'read', 'in_progress', 'completed', 'blocked', 'archived'];

function ensureDir(): void {
  fs.mkdirSync(GOLDEN_PATHS_DIR, { recursive: true });
}

function fileFor(name: string): string {
  // keep names filesystem-safe
  const safe = name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-');
  return path.join(GOLDEN_PATHS_DIR, `${safe}.json`);
}

/**
 * Record a completed message's lifecycle as a named golden path.
 * Refuses to record an empty trajectory — a golden path must demonstrate
 * an actual walked lifecycle, otherwise it can't serve as a reference.
 */
export async function recordGoldenPath(messageId: string, name: string): Promise<{ success: boolean; path?: string; golden?: GoldenPath; error?: string }> {
  const msg = await getMessage(messageId);
  if (!msg) return { success: false, error: `Message not found: ${messageId}` };

  const history = getStatusHistory(messageId);
  if (history.length === 0) {
    return { success: false, error: `Message ${messageId} has no status_history — nothing to record as a golden path` };
  }

  const golden: GoldenPath = {
    name,
    recorded_from: messageId,
    recorded_at: new Date().toISOString(),
    type: msg.type,
    from_terminal: msg.from_terminal,
    to_terminal: msg.to_terminal,
    trajectory: history.map(h => h.to),
    history,
  };

  ensureDir();
  const file = fileFor(name);
  fs.writeFileSync(file, JSON.stringify(golden, null, 2), 'utf-8');
  log(`Recorded golden path '${name}' from ${messageId} (${golden.trajectory.join(' → ')}) → ${file}`);
  return { success: true, path: file, golden };
}

/** Load a golden path by name. */
export function loadGoldenPath(name: string): GoldenPath | null {
  const file = fileFor(name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as GoldenPath; }
  catch { return null; }
}

/** List all recorded golden path names. */
export function listGoldenPaths(): string[] {
  ensureDir();
  return fs.readdirSync(GOLDEN_PATHS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

/**
 * Import golden paths produced by an external migration (e.g. the legacy-DONE
 * parser on the VPS). Validates that each carries a name, a canonical-status
 * trajectory, and (if provided) semantic_steps/deliverables. Writes each as a
 * golden path file (source='migrated'). Returns per-item results so the caller
 * sees exactly what was accepted/rejected — no silent drops.
 */
export function importGoldenPaths(items: Array<Partial<GoldenPath>>): {
  imported: string[];
  rejected: Array<{ name?: string; reason: string }>;
} {
  ensureDir();
  const imported: string[] = [];
  const rejected: Array<{ name?: string; reason: string }> = [];

  for (const item of items || []) {
    if (!item.name) { rejected.push({ reason: 'missing name' }); continue; }
    if (!Array.isArray(item.trajectory) || item.trajectory.length === 0) {
      rejected.push({ name: item.name, reason: 'missing/empty trajectory' }); continue;
    }
    const bad = item.trajectory.filter(s => !CANONICAL_TRAJECTORY_STEPS.includes(s));
    if (bad.length) {
      rejected.push({ name: item.name, reason: `non-canonical trajectory step(s): ${bad.join(', ')}` });
      continue;
    }
    const golden: GoldenPath = {
      name: item.name,
      recorded_from: item.recorded_from || '(migrated)',
      recorded_at: item.recorded_at || new Date().toISOString(),
      type: item.type || 'task',
      from_terminal: item.from_terminal || '(unknown)',
      to_terminal: item.to_terminal || '(unknown)',
      trajectory: item.trajectory,
      source: 'migrated',
      sample_count: item.sample_count,
      semantic_steps: item.semantic_steps,
      expected_deliverables: item.expected_deliverables,
    };
    fs.writeFileSync(fileFor(item.name), JSON.stringify(golden, null, 2), 'utf-8');
    imported.push(item.name);
  }
  log(`imported ${imported.length} migrated golden path(s), rejected ${rejected.length}`);
  return { imported, rejected };
}
