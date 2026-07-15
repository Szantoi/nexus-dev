/**
 * Goal MCP tools — monitor-driven goal progression and memory management.
 *
 * Tools: create_goal, list_goals, get_goal, check_goal_criteria, trigger_goal, complete_goal,
 *        memory_health_report, compress_memory, extract_patterns,
 *        get_terminal_status_aggregate, resolve_epic_dependencies, transfer_session_context,
 *        match_domain_pattern, scaffold_react_hook, create_skill, list_all_skills,
 *        get_skill_metadata, delete_skill, get_epic_progress, get_all_epics_progress
 */

import { toolRegistry, success, error, type ToolContext } from './base-tool';
import { TERMINALS } from '../../../identity';
import {
  createGoal,
  listGoals,
  getGoal,
  triggerGoal,
  completeGoal,
  checkGoalCriteria,
  checkExpiredGoals,
  type CreateGoalParams,
  type GoalStatus,
} from '../../../goalStore';
import {
  getMemoryHealthReport,
  compressMemory,
  extractPatterns,
  type CompressMemoryParams,
  type ExtractPatternsParams,
} from '../../../memoryTools';
import { getTerminalStatusAggregate } from '../../../pipeline/terminalStatusAggregator';
import { resolveDependencies } from '../../../pipeline/dependencyResolver';
import { transferSessionContext } from '../../../pipeline/sessionContextTransfer';
import { matchDomainPattern } from '../../../pipeline/domainPatternMatcher';
import {
  createSkill,
  listSkills as listAllSkills,
  getSkillMetadata,
  deleteSkill,
  type CreateSkillParams,
} from '../../../pipeline/skillFactory';
import {
  getEpicProgress,
  getAllEpicsProgress,
} from '../../../pipeline/epicProgressTracker';
import { createTask } from '../../../mailbox';

export function registerGoalTools(): void {
  // ─── create_goal ─────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'create_goal',
      description:
        'Create a goal with completion criteria. When criteria are met, Monitor triggers specified terminal. Used by Conductor for Mode #4 continuous operation.',
      inputSchema: {
        type: 'object',
        properties: {
          created_by: {
            type: 'string',
            description: 'Terminal creating the goal (e.g., "conductor")',
          },
          epic_id: {
            type: 'string',
            description: 'Related epic ID (optional, e.g., "EPIC-CUTTING-Q3")',
          },
          description: {
            type: 'string',
            description: 'Human-readable goal description',
          },
          checkpoint_id: {
            type: 'string',
            description: 'Related checkpoint ID (optional)',
          },
          completion_criteria: {
            type: 'array',
            description: 'Completion criteria (all must be satisfied)',
            items: { type: 'object' },
          },
          trigger_terminal: {
            type: 'string',
            description: 'Terminal to trigger when goal completes (e.g., "conductor")',
          },
          next_goal: {
            type: 'string',
            description: 'Description of next goal (for chaining)',
          },
          prompt: {
            type: 'string',
            description: 'Prompt template for trigger message',
          },
          expires_in_hours: {
            type: 'number',
            description: 'Goal expiration in hours (optional)',
          },
        },
        required: ['created_by', 'description', 'completion_criteria', 'trigger_terminal', 'prompt'],
      },
    },
    async (args, ctx) => {
      const callerTerminal = ctx.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== 'conductor') {
        return error(`Terminal ${callerTerminal} cannot create goals. Only root and conductor can create goals.`);
      }

      const params: CreateGoalParams = {
        created_by: String(args.created_by || callerTerminal || 'unknown'),
        epic_id: args.epic_id ? String(args.epic_id) : undefined,
        description: String(args.description || ''),
        checkpoint_id: args.checkpoint_id ? String(args.checkpoint_id) : undefined,
        completion_criteria: (args.completion_criteria as CreateGoalParams['completion_criteria']) || [],
        trigger_terminal: String(args.trigger_terminal || 'conductor'),
        next_goal: args.next_goal ? String(args.next_goal) : undefined,
        prompt: String(args.prompt || ''),
        expires_in_hours: args.expires_in_hours ? Number(args.expires_in_hours) : undefined,
      };

      const goal = await createGoal(params);
      return success({
        success: true,
        goal_id: goal.id,
        status: goal.status,
        message: `Goal created: ${goal.id}`,
        goal,
      });
    }
  );

  // ─── list_goals ──────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_goals',
      description:
        'List goals by status. Returns all active goals being watched by Monitor.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by status (optional, returns all if omitted)',
            enum: ['watching', 'triggered', 'completed', 'expired'],
          },
        },
      },
    },
    async (args) => {
      const status = args.status ? String(args.status) as GoalStatus : undefined;
      const goals = await listGoals(status);
      return success({
        count: goals.length,
        status: status || 'all',
        goals,
      });
    }
  );

  // ─── get_goal ────────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_goal',
      description:
        'Get a specific goal by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID (e.g., "GOAL-2026-07-04-001")',
          },
        },
        required: ['goal_id'],
      },
    },
    async (args) => {
      const goalId = String(args.goal_id || '');
      const goal = await getGoal(goalId);
      if (!goal) {
        return error(`Goal not found: ${goalId}`);
      }
      return success({ success: true, goal });
    }
  );

  // ─── check_goal_criteria ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'check_goal_criteria',
      description:
        'Check if goal criteria are met. Used by Monitor during Nightwatch cycles.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID to check',
          },
        },
        required: ['goal_id'],
      },
    },
    async (args) => {
      const goalId = String(args.goal_id || '');
      const goal = await getGoal(goalId);
      if (!goal) {
        return error(`Goal not found: ${goalId}`);
      }

      const { allMet, results } = await checkGoalCriteria(goal);
      return success({
        success: true,
        goal_id: goalId,
        all_criteria_met: allMet,
        results,
      });
    }
  );

  // ─── trigger_goal ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'trigger_goal',
      description:
        'Mark goal as triggered and notify target terminal. Used by Monitor when criteria are met.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID to trigger',
          },
        },
        required: ['goal_id'],
      },
    },
    async (args, ctx) => {
      const callerTerminal = ctx.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== 'monitor') {
        return error(`Terminal ${callerTerminal} cannot trigger goals. Only root and monitor can trigger goals.`);
      }

      const goalId = String(args.goal_id || '');
      const goal = await getGoal(goalId);
      if (!goal) {
        return error(`Goal not found: ${goalId}`);
      }

      const { allMet, results } = await checkGoalCriteria(goal);
      if (!allMet) {
        return success({
          success: false,
          error: 'Not all criteria are met',
          results,
        });
      }

      const triggerResult = await createTask({
        from: 'monitor',
        to: goal.on_complete.trigger_terminal,
        title: `Goal Completed: ${goal.goal.description}`,
        description: goal.on_complete.prompt
          .replace(/\{\{goal\.description\}\}/g, goal.goal.description)
          .replace(/\{\{on_complete\.next_goal\}\}/g, goal.on_complete.next_goal || '')
          .replace(/\{\{completed_criteria\}\}/g, results.map(r => `- ${r.met ? '✓' : '✗'} ${r.criterion.type}: ${r.details}`).join('\n')),
        priority: 'high',
        model: 'sonnet',
        ref: goalId,
      });

      const triggerId = triggerResult.id || 'unknown';
      await triggerGoal(goalId, triggerId, results);

      return success({
        success: true,
        goal_id: goalId,
        trigger_message_id: triggerId,
        target_terminal: goal.on_complete.trigger_terminal,
        message: `Goal triggered, notification sent to ${goal.on_complete.trigger_terminal}`,
      });
    }
  );

  // ─── complete_goal ───────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'complete_goal',
      description:
        'Mark goal as completed. Called after trigger_terminal processes the goal.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID to complete',
          },
        },
        required: ['goal_id'],
      },
    },
    async (args) => {
      const goalId = String(args.goal_id || '');
      const goal = await completeGoal(goalId);
      if (!goal) {
        return error(`Goal not found: ${goalId}`);
      }
      return success({
        success: true,
        goal_id: goalId,
        status: goal.status,
        completed_at: goal.completed_at,
        message: `Goal completed: ${goalId}`,
      });
    }
  );

  // ─── memory_health_report ────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'memory_health_report',
      description:
        'Get fleet-wide memory health status in one call. Returns size, staleness, duplicate ratio, and suggested actions for all terminals.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const report = await getMemoryHealthReport();
      return success(report);
    }
  );

  // ─── compress_memory ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'compress_memory',
      description:
        'Automatic memory compression with pattern detection. Supports dry_run mode for safe preview.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          strategy: {
            type: 'string',
            description: 'Compression level',
            enum: ['aggressive', 'moderate', 'conservative'],
          },
          preserve_sections: {
            type: 'array',
            description: 'Section headers to preserve (optional)',
            items: { type: 'string' },
          },
          dry_run: {
            type: 'boolean',
            description: 'Preview compression without writing (default: true)',
          },
        },
        required: ['terminal', 'strategy'],
      },
    },
    async (args) => {
      const params: CompressMemoryParams = {
        terminal: String(args.terminal || ''),
        strategy: (args.strategy as 'aggressive' | 'moderate' | 'conservative') || 'moderate',
        preserve_sections: (args.preserve_sections as string[]) || undefined,
        dry_run: args.dry_run !== false,
      };
      const result = await compressMemory(params);
      return success(result);
    }
  );

  // ─── extract_patterns ────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'extract_patterns',
      description:
        'Cross-terminal pattern mining for knowledge extraction. Finds repeating workflows, decisions, and error resolutions.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name or 'all' for fleet-wide: ${TERMINALS.join(', ')}, all`,
          },
          min_frequency: {
            type: 'number',
            description: 'Minimum pattern frequency (default: 3)',
          },
          pattern_types: {
            type: 'array',
            description: 'Pattern types to extract',
            items: { type: 'string' },
          },
        },
        required: ['terminal', 'pattern_types'],
      },
    },
    async (args) => {
      const params: ExtractPatternsParams = {
        terminal: String(args.terminal || 'all'),
        min_frequency: Number(args.min_frequency) || 3,
        pattern_types: (args.pattern_types as Array<'workflow' | 'decision' | 'error_resolution'>) || [],
      };
      const result = await extractPatterns(params);
      return success(result);
    }
  );

  // ─── get_terminal_status_aggregate ───────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_terminal_status_aggregate',
      description:
        'Get aggregated status from all 7 terminals. Shows working/idle/stuck states, context saturation, health scores, and alerts.',
      inputSchema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'Output format (default: summary)',
            enum: ['summary', 'detailed', 'alerts_only'],
          },
        },
      },
    },
    async (args) => {
      const format = (args.format as 'summary' | 'detailed' | 'alerts_only') || 'summary';
      const result = await getTerminalStatusAggregate(format);
      return success(result);
    }
  );

  // ─── resolve_epic_dependencies ───────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'resolve_epic_dependencies',
      description:
        'Resolve epic dependencies from EPICS.yaml. Identifies blockers, ready tasks, and validates dependency graph.',
      inputSchema: {
        type: 'object',
        properties: {
          epic_id: {
            type: 'string',
            description: 'Epic ID (e.g., "EPIC-CUTTING-Q3")',
          },
          check_blockers: {
            type: 'boolean',
            description: 'Validate blocker resolution (default: true)',
          },
        },
        required: ['epic_id'],
      },
    },
    async (args) => {
      const epicId = String(args.epic_id || '');
      const checkBlockers = args.check_blockers !== false;
      const result = await resolveDependencies(epicId, checkBlockers);
      return success(result);
    }
  );

  // ─── transfer_session_context ────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'transfer_session_context',
      description:
        'Transfer context between terminals via inbox messages.',
      inputSchema: {
        type: 'object',
        properties: {
          from_terminal: {
            type: 'string',
            description: 'Source terminal',
          },
          to_terminal: {
            type: 'string',
            description: 'Target terminal',
          },
          context_type: {
            type: 'string',
            description: 'Context transfer type',
            enum: ['research_summary', 'code_audit', 'knowledge_synthesis'],
          },
          summary: {
            type: 'string',
            description: 'Context summary (optional)',
          },
          include_files: {
            type: 'array',
            description: 'Files to reference (max 20)',
            items: { type: 'string' },
          },
        },
        required: ['from_terminal', 'to_terminal', 'context_type'],
      },
    },
    async (args) => {
      const result = await transferSessionContext({
        fromTerminal: String(args.from_terminal || ''),
        toTerminal: String(args.to_terminal || ''),
        contextType: args.context_type as 'research_summary' | 'code_audit' | 'knowledge_synthesis',
        summary: args.summary ? String(args.summary) : undefined,
        includeFiles: (args.include_files as string[]) || [],
      });
      return success(result);
    }
  );

  // ─── match_domain_pattern ────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'match_domain_pattern',
      description:
        'Match description to known domain patterns with confidence scores and recommendations.',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Problem/feature description (max 500 chars)',
          },
          domain: {
            type: 'string',
            description: 'Filter by domain (optional)',
            enum: ['crm', 'controlling', 'procurement', 'ehs', 'cutting', 'joinery', 'kernel', 'general'],
          },
        },
        required: ['description'],
      },
    },
    async (args) => {
      const result = await matchDomainPattern(
        String(args.description || ''),
        args.domain ? String(args.domain) : undefined
      );
      return success(result);
    }
  );

  // ─── create_skill ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'create_skill',
      description:
        'Create a new skill from workflow template. Skill is saved to .claude/skills/ and becomes available immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name (kebab-case, alphanumeric + hyphens only)',
          },
          template: {
            type: 'string',
            description: 'Skill content (markdown template)',
          },
          description: {
            type: 'string',
            description: 'Short skill description (optional)',
          },
          terminal: {
            type: 'string',
            description: 'Specific terminal (e.g., backend, frontend) (optional)',
          },
          trigger_patterns: {
            type: 'array',
            description: 'Trigger patterns (e.g., ["git conflict", "merge issue"]) (optional)',
            items: { type: 'string' },
          },
        },
        required: ['name', 'template'],
      },
    },
    async (args) => {
      const params: CreateSkillParams = {
        name: String(args.name || ''),
        template: String(args.template || ''),
        description: args.description ? String(args.description) : undefined,
        terminal: args.terminal ? String(args.terminal) : undefined,
        trigger_patterns: args.trigger_patterns as string[] | undefined,
      };
      const result = await createSkill(params);
      return success(result);
    }
  );

  // ─── list_all_skills ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_all_skills',
      description:
        'List all skills in .claude/skills/ with metadata.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const skills = await listAllSkills();
      return success({ count: skills.length, skills });
    }
  );

  // ─── get_skill_metadata ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_skill_metadata',
      description:
        'Get metadata for a specific skill.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name',
          },
        },
        required: ['name'],
      },
    },
    async (args) => {
      const name = String(args.name || '');
      const metadata = await getSkillMetadata(name);
      if (!metadata) {
        return error(`Skill not found: ${name}`);
      }
      return success(metadata);
    }
  );

  // ─── delete_skill ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'delete_skill',
      description:
        'Delete a skill from .claude/skills/.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name to delete',
          },
        },
        required: ['name'],
      },
    },
    async (args) => {
      const name = String(args.name || '');
      const result = await deleteSkill(name);
      return success(result);
    }
  );

  // ─── get_epic_progress ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_epic_progress',
      description:
        'Get progress for a specific epic.',
      inputSchema: {
        type: 'object',
        properties: {
          epic_id: {
            type: 'string',
            description: 'Epic ID (e.g., "EPIC-CUTTING-Q3")',
          },
        },
        required: ['epic_id'],
      },
    },
    async (args) => {
      const epicId = String(args.epic_id || '');
      const progress = await getEpicProgress(epicId);
      return success(progress);
    }
  );

  // ─── get_all_epics_progress ──────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_all_epics_progress',
      description:
        'Get progress for all epics.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const progress = await getAllEpicsProgress();
      return success(progress);
    }
  );
}
