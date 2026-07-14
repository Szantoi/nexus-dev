/**
 * Graph Types — SpaceOS Graph-Based Workflow (ADR-041)
 *
 * Core type definitions for graph-based workflow and project management.
 *
 * @see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md
 */

// ─── Node Types ─────────────────────────────────────────────────────────────

/**
 * Status of a graph node
 */
export type NodeStatus = 'pending' | 'active' | 'done' | 'blocked';

/**
 * Type of graph node
 */
export type NodeType = 'epic' | 'task' | 'workflow_step' | 'milestone';

/**
 * Priority level
 */
export type Priority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Terminal assignment (8-terminal architecture - includes monitor)
 */
export type Terminal =
  | 'root'
  | 'conductor'
  | 'architect'
  | 'librarian'
  | 'explorer'
  | 'backend'
  | 'frontend'
  | 'designer'
  | 'monitor';

/**
 * Model for LLM execution
 */
export type Model = 'sonnet' | 'opus' | 'haiku';

// ─── Core Graph Node ────────────────────────────────────────────────────────

/**
 * Universal graph node interface
 *
 * Represents any node in a workflow/dependency graph:
 * - Epics (cross-project)
 * - Tasks (within project)
 * - Workflow steps (manufacturing)
 * - Milestones (grouping)
 */
export interface GraphNode {
  /** Unique identifier (e.g., EPIC-CUTTING-Q3, TASK-001) */
  id: string;

  /** Type of node */
  type: NodeType;

  /** Human-readable name */
  name: string;

  /** Current status */
  status: NodeStatus;

  /** Incoming edges — nodes this depends on (blocked_by equivalent) */
  depends_on: string[];

  /** Outgoing edges — nodes triggered when this completes */
  triggers: string[];

  /** Explicit parallel execution hint */
  parallel_with?: string[];

  /** Assigned terminal (for tasks) */
  terminal?: Terminal;

  /** Description */
  description?: string;

  /** Priority level */
  priority?: Priority;

  /** Target completion date (YYYY-MM-DD) */
  target_date?: string;

  /** Arbitrary metadata */
  metadata: Record<string, unknown>;
}

// ─── Workflow Graph ─────────────────────────────────────────────────────────

/**
 * Type of workflow graph
 */
export type GraphType = 'project' | 'epic_dependency' | 'manufacturing';

/**
 * Complete workflow graph
 *
 * Contains all nodes and computed properties for visualization
 * and execution planning.
 */
export interface WorkflowGraph {
  /** Graph identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Type of graph */
  type: GraphType;

  /** All nodes in the graph */
  nodes: GraphNode[];

  // ─── Computed Properties (runtime) ────────────────────────────────────────

  /** Topologically sorted node IDs (execution order) */
  execution_order?: string[];

  /** Critical path — longest dependency chain */
  critical_path?: string[];

  /** Groups of nodes that can execute in parallel */
  parallel_groups?: string[][];

  /** Currently blocked dependency chains */
  blocked_chains?: string[][];

  /** Completion percentage (done / total) */
  completion_percentage?: number;

  /** Has cycles (invalid DAG) */
  has_cycles?: boolean;

  /** Detected cycles (if any) */
  cycles?: string[][];
}

// ─── Epic Specific Types ────────────────────────────────────────────────────

/**
 * Epic dependency entry (from EPICS.yaml)
 */
export interface EpicDependency {
  /** Epic identifier (e.g., EPIC-CUTTING-Q3) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Project slug (e.g., spaceos/cutting) */
  project: string;

  /** Epic IDs this depends on */
  depends_on: string[];

  /** Epic IDs that can run in parallel */
  parallel_with?: string[];

  /** Current status */
  status: NodeStatus;

  /** Target completion date */
  target_date?: string;

  /** Relative path to TASKS.yaml */
  tasks_yaml: string;

  /** Description */
  description?: string;
}

/**
 * EPICS.yaml schema
 */
export interface EpicsYaml {
  /** Schema version */
  version: string;

  /** Last update date (YYYY-MM-DD) */
  updated: string;

  /** All epics */
  epics: EpicDependency[];
}

// ─── Task Specific Types ────────────────────────────────────────────────────

/**
 * Task status (extended from NodeStatus)
 */
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'escalated';

/**
 * Task entry (from TASKS.yaml)
 *
 * Extended from projectDispatcher.ts Task interface for graph compatibility.
 */
export interface TaskNode extends Omit<GraphNode, 'type' | 'status'> {
  type: 'task';

  /** Task status (includes in_progress, escalated) */
  status: TaskStatus;

  /** Assigned terminal */
  terminal: Terminal;

  /** LLM model for execution */
  model?: Model;

  /** Auto-generate skeleton files */
  auto_generate?: boolean;

  /** Generator to use */
  generator?: string;

  /** Generator parameters */
  generator_params?: Record<string, unknown>;

  /** Message ID when dispatched */
  msg_id?: string;

  /** Path to inbox file */
  inbox_path?: string;

  /** Retry count for failed dispatches */
  retry_count?: number;

  /** Completion timestamp */
  completed_at?: string;
}

// ─── Manufacturing Workflow Types ───────────────────────────────────────────

/**
 * Manufacturing step type
 */
export type WorkflowStepType = 'start' | 'process' | 'decision' | 'join' | 'end';

/**
 * Manufacturing workflow step
 */
export interface WorkflowStep extends Omit<GraphNode, 'type'> {
  type: 'workflow_step';

  /** Step subtype */
  step_type: WorkflowStepType;

  /** Estimated duration (minutes) */
  estimated_duration?: number;

  /** Actual duration (minutes, when completed) */
  actual_duration?: number;

  /** Assigned workstation/machine */
  workstation?: string;

  /** SLA deadline */
  deadline?: string;
}

// ─── Graph Computation Results ──────────────────────────────────────────────

/**
 * Topological sort result
 */
export interface TopologicalSortResult {
  /** Sorted node IDs (execution order) */
  sorted: string[];

  /** True if graph is a valid DAG */
  valid: boolean;

  /** Detected cycles (if any) */
  cycles?: string[][];
}

/**
 * Critical path result
 */
export interface CriticalPathResult {
  /** Node IDs on the critical path */
  path: string[];

  /** Length of the critical path (number of nodes) */
  length: number;

  /** Total estimated duration (if nodes have duration) */
  total_duration?: number;
}

/**
 * Parallel groups result
 */
export interface ParallelGroupsResult {
  /** Groups of node IDs that can execute in parallel */
  groups: string[][];

  /** Number of parallel levels */
  levels: number;

  /** Maximum parallelism (max group size) */
  max_parallelism: number;
}

/**
 * Validation result for graph
 */
export interface GraphValidationResult {
  /** Is the graph valid */
  valid: boolean;

  /** Is it a valid DAG (no cycles) */
  is_dag: boolean;

  /** Validation errors */
  errors: GraphValidationError[];

  /** Validation warnings */
  warnings: GraphValidationWarning[];

  /** Detected cycles */
  cycles: string[][];

  /** Orphaned nodes (no incoming or outgoing edges) */
  orphans: string[];
}

export interface GraphValidationError {
  code: string;
  message: string;
  node_id?: string;
}

export interface GraphValidationWarning {
  code: string;
  message: string;
  node_id?: string;
}

// ─── API Response Types ─────────────────────────────────────────────────────

/**
 * GET /api/graph/epics response
 */
export interface EpicGraphResponse {
  graph: WorkflowGraph;
  mermaid?: string;
}

/**
 * GET /api/graph/project/:slug response
 */
export interface ProjectGraphResponse {
  project: string;
  graph: WorkflowGraph;
  mermaid?: string;
}

/**
 * POST /api/graph/validate response
 */
export interface ValidateGraphResponse {
  validation: GraphValidationResult;
}

/**
 * GET /api/graph/critical-path/:type/:id response
 */
export interface CriticalPathResponse {
  critical_path: CriticalPathResult;
}

/**
 * GET /api/graph/parallel/:type/:id response
 */
export interface ParallelGroupsResponse {
  parallel: ParallelGroupsResult;
}

/**
 * GET /api/graph/mermaid/:type/:id response
 */
export interface MermaidResponse {
  mermaid: string;
  node_count: number;
}
