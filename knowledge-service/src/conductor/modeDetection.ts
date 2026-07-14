// modeDetection.ts - Detect SpaceOS operation mode
// ADR-053: Mode #4 Program-Awareness (2026-07-02)

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type OperationMode = 'manual' | 'planning_pipeline' | 'structured_program';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const EPICS_PATH = process.env.EPICS_PATH || `${SPACEOS_ROOT}/docs/projects/EPICS.yaml`;

/**
 * Detect current SpaceOS operation mode
 *
 * Mode detection logic:
 * 1. Check for SPACEOS_MODE env var (explicit override)
 * 2. Check EPICS.yaml for active epic → structured_program
 * 3. Check planning queue directory → planning_pipeline
 * 4. Default: manual
 *
 * @returns Current operation mode
 */
export function detectOperationMode(): OperationMode {
  // 1. Explicit env var override (for testing)
  const envMode = process.env.SPACEOS_MODE;
  if (envMode === 'manual' || envMode === 'planning_pipeline' || envMode === 'structured_program') {
    return envMode;
  }

  // 2. Check for active epic in EPICS.yaml
  try {
    if (fs.existsSync(EPICS_PATH)) {
      const content = fs.readFileSync(EPICS_PATH, 'utf-8');
      const data = yaml.load(content) as any;

      if (data && data.epics && Array.isArray(data.epics)) {
        const hasActiveEpic = data.epics.some((epic: any) => epic.status === 'active');
        if (hasActiveEpic) {
          return 'structured_program';
        }
      }
    }
  } catch (error) {
    console.warn('[modeDetection] Failed to read EPICS.yaml:', error);
    // Continue to next check
  }

  // 3. Check planning queue (fallback for Mode #2/#3)
  const queuePath = `${SPACEOS_ROOT}/docs/planning/queue`;
  try {
    if (fs.existsSync(queuePath)) {
      const files = fs.readdirSync(queuePath);
      if (files.length > 0) {
        return 'planning_pipeline';
      }
    }
  } catch (error) {
    console.warn('[modeDetection] Failed to check planning queue:', error);
  }

  // 4. Default: manual mode
  return 'manual';
}

/**
 * Get human-readable mode description
 */
export function getModeDescription(mode: OperationMode): string {
  switch (mode) {
    case 'structured_program':
      return 'Mode #4: Structured Program (EPICS.yaml-driven)';
    case 'planning_pipeline':
      return 'Mode #2/3: Planning Pipeline (idea → consensus)';
    case 'manual':
      return 'Mode #1: Manual (ad-hoc tasks)';
  }
}
