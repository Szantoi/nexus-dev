/**
 * Unit Tests for Conductor Program-Awareness Modules (ADR-053)
 * Tests: modeDetection, epicManager, checkpointTracker
 *
 * Hermetic: all modules read EPICS_PATH / SPACEOS_ROOT / TERMINALS_PATH at
 * module scope, so we point them at a temp directory BEFORE importing
 * (vi.hoisted runs before the hoisted imports).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const TEST_ROOT = vi.hoisted(() => {
  // os.tmpdir() equivalent without imports (vi.hoisted runs before imports)
  const base = process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp';
  const root = `${base.replace(/[\\/]+$/, '')}/conductor-modules-test-${process.pid}`;
  process.env.SPACEOS_ROOT = root;
  process.env.TERMINALS_PATH = `${root}/terminals`;
  process.env.EPICS_PATH = `${root}/EPICS.yaml`;
  delete process.env.SPACEOS_MODE;
  delete process.env.ENABLE_IDEA_SCAN;
  delete process.env.ENABLE_PLANNING_PIPELINE;
  return root;
});

// Import modules under test (after env setup above)
import { detectOperationMode, getModeDescription } from '../../conductor/modeDetection';
import {
  loadActiveEpic,
  loadActiveEpics,
  loadAllEpics,
  completeEpic,
  getNextCheckpoint,
  getEpicProgress,
  type Epic,
  type Checkpoint,
} from '../../conductor/epicManager';
import { checkCheckpointCompletion, updateCheckpointStatus } from '../../conductor/checkpointTracker';

const EPICS_PATH = path.join(TEST_ROOT, 'EPICS.yaml');
const QUEUE_DIR = path.join(TEST_ROOT, 'docs', 'planning', 'queue');
const TERMINALS_DIR = path.join(TEST_ROOT, 'terminals');

function writeEpicsYaml(data: unknown): void {
  fs.writeFileSync(EPICS_PATH, yaml.dump(data), 'utf-8');
}

function resetTestTree(): void {
  fs.rmSync(EPICS_PATH, { force: true });
  fs.rmSync(QUEUE_DIR, { recursive: true, force: true });
  fs.rmSync(TERMINALS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('Mode Detection (ADR-053)', () => {
  beforeEach(() => {
    resetTestTree();
  });

  describe('detectOperationMode', () => {
    it('should return structured_program when active epic exists in EPICS.yaml', () => {
      writeEpicsYaml({
        epics: [{ id: 'EPIC-TEST-001', name: 'Test Epic', status: 'active' }],
      });

      const mode = detectOperationMode();
      expect(mode).toBe('structured_program');
    });

    it('should return planning_pipeline when planning queue has items', () => {
      // No active epic, but queue directory contains a pending idea
      fs.mkdirSync(QUEUE_DIR, { recursive: true });
      fs.writeFileSync(path.join(QUEUE_DIR, 'idea-001.md'), '# Idea', 'utf-8');

      const mode = detectOperationMode();
      expect(mode).toBe('planning_pipeline');
    });

    it('should respect SPACEOS_MODE env override', () => {
      process.env.SPACEOS_MODE = 'planning_pipeline';
      try {
        expect(detectOperationMode()).toBe('planning_pipeline');
      } finally {
        delete process.env.SPACEOS_MODE;
      }
    });

    it('should return manual as default', () => {
      // No EPICS.yaml, no planning queue
      const mode = detectOperationMode();
      expect(mode).toBe('manual');
    });

    it('should return manual when EPICS.yaml has no active epic and queue is empty', () => {
      writeEpicsYaml({
        epics: [{ id: 'EPIC-TEST-002', name: 'Pending Epic', status: 'pending' }],
      });
      fs.mkdirSync(QUEUE_DIR, { recursive: true });

      const mode = detectOperationMode();
      expect(mode).toBe('manual');
    });
  });

  describe('getModeDescription', () => {
    it('should return appropriate text for each mode', () => {
      expect(getModeDescription('manual')).toContain('Manual');
      expect(getModeDescription('planning_pipeline')).toContain('Planning Pipeline');
      expect(getModeDescription('structured_program')).toContain('Structured Program');
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
    resetTestTree();
    writeEpicsYaml({ epics: [mockEpic] });
  });

  describe('loadActiveEpic', () => {
    it('should load active epic from EPICS.yaml', () => {
      const epic = loadActiveEpic();
      expect(epic).toBeDefined();
      expect(epic?.id).toBe('EPIC-TEST-001');
      expect(epic?.status).toBe('active');
    });

    it('should return null if no active epic', () => {
      writeEpicsYaml({
        epics: [{ id: 'EPIC-TEST-002', name: 'Pending Epic', status: 'pending' }],
      });

      const epic = loadActiveEpic();
      expect(epic).toBeNull();
    });
  });

  describe('loadActiveEpics', () => {
    it('should return all active epics', () => {
      writeEpicsYaml({
        epics: [
          { ...mockEpic, id: 'EPIC-A' },
          { ...mockEpic, id: 'EPIC-B' },
          { ...mockEpic, id: 'EPIC-C', status: 'pending' },
        ],
      });

      const epics = loadActiveEpics();
      expect(epics.map(e => e.id)).toEqual(['EPIC-A', 'EPIC-B']);
    });

    it('should return empty array when EPICS.yaml is missing', () => {
      fs.rmSync(EPICS_PATH, { force: true });
      expect(loadActiveEpics()).toEqual([]);
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
    it('getNextCheckpoint should return first pending checkpoint', () => {
      const next = getNextCheckpoint(mockEpic);
      expect(next).toBeDefined();
      expect(next?.id).toBe('CP-002');
    });

    it('getNextCheckpoint should return null if no pending checkpoints', () => {
      const completedEpic: Epic = {
        ...mockEpic,
        checkpoints: mockEpic.checkpoints.map(cp => ({ ...cp, status: 'done' as const })),
      };
      const next = getNextCheckpoint(completedEpic);
      expect(next).toBeNull();
    });

    it('getEpicProgress should return percentage of completed checkpoints', () => {
      const progress = getEpicProgress(mockEpic);
      expect(progress).toBe(33); // 1 done out of 3 = ~33%
    });

    it('getEpicProgress should return 0 for epic without checkpoints', () => {
      const epic: Epic = { ...mockEpic, checkpoints: [] };
      expect(getEpicProgress(epic)).toBe(0);
    });
  });

  describe('completeEpic', () => {
    it('should mark epic as done', () => {
      const result = completeEpic('EPIC-TEST-001');
      expect(result).toBe(true);

      const written = yaml.load(fs.readFileSync(EPICS_PATH, 'utf-8')) as { epics: Epic[] };
      expect(written.epics[0].status).toBe('done');
    });

    it('should return false for unknown epic', () => {
      expect(completeEpic('EPIC-DOES-NOT-EXIST')).toBe(false);
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

  beforeEach(() => {
    resetTestTree();
  });

  describe('Condition parsing', () => {
    it('should correctly parse MSG condition (no outbox → not complete)', () => {
      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'MSG-BACKEND-103 status=DONE',
      };

      const completed = checkCheckpointCompletion(checkpoint);
      expect(completed).toBe(false);
    });

    it('should correctly parse EPIC condition against EPICS.yaml', () => {
      writeEpicsYaml({
        epics: [{ id: 'EPIC-JOINERY', name: 'Joinery', status: 'done' }],
      });

      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'EPIC-JOINERY status=done',
      };

      expect(checkCheckpointCompletion(checkpoint)).toBe(true);
    });

    it('should return false for EPIC condition with non-matching status', () => {
      writeEpicsYaml({
        epics: [{ id: 'EPIC-JOINERY', name: 'Joinery', status: 'active' }],
      });

      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'EPIC-JOINERY status=done',
      };

      expect(checkCheckpointCompletion(checkpoint)).toBe(false);
    });

    it('should return false for invalid condition', () => {
      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'INVALID condition format',
      };

      expect(checkCheckpointCompletion(checkpoint)).toBe(false);
    });
  });

  describe('Message status checking', () => {
    it('should find message file in terminal outbox and check status', () => {
      const outboxDir = path.join(TERMINALS_DIR, 'backend', 'outbox');
      fs.mkdirSync(outboxDir, { recursive: true });
      fs.writeFileSync(
        path.join(outboxDir, '2026-07-02_103_test-msg.md'),
        '---\nref: MSG-BACKEND-103\nstatus: DONE\n---\n\nContent here',
        'utf-8'
      );

      const checkpoint: Checkpoint = {
        ...mockCheckpoint,
        condition: 'MSG-BACKEND-103 status=DONE',
      };

      expect(checkCheckpointCompletion(checkpoint)).toBe(true);
    });
  });

  describe('updateCheckpointStatus', () => {
    it('should persist checkpoint status change to EPICS.yaml', () => {
      writeEpicsYaml({
        epics: [
          {
            id: 'EPIC-TEST-001',
            name: 'Test Epic',
            status: 'active',
            checkpoints: [
              { id: 'CP-001', name: 'CP', status: 'pending', condition: 'MSG-BACKEND-1 status=DONE' },
            ],
          },
        ],
      });

      const ok = updateCheckpointStatus('EPIC-TEST-001', 'CP-001', 'done');
      expect(ok).toBe(true);

      const written = yaml.load(fs.readFileSync(EPICS_PATH, 'utf-8')) as { epics: Epic[] };
      expect(written.epics[0].checkpoints[0].status).toBe('done');
    });

    it('should return false when EPICS.yaml is missing', () => {
      expect(updateCheckpointStatus('EPIC-TEST-001', 'CP-001', 'done')).toBe(false);
    });
  });
});

describe('Integration: Mode #4 Workflow', () => {
  it('should detect structured program mode and load epic context', () => {
    resetTestTree();
    writeEpicsYaml({
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
    });

    // Mode detection should work
    const mode = detectOperationMode();
    expect(mode).toBe('structured_program');

    // Epic loading should work
    const epic = loadActiveEpic();
    expect(epic?.id).toBe('EPIC-INTEGRATION-TEST');

    // Checkpoint tracking should work
    const nextCheckpoint = getNextCheckpoint(epic!);
    expect(nextCheckpoint?.id).toBe('CP-INT-001');

    // Checkpoint completion check should work (no outbox message → false)
    const completed = checkCheckpointCompletion(nextCheckpoint!);
    expect(completed).toBe(false);
  });
});
