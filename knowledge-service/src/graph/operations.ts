/**
 * Graph Operations — SpaceOS Graph-Based Workflow (ADR-041)
 *
 * Core algorithms for graph processing:
 * - Topological sort (execution order)
 * - Cycle detection (DAG validation)
 * - Critical path calculation
 * - Parallel group identification
 *
 * @see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md
 */

import {
  WorkflowGraph,
  GraphNode,
  TopologicalSortResult,
  CriticalPathResult,
  ParallelGroupsResult,
  GraphValidationResult,
  GraphValidationError,
  GraphValidationWarning,
} from './types';

// ─── Topological Sort ───────────────────────────────────────────────────────

/**
 * Topological sort using Kahn's algorithm
 *
 * Returns nodes in execution order (respecting dependencies).
 * Detects cycles if the graph is not a valid DAG.
 *
 * @param graph Workflow graph
 * @returns Sorted node IDs and cycle information
 */
export function topologicalSort(graph: WorkflowGraph): TopologicalSortResult {
  const nodeMap = new Map<string, GraphNode>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  // Build adjacency and in-degree
  for (const node of graph.nodes) {
    for (const depId of node.depends_on) {
      if (nodeMap.has(depId)) {
        // depId → node.id (dependency points to dependent)
        adjacency.get(depId)!.push(node.id);
        inDegree.set(node.id, inDegree.get(node.id)! + 1);
      }
    }
  }

  // Queue nodes with no dependencies (in-degree 0)
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const neighbor of adjacency.get(current) || []) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Check for cycles
  if (sorted.length !== graph.nodes.length) {
    // Graph has cycles - find them
    const cycles = detectCycles(graph);
    return {
      sorted: [],
      valid: false,
      cycles,
    };
  }

  return {
    sorted,
    valid: true,
  };
}

// ─── Cycle Detection ────────────────────────────────────────────────────────

/**
 * Detect cycles in the graph using DFS
 *
 * @param graph Workflow graph
 * @returns Array of cycles (each cycle is an array of node IDs)
 */
export function detectCycles(graph: WorkflowGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  const nodeMap = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  function dfs(nodeId: string): void {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    // Follow depends_on edges (reverse direction for cycle detection)
    for (const depId of node.depends_on) {
      if (!nodeMap.has(depId)) continue;

      if (!visited.has(depId)) {
        dfs(depId);
      } else if (recursionStack.has(depId)) {
        // Cycle detected
        const cycleStart = path.indexOf(depId);
        const cycle = path.slice(cycleStart);
        cycle.push(depId); // Close the cycle
        cycles.push(cycle);
      }
    }

    path.pop();
    recursionStack.delete(nodeId);
  }

  // Run DFS from each unvisited node
  for (const node of graph.nodes) {
    if (!visited.has(node.id)) {
      dfs(node.id);
    }
  }

  return cycles;
}

// ─── Critical Path ──────────────────────────────────────────────────────────

/**
 * Find the critical path (longest dependency chain)
 *
 * Uses dynamic programming on the topologically sorted graph.
 *
 * @param graph Workflow graph
 * @returns Critical path result
 */
export function findCriticalPath(graph: WorkflowGraph): CriticalPathResult {
  const sortResult = topologicalSort(graph);

  if (!sortResult.valid) {
    return {
      path: [],
      length: 0,
    };
  }

  const nodeMap = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  // Distance from any start node
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();

  for (const id of sortResult.sorted) {
    dist.set(id, 0);
    prev.set(id, null);
  }

  // Process in topological order
  for (const id of sortResult.sorted) {
    const node = nodeMap.get(id)!;
    const currentDist = dist.get(id)!;

    // Find nodes that depend on this one (outgoing edges)
    for (const otherNode of graph.nodes) {
      if (otherNode.depends_on.includes(id)) {
        const newDist = currentDist + 1;
        if (newDist > dist.get(otherNode.id)!) {
          dist.set(otherNode.id, newDist);
          prev.set(otherNode.id, id);
        }
      }
    }
  }

  // Find end node with max distance
  let maxDist = 0;
  let endNode = sortResult.sorted[0];

  for (const [id, d] of dist) {
    if (d > maxDist) {
      maxDist = d;
      endNode = id;
    }
  }

  // Backtrack to get path
  const path: string[] = [];
  let current: string | null = endNode;

  while (current) {
    path.unshift(current);
    current = prev.get(current) || null;
  }

  return {
    path,
    length: path.length,
  };
}

// ─── Parallel Groups ────────────────────────────────────────────────────────

/**
 * Find groups of nodes that can execute in parallel
 *
 * Nodes at the same "level" (same distance from start) can run in parallel.
 *
 * @param graph Workflow graph
 * @returns Parallel groups result
 */
export function findParallelGroups(graph: WorkflowGraph): ParallelGroupsResult {
  const sortResult = topologicalSort(graph);

  if (!sortResult.valid) {
    return {
      groups: [],
      levels: 0,
      max_parallelism: 0,
    };
  }

  const nodeMap = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  // Calculate level for each node
  const nodeLevel = new Map<string, number>();
  const levels: string[][] = [];

  for (const id of sortResult.sorted) {
    const node = nodeMap.get(id)!;

    // Level is 1 + max level of dependencies
    let maxDepLevel = -1;
    for (const depId of node.depends_on) {
      const depLevel = nodeLevel.get(depId);
      if (depLevel !== undefined && depLevel > maxDepLevel) {
        maxDepLevel = depLevel;
      }
    }

    const level = maxDepLevel + 1;
    nodeLevel.set(id, level);

    if (!levels[level]) {
      levels[level] = [];
    }
    levels[level].push(id);
  }

  // Filter to only groups with multiple nodes (actual parallelism)
  const parallelGroups = levels.filter(l => l && l.length > 1);

  // Calculate max parallelism
  let maxParallelism = 0;
  for (const level of levels) {
    if (level && level.length > maxParallelism) {
      maxParallelism = level.length;
    }
  }

  return {
    groups: parallelGroups,
    levels: levels.filter(l => l).length,
    max_parallelism: maxParallelism,
  };
}

// ─── Graph Validation ───────────────────────────────────────────────────────

/**
 * Validate a workflow graph
 *
 * Checks:
 * - DAG validity (no cycles)
 * - Reference integrity (all depends_on exist)
 * - Orphan nodes (no connections)
 * - Self-references
 *
 * @param graph Workflow graph
 * @returns Validation result
 */
export function validateGraph(graph: WorkflowGraph): GraphValidationResult {
  const errors: GraphValidationError[] = [];
  const warnings: GraphValidationWarning[] = [];

  const nodeIds = new Set(graph.nodes.map(n => n.id));

  // Check for duplicate IDs
  const seenIds = new Set<string>();
  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) {
      errors.push({
        code: 'DUPLICATE_ID',
        message: `Duplicate node ID: ${node.id}`,
        node_id: node.id,
      });
    }
    seenIds.add(node.id);
  }

  // Check each node
  for (const node of graph.nodes) {
    // Self-reference check
    if (node.depends_on.includes(node.id)) {
      errors.push({
        code: 'SELF_REFERENCE',
        message: `Node ${node.id} depends on itself`,
        node_id: node.id,
      });
    }

    // Reference integrity
    for (const depId of node.depends_on) {
      if (!nodeIds.has(depId)) {
        errors.push({
          code: 'INVALID_REFERENCE',
          message: `Node ${node.id} depends on non-existent node: ${depId}`,
          node_id: node.id,
        });
      }
    }

    // Triggers reference integrity
    for (const triggerId of node.triggers) {
      if (!nodeIds.has(triggerId)) {
        errors.push({
          code: 'INVALID_TRIGGER',
          message: `Node ${node.id} triggers non-existent node: ${triggerId}`,
          node_id: node.id,
        });
      }
    }

    // Parallel_with reference integrity
    if (node.parallel_with) {
      for (const parallelId of node.parallel_with) {
        if (!nodeIds.has(parallelId)) {
          warnings.push({
            code: 'INVALID_PARALLEL',
            message: `Node ${node.id} parallel_with non-existent node: ${parallelId}`,
            node_id: node.id,
          });
        }
      }
    }
  }

  // Cycle detection
  const cycles = detectCycles(graph);
  const isDag = cycles.length === 0;

  if (!isDag) {
    for (const cycle of cycles) {
      errors.push({
        code: 'CYCLE_DETECTED',
        message: `Cycle detected: ${cycle.join(' → ')}`,
      });
    }
  }

  // Orphan detection
  const orphans: string[] = [];
  for (const node of graph.nodes) {
    const hasIncoming = node.depends_on.length > 0;
    const hasOutgoing = graph.nodes.some(n => n.depends_on.includes(node.id));

    if (!hasIncoming && !hasOutgoing && graph.nodes.length > 1) {
      orphans.push(node.id);
      warnings.push({
        code: 'ORPHAN_NODE',
        message: `Node ${node.id} has no connections`,
        node_id: node.id,
      });
    }
  }

  return {
    valid: errors.length === 0,
    is_dag: isDag,
    errors,
    warnings,
    cycles,
    orphans,
  };
}

// ─── Graph Metrics ──────────────────────────────────────────────────────────

/**
 * Calculate completion percentage
 *
 * @param graph Workflow graph
 * @returns Percentage of done nodes (0-100)
 */
export function calculateCompletion(graph: WorkflowGraph): number {
  if (graph.nodes.length === 0) return 100;

  const doneCount = graph.nodes.filter(n => n.status === 'done').length;
  return Math.round((doneCount / graph.nodes.length) * 100);
}

/**
 * Find blocked chains (nodes blocked by incomplete dependencies)
 *
 * @param graph Workflow graph
 * @returns Array of blocked chains
 */
export function findBlockedChains(graph: WorkflowGraph): string[][] {
  const nodeMap = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  const blockedChains: string[][] = [];

  // Find nodes that are blocked
  for (const node of graph.nodes) {
    if (node.status === 'blocked' || node.status === 'pending') {
      // Check if any dependency is not done
      const blockers = node.depends_on.filter(depId => {
        const dep = nodeMap.get(depId);
        return dep && dep.status !== 'done';
      });

      if (blockers.length > 0) {
        blockedChains.push([...blockers, node.id]);
      }
    }
  }

  return blockedChains;
}

/**
 * Compute all runtime properties for a graph
 *
 * @param graph Workflow graph
 * @returns Graph with all computed properties
 */
export function computeGraphProperties(graph: WorkflowGraph): WorkflowGraph {
  const sortResult = topologicalSort(graph);
  const criticalPath = findCriticalPath(graph);
  const parallelGroups = findParallelGroups(graph);
  const blockedChains = findBlockedChains(graph);
  const completion = calculateCompletion(graph);

  return {
    ...graph,
    execution_order: sortResult.sorted,
    critical_path: criticalPath.path,
    parallel_groups: parallelGroups.groups,
    blocked_chains: blockedChains,
    completion_percentage: completion,
    has_cycles: !sortResult.valid,
    cycles: sortResult.cycles,
  };
}
