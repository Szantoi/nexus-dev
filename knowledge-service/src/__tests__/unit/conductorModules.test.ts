/**
 * Unit Tests for Conductor Program-Awareness Modules (ADR-053)
 * Tests: modeDetection, epicManager, checkpointTracker
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import modules under test
import { detectOperationMode, isStructuredProgramMode, isPlanningPipelineMode, getModeDescription } from '../../conductor/modeDetection';
import { loadActiveEpic, loadAllEpics, completeEpic, getCheckpoints, getPendingCheckpoints, getNextPendingCheckpoint, allCheckpointsComplete, getEpicProgress, type Epic, type Checkpoint } from '../../conductor/epicManager';
import { checkCheckpointCompletion, getNextPendingCheckpoint as getNextCheckpointFromTracker, getStuckCheckpoints, isEpicBlocked, type CheckpointStatus } from '../../conductor/checkpointTracker';

describe('Mode Detection (ADR-053)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('detectOperationMode', () => {
    it('should return structured_program when active epic exists in EPICS.yaml', () => {
      // Mock EPICS.yaml with active epic
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(`epics:
  - id: EPIC-TEST-001
    name: "Test Epic"
    status: active
`);

      const mode = detectOperationMode();
      expect(mode).toBe('structured_program');
    });

    it('should return planning_pipeline when ENABLE_IDEA_SCAN is true', () => {
      process.env.ENABLE_IDEA_SCAN = 'true';
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const mode = detectOperationMode();
      expect(mode).toBe('planning_pipeline');
    });

    it('should return planning_pipeline when ENABLE_PLANNING_PIPELINE is true', () => {
      process.env.ENABLE_PLANNING_PIPELINE = 'true';
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const mode = detectOperationMode();
      expect(mode).toBe('planning_pipeline');
    });

    it('should return manual as default', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      process.env.ENABLE_IDEA_SCAN = undefined;
      process.env.ENABLE_PLANNING_PIPELINE = undefined;

      const mode = detectOperationMode();
      expect(mode).toBe('manual');
    });
  });

  describe('Helper functions', () => {
    it('isStructuredProgramMode should return true for structured_program mode', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(`epics:
  - id: EPIC-TEST-001
    status: active
`);

      expect(isStructuredProgramMode()).toBe(true);
    });

    it('isPlanningPipelineMode should return true for planning_pipeline mode', () => {
      process.env.ENABLE_IDEA_SCAN = 'true';
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      expect(isPlanningPipelineMode()).toBe(true);
    });

    it('getModeDescription should return appropriate text for each mode', () => {
      const manual = getModeDescription('manual');
      expect(manual).toContain('Manual task execution');

      const planning = getModeDescription('planning_pipeline');
      expect(planning).toContain('Planning pipeline');

      const structured = getModeDescription('structured_program');
      expect(structured).toContain('Structured program');
    });
  });
});

describe('Epic Manager (ADR-053)', () => {
  const mockEpic: Epic = {
    id: 'EPIC-TEST-001',
    name: 'Test Epic',
    status: 'active',
    depends_on: [],
    parallel_with: [],
    checkpoints: [
      {
        id: 'CP-001',
        name: 'First Checkpoint',
        status: 'done',
        condition: 'MSG-BACKEND-100 status=DONE',
      },
      {
        id: 'CP-002',
        name: 'Second Checkpoint',
        status: 'pending',
        condition: 'MSG-BACKEND-101 status=DONE',
      },
      {
        id: 'CP-003',
        name: 'Third Checkpoint',
        status: 'pending',
        condition: 'EPIC-DEP status=done',
      },
    ],
    target_date: '2026-07-31',
  };

  beforeEach(() => {
    const mockYaml = {
      epics: [mockEpic],
    };

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yaml.dump(mockYaml));
  });

  describe('loadActiveEpic', () => {
    it('should load active epic from EPICS.yaml', () => {
      const epic = loadActiveEpic();
      expect(epic).toBeDefined();
      expect(epic?.id).toBe('EPIC-TEST-001');
      expect(epic?.status).toBe('active');
    });

    it('should return null if no active epic', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(`epics:
  - id: EPIC-TEST-002
    name: "Pending Epic"
    status: pending
`);

      const epic = loadActiveEpic();
      expect(epic).toBeNull();
    });
  });

  describe('loadAllEpics', () => {
    it('should load all epics from EPICS.yaml', () => {
      const epics = loadAllEpics();
      expect(Array.isArray(epics)).toBe(true);
      expect(epics.length).toBeGreaterThan(0);
    });
  });

  describe('Checkpoint methods', () => {
    it('getCheckpoints should return all checkpoints', () => {
      const checkpoints = getCheckpoints(mockEpic);
      expect(checkpoints.length).toBe(3);
    });

    it('getPendingCheckpoints should return only pending checkpoints', () => {
      const pending = getPendingCheckpoints(mockEpic);
      expect(pending.length).toBe(2);
      expect(pending.every(cp => cp.status === 'pending')).toBe(true);
    });

    it('getNextPendingCheckpoint should return first pending checkpoint', () => {
      const next = getNextPendingCheckpoint(mockEpic);
      expect(next).toBeDefined();
      expect(next?.id).toBe('CP-002');
    });

    it('getNextPendingCheckpoint should return null if no pending checkpoints', () => {
      const completedEpic: Epic = {
        ...mockEpic,
        checkpoints: mockEpic.checkpoints?.map(cp => ({ ...cp, status: 'done' })),
      };
      const next = getNextPendingCheckpoint(completedEpic);
      expect(next).toBeNull();
    });

    it('allCheckpointsComplete should return false if any pending', () => {
      const result = allCheckpointsComplete(mockEpic);
      expect(result).toBe(false);
    });

    it('allCheckpointsComplete should return true if all done', () => {
      const completedEpic: Epic = {
        ...mockEpic,
        checkpoints: mockEpic.checkpoints?.map(cp => ({ ...cp, status: 'done' })),
      };
      const result = allCheckpointsComplete(completedEpic);
      expect(result).toBe(true);
    });

    it('getEpicProgress should return percentage of completed checkpoints', () => {
      const progress = getEpicProgress(mockEpic);
      expect(progress).toBe(33); // 1 done out of 3 = ~33%
    });
  });

  describe('completeEpic', () => {
    it('should mark epic as done', async () => {
      const writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => '');

      const result = await completeEpic('EPIC-TEST-001');
      expect(result).toBe(true);
      expect(writeFileSpy).toHaveBeenCalled();
    });
  });
});

describe('Checkpoint Tracker (ADR-053)', () => {
  const mockCheckpoint: Checkpoint = {
    id: 'CP-001',
    name: 'Test Checkpoint',
    status: 'pending',
    condition: 'MSG-BACKEND-103 status=DONE',
  };

  describe('Condition parsing', () => {
    it('should correctly parse MSG condition', () => {
      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'MSG-BACKEND-103 status=DONE',
      };

      const status = checkCheckpointCompletion(checkpoint);
      expect(status.checkpoint).toBe(checkpoint);
      expect(typeof status.completed).toBe('boolean');
      expect(status.checkedAt).toBeInstanceOf(Date);
    });

    it('should correctly parse EPIC condition', () => {
      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'EPIC-JOINERY status=done',
      };

      const status = checkCheckpointCompletion(checkpoint);
      expect(status.checkpoint).toBe(checkpoint);
    });

    it('should correctly parse FILE condition', () => {
      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'FILE:docs/projects/EPICS.yaml contains:EPIC-TEST',
      };

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('epics:\n- id: EPIC-TEST');

      const status = checkCheckpointCompletion(checkpoint);
      expect(status.checkpoint).toBe(checkpoint);
    });

    it('should return false for invalid condition', () => {
      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'INVALID condition format',
      };

      const status = checkCheckpointCompletion(checkpoint);
      expect(status.completed).toBe(false);
    });
  });

  describe('Message status checking', () => {
    it('should find message file and check status', () => {
      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'MSG-BACKEND-103 status=DONE',
      };

      // Mock outbox directory with message file
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readdirSync').mockReturnValue(['2026-07-02_103_test-msg.md']);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('id: MSG-BACKEND-103\nstatus: DONE\n\nContent here');

      const status = checkCheckpointCompletion(checkpoint);
      expect(status).toBeDefined();
      expect(status.evidence).toBeDefined();
    });
  });

  describe('Stuck checkpoint detection', () => {
    it('should identify stuck checkpoints', () => {
      const epic: Epic = {
        id: 'EPIC-TEST-001',
        name: 'Test',
        status: 'active',
        checkpoints: [
          { id: 'CP-001', name: 'Done', status: 'done', condition: 'test' },
          { id: 'CP-002', name: 'Stuck', status: 'stuck', condition: 'test' },
          { id: 'CP-003', name: 'Pending', status: 'pending', condition: 'test' },
        ],
      };

      const stuck = getStuckCheckpoints(epic);
      expect(stuck.length).toBe(1);
      expect(stuck[0].id).toBe('CP-002');
    });
  });

  describe('Epic blocking detection', () => {
    it('should detect if epic is blocked by dependency', () => {
      const dependentEpic: Epic = {
        id: 'EPIC-DEPENDENT',
        name: 'Dependent Epic',
        status: 'active',
        depends_on: ['EPIC-BLOCKER'],
      };

      const blockerEpic: Epic = {
        id: 'EPIC-BLOCKER',
        name: 'Blocker Epic',
        status: 'pending',
      };

      const allEpics: Epic[] = [dependentEpic, blockerEpic];

      const isBlocked = isEpicBlocked(dependentEpic, allEpics);
      expect(isBlocked).toBe(true);
    });

    it('should return false if dependency is done', () => {
      const dependentEpic: Epic = {
        id: 'EPIC-DEPENDENT',
        name: 'Dependent Epic',
        status: 'active',
        depends_on: ['EPIC-BLOCKER'],
      };

      const blockerEpic: Epic = {
        id: 'EPIC-BLOCKER',
        name: 'Blocker Epic',
        status: 'done',
      };

      const allEpics: Epic[] = [dependentEpic, blockerEpic];

      const isBlocked = isEpicBlocked(dependentEpic, allEpics);
      expect(isBlocked).toBe(false);
    });

    it('should return false if no dependencies', () => {
      const epic: Epic = {
        id: 'EPIC-INDEPENDENT',
        name: 'Independent Epic',
        status: 'active',
      };

      const isBlocked = isEpicBlocked(epic, [epic]);
      expect(isBlocked).toBe(false);
    });
  });
});

describe('Integration: Mode #4 Workflow', () => {
  it('should detect structured program mode and load epic context', () => {
    const mockEpicData = {
      epics: [
        {
          id: 'EPIC-INTEGRATION-TEST',
          name: 'Integration Test Epic',
          status: 'active',
          checkpoints: [
            {
              id: 'CP-INT-001',
              name: 'Integration Checkpoint',
              status: 'pending',
              condition: 'MSG-INTEGRATION-100 status=DONE',
            },
          ],
        },
      ],
    };

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yaml.dump(mockEpicData));

    // Mode detection should work
    const mode = detectOperationMode();
    expect(mode).toBe('structured_program');

    // Epic loading should work
    const epic = loadActiveEpic();
    expect(epic?.id).toBe('EPIC-INTEGRATION-TEST');

    // Checkpoint tracking should work
    const nextCheckpoint = getNextPendingCheckpoint(epic!);
    expect(nextCheckpoint?.id).toBe('CP-INT-001');

    // Checkpoint completion check should work
    const status = checkCheckpointCompletion(nextCheckpoint!);
    expect(status).toBeDefined();
    expect(status.checkpoint.id).toBe('CP-INT-001');
  });
});
