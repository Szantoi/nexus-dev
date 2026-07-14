/**
 * EPICS Loader & Graph Builder (ADR-041 Phase 1 / TASK-002)
 *
 * Loads EPICS.yaml and builds WorkflowGraph:
 * - File read + YAML parse
 * - EpicDependency[] → WorkflowGraph conversion
 * - Auto-generate triggers from depends_on (inverse relationships)
 * - Compute graph properties (topological sort, critical path, etc.)
 *
 * @see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md
 */

import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';
import { EpicsYaml, EpicDependency, WorkflowGraph, GraphNode } from './types';
import { validateEpicsYaml } from '../pipeline/epicsValidator';
import { computeGraphProperties } from './operations';

/**
 * Load and parse EPICS.yaml from file
 *
 * @param path Path to EPICS.yaml file
 * @returns Parsed and validated EPICS.yaml content
 * @throws Error if file doesn't exist, YAML is invalid, or validation fails
 */
export async function loadEpicsYaml(path: string): Promise<EpicsYaml> {
  try {
    // Read file
    const fileContent = await fs.readFile(path, 'utf-8');

    // Parse YAML
    const parsed = yaml.load(fileContent) as any;

    // Validate schema
    const validation = validateEpicsYaml(parsed);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `[${e.code}] ${e.message}`).join('\n');
      throw new Error(`EPICS.yaml validation failed:\n${errorMessages}`);
    }

    // Warn on validation warnings
    if (validation.warnings.length > 0) {
      console.warn(`EPICS.yaml validation warnings:`);
      for (const warning of validation.warnings) {
        console.warn(`  [${warning.code}] ${warning.message}`);
      }
    }

    return parsed as EpicsYaml;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`EPICS.yaml not found at path: ${path}`);
    }
    if (error instanceof yaml.YAMLException) {
      throw new Error(`YAML parse error: ${error.message}`);
    }
    throw error; // Re-throw validation errors and other errors
  }
}

/**
 * Build WorkflowGraph from EpicDependency array
 *
 * Converts EPICS.yaml epic entries to a full WorkflowGraph with:
 * - Nodes (GraphNode[]) from epics
 * - Auto-generated triggers (inverse of depends_on)
 * - Computed properties (execution_order, critical_path, etc.)
 *
 * @param epics Array of epic dependencies from EPICS.yaml
 * @returns Complete WorkflowGraph with computed properties
 */
export function buildEpicGraph(epics: EpicDependency[]): WorkflowGraph {
  // Build node map for quick lookup
  const nodeMap = new Map<string, GraphNode>();

  // ─── Step 1: Convert EpicDependency → GraphNode ────────────────────────
  const nodes: GraphNode[] = epics.map(epic => ({
    id: epic.id,
    type: 'epic',
    name: epic.name,
    status: epic.status || 'pending',
    depends_on: epic.depends_on || [],
    triggers: [], // Will be computed in Step 2
    parallel_with: epic.parallel_with,
    description: epic.description,
    target_date: epic.target_date,
    metadata: {
      project: epic.project,
      tasks_yaml: epic.tasks_yaml,
    },
  }));

  // Populate node map
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // ─── Step 2: Auto-generate triggers (inverse of depends_on) ────────────
  for (const node of nodes) {
    for (const depId of node.depends_on) {
      const depNode = nodeMap.get(depId);
      if (depNode) {
        // depNode triggers this node when completed
        if (!depNode.triggers.includes(node.id)) {
          depNode.triggers.push(node.id);
        }
      }
    }
  }

  // ─── Step 3: Build WorkflowGraph ────────────────────────────────────────
  const graph: WorkflowGraph = {
    id: 'spaceos-epics',
    name: 'SpaceOS Epic Dependency Graph',
    type: 'epic_dependency',
    nodes,
  };

  // ─── Step 4: Compute graph properties ───────────────────────────────────
  // computeGraphProperties returns a new object with computed properties
  return computeGraphProperties(graph);
}

/**
 * Load EPICS.yaml and build WorkflowGraph (convenience function)
 *
 * Combines loadEpicsYaml() and buildEpicGraph() in one call.
 *
 * @param path Path to EPICS.yaml file (default: docs/projects/EPICS.yaml)
 * @returns Complete WorkflowGraph
 */
export async function loadEpicGraph(path: string = 'docs/projects/EPICS.yaml'): Promise<WorkflowGraph> {
  const epicsYaml = await loadEpicsYaml(path);
  return buildEpicGraph(epicsYaml.epics);
}

// ─── Optional: File watcher for auto-reload ────────────────────────────────

/**
 * In-memory cached graph (optional optimization)
 */
let cachedGraph: WorkflowGraph | null = null;
let cachedPath: string | null = null;
let lastModified: Date | null = null;

/**
 * Load epic graph with caching
 *
 * Checks file modification time and reloads only if changed.
 * Use this for production where EPICS.yaml changes infrequently.
 *
 * @param path Path to EPICS.yaml file
 * @param forceReload Force reload even if cached
 * @returns WorkflowGraph (cached or freshly loaded)
 */
export async function loadEpicGraphCached(
  path: string = 'docs/projects/EPICS.yaml',
  forceReload: boolean = false
): Promise<WorkflowGraph> {
  // Check if file modified
  const stats = await fs.stat(path);
  const fileModified = stats.mtime;

  if (
    !forceReload &&
    cachedGraph &&
    cachedPath === path &&
    lastModified &&
    fileModified.getTime() === lastModified.getTime()
  ) {
    // Return cached graph
    return cachedGraph;
  }

  // Reload graph
  const graph = await loadEpicGraph(path);

  // Update cache
  cachedGraph = graph;
  cachedPath = path;
  lastModified = fileModified;

  return graph;
}

/**
 * Clear cached graph (for testing or manual reload)
 */
export function clearEpicGraphCache(): void {
  cachedGraph = null;
  cachedPath = null;
  lastModified = null;
}

/**
 * Write EPICS.yaml to file (atomic write)
 *
 * @param path Path to EPICS.yaml file
 * @param data EpicsYaml content to write
 * @throws Error if validation fails or write fails
 */
export async function writeEpicsYaml(path: string, data: EpicsYaml): Promise<void> {
  try {
    // Validate before write
    const validation = validateEpicsYaml(data);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `[${e.code}] ${e.message}`).join('\n');
      throw new Error(`EPICS.yaml validation failed:\n${errorMessages}`);
    }

    // Serialize to YAML
    const yamlContent = yaml.dump(data, {
      indent: 2,
      lineWidth: -1,
    });

    // Write atomically (write to temp file, then rename)
    const tempPath = `${path}.tmp`;
    await fs.writeFile(tempPath, yamlContent, 'utf-8');
    await fs.rename(tempPath, path);

    // Clear cache to force reload
    clearEpicGraphCache();
  } catch (error: any) {
    // Clean up temp file on error
    try {
      await fs.unlink(`${path}.tmp`);
    } catch (e) {
      // Ignore
    }
    throw error;
  }
}
