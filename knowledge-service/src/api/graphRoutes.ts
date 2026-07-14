/**
 * Graph API Routes (ADR-041 Phase 1 / TASK-003)
 *
 * REST API endpoints for Graph-Based Workflow:
 * - GET /api/graph/epics — Epic dependency graph
 * - GET /api/graph/project/:slug — Project-level graph
 * - POST /api/graph/validate — YAML validation
 * - GET /api/graph/critical-path/:type/:id — Critical path query
 * - GET /api/graph/mermaid/:type/:id — Mermaid diagram generation
 *
 * @see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md
 */

import { Router, Request, Response } from 'express';
import * as yaml from 'js-yaml';
import * as path from 'path';
import {
  loadEpicGraphCached,
  buildEpicGraph,
  loadEpicsYaml,
  writeEpicsYaml,
  clearEpicGraphCache,
} from '../graph/epicsLoader';

// SPACEOS root path for file access
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const EPICS_YAML_PATH = path.join(SPACEOS_ROOT, 'docs/projects/EPICS.yaml');
import {
  generateMermaid,
  findCriticalPath,
  detectCycles,
} from '../graph';
import {
  validateEpicsYaml,
  EpicsValidationResult,
} from '../pipeline/epicsValidator';
import {
  EpicGraphResponse,
  ProjectGraphResponse,
  ValidateGraphResponse,
  CriticalPathResponse,
  MermaidResponse,
} from '../graph/types';
import {
  isValidStatusTransition,
  validateDonePrecondition,
  validateNoSelfReference,
} from '../graph/validators';

const router = Router();

// ─── GET /api/graph/epics ───────────────────────────────────────────────────

/**
 * Get epic dependency graph
 *
 * Returns the complete SpaceOS epic dependency graph with all
 * computed properties (execution order, critical path, etc.)
 *
 * Query params:
 *   - mermaid (boolean): Include Mermaid diagram in response
 *
 * Response: EpicGraphResponse
 */
router.get('/epics', async (req: Request, res: Response) => {
  try {
    const includeMermaid = req.query.mermaid === 'true';

    // Load epic graph (cached)
    const graph = await loadEpicGraphCached(EPICS_YAML_PATH);

    const response: EpicGraphResponse = {
      graph,
    };

    if (includeMermaid) {
      response.mermaid = generateMermaid(graph);
    }

    res.json(response);
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: 'EPICS.yaml not found' });
    } else if (error.message.includes('validation failed')) {
      res.status(400).json({ error: error.message });
    } else {
      console.error('Error loading epic graph:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ─── GET /api/graph/project/:slug ───────────────────────────────────────────

/**
 * Get project-level task graph
 *
 * Loads TASKS.yaml for a specific project and builds a WorkflowGraph.
 *
 * Path params:
 *   - slug (string): Project slug (e.g., "spaceos/cutting")
 *
 * Query params:
 *   - mermaid (boolean): Include Mermaid diagram in response
 *
 * Response: ProjectGraphResponse
 *
 * NOTE: Phase 1 returns stub (not yet implemented).
 *       Phase 2 will integrate with projectDispatcher.ts
 */
router.get('/project/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const includeMermaid = req.query.mermaid === 'true';

    // TODO Phase 2: Load TASKS.yaml and build project graph
    // For now, return a stub response
    res.status(501).json({
      error: 'Project-level graphs not yet implemented (Phase 2)',
      project: slug,
      hint: 'Use GET /api/graph/epics for epic-level graph',
    });
  } catch (error: any) {
    console.error('Error loading project graph:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/graph/validate ───────────────────────────────────────────────

/**
 * Validate EPICS.yaml content
 *
 * Accepts YAML content in request body and validates it against
 * the EPICS.yaml schema.
 *
 * Request body:
 *   - yaml (string): YAML content to validate
 *
 * Response: ValidateGraphResponse
 */
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { yaml: yamlContent } = req.body;

    if (!yamlContent || typeof yamlContent !== 'string') {
      res.status(400).json({
        error: 'Missing or invalid "yaml" field in request body',
      });
      return;
    }

    // Parse YAML
    let parsed: any;
    try {
      parsed = yaml.load(yamlContent);
    } catch (err: any) {
      res.status(400).json({
        error: 'YAML parse error',
        message: err.message,
      });
      return;
    }

    // Validate
    const validation = validateEpicsYaml(parsed);

    // Convert EpicsValidationResult to GraphValidationResult format
    const response = {
      validation: {
        valid: validation.valid,
        is_dag: !validation.cycles || validation.cycles.length === 0,
        errors: validation.errors.map(e => ({
          code: e.code,
          message: e.message,
          node_id: e.epic_id,
        })),
        warnings: validation.warnings.map(w => ({
          code: w.code,
          message: w.message,
          node_id: w.epic_id,
        })),
        cycles: validation.cycles || [],
        orphans: [], // Not yet computed for epics
      },
    };

    res.json(response);
  } catch (error: any) {
    console.error('Error validating YAML:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/graph/critical-path/:type/:id ─────────────────────────────────

/**
 * Get critical path for a graph
 *
 * Path params:
 *   - type (string): Graph type ("epic" | "project" | "workflow")
 *   - id (string): Graph ID or project slug
 *
 * Response: CriticalPathResponse
 */
router.get('/critical-path/:type/:id', async (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    const id = req.params.id as string;

    // Validate type
    const validTypes = ['epic', 'project', 'workflow'];
    if (!validTypes.includes(type)) {
      res.status(400).json({
        error: `Invalid graph type: ${type}. Valid types: ${validTypes.join(', ')}`,
      });
      return;
    }

    // Load graph based on type
    let graph;
    if (type === 'epic') {
      graph = await loadEpicGraphCached(EPICS_YAML_PATH);
    } else {
      // TODO Phase 2: Load project/workflow graphs
      res.status(501).json({
        error: `Critical path for type "${type}" not yet implemented (Phase 2)`,
      });
      return;
    }

    // Compute critical path
    const criticalPath = findCriticalPath(graph);

    const response: CriticalPathResponse = {
      critical_path: criticalPath,
    };

    res.json(response);
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: 'Graph not found' });
    } else {
      console.error('Error computing critical path:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ─── GET /api/graph/mermaid/:type/:id ───────────────────────────────────────

/**
 * Generate Mermaid diagram for a graph
 *
 * Path params:
 *   - type (string): Graph type ("epic" | "project" | "workflow")
 *   - id (string): Graph ID or project slug
 *
 * Response: MermaidResponse
 */
router.get('/mermaid/:type/:id', async (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    const id = req.params.id as string;

    // Validate type
    const validTypes = ['epic', 'project', 'workflow'];
    if (!validTypes.includes(type)) {
      res.status(400).json({
        error: `Invalid graph type: ${type}. Valid types: ${validTypes.join(', ')}`,
      });
      return;
    }

    // Load graph based on type
    let graph;
    if (type === 'epic') {
      graph = await loadEpicGraphCached(EPICS_YAML_PATH);
    } else {
      // TODO Phase 2: Load project/workflow graphs
      res.status(501).json({
        error: `Mermaid generation for type "${type}" not yet implemented (Phase 2)`,
      });
      return;
    }

    // Generate Mermaid diagram
    const mermaid = generateMermaid(graph);

    const response: MermaidResponse = {
      mermaid,
      node_count: graph.nodes.length,
    };

    res.json(response);
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: 'Graph not found' });
    } else {
      console.error('Error generating Mermaid diagram:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ─── PUT /api/graph/epics/:id ───────────────────────────────────────────────

/**
 * Update epic properties (status, dependencies, metadata)
 *
 * Path params:
 *   - id (string): Epic ID (e.g., "EPIC-CUTTING-Q3")
 *
 * Request body (all optional):
 *   - status (string): New status (pending | active | done | blocked)
 *   - depends_on (string[]): Updated dependency list
 *   - parallel_with (string[]): Updated parallel list
 *   - target_date (string): Updated target date (ISO 8601)
 *   - name (string): Epic name
 *   - description (string): Epic description
 *
 * Response: { success: true, epic: {...}, validation: {...} }
 *
 * Validation:
 *   - Status transitions must be valid
 *   - New dependencies must not create cycles
 *   - All epic IDs must exist
 */
router.put('/epics/:id', async (req: Request, res: Response) => {
  try {
    const epicId = req.params.id as string;
    const updates = req.body;

    // Load current EPICS.yaml
    const epicsYaml = await loadEpicsYaml(EPICS_YAML_PATH);

    // Find epic by ID
    const epicIndex = epicsYaml.epics.findIndex(e => e.id === epicId);
    if (epicIndex < 0) {
      res.status(404).json({ error: `Epic not found: ${epicId}` });
      return;
    }

    const epic = epicsYaml.epics[epicIndex];
    const originalStatus = epic.status || 'pending';

    // ─── Validate status transition if provided ─────────────────────────────
    if (updates.status && typeof updates.status === 'string') {
      const transitionCheck = isValidStatusTransition(
        originalStatus as any,
        updates.status as any
      );

      if (!transitionCheck.valid) {
        res.status(400).json({
          error: transitionCheck.error,
        });
        return;
      }

      // ─── Validate "done" precondition ──────────────────────────────────────
      // Before setting status to "done", all dependencies must be "done"
      if (updates.status === 'done') {
        const testEpic = { ...epic, status: 'done' as const };
        const doneCheck = validateDonePrecondition(testEpic, epicsYaml.epics);

        if (!doneCheck.valid) {
          res.status(400).json({
            error: doneCheck.error,
            blocking_dependencies: doneCheck.blockingDeps,
          });
          return;
        }
      }
    }

    // ─── Validate dependencies if provided ──────────────────────────────────
    if (updates.depends_on && Array.isArray(updates.depends_on)) {
      // Check for self-reference
      const selfRefCheck = validateNoSelfReference(epicId, updates.depends_on);
      if (!selfRefCheck.valid) {
        res.status(400).json({
          error: selfRefCheck.error,
        });
        return;
      }

      // Verify all referenced epic IDs exist
      const validEpicIds = new Set(epicsYaml.epics.map(e => e.id));
      for (const depId of updates.depends_on) {
        if (!validEpicIds.has(depId)) {
          res.status(400).json({
            error: `Referenced epic not found: ${depId}`,
          });
          return;
        }
      }

      // Build test graph with new dependencies and check for cycles
      const testEpics = epicsYaml.epics.map((e, i) =>
        i === epicIndex
          ? { ...epic, depends_on: updates.depends_on }
          : e
      );
      const testGraph = buildEpicGraph(testEpics);
      const cycles = detectCycles(testGraph);

      if (cycles.length > 0) {
        res.status(400).json({
          error: 'Dependency change would create a cycle',
          cycles,
        });
        return;
      }
    }

    // ─── Apply updates ─────────────────────────────────────────────────────
    if (updates.status) epic.status = updates.status;
    if (updates.depends_on !== undefined) epic.depends_on = updates.depends_on;
    if (updates.parallel_with !== undefined) epic.parallel_with = updates.parallel_with;
    if (updates.target_date) epic.target_date = updates.target_date;
    if (updates.name) epic.name = updates.name;
    if (updates.description) epic.description = updates.description;

    // ─── Write updated EPICS.yaml ──────────────────────────────────────────
    await writeEpicsYaml(EPICS_YAML_PATH, epicsYaml);

    // ─── Return updated epic ───────────────────────────────────────────────
    res.json({
      success: true,
      epic,
      validation: {
        valid: true,
        cycles: [],
      },
    });
  } catch (error: any) {
    console.error('Error updating epic:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
