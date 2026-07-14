/**
 * Mermaid Generator — SpaceOS Graph-Based Workflow (ADR-041)
 *
 * Generates Mermaid.js diagram syntax from WorkflowGraph.
 * Used for STATUS.md auto-generation and documentation.
 *
 * @see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md
 */

import { WorkflowGraph, GraphNode, NodeStatus, GraphType } from './types';

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Mermaid diagram configuration
 */
export interface MermaidConfig {
  /** Diagram direction: TD (top-down), LR (left-right) */
  direction: 'TD' | 'LR' | 'BT' | 'RL';

  /** Show status as node style */
  showStatus: boolean;

  /** Show node descriptions in tooltips */
  showDescriptions: boolean;

  /** Max label length before truncation */
  maxLabelLength: number;

  /** Include legend */
  includeLegend: boolean;

  /** Theme preset */
  theme: 'default' | 'dark' | 'forest' | 'neutral';
}

const DEFAULT_CONFIG: MermaidConfig = {
  direction: 'TD',
  showStatus: true,
  showDescriptions: false,
  maxLabelLength: 30,
  includeLegend: true,
  theme: 'default',
};

// ─── Style Definitions ──────────────────────────────────────────────────────

/**
 * CSS class definitions for Mermaid nodes
 */
const STATUS_STYLES: Record<NodeStatus, string> = {
  pending: 'fill:#f9f9f9,stroke:#999,stroke-width:1px',
  active: 'fill:#e6f3ff,stroke:#0066cc,stroke-width:2px',
  done: 'fill:#e6ffe6,stroke:#00cc00,stroke-width:1px',
  blocked: 'fill:#ffe6e6,stroke:#cc0000,stroke-width:2px',
};

/**
 * Node shape based on type
 */
const TYPE_SHAPES: Record<string, { open: string; close: string }> = {
  epic: { open: '([', close: '])' },           // Stadium shape
  milestone: { open: '{{', close: '}}' },      // Hexagon
  task: { open: '[', close: ']' },             // Rectangle
  workflow_step: { open: '(', close: ')' },    // Rounded
  start: { open: '((', close: '))' },          // Circle
  end: { open: '((', close: '))' },            // Circle
  decision: { open: '{', close: '}' },         // Diamond
};

// ─── Main Generator ─────────────────────────────────────────────────────────

/**
 * Generate Mermaid diagram from WorkflowGraph
 *
 * @param graph Workflow graph
 * @param config Diagram configuration
 * @returns Mermaid diagram source
 */
export function generateMermaid(
  graph: WorkflowGraph,
  config: Partial<MermaidConfig> = {}
): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const lines: string[] = [];

  // Diagram header
  lines.push(`graph ${cfg.direction}`);
  lines.push('');

  // Generate nodes
  lines.push('    %% Nodes');
  for (const node of graph.nodes) {
    const nodeLine = generateNodeLine(node, cfg);
    lines.push(`    ${nodeLine}`);
  }
  lines.push('');

  // Generate edges
  lines.push('    %% Dependencies');
  for (const node of graph.nodes) {
    for (const depId of node.depends_on) {
      // Edge from dependency to dependent
      lines.push(`    ${depId} --> ${node.id}`);
    }
  }
  lines.push('');

  // Generate parallel hints (dashed lines)
  const parallelEdges = new Set<string>();
  for (const node of graph.nodes) {
    if (node.parallel_with) {
      for (const parallelId of node.parallel_with) {
        // Avoid duplicate edges
        const edgeKey = [node.id, parallelId].sort().join('-');
        if (!parallelEdges.has(edgeKey)) {
          parallelEdges.add(edgeKey);
          lines.push(`    ${node.id} -.->|parallel| ${parallelId}`);
        }
      }
    }
  }

  if (parallelEdges.size > 0) {
    lines.push('');
  }

  // Style classes
  if (cfg.showStatus) {
    lines.push('    %% Status Styles');
    lines.push(`    classDef pending ${STATUS_STYLES.pending}`);
    lines.push(`    classDef active ${STATUS_STYLES.active}`);
    lines.push(`    classDef done ${STATUS_STYLES.done}`);
    lines.push(`    classDef blocked ${STATUS_STYLES.blocked}`);
    lines.push('');

    // Apply classes
    const statusGroups: Record<NodeStatus, string[]> = {
      pending: [],
      active: [],
      done: [],
      blocked: [],
    };

    for (const node of graph.nodes) {
      if (statusGroups[node.status]) {
        statusGroups[node.status].push(node.id);
      }
    }

    for (const [status, ids] of Object.entries(statusGroups)) {
      if (ids.length > 0) {
        lines.push(`    class ${ids.join(',')} ${status}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Generate a single node line
 */
function generateNodeLine(node: GraphNode, config: MermaidConfig): string {
  const shape = TYPE_SHAPES[node.type] || TYPE_SHAPES.task;
  let label = node.name;

  // Truncate long labels
  if (label.length > config.maxLabelLength) {
    label = label.substring(0, config.maxLabelLength - 3) + '...';
  }

  // Escape special characters in label
  label = escapeLabel(label);

  return `${node.id}${shape.open}"${label}"${shape.close}`;
}

/**
 * Escape special characters in Mermaid labels
 */
function escapeLabel(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/&/g, 'and')   // Mermaid parses & as HTML entity start
    .replace(/</g, '')
    .replace(/>/g, '')
    .replace(/#/g, '');     // # can also cause issues
}

// ─── Specialized Generators ─────────────────────────────────────────────────

/**
 * Generate Epic dependency diagram
 */
export function generateEpicDiagram(graph: WorkflowGraph): string {
  return generateMermaid(graph, {
    direction: 'LR',
    showStatus: true,
    includeLegend: true,
  });
}

/**
 * Generate Project task diagram
 */
export function generateProjectDiagram(graph: WorkflowGraph): string {
  return generateMermaid(graph, {
    direction: 'TD',
    showStatus: true,
    maxLabelLength: 40,
  });
}

/**
 * Generate Manufacturing workflow diagram
 */
export function generateWorkflowDiagram(graph: WorkflowGraph): string {
  return generateMermaid(graph, {
    direction: 'LR',
    showStatus: true,
    showDescriptions: true,
  });
}

// ─── Markdown Integration ───────────────────────────────────────────────────

/**
 * Generate Mermaid code block for Markdown
 */
export function generateMermaidCodeBlock(graph: WorkflowGraph): string {
  const diagram = generateMermaid(graph);

  return `\`\`\`mermaid
${diagram}
\`\`\``;
}

/**
 * Generate STATUS.md section with graph
 */
export function generateStatusSection(
  graph: WorkflowGraph,
  title: string = 'Dependency Graph'
): string {
  const completion = Math.round(
    (graph.nodes.filter(n => n.status === 'done').length / graph.nodes.length) * 100
  );

  const activeCount = graph.nodes.filter(n => n.status === 'active').length;
  const blockedCount = graph.nodes.filter(n => n.status === 'blocked').length;
  const pendingCount = graph.nodes.filter(n => n.status === 'pending').length;
  const doneCount = graph.nodes.filter(n => n.status === 'done').length;

  const lines = [
    `## ${title}`,
    '',
    `**Progress:** ${completion}% complete`,
    '',
    `| Status | Count |`,
    `|--------|-------|`,
    `| Done | ${doneCount} |`,
    `| Active | ${activeCount} |`,
    `| Pending | ${pendingCount} |`,
    `| Blocked | ${blockedCount} |`,
    '',
    generateMermaidCodeBlock(graph),
    '',
    `*Generated: ${new Date().toISOString()}*`,
  ];

  return lines.join('\n');
}

// ─── Critical Path Highlighting ─────────────────────────────────────────────

/**
 * Generate Mermaid with critical path highlighted
 */
export function generateMermaidWithCriticalPath(
  graph: WorkflowGraph,
  criticalPath: string[]
): string {
  const cfg = { ...DEFAULT_CONFIG };
  const lines: string[] = [];

  lines.push(`graph ${cfg.direction}`);
  lines.push('');

  // Nodes
  lines.push('    %% Nodes');
  for (const node of graph.nodes) {
    const shape = TYPE_SHAPES[node.type] || TYPE_SHAPES.task;
    const label = escapeLabel(node.name);
    lines.push(`    ${node.id}${shape.open}"${label}"${shape.close}`);
  }
  lines.push('');

  // Edges
  lines.push('    %% Dependencies');
  const criticalSet = new Set(criticalPath);

  for (const node of graph.nodes) {
    for (const depId of node.depends_on) {
      // Check if this edge is on critical path
      const isCritical =
        criticalSet.has(node.id) &&
        criticalSet.has(depId) &&
        criticalPath.indexOf(depId) === criticalPath.indexOf(node.id) - 1;

      if (isCritical) {
        lines.push(`    ${depId} ==>|critical| ${node.id}`);
      } else {
        lines.push(`    ${depId} --> ${node.id}`);
      }
    }
  }
  lines.push('');

  // Styles
  lines.push('    %% Styles');
  lines.push(`    classDef pending ${STATUS_STYLES.pending}`);
  lines.push(`    classDef active ${STATUS_STYLES.active}`);
  lines.push(`    classDef done ${STATUS_STYLES.done}`);
  lines.push(`    classDef blocked ${STATUS_STYLES.blocked}`);
  lines.push('    classDef critical fill:#ffeb3b,stroke:#f57f17,stroke-width:3px');
  lines.push('');

  // Apply status classes
  const statusGroups: Record<NodeStatus, string[]> = {
    pending: [],
    active: [],
    done: [],
    blocked: [],
  };

  for (const node of graph.nodes) {
    if (statusGroups[node.status]) {
      statusGroups[node.status].push(node.id);
    }
  }

  for (const [status, ids] of Object.entries(statusGroups)) {
    if (ids.length > 0) {
      lines.push(`    class ${ids.join(',')} ${status}`);
    }
  }

  // Apply critical path class (overrides status)
  if (criticalPath.length > 0) {
    lines.push(`    class ${criticalPath.join(',')} critical`);
  }

  return lines.join('\n');
}
