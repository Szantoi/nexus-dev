/**
 * EPICS Loader Integration Tests (ADR-041 Phase 1 / TASK-002)
 *
 * Integration tests for EPICS.yaml loading and graph building:
 * - File loading and YAML parsing
 * - EpicDependency[] → WorkflowGraph conversion
 * - Triggers auto-generation
 * - Graph properties computation
 * - Caching behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  loadEpicsYaml,
  buildEpicGraph,
  loadEpicGraph,
  loadEpicGraphCached,
  clearEpicGraphCache,
} from '../graph/epicsLoader';
import { EpicsYaml, WorkflowGraph } from '../graph/types';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_EPICS_YAML = `version: "1.0"
updated: "2026-06-22"

epics:
  - id: EPIC-A
    name: "Epic A"
    project: test/a
    depends_on: []
    status: done
    tasks_yaml: "test/a/TASKS.yaml"
    description: "Foundation epic"

  - id: EPIC-B
    name: "Epic B"
    project: test/b
    depends_on: ["EPIC-A"]
    parallel_with: ["EPIC-C"]
    status: active
    tasks_yaml: "test/b/TASKS.yaml"

  - id: EPIC-C
    name: "Epic C"
    project: test/c
    depends_on: ["EPIC-A"]
    parallel_with: ["EPIC-B"]
    status: pending
    tasks_yaml: "test/c/TASKS.yaml"

  - id: EPIC-D
    name: "Epic D"
    project: test/d
    depends_on: ["EPIC-B", "EPIC-C"]
    status: pending
    tasks_yaml: "test/d/TASKS.yaml"
`;

const INVALID_EPICS_YAML = `version: "1.0"
updated: "2026-06-22"

epics:
  - id: EPIC-X
    name: "Epic X"
    depends_on: ["EPIC-NONEXISTENT"]
    # Missing: project, tasks_yaml
`;

const TEST_DIR = '/tmp/spaceos-test-epics';
const TEST_FILE_PATH = path.join(TEST_DIR, 'EPICS-test.yaml');
const INVALID_FILE_PATH = path.join(TEST_DIR, 'EPICS-invalid.yaml');

// ─── Setup & Teardown ───────────────────────────────────────────────────────

beforeEach(async () => {
  // Create test directory
  await fs.mkdir(TEST_DIR, { recursive: true });

  // Write test YAML files
  await fs.writeFile(TEST_FILE_PATH, TEST_EPICS_YAML, 'utf-8');
  await fs.writeFile(INVALID_FILE_PATH, INVALID_EPICS_YAML, 'utf-8');
});

afterEach(async () => {
  // Clean up test files
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch (err) {
    // Ignore cleanup errors
  }

  // Clear cache
  clearEpicGraphCache();
});

// ─── loadEpicsYaml() Tests ──────────────────────────────────────────────────

describe('epicsLoader - loadEpicsYaml()', () => {
  it('should load and parse valid EPICS.yaml', async () => {
    const epics = await loadEpicsYaml(TEST_FILE_PATH);

    expect(epics.version).toBe('1.0');
    expect(epics.updated).toBe('2026-06-22');
    expect(epics.epics).toHaveLength(4);
    expect(epics.epics[0].id).toBe('EPIC-A');
  });

  it('should throw error when file does not exist', async () => {
    await expect(loadEpicsYaml('/nonexistent/path.yaml')).rejects.toThrow(
      'EPICS.yaml not found at path'
    );
  });

  it('should throw error on invalid YAML syntax', async () => {
    const badYamlPath = path.join(TEST_DIR, 'bad.yaml');
    await fs.writeFile(badYamlPath, 'invalid:\n\t\tyaml:\n', 'utf-8');

    await expect(loadEpicsYaml(badYamlPath)).rejects.toThrow('YAML parse error');
  });

  it('should throw error on validation failure', async () => {
    await expect(loadEpicsYaml(INVALID_FILE_PATH)).rejects.toThrow(
      'EPICS.yaml validation failed'
    );
  });

  it('should log warnings on validation warnings', async () => {
    const warnYaml = `version: "1.0"
updated: "2026-06-22"

epics:
  - id: EPIC-W
    name: "Epic W"
    project: test/w
    tasks_yaml: "test/w/TASKS.yaml"
    depends_on: []
    # Missing: description (should warn)
`;
    const warnPath = path.join(TEST_DIR, 'warn.yaml');
    await fs.writeFile(warnPath, warnYaml, 'utf-8');

    // Should not throw, but may log warnings
    const epics = await loadEpicsYaml(warnPath);
    expect(epics.epics).toHaveLength(1);
  });
});

// ─── buildEpicGraph() Tests ─────────────────────────────────────────────────

describe('epicsLoader - buildEpicGraph()', () => {
  let epicsYaml: EpicsYaml;

  beforeEach(async () => {
    epicsYaml = await loadEpicsYaml(TEST_FILE_PATH);
  });

  it('should convert EpicDependency[] to WorkflowGraph', () => {
    const graph = buildEpicGraph(epicsYaml.epics);

    expect(graph.id).toBe('spaceos-epics');
    expect(graph.name).toBe('SpaceOS Epic Dependency Graph');
    expect(graph.type).toBe('epic_dependency');
    expect(graph.nodes).toHaveLength(4);
  });

  it('should preserve epic properties in GraphNode', () => {
    const graph = buildEpicGraph(epicsYaml.epics);
    const nodeA = graph.nodes.find(n => n.id === 'EPIC-A');

    expect(nodeA).toBeDefined();
    expect(nodeA!.type).toBe('epic');
    expect(nodeA!.name).toBe('Epic A');
    expect(nodeA!.status).toBe('done');
    expect(nodeA!.description).toBe('Foundation epic');
    expect(nodeA!.depends_on).toEqual([]);
    expect(nodeA!.metadata.project).toBe('test/a');
    expect(nodeA!.metadata.tasks_yaml).toBe('test/a/TASKS.yaml');
  });

  it('should auto-generate triggers from depends_on', () => {
    const graph = buildEpicGraph(epicsYaml.epics);

    // EPIC-A is depended on by EPIC-B and EPIC-C
    const nodeA = graph.nodes.find(n => n.id === 'EPIC-A')!;
    expect(nodeA.triggers).toContain('EPIC-B');
    expect(nodeA.triggers).toContain('EPIC-C');
    expect(nodeA.triggers).toHaveLength(2);

    // EPIC-B is depended on by EPIC-D
    const nodeB = graph.nodes.find(n => n.id === 'EPIC-B')!;
    expect(nodeB.triggers).toContain('EPIC-D');

    // EPIC-C is depended on by EPIC-D
    const nodeC = graph.nodes.find(n => n.id === 'EPIC-C')!;
    expect(nodeC.triggers).toContain('EPIC-D');

    // EPIC-D triggers nothing
    const nodeD = graph.nodes.find(n => n.id === 'EPIC-D')!;
    expect(nodeD.triggers).toEqual([]);
  });

  it('should preserve parallel_with hints', () => {
    const graph = buildEpicGraph(epicsYaml.epics);

    const nodeB = graph.nodes.find(n => n.id === 'EPIC-B')!;
    expect(nodeB.parallel_with).toContain('EPIC-C');

    const nodeC = graph.nodes.find(n => n.id === 'EPIC-C')!;
    expect(nodeC.parallel_with).toContain('EPIC-B');
  });

  it('should compute graph properties (execution_order, critical_path, etc.)', () => {
    const graph = buildEpicGraph(epicsYaml.epics);

    // Graph properties should be computed
    expect(graph.execution_order).toBeDefined();
    expect(graph.critical_path).toBeDefined();
    expect(graph.parallel_groups).toBeDefined();
    expect(graph.completion_percentage).toBeDefined();
    expect(graph.has_cycles).toBe(false);

    // Execution order should be topologically sorted
    // EPIC-A must come before EPIC-B, EPIC-C, EPIC-D
    const execOrder = graph.execution_order!;
    const indexA = execOrder.indexOf('EPIC-A');
    const indexB = execOrder.indexOf('EPIC-B');
    const indexC = execOrder.indexOf('EPIC-C');
    const indexD = execOrder.indexOf('EPIC-D');

    expect(indexA).toBeLessThan(indexB);
    expect(indexA).toBeLessThan(indexC);
    expect(indexB).toBeLessThan(indexD);
    expect(indexC).toBeLessThan(indexD);
  });

  it('should calculate completion percentage correctly', () => {
    const graph = buildEpicGraph(epicsYaml.epics);

    // 1 done out of 4 epics = 25%
    expect(graph.completion_percentage).toBe(25);
  });

  it('should handle empty epic list', () => {
    const graph = buildEpicGraph([]);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.execution_order).toEqual([]);
    // Empty graph is considered 100% complete (no work to do)
    expect(graph.completion_percentage).toBe(100);
  });
});

// ─── loadEpicGraph() Tests ──────────────────────────────────────────────────

describe('epicsLoader - loadEpicGraph()', () => {
  it('should load and build graph in one call', async () => {
    const graph = await loadEpicGraph(TEST_FILE_PATH);

    expect(graph.nodes).toHaveLength(4);
    expect(graph.execution_order).toBeDefined();
  });

  it('should reject on invalid file', async () => {
    await expect(loadEpicGraph(INVALID_FILE_PATH)).rejects.toThrow(
      'EPICS.yaml validation failed'
    );
  });
});

// ─── Caching Tests ──────────────────────────────────────────────────────────

describe('epicsLoader - Caching', () => {
  it('should cache graph on first load', async () => {
    const graph1 = await loadEpicGraphCached(TEST_FILE_PATH);
    const graph2 = await loadEpicGraphCached(TEST_FILE_PATH);

    // Should return the same instance (cached)
    expect(graph1).toBe(graph2);
  });

  it('should reload when file is modified', async () => {
    const graph1 = await loadEpicGraphCached(TEST_FILE_PATH);

    // Modify file
    await new Promise(resolve => setTimeout(resolve, 10)); // Ensure mtime changes
    const updatedYaml = TEST_EPICS_YAML.replace('2026-06-22', '2026-06-23');
    await fs.writeFile(TEST_FILE_PATH, updatedYaml, 'utf-8');

    const graph2 = await loadEpicGraphCached(TEST_FILE_PATH);

    // Should be different instances (reloaded)
    expect(graph1).not.toBe(graph2);
  });

  it('should force reload when forceReload=true', async () => {
    const graph1 = await loadEpicGraphCached(TEST_FILE_PATH);
    const graph2 = await loadEpicGraphCached(TEST_FILE_PATH, true);

    // Should be different instances
    expect(graph1).not.toBe(graph2);
  });

  it('should clear cache with clearEpicGraphCache()', async () => {
    await loadEpicGraphCached(TEST_FILE_PATH);
    clearEpicGraphCache();

    // Next load should reload
    const graph = await loadEpicGraphCached(TEST_FILE_PATH);
    expect(graph).toBeDefined();
  });
});

// ─── Real EPICS.yaml Integration Test ───────────────────────────────────────

describe('epicsLoader - Real EPICS.yaml', () => {
  it('should load the actual SpaceOS EPICS.yaml', async () => {
    const realPath = 'docs/projects/EPICS.yaml';

    try {
      const graph = await loadEpicGraph(realPath);

      // Basic validation
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.execution_order).toBeDefined();
      expect(graph.has_cycles).toBe(false);

      console.log(`Loaded ${graph.nodes.length} epics from ${realPath}`);
      console.log(`Completion: ${graph.completion_percentage}%`);
    } catch (err: any) {
      // If EPICS.yaml doesn't exist yet, skip this test
      if (err.message.includes('not found')) {
        console.log('Real EPICS.yaml not found yet - skipping integration test');
      } else {
        throw err;
      }
    }
  });
});
