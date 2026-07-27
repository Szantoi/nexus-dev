/**
 * Integration Test: Mode #4 Program-Awareness (ADR-053)
 * Tests end-to-end workflow for Conductor operating in structured program mode
 *
 * Hermetic: modules read EPICS_PATH / SPACEOS_ROOT / TERMINALS_PATH at module
 * scope, so we point them at a temp directory BEFORE importing (vi.hoisted).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const TEST_ROOT = vi.hoisted(() => {
  const os = require('node:os');
  const path = require('node:path');
  const root = path.join(os.tmpdir(), `mode4-test-${process.pid}`);
  process.env.SPACEOS_ROOT = root;
  process.env.TERMINALS_PATH = path.join(root, 'terminals');
  process.env.EPICS_PATH = path.join(root, 'EPICS.yaml');
  delete process.env.SPACEOS_MODE;
  return root;
});

import { detectOperationMode, getModeDescription } from '../../conductor/modeDetection';
import { loadActiveEpic, getNextCheckpoint, getEpicProgress } from '../../conductor/epicManager';
import { checkCheckpointCompletion } from '../../conductor/checkpointTracker';

const EPICS_PATH = path.join(TEST_ROOT, 'EPICS.yaml');

function writeEpicsYaml(data: unknown): void {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(EPICS_PATH, yaml.dump(data), 'utf-8');
}

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('Mode #4: Structured Program Execution (Integration)', () => {
  /**
   * EPICS.yaml fixture for testing
   * Simulates a real production epic with multiple checkpoints
   */
  const mockEpicsYaml = {
    epics: [
      {
        id: 'EPIC-JOINERY-PHASE3',
        name: 'JoineryTech CRM Production',
        status: 'active',
        depends_on: [],
        parallel_with: [],
        checkpoints: [
          {
            id: 'CP-JOINERY-DOMAIN',
            name: 'CRM Domain Model Complete',
            status: 'done',
            condition: 'MSG-BACKEND-103 status=DONE',
            trigger_to: ['conductor'],
          },
          {
            id: 'CP-JOINERY-BACKEND-API',
            name: 'CRM Backend API Complete',
            status: 'pending',
            condition: 'MSG-BACKEND-105 status=DONE',
            trigger_to: ['frontend', 'conductor'],
          },
          {
            id: 'CP-JOINERY-FRONTEND',
            name: 'CRM Frontend Integration Complete',
            status: 'pending',
            condition: 'MSG-FRONTEND-065 status=DONE',
            trigger_to: ['conductor'],
          },
          {
            id: 'CP-JOINERY-TESTING',
            name: 'CRM E2E Testing Complete',
            status: 'pending',
            condition: 'MSG-BACKEND-110 status=DONE',
            trigger_to: ['conductor'],
          },
          {
            id: 'CP-JOINERY-DEPLOYMENT',
            name: 'CRM Deployed to Production',
            status: 'pending',
            condition: 'EPIC-DEPLOYMENT status=done',
            trigger_to: ['root'],
          },
        ],
        target_date: '2026-07-31',
      },
    ],
  };

  beforeEach(() => {
    writeEpicsYaml(mockEpicsYaml);
  });

  describe('Conductor Session Initialization', () => {
    it('should detect structured program mode', () => {
      const mode = detectOperationMode();
      expect(mode).toBe('structured_program');
    });

    it('should provide appropriate mode description', () => {
      const mode = detectOperationMode();
      const description = getModeDescription(mode);
      expect(description).toContain('Structured Program');
      expect(description).toContain('EPICS.yaml');
    });

    it('should load active epic for Conductor', () => {
      const epic = loadActiveEpic();

      expect(epic).toBeDefined();
      expect(epic?.id).toBe('EPIC-JOINERY-PHASE3');
      expect(epic?.name).toBe('JoineryTech CRM Production');
      expect(epic?.status).toBe('active');
      expect(epic?.checkpoints?.length).toBe(5);
    });

    it('should have complete checkpoint metadata', () => {
      const epic = loadActiveEpic();
      expect(epic?.checkpoints).toBeDefined();

      epic?.checkpoints?.forEach(cp => {
        expect(cp.id).toBeDefined();
        expect(cp.name).toBeDefined();
        expect(cp.status).toBeDefined();
        expect(cp.condition).toBeDefined();
      });
    });
  });

  describe('Checkpoint Progress Tracking', () => {
    it('should identify next pending checkpoint for Conductor', () => {
      const epic = loadActiveEpic();
      const nextCheckpoint = getNextCheckpoint(epic!);

      expect(nextCheckpoint).toBeDefined();
      expect(nextCheckpoint?.id).toBe('CP-JOINERY-BACKEND-API');
      expect(nextCheckpoint?.status).toBe('pending');
      expect(nextCheckpoint?.condition).toBe('MSG-BACKEND-105 status=DONE');
    });

    it('should calculate epic progress correctly', () => {
      const epic = loadActiveEpic();
      const progress = getEpicProgress(epic!);

      // 1 done out of 5 checkpoints = 20%
      expect(progress).toBe(20);
    });

    it('should identify completed vs pending checkpoints', () => {
      const epic = loadActiveEpic();

      const doneCount = epic?.checkpoints?.filter(cp => cp.status === 'done').length;
      const pendingCount = epic?.checkpoints?.filter(cp => cp.status === 'pending').length;

      expect(doneCount).toBe(1);
      expect(pendingCount).toBe(4);
      // Not all checkpoints complete → there is a next pending checkpoint
      expect(getNextCheckpoint(epic!)).not.toBeNull();
    });
  });

  describe('Checkpoint Condition Evaluation', () => {
    it('should evaluate MSG-based conditions', () => {
      const epic = loadActiveEpic();
      const checkpointToCheck = epic?.checkpoints?.[1]; // CP-JOINERY-BACKEND-API

      expect(checkpointToCheck?.condition).toBe('MSG-BACKEND-105 status=DONE');

      // No outbox message exists in the temp tree → not complete
      const completed = checkCheckpointCompletion(checkpointToCheck!);
      expect(completed).toBe(false);
    });

    it('should evaluate MSG-based conditions with a matching outbox message', () => {
      const epic = loadActiveEpic();
      const checkpointToCheck = epic?.checkpoints?.[1]; // CP-JOINERY-BACKEND-API

      const outboxDir = path.join(TEST_ROOT, 'terminals', 'backend', 'outbox');
      fs.mkdirSync(outboxDir, { recursive: true });
      fs.writeFileSync(
        path.join(outboxDir, '2026-07-02_105_done.md'),
        '---\nref: MSG-BACKEND-105\nstatus: DONE\n---\n\nDone.',
        'utf-8'
      );

      try {
        const completed = checkCheckpointCompletion(checkpointToCheck!);
        expect(completed).toBe(true);
      } finally {
        fs.rmSync(path.join(TEST_ROOT, 'terminals'), { recursive: true, force: true });
      }
    });

    it('should evaluate EPIC-based conditions', () => {
      const epic = loadActiveEpic();
      const deploymentCheckpoint = epic?.checkpoints?.[4]; // CP-JOINERY-DEPLOYMENT

      expect(deploymentCheckpoint?.condition).toBe('EPIC-DEPLOYMENT status=done');

      // EPICS.yaml with non-done deployment epic
      writeEpicsYaml({
        epics: [
          ...mockEpicsYaml.epics,
          {
            id: 'EPIC-DEPLOYMENT',
            name: 'Deployment',
            status: 'pending',
          },
        ],
      });

      const completed = checkCheckpointCompletion(deploymentCheckpoint!);
      expect(completed).toBe(false); // Deployment epic not done
    });

    it('should evaluate EPIC-based conditions as complete when epic is done', () => {
      const epic = loadActiveEpic();
      const deploymentCheckpoint = epic?.checkpoints?.[4]; // CP-JOINERY-DEPLOYMENT

      writeEpicsYaml({
        epics: [
          ...mockEpicsYaml.epics,
          {
            id: 'EPIC-DEPLOYMENT',
            name: 'Deployment',
            status: 'done',
          },
        ],
      });

      const completed = checkCheckpointCompletion(deploymentCheckpoint!);
      expect(completed).toBe(true);
    });
  });

  describe('Conductor Task Assignment', () => {
    it('should provide Conductor with next action', () => {
      const epic = loadActiveEpic();
      const nextCheckpoint = getNextCheckpoint(epic!);

      expect(nextCheckpoint).toBeDefined();

      // Simulate Conductor's next task
      const conductorAction = {
        checkpoint: nextCheckpoint,
        epic: epic,
        progress: getEpicProgress(epic!),
        action: `Monitor checkpoint: ${nextCheckpoint?.name}`,
        condition: nextCheckpoint?.condition,
      };

      expect(conductorAction.checkpoint?.id).toBe('CP-JOINERY-BACKEND-API');
      expect(conductorAction.condition).toBe('MSG-BACKEND-105 status=DONE');
      expect(conductorAction.progress).toBe(20);
    });

    it('should include trigger targets for notification', () => {
      const epic = loadActiveEpic();
      const nextCheckpoint = getNextCheckpoint(epic!);

      expect(nextCheckpoint?.trigger_to).toBeDefined();
      expect(nextCheckpoint?.trigger_to).toContain('frontend');
      expect(nextCheckpoint?.trigger_to).toContain('conductor');
    });
  });

  describe('Mode #4 Advantages Over Review System', () => {
    it('should operate without review system dependency', () => {
      // In Mode #4, progress is based on checkpoint conditions,
      // not on review verdicts from Architect/Librarian
      const epic = loadActiveEpic();
      expect(epic).toBeDefined();

      // No review dependencies in the checkpoint conditions
      const reviewConditions = epic?.checkpoints?.filter(cp =>
        cp.condition.includes('REVIEW')
      );
      expect(reviewConditions?.length || 0).toBe(0);
    });

    it('should track progress automatically without manual review gates', () => {
      const epic = loadActiveEpic();
      const progress1 = getEpicProgress(epic!);

      // Simulate checkpoint completion
      writeEpicsYaml({
        epics: [
          {
            ...epic!,
            checkpoints: epic?.checkpoints?.map((cp, idx) => ({
              ...cp,
              status: idx <= 1 ? 'done' : cp.status,
            })),
          },
        ],
      });

      const updatedEpic = loadActiveEpic();
      const progress2 = getEpicProgress(updatedEpic!);

      expect(progress2).toBeGreaterThan(progress1);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing EPICS.yaml gracefully', () => {
      fs.rmSync(EPICS_PATH, { force: true });

      const epic = loadActiveEpic();
      expect(epic).toBeNull();
    });

    it('should handle malformed EPICS.yaml gracefully', () => {
      fs.writeFileSync(EPICS_PATH, '{{{ not valid yaml: [', 'utf-8');

      const epic = loadActiveEpic();
      expect(epic).toBeNull();
    });

    it('should handle missing checkpoints', () => {
      writeEpicsYaml({
        epics: [
          {
            id: 'EPIC-NO-CHECKPOINTS',
            name: 'No Checkpoints',
            status: 'active',
          },
        ],
      });

      const epic = loadActiveEpic();
      expect(epic?.checkpoints || []).toHaveLength(0);

      const nextCheckpoint = getNextCheckpoint(epic!);
      expect(nextCheckpoint).toBeNull();
    });
  });

  describe('Real-World Scenario', () => {
    it('should support typical Conductor workflow in Mode #4', () => {
      /**
       * Scenario:
       * 1. Conductor starts (Mode #4 detected)
       * 2. Loads active epic (EPIC-JOINERY-PHASE3)
       * 3. Identifies next checkpoint (CP-JOINERY-BACKEND-API)
       * 4. Checks condition (MSG-BACKEND-105 status=DONE)
       * 5. Takes action based on result
       */

      // Step 1: Mode detection
      const mode = detectOperationMode();
      expect(mode).toBe('structured_program');

      // Step 2: Load epic
      const epic = loadActiveEpic();
      expect(epic?.id).toBe('EPIC-JOINERY-PHASE3');

      // Step 3: Next checkpoint
      const nextCheckpoint = getNextCheckpoint(epic!);
      expect(nextCheckpoint?.id).toBe('CP-JOINERY-BACKEND-API');

      // Step 4: Evaluate condition (no outbox message → pending)
      const completed = checkCheckpointCompletion(nextCheckpoint!);

      // Step 5: Conductor's action: checkpoint pending → wait/monitor
      expect(completed).toBe(false);
    });
  });
});
