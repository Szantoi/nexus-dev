// epicManager.ts - Load and manage EPICS.yaml
// ADR-053: Mode #4 Program-Awareness (2026-07-02)

import * as fs from 'fs';
import * as yaml from 'js-yaml';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const EPICS_PATH = process.env.EPICS_PATH || `${SPACEOS_ROOT}/docs/projects/EPICS.yaml`;

export interface Checkpoint {
  id: string;
  name: string;
  status: 'pending' | 'done';
  condition: string;
  trigger_to?: string[];
}

export interface Epic {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  depends_on: string[];
  parallel_with?: string[];
  target_date?: string;
  checkpoints: Checkpoint[];
}

export interface EpicsYaml {
  epics: Epic[];
}

/**
 * Load active epic from EPICS.yaml
 * Returns the first epic with status='active', or null if none found
 * @deprecated Use loadActiveEpics() for multi-epic support
 */
export function loadActiveEpic(): Epic | null {
  const epics = loadActiveEpics();
  return epics.length > 0 ? epics[0] : null;
}

/**
 * Load ALL active epics from EPICS.yaml
 * Returns array of epics with status='active'
 */
export function loadActiveEpics(): Epic[] {
  try {
    if (!fs.existsSync(EPICS_PATH)) {
      console.warn('[epicManager] EPICS.yaml not found');
      return [];
    }

    const content = fs.readFileSync(EPICS_PATH, 'utf-8');
    const data = yaml.load(content) as EpicsYaml;

    if (!data || !data.epics || !Array.isArray(data.epics)) {
      console.warn('[epicManager] Invalid EPICS.yaml structure');
      return [];
    }

    return data.epics.filter(epic => epic.status === 'active');
  } catch (error) {
    console.error('[epicManager] Failed to load active epics:', error);
    return [];
  }
}

/**
 * Get epic completion progress (percentage)
 * Based on checkpoint completion
 */
export function getEpicProgress(epic: Epic): number {
  if (!epic.checkpoints || epic.checkpoints.length === 0) {
    return 0;
  }

  const doneCount = epic.checkpoints.filter(cp => cp.status === 'done').length;
  return Math.round((doneCount / epic.checkpoints.length) * 100);
}

/**
 * Get next pending checkpoint for an epic
 */
export function getNextCheckpoint(epic: Epic): Checkpoint | null {
  if (!epic.checkpoints) {
    return null;
  }

  return epic.checkpoints.find(cp => cp.status === 'pending') || null;
}

/**
 * Mark epic as complete in EPICS.yaml
 * Updates the epic status to 'done'
 *
 * @param epicId Epic ID to complete
 * @returns true if successful, false otherwise
 */
export function completeEpic(epicId: string): boolean {
  try {
    if (!fs.existsSync(EPICS_PATH)) {
      console.error('[epicManager] EPICS.yaml not found');
      return false;
    }

    const content = fs.readFileSync(EPICS_PATH, 'utf-8');
    const data = yaml.load(content) as EpicsYaml;

    if (!data || !data.epics) {
      console.error('[epicManager] Invalid EPICS.yaml structure');
      return false;
    }

    const epic = data.epics.find(e => e.id === epicId);
    if (!epic) {
      console.error(`[epicManager] Epic ${epicId} not found`);
      return false;
    }

    // Update status
    epic.status = 'done';

    // Write back to file
    const yamlContent = yaml.dump(data, { lineWidth: -1 });
    fs.writeFileSync(EPICS_PATH, yamlContent, 'utf-8');

    console.log(`[epicManager] Epic ${epicId} marked as DONE`);
    return true;
  } catch (error) {
    console.error('[epicManager] Failed to complete epic:', error);
    return false;
  }
}

/**
 * Load all epics (for dependency checking)
 */
export function loadAllEpics(): Epic[] {
  try {
    if (!fs.existsSync(EPICS_PATH)) {
      return [];
    }

    const content = fs.readFileSync(EPICS_PATH, 'utf-8');
    const data = yaml.load(content) as EpicsYaml;

    return data?.epics || [];
  } catch (error) {
    console.error('[epicManager] Failed to load epics:', error);
    return [];
  }
}
