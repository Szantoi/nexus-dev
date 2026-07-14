/**
 * Graph Workflow E2E Smoke Test (ADR-041 Phase 1 / TASK-006)
 *
 * End-to-end test scenario:
 * 1. Load EPICS.yaml
 * 2. Query /api/graph/epics
 * 3. Generate Mermaid diagram
 * 4. Validate critical path computation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadEpicGraph } from '../../graph/epicsLoader';
import { generateMermaid } from '../../graph/mermaidGenerator';
import { findCriticalPath } from '../../graph/operations';
import * as path from 'path';

const EPICS_PATH = path.resolve(__dirname, '../../../../../docs/projects/EPICS.yaml');

describe('Graph Workflow E2E', () => {
  it('should load EPICS.yaml and build complete graph', async () => {
    const graph = await loadEpicGraph(EPICS_PATH);

    // Validate graph structure
    expect(graph.id).toBe('spaceos-epics');
    expect(graph.type).toBe('epic_dependency');
    expect(graph.nodes.length).toBeGreaterThan(0);

    // Validate computed properties
    expect(graph.execution_order).toBeDefined();
    expect(graph.execution_order!.length).toBe(graph.nodes.length);
    expect(graph.critical_path).toBeDefined();
    expect(graph.parallel_groups).toBeDefined();
    expect(graph.completion_percentage).toBeDefined();
    expect(graph.has_cycles).toBe(false);

    console.log(`✅ Loaded ${graph.nodes.length} epics`);
    console.log(`✅ Completion: ${graph.completion_percentage}%`);
  });

  it('should generate valid Mermaid diagram', async () => {
    const graph = await loadEpicGraph(EPICS_PATH);
    const mermaid = generateMermaid(graph);

    // Validate Mermaid syntax
    expect(mermaid).toContain('graph');
    expect(mermaid).toContain('[');
    expect(mermaid).toContain(']');

    // Validate nodes are present
    for (const node of graph.nodes) {
      expect(mermaid).toContain(node.id);
    }

    // Validate edges are present (depends_on relationships)
    for (const node of graph.nodes) {
      for (const depId of node.depends_on) {
        expect(mermaid).toContain('-->');
      }
    }

    console.log(`✅ Generated Mermaid diagram (${mermaid.split('\n').length} lines)`);
  });

  it('should compute critical path correctly', async () => {
    const graph = await loadEpicGraph(EPICS_PATH);
    const criticalPath = findCriticalPath(graph);

    // Critical path should exist
    expect(criticalPath.path.length).toBeGreaterThan(0);
    expect(criticalPath.length).toBe(criticalPath.path.length);

    // All nodes in critical path should exist in graph
    for (const nodeId of criticalPath.path) {
      const node = graph.nodes.find(n => n.id === nodeId);
      expect(node).toBeDefined();
    }

    // Critical path should be a valid dependency chain
    for (let i = 1; i < criticalPath.path.length; i++) {
      const currentId = criticalPath.path[i];
      const previousId = criticalPath.path[i - 1];

      const currentNode = graph.nodes.find(n => n.id === currentId)!;

      // Current node should depend on previous node (directly or transitively)
      const dependsOnPrevious =
        currentNode.depends_on.includes(previousId) ||
        hasTransitiveDependency(graph, currentId, previousId);

      expect(dependsOnPrevious).toBe(true);
    }

    console.log(`✅ Critical path length: ${criticalPath.length}`);
    console.log(`   Path: ${criticalPath.path.join(' → ')}`);
  });

  it('should validate execution order is topologically sorted', async () => {
    const graph = await loadEpicGraph(EPICS_PATH);

    // For each node, all its dependencies should appear earlier in execution order
    const execOrder = graph.execution_order!;
    const indexMap = new Map<string, number>();

    execOrder.forEach((id, index) => {
      indexMap.set(id, index);
    });

    for (const node of graph.nodes) {
      const nodeIndex = indexMap.get(node.id)!;

      for (const depId of node.depends_on) {
        const depIndex = indexMap.get(depId);

        expect(depIndex).toBeDefined();
        expect(depIndex!).toBeLessThan(nodeIndex);
      }
    }

    console.log(`✅ Execution order is valid topological sort`);
  });

  it('should handle parallel groups correctly', async () => {
    const graph = await loadEpicGraph(EPICS_PATH);

    // Parallel groups should exist
    expect(graph.parallel_groups).toBeDefined();
    expect(graph.parallel_groups!.length).toBeGreaterThan(0);

    // Each parallel group should contain nodes that can execute in parallel
    for (const group of graph.parallel_groups!) {
      // Nodes in same group should not depend on each other
      for (const nodeId of group) {
        const node = graph.nodes.find(n => n.id === nodeId)!;

        for (const otherId of group) {
          if (nodeId !== otherId) {
            // nodeId should not depend on otherId
            expect(node.depends_on).not.toContain(otherId);
          }
        }
      }
    }

    console.log(`✅ Parallel groups validated (${graph.parallel_groups!.length} groups)`);
  });

  it('should calculate completion percentage accurately', async () => {
    const graph = await loadEpicGraph(EPICS_PATH);

    const doneCount = graph.nodes.filter(n => n.status === 'done').length;
    const total = graph.nodes.length;
    const expectedPercent = Math.round((doneCount / total) * 100);

    expect(graph.completion_percentage).toBe(expectedPercent);

    console.log(`✅ Completion: ${doneCount}/${total} = ${expectedPercent}%`);
  });
});

/**
 * Helper: Check if node has transitive dependency
 */
function hasTransitiveDependency(
  graph: any,
  nodeId: string,
  targetId: string,
  visited: Set<string> = new Set()
): boolean {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);

  const node = graph.nodes.find((n: any) => n.id === nodeId);
  if (!node) return false;

  if (node.depends_on.includes(targetId)) return true;

  for (const depId of node.depends_on) {
    if (hasTransitiveDependency(graph, depId, targetId, visited)) {
      return true;
    }
  }

  return false;
}
