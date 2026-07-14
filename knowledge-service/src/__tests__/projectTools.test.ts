/**
 * Project Tools Tests (Track E)
 *
 * Unit tests for MCP project automation tools:
 * - create_project
 * - get_project_status
 * - dispatch_next
 * - list_blocked
 * - generate_skeleton
 * - generate_endpoint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  handleCreateProject,
  CreateProjectArgs,
  handleGetProjectStatus,
  GetProjectStatusArgs,
  handleDispatchNext,
  DispatchNextArgs,
  handleListBlocked,
} from '../projectTools';
import { TaskChain } from '../pipeline/projectDispatcher';

// Test fixtures directory
const TEST_PROJECTS_DIR = '/tmp/test-projects';
const TEST_TERMINALS_DIR = '/tmp/test-terminals';

describe('Project Tools', () => {
  beforeEach(async () => {
    // Create test directory structure
    await fs.mkdir(TEST_PROJECTS_DIR, { recursive: true });
    await fs.mkdir(TEST_TERMINALS_DIR, { recursive: true });

    // Create test terminals
    const terminals = ['backend', 'frontend', 'conductor'];
    for (const terminal of terminals) {
      await fs.mkdir(path.join(TEST_TERMINALS_DIR, terminal, 'inbox'), { recursive: true });
      await fs.mkdir(path.join(TEST_TERMINALS_DIR, terminal, 'outbox'), { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up test directories
    await fs.rm(TEST_PROJECTS_DIR, { recursive: true, force: true });
    await fs.rm(TEST_TERMINALS_DIR, { recursive: true, force: true });
  });

  describe('create_project', () => {
    it('should create project directory structure', async () => {
      const args: CreateProjectArgs = {
        slug: 'test-project',
        name: 'Test Project',
        description: 'A test project for unit testing',
      };

      // Override PROJECTS_DIR for testing
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      const result = await handleCreateProject(args);

      expect(result.success).toBe(true);
      expect(result.path).toBe(path.join(TEST_PROJECTS_DIR, 'test-project'));
      expect(result.files).toContain('PROJECT.md');
      expect(result.files).toContain('TASKS.yaml');
      expect(result.files).toContain('STATUS.md');

      // Verify directory structure
      const projectDir = path.join(TEST_PROJECTS_DIR, 'test-project');
      const stats = await fs.stat(projectDir);
      expect(stats.isDirectory()).toBe(true);

      // Verify PROJECT.md content
      const projectMd = await fs.readFile(path.join(projectDir, 'PROJECT.md'), 'utf-8');
      expect(projectMd).toContain('# Test Project');
      expect(projectMd).toContain('A test project for unit testing');

      // Verify TASKS.yaml structure
      const tasksYaml = await fs.readFile(path.join(projectDir, 'TASKS.yaml'), 'utf-8');
      const tasks = yaml.load(tasksYaml) as TaskChain;
      expect(tasks.version).toBe('1.0');
      expect(tasks.project).toBe('test-project');
      expect(tasks.milestones.length).toBeGreaterThan(0);

      // Restore original env
      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });

    it('should create project with custom milestones', async () => {
      const args: CreateProjectArgs = {
        slug: 'milestone-test',
        name: 'Milestone Test',
        milestones: [
          { id: 'M1', name: 'Phase 1' },
          { id: 'M2', name: 'Phase 2' },
          { id: 'M3', name: 'Phase 3' },
        ],
      };

      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      const result = await handleCreateProject(args);

      expect(result.success).toBe(true);

      // Verify TASKS.yaml has custom milestones
      const tasksYaml = await fs.readFile(
        path.join(TEST_PROJECTS_DIR, 'milestone-test', 'TASKS.yaml'),
        'utf-8'
      );
      const tasks = yaml.load(tasksYaml) as TaskChain;
      expect(tasks.milestones.length).toBe(3);
      expect(tasks.milestones[0].id).toBe('M1');
      expect(tasks.milestones[0].name).toBe('Phase 1');
      expect(tasks.milestones[1].id).toBe('M2');
      expect(tasks.milestones[2].id).toBe('M3');

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });

    it('should handle errors gracefully', async () => {
      const args: CreateProjectArgs = {
        slug: '../../../etc/passwd',  // Path traversal attempt
        name: 'Invalid Project',
      };

      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = '/invalid/read-only/path/that/does/not/exist';

      const result = await handleCreateProject(args);

      // Should fail due to invalid path
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });
  });

  describe('get_project_status', () => {
    beforeEach(async () => {
      // Create a test project first
      const args: CreateProjectArgs = {
        slug: 'status-test',
        name: 'Status Test Project',
      };

      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      await handleCreateProject(args);

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });

    it('should return project status', async () => {
      const args: GetProjectStatusArgs = {
        project: 'status-test',
      };

      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      const result = await handleGetProjectStatus(args);

      expect(result.success).toBe(true);
      if (!result.success) return; // Type guard

      expect(result.project).toBe('status-test');
      expect(result.milestones).toBeDefined();
      expect(result.stats).toBeDefined();

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });

    it('should handle non-existent project', async () => {
      const args: GetProjectStatusArgs = {
        project: 'non-existent-project',
      };

      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      const result = await handleGetProjectStatus(args);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });
  });

  describe('dispatch_next', () => {
    it('should return success message for manual dispatch', async () => {
      const args: DispatchNextArgs = {
        project: 'test-project',
      };

      const result = await handleDispatchNext(args);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Auto-dispatcher will find next unblocked tasks');
      expect(result.note).toBeDefined();
    });

    it('should handle task-specific dispatch', async () => {
      const args: DispatchNextArgs = {
        project: 'test-project',
        task_id: 'TASK-001',
      };

      const result = await handleDispatchNext(args);

      expect(result.success).toBe(true);
      expect(result.message).toContain('TASK-001');
    });
  });

  describe('list_blocked', () => {
    beforeEach(async () => {
      // Create a test project with blocked tasks
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      const args: CreateProjectArgs = {
        slug: 'blocked-test',
        name: 'Blocked Test Project',
        milestones: [{ id: 'M1', name: 'Phase 1' }],
      };

      await handleCreateProject(args);

      // Modify TASKS.yaml to add a blocked task
      const tasksPath = path.join(TEST_PROJECTS_DIR, 'blocked-test', 'TASKS.yaml');
      const tasksContent = await fs.readFile(tasksPath, 'utf-8');
      const tasks = yaml.load(tasksContent) as TaskChain;

      tasks.milestones[0].tasks.push({
        id: 'TASK-001',
        name: 'Blocked Task',
        terminal: 'backend',
        status: 'blocked',
        blocked_by: ['TASK-002'],
        triggers_on_done: [],
      });

      await fs.writeFile(tasksPath, yaml.dump(tasks));

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });

    it('should list all blocked tasks', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      const result = await handleListBlocked();

      expect(result.success).toBe(true);
      expect(result.count).toBeGreaterThan(0);
      expect(result.blocked).toBeDefined();
      expect(Array.isArray(result.blocked)).toBe(true);

      const blockedTask = result.blocked?.find(
        (b: any) => b.project === 'blocked-test' && b.task.id === 'TASK-001'
      );
      expect(blockedTask).toBeDefined();
      expect(blockedTask?.task.status).toBe('blocked');

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });

    it('should return empty list when no blocked tasks', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = TEST_PROJECTS_DIR;

      // Remove all tasks
      const tasksPath = path.join(TEST_PROJECTS_DIR, 'blocked-test', 'TASKS.yaml');
      const tasksContent = await fs.readFile(tasksPath, 'utf-8');
      const tasks = yaml.load(tasksContent) as TaskChain;
      tasks.milestones[0].tasks = [];
      await fs.writeFile(tasksPath, yaml.dump(tasks));

      const result = await handleListBlocked();

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);

      if (originalProjectsDir) {
        process.env.PROJECTS_DIR = originalProjectsDir;
      } else {
        delete process.env.PROJECTS_DIR;
      }
    });
  });
});
