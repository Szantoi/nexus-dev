/**
 * Terminal Status MCP tools — terminal state, context persistence, and focus queue.
 *
 * Tools: register_working, register_idle, get_terminal_status,
 *        read_terminal_status_md, write_terminal_status_md, read_session_state,
 *        write_session_state, get_context_saturation, increment_turn_count,
 *        reset_turn_count, read_checkpoints_md, append_checkpoint_to_md,
 *        get_context_files_status, get_all_context_files_status, build_session_start_context,
 *        list_domain_memories, detect_task_domains
 */

import { toolRegistry, success, error } from './base-tool';
import { TERMINALS } from '../../../identity';
import {
  registerWorking,
  registerIdle,
  shouldWakeUp,
  getAllStatus,
  getStatus,
} from '../../../terminalStatus';
import {
  readStatusMd,
  writeStatusMd,
  readSessionState,
  writeSessionState,
  readTurnCount,
  incrementTurnCount,
  resetTurnCount,
  getContextSaturation,
  readCheckpointsMd,
  appendCheckpoint,
  getContextFilesStatus,
  getAllContextFilesStatus,
  buildSessionStartContext,
} from '../../../contextPersistence';
import {
  listAvailableMemories,
  detectDomains,
  hasKnowledgeFolder,
} from '../../../pipeline/knowledgeLoader';

export function registerTerminalStatusTools(): void {
  // ─── register_working ────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'register_working',
      description:
        'Register terminal as working on a task. Prevents wake-up notifications while busy.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          task_id: {
            type: 'string',
            description: 'Optional task ID being worked on',
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const taskId = args.task_id ? String(args.task_id) : undefined;
      registerWorking(terminal, taskId);
      return success({
        success: true,
        terminal,
        state: 'working',
        taskId,
        message: `Terminal ${terminal} registered as WORKING`,
      });
    }
  );

  // ─── register_idle ───────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'register_idle',
      description:
        'Register terminal as idle (finished task). Allows wake-up notifications.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      registerIdle(terminal);
      return success({
        success: true,
        terminal,
        state: 'idle',
        message: `Terminal ${terminal} registered as IDLE`,
      });
    }
  );

  // ─── get_terminal_status ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_terminal_status',
      description:
        'Get the working/idle status of a terminal or all terminals.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: 'Terminal name (optional - omit for all terminals)',
          },
        },
      },
    },
    async (args) => {
      const terminal = args.terminal ? String(args.terminal) : undefined;
      if (terminal) {
        const status = getStatus(terminal);
        return success({
          terminal,
          status: status || { state: 'idle', lastActivity: null },
          shouldWakeUp: shouldWakeUp(terminal),
        });
      } else {
        const allStatus = getAllStatus();
        return success({ terminals: allStatus });
      }
    }
  );

  // ─── read_terminal_status_md ─────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'read_terminal_status_md',
      description:
        'Read STATUS.md for a terminal - current state snapshot for goal re-anchoring.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const status = await readStatusMd(terminal);
        return success({
          success: true,
          exists: status !== null,
          ...(status || { terminal, note: 'STATUS.md not found for this terminal' }),
        });
      } catch (err) {
        return error(`Failed to read STATUS.md: ${err}`);
      }
    }
  );

  // ─── write_terminal_status_md ────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'write_terminal_status_md',
      description:
        'Update STATUS.md for a terminal - record current state, focus, and progress.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          system_status: {
            type: 'string',
            description: 'Current system status',
            enum: ['operational', 'in_progress', 'paused', 'blocked'],
          },
          current_focus: {
            type: 'string',
            description: 'Active task (e.g., MSG-BACKEND-045)',
          },
          recent_actions: {
            type: 'array',
            description: 'List of recent actions taken',
            items: { type: 'string' },
          },
          next_steps: {
            type: 'array',
            description: 'List of planned next steps',
            items: { type: 'string' },
          },
        },
        required: ['terminal', 'system_status'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const systemStatus = args.system_status as 'operational' | 'in_progress' | 'paused' | 'blocked';
      const currentFocus = args.current_focus ? String(args.current_focus) : undefined;
      const recentActions = args.recent_actions as string[] | undefined;
      const nextSteps = args.next_steps as string[] | undefined;

      try {
        const result = await writeStatusMd(terminal, {
          systemStatus,
          currentFocus,
          recentActions,
          nextSteps,
        });
        return success({
          success: true,
          terminal,
          path: result.path,
          message: `STATUS.md updated for ${terminal}`,
        });
      } catch (err) {
        return error(`Failed to write STATUS.md: ${err}`);
      }
    }
  );

  // ─── read_session_state ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'read_session_state',
      description:
        'Read .session-state.json for a terminal - cross-session goal recovery.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const state = await readSessionState(terminal);
        return success({
          success: true,
          terminal,
          exists: state !== null,
          sessionState: state,
        });
      } catch (err) {
        return error(`Failed to read session state: ${err}`);
      }
    }
  );

  // ─── write_session_state ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'write_session_state',
      description:
        'Update .session-state.json for a terminal - persist epic, progress, and checkpoint state.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          epic_id: {
            type: 'string',
            description: 'Epic ID (e.g., EPIC-CUTTING-Q3)',
          },
          epic_name: {
            type: 'string',
            description: 'Human-readable epic name',
          },
          epic_progress: {
            type: 'number',
            description: 'Progress percentage (0-100)',
          },
          next_checkpoint_id: {
            type: 'string',
            description: 'Next checkpoint ID',
          },
          next_checkpoint_name: {
            type: 'string',
            description: 'Next checkpoint name',
          },
          completed_checkpoints: {
            type: 'array',
            description: 'List of completed checkpoint IDs',
            items: { type: 'string' },
          },
          last_active_task: {
            type: 'string',
            description: 'Last active task ID',
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const result = await writeSessionState(terminal, {
          epicId: args.epic_id ? String(args.epic_id) : undefined,
          epicName: args.epic_name ? String(args.epic_name) : undefined,
          epicProgress: args.epic_progress !== undefined ? Number(args.epic_progress) : undefined,
          nextCheckpointId: args.next_checkpoint_id ? String(args.next_checkpoint_id) : undefined,
          nextCheckpointName: args.next_checkpoint_name ? String(args.next_checkpoint_name) : undefined,
          completedCheckpoints: args.completed_checkpoints as string[] | undefined,
          lastActiveTask: args.last_active_task ? String(args.last_active_task) : undefined,
        });
        return success({
          success: true,
          terminal,
          path: result.path,
          message: `.session-state.json updated for ${terminal}`,
        });
      } catch (err) {
        return error(`Failed to write session state: ${err}`);
      }
    }
  );

  // ─── get_context_saturation ──────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_context_saturation',
      description:
        'Get context saturation status for a terminal. Returns turn count and warning levels (ok/warning/critical).',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const saturation = await getContextSaturation(terminal);
        return success({ success: true, ...saturation });
      } catch (err) {
        return error(`Failed to get context saturation: ${err}`);
      }
    }
  );

  // ─── increment_turn_count ────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'increment_turn_count',
      description:
        'Increment .turn-count for a terminal. Used by Nightwatch for context saturation tracking.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          amount: {
            type: 'number',
            description: 'Amount to increment (default: 1)',
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const amount = args.amount !== undefined ? Number(args.amount) : 1;
      try {
        const result = await incrementTurnCount(terminal, amount);
        return success({
          success: true,
          terminal,
          count: result.count,
          warning: result.warning,
          critical: result.critical,
          needsReanchor: result.needsReanchor,
          message: result.critical
            ? `CRITICAL: Turn count ${result.count} exceeds 50. Consider re-anchoring.`
            : result.warning
              ? `WARNING: Turn count ${result.count} exceeds 30. Context saturation approaching.`
              : `Turn count incremented to ${result.count}.`,
        });
      } catch (err) {
        return error(`Failed to increment turn count: ${err}`);
      }
    }
  );

  // ─── reset_turn_count ────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'reset_turn_count',
      description:
        'Reset .turn-count to 0 for a terminal. Use after session restart or re-anchoring.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const result = await resetTurnCount(terminal);
        return success({
          success: true,
          terminal,
          path: result.path,
          message: `Turn count reset to 0 for ${terminal}.`,
        });
      } catch (err) {
        return error(`Failed to reset turn count: ${err}`);
      }
    }
  );

  // ─── read_checkpoints_md ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'read_checkpoints_md',
      description:
        'Read CHECKPOINTS.md for a terminal - milestone tracking and strategic decision points.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const checkpoints = await readCheckpointsMd(terminal);
        return success({
          success: true,
          exists: checkpoints !== null,
          ...(checkpoints || { terminal, note: 'CHECKPOINTS.md not found for this terminal' }),
        });
      } catch (err) {
        return error(`Failed to read CHECKPOINTS.md: ${err}`);
      }
    }
  );

  // ─── append_checkpoint_to_md ─────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'append_checkpoint_to_md',
      description:
        'Append a new checkpoint to CHECKPOINTS.md for a terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          date: {
            type: 'string',
            description: 'Checkpoint date (YYYY-MM-DD)',
          },
          name: {
            type: 'string',
            description: 'Checkpoint name',
          },
          decision: {
            type: 'string',
            description: 'Decision type (e.g., GO/NO-GO)',
          },
          evaluation_criteria: {
            type: 'array',
            description: 'Evaluation criteria list',
            items: { type: 'string' },
          },
          go_actions: {
            type: 'array',
            description: 'Actions if GO decision',
            items: { type: 'string' },
          },
          no_go_actions: {
            type: 'array',
            description: 'Actions if NO-GO decision',
            items: { type: 'string' },
          },
          refs: {
            type: 'array',
            description: 'Reference links',
            items: { type: 'string' },
          },
        },
        required: ['terminal', 'date', 'name', 'decision', 'evaluation_criteria', 'go_actions', 'no_go_actions'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const result = await appendCheckpoint(terminal, {
          date: String(args.date || ''),
          name: String(args.name || ''),
          decision: String(args.decision || ''),
          evaluationCriteria: args.evaluation_criteria as string[],
          goActions: args.go_actions as string[],
          noGoActions: args.no_go_actions as string[],
          refs: args.refs as string[] | undefined,
        });
        return success({
          success: true,
          terminal,
          path: result.path,
          message: `Checkpoint added to CHECKPOINTS.md for ${terminal}.`,
        });
      } catch (err) {
        return error(`Failed to append checkpoint: ${err}`);
      }
    }
  );

  // ─── get_context_files_status ────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_context_files_status',
      description:
        'Get status of all context persistence files for a terminal (STATUS.md, .session-state.json, .turn-count, CHECKPOINTS.md).',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const status = await getContextFilesStatus(terminal);
        return success({ success: true, ...status });
      } catch (err) {
        return error(`Failed to get context files status: ${err}`);
      }
    }
  );

  // ─── get_all_context_files_status ────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_all_context_files_status',
      description:
        'Get context persistence files status for ALL terminals. Overview of goal persistence readiness.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      try {
        const statuses = await getAllContextFilesStatus();
        return success({
          success: true,
          terminals: statuses,
          count: statuses.length,
        });
      } catch (err) {
        return error(`Failed to get all context files status: ${err}`);
      }
    }
  );

  // ─── build_session_start_context ─────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'build_session_start_context',
      description:
        'Build goal re-anchoring context for session start. Combines session state, context saturation, and STATUS.md.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      try {
        const context = await buildSessionStartContext(terminal);
        return success({
          success: true,
          terminal,
          context,
          note: 'Use this context for goal re-anchoring at session start.',
        });
      } catch (err) {
        return error(`Failed to build session start context: ${err}`);
      }
    }
  );

  // ─── list_domain_memories ────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_domain_memories',
      description:
        'List available domain-specific memory files for a terminal (ADR-049 Phase 3).',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const hasFolder = hasKnowledgeFolder(terminal);
      const memories = listAvailableMemories(terminal);
      return success({
        terminal,
        hasKnowledgeFolder: hasFolder,
        availableMemories: memories,
        count: memories.length,
      });
    }
  );

  // ─── detect_task_domains ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'detect_task_domains',
      description:
        'Detect relevant domains for a task description (ADR-049 Phase 3). Returns suggested memory files to load.',
      inputSchema: {
        type: 'object',
        properties: {
          task_description: {
            type: 'string',
            description: 'Task description text to analyze',
          },
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['task_description', 'terminal'],
      },
    },
    async (args) => {
      const taskDescription = String(args.task_description || '');
      const terminal = String(args.terminal || '');
      const domains = detectDomains(taskDescription, terminal);
      return success({
        terminal,
        taskDescription: taskDescription.slice(0, 100) + (taskDescription.length > 100 ? '...' : ''),
        detectedDomains: domains,
        count: domains.length,
      });
    }
  );
}
