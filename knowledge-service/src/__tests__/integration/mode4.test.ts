/**
 * Integration Test: Mode #4 Program-Awareness (ADR-053)
 * Tests end-to-end workflow for Conductor operating in structured program mode
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  detectOperationMode,
  getModeDescription,
} from '../../conductor/modeDetection';
import {
  loadActiveEpic,
  getNextPendingCheckpoint,
  getEpicProgress,
  allCheckpointsComplete,
} from '../../conductor/epicManager';
import { checkCheckpointCompletion } from '../../conductor/checkpointTracker';

describe('Mode #4: Structured Program Execution (Integration)', () => {
  /**
   * Mock EPICS.yaml structure for testing
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
            condition: 'FILE:docs/projects/test-results.md contains:CRM E2E PASSED',
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
    // Mock EPICS.yaml existence and content
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath: string) => {
      if (filePath.includes('EPICS.yaml')) {
        return true;
      }
      return false;
    });

    vi.spyOn(fs, 'readFileSync').mockImplementation(
      (filePath: string) => {
        if (filePath.includes('EPICS.yaml')) {
          return yaml.dump(mockEpicsYaml);
        }
        throw new Error(`File not mocked: ${filePath}`);
      }
    );
  });

  describe('Conductor Session Initialization', () => {
    it('should detect structured program mode', () => {
      const mode = detectOperationMode();
      expect(mode).toBe('structured_program');
    });

    it('should provide appropriate mode description', () => {
      const mode = detectOperationMode();
      const description = getModeDescription(mode);
      expect(description).toContain('Structured program');
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
      const nextCheckpoint = getNextPendingCheckpoint(epic!);

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

      const allComplete = allCheckpointsComplete(epic!);
      expect(allComplete).toBe(false);

      const doneCount = epic?.checkpoints?.filter(cp => cp.status === 'done').length;
      const pendingCount = epic?.checkpoints?.filter(
        cp => cp.status === 'pending'
      ).length;

      expect(doneCount).toBe(1);
      expect(pendingCount).toBe(4);
    });
  });

  describe('Checkpoint Condition Evaluation', () => {
    it('should evaluate MSG-based conditions', () => {
      const epic = loadActiveEpic();
      const checkpointToCheck = epic?.checkpoints?.[1]; // CP-JOINERY-BACKEND-API

      expect(checkpointToCheck?.condition).toBe('MSG-BACKEND-105 status=DONE');

      // Mock that the message doesn't exist yet
      vi.spyOn(fs, 'readdirSync').mockReturnValue([]);

      const status = checkCheckpointCompletion(checkpointToCheck!);
      expect(status.completed).toBe(false); // Message not found
    });

    it('should evaluate EPIC-based conditions', () => {
      const epic = loadActiveEpic();
      const deploymentCheckpoint = epic?.checkpoints?.[4]; // CP-JOINERY-DEPLOYMENT

      expect(deploymentCheckpoint?.condition).toBe('EPIC-DEPLOYMENT status=done');

      // Mock EPICS.yaml with non-done deployment epic
      const updatedEpics = {
        epics: [
          ...mockEpicsYaml.epics,
          {
            id: 'EPIC-DEPLOYMENT',
            name: 'Deployment',
            status: 'pending',
          },
        ],
      };

      vi.spyOn(fs, 'readFileSync').mockImplementation(
        (filePath: string) => {
          if (filePath.includes('EPICS.yaml')) {
            return yaml.dump(updatedEpics);
          }
          throw new Error(`File not mocked: ${filePath}`);
        }
      );

      const status = checkCheckpointCompletion(deploymentCheckpoint!);
      expect(status.completed).toBe(false); // Deployment epic not done
    });

    it('should evaluate FILE-based conditions', () => {
      const epic = loadActiveEpic();
      const testingCheckpoint = epic?.checkpoints?.[3]; // CP-JOINERY-TESTING

      expect(testingCheckpoint?.condition).toContain(
        'FILE:docs/projects/test-results.md'
      );

      // Mock file not existing
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const status = checkCheckpointCompletion(testingCheckpoint!);
      expect(status.completed).toBe(false); // File not found
    });
  });

  describe('Conductor Task Assignment', () => {
    it('should provide Conductor with next action', () => {
      const epic = loadActiveEpic();
      const nextCheckpoint = getNextPendingCheckpoint(epic!);

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
      const nextCheckpoint = getNextPendingCheckpoint(epic!);

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
      const updatedEpics = {
        epics: [
          {
            ...epic!,
            checkpoints: epic?.checkpoints?.map((cp, idx) => ({
              ...cp,
              status: idx <= 1 ? 'done' : cp.status,
            })),
          },
        ],
      };

      vi.spyOn(fs, 'readFileSync').mockImplementation(
        (filePath: string) => {
          if (filePath.includes('EPICS.yaml')) {
            return yaml.dump(updatedEpics);
          }
          throw new Error(`File not mocked: ${filePath}`);
        }
      );

      const updatedEpic = loadActiveEpic();
      const progress2 = getEpicProgress(updatedEpic!);

      expect(progress2).toBeGreaterThan(progress1);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing EPICS.yaml gracefully', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const epic = loadActiveEpic();
      expect(epic).toBeNull();
    });

    it('should handle malformed EPICS.yaml gracefully', () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('YAML parse error');
      });

      const epic = loadActiveEpic();
      expect(epic).toBeNull();
    });

    it('should handle missing checkpoints', () => {
      const incompleteEpics = {
        epics: [
          {
            id: 'EPIC-NO-CHECKPOINTS',
            name: 'No Checkpoints',
            status: 'active',
          },
        ],
      };

      vi.spyOn(fs, 'readFileSync').mockImplementation(
        (filePath: string) => {
          if (filePath.includes('EPICS.yaml')) {
            return yaml.dump(incompleteEpics);
          }
          throw new Error(`File not mocked: ${filePath}`);
        }
      );

      const epic = loadActiveEpic();
      expect(epic?.checkpoints || []).toHaveLength(0);

      const nextCheckpoint = getNextPendingCheckpoint(epic!);
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
      const nextCheckpoint = getNextPendingCheckpoint(epic!);
      expect(nextCheckpoint?.id).toBe('CP-JOINERY-BACKEND-API');

      // Step 4: Evaluate condition
      const conditionStatus = checkCheckpointCompletion(nextCheckpoint!);
      expect(conditionStatus.checkpoint.id).toBe('CP-JOINERY-BACKEND-API');

      // Step 5: Conductor's action
      if (conditionStatus.completed) {
        // Checkpoint complete → mark as done, move to next
        expect(true).toBe(false); // Won't happen in this test
      } else {
        // Checkpoint pending → wait/monitor
        console.log(
          `[Conductor] Waiting for: ${nextCheckpoint?.condition}`
        );
      }

      expect(conditionStatus.completed).toBe(false);
    });
  });
});
