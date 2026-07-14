/**
 * Graph Module — SpaceOS Graph-Based Workflow (ADR-041)
 *
 * Public exports for graph-based workflow and project management.
 *
 * @see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md
 */

// Types
export * from './types';

// Operations
export {
  topologicalSort,
  detectCycles,
  findCriticalPath,
  findParallelGroups,
  validateGraph,
  calculateCompletion,
  findBlockedChains,
  computeGraphProperties,
} from './operations';

// Mermaid Generator
export {
  generateMermaid,
  generateEpicDiagram,
  generateProjectDiagram,
  generateWorkflowDiagram,
  generateMermaidCodeBlock,
  generateStatusSection,
  generateMermaidWithCriticalPath,
} from './mermaidGenerator';

// EPICS Loader (Phase 1 / TASK-002)
export {
  loadEpicsYaml,
  writeEpicsYaml,
  buildEpicGraph,
  loadEpicGraph,
  loadEpicGraphCached,
  clearEpicGraphCache,
} from './epicsLoader';

// Re-export main types for convenience
export type {
  GraphNode,
  WorkflowGraph,
  EpicDependency,
  EpicsYaml,
  TaskNode,
  WorkflowStep,
  NodeStatus,
  NodeType,
  GraphType,
  Terminal,
  Model,
  Priority,
} from './types';
