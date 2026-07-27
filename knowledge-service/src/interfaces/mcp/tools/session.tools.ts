/**
 * Session MCP tools — work sessions, memory tiers, retrospective, handoff, digest.
 *
 * Tools: request_work_session, spawn_work_session, save_tiered_memory, promote_memory,
 *        get_session_context, run_retrospective, apply_retrospective, generate_handoff,
 *        generate_daily_digest
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { toolRegistry, success, error, type ToolContext } from './base-tool';
import { getTerminalsPath } from '../../../config/paths';
import { TERMINALS } from '../../../identity';
import { logger } from '../../../core/logger';
import {
  saveTieredMemory,
  queryByTier,
  promoteMemory,
} from '../../../pipeline/ftsMemoryStore';
import { buildStartContext } from '../../../sessionHooks';
import { runRetrospective, applyRetrospective } from '../../../retrospective';
import { generateHandoff } from '../../../handoff';
import { generateDailyDigest } from '../../../digest';

export function registerSessionTools(): void {
  // ─── request_work_session ────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'request_work_session',
      description:
        'Request a work session from your chat session. This sends a request to the Conductor, who will decide which terminal should handle the task.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Detailed task description - what needs to be done',
          },
          suggested_terminal: {
            type: 'string',
            description: `Optional: suggest which terminal should handle it: ${TERMINALS.join(', ')}. Conductor may override.`,
          },
          priority: {
            type: 'string',
            description: 'Task priority',
            enum: ['critical', 'high', 'medium', 'low'],
          },
          context: {
            type: 'string',
            description: 'Additional context from the user conversation',
          },
        },
        required: ['task'],
      },
    },
    async (args, ctx) => {
      const callerTerminal = ctx.terminal;
      const task = String(args.task || '');
      const suggestedTerminal = args.suggested_terminal ? String(args.suggested_terminal) : undefined;
      const priority = (args.priority as 'critical' | 'high' | 'medium' | 'low') || 'medium';
      const context = args.context ? String(args.context) : '';

      if (!task) {
        return error('Task description is required');
      }

      const { logWorkSessionRequest, hashTask } = await import('../../../pipeline/workSessionLog');
      const taskHash = await hashTask(task);

      const timestamp = new Date().toISOString();
      const messageId = `WORK-REQ-${Date.now()}`;

      const requestContent = `---
id: ${messageId}
from: ${callerTerminal || 'chat-session'}
to: conductor
type: work-request
priority: ${priority}
status: UNREAD
created: ${timestamp.split('T')[0]}
---

# Work Session Request

## Task
${task}

## Context
${context || 'No additional context provided.'}

## Suggested Terminal
${suggestedTerminal || 'Let Conductor decide based on task type.'}

## Source
Requested by ${callerTerminal || 'unknown'} chat session.
`;

      const TERMINALS_ROOT = getTerminalsPath();
      const inboxPath = path.join(TERMINALS_ROOT, 'conductor', 'inbox');
      const filename = `${timestamp.split('T')[0]}_${messageId.toLowerCase()}.md`;

      try {
        await fs.writeFile(path.join(inboxPath, filename), requestContent, 'utf-8');

        const logEntry = await logWorkSessionRequest({
          from_terminal: callerTerminal || 'unknown',
          task_summary: task.slice(0, 200),
          task_hash: taskHash,
          priority,
          suggested_terminal: suggestedTerminal,
          conductor_inbox_file: filename,
          success: true,
        });

        logger.info(`[MCP] Work session request created: ${logEntry.request_id} (inbox: ${messageId})`);

        try {
          const { injectToChatSession } = await import('../../../chatSessionStarter');
          await injectToChatSession('conductor', `[WORK REQUEST] ${callerTerminal} kér work session-t: ${task.slice(0, 100)}...`);
        } catch {
          // Chat session not running, inbox will be picked up
        }

        return success({
          success: true,
          request_id: logEntry.request_id,
          messageId,
          message: 'Work session request sent to Conductor',
          task: task.slice(0, 100) + '...',
          suggestedTerminal,
          priority,
        });
      } catch (err) {
        await logWorkSessionRequest({
          from_terminal: callerTerminal || 'unknown',
          task_summary: task.slice(0, 200),
          task_hash: taskHash,
          priority,
          suggested_terminal: suggestedTerminal,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });

        return error(`Failed to create work request: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ─── spawn_work_session ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'spawn_work_session',
      description:
        'CONDUCTOR/ROOT ONLY: Queue an audited work request for the autonomous runner. Regular terminals should use request_work_session instead.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal to spawn work session for: ${TERMINALS.join(', ')}`,
          },
          task: {
            type: 'string',
            description: 'Task description to pass to the work session',
          },
          model: {
            type: 'string',
            description: 'Model to use (default: sonnet). Options: haiku, sonnet, opus',
            enum: ['haiku', 'sonnet', 'opus'],
          },
        },
        required: ['terminal', 'task'],
      },
    },
    async (args, ctx) => {
      const callerTerminal = ctx.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== 'conductor') {
        return error(`Only Conductor and Root can queue work sessions. Use request_work_session instead.`);
      }

      const terminal = String(args.terminal || '');
      const task = String(args.task || '');
      const model = args.model ? String(args.model) : 'sonnet';
      const requestId = args.request_id ? String(args.request_id) : undefined;

      if (!terminal || !task) {
        return error('Terminal and task are required');
      }
      if (!TERMINALS.includes(terminal as (typeof TERMINALS)[number])) {
        return error(`Unknown terminal: ${terminal}`);
      }
      if (!['haiku', 'sonnet', 'opus'].includes(model)) {
        return error('Model must be one of: haiku, sonnet, opus');
      }

      const { logWorkSessionSpawn, hashTask } = await import('../../../pipeline/workSessionLog');
      const taskHash = await hashTask(task);
      const { createTask } = await import('../../../mailbox');
      const queued = await createTask({
        from: callerTerminal,
        to: terminal,
        title: `Work request from ${callerTerminal}`,
        description: task,
        acceptance_criteria: [
          'Set a precise goal, measurable success criteria and exit condition.',
          'Run and record the relevant quality checks.',
          'Update task notes, state.md, todo.md and MEMORY.md before completion.',
        ],
        priority: 'high',
        model: model as 'haiku' | 'sonnet' | 'opus',
        ref: requestId,
        context: `requested_by=${callerTerminal}; task_hash=${taskHash}`,
      });
      const result = {
        success: queued.success,
        message: queued.success
          ? `Work request queued as ${queued.id}`
          : `Failed to queue work request: ${queued.error}`,
        sessionName: queued.id ? `queued:${queued.id}` : undefined,
        requestId: queued.id,
      };

      const logEntry = await logWorkSessionSpawn({
        terminal,
        session_name: result.sessionName || `spaceos-${terminal}`,
        model,
        task_summary: task.slice(0, 200),
        task_hash: taskHash,
        spawned_by: callerTerminal || 'unknown',
        request_id: requestId,
        success: result.success,
        error: result.success ? undefined : result.message,
      });

      logger.info(`[MCP] Work session spawn logged: ${logEntry.spawn_id} for ${terminal}`);

      return success({
        ...result,
        spawn_id: logEntry.spawn_id,
      });
    }
  );

  // ─── save_tiered_memory ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'save_tiered_memory',
      description:
        'Save a memory with explicit tier assignment (hot/warm/cold/shared)',
      inputSchema: {
        type: 'object',
        properties: {
          tier: {
            type: 'string',
            description: 'Memory tier: hot (48h, high priority), warm (14d), cold (365d), shared (global)',
            enum: ['hot', 'warm', 'cold', 'shared'],
          },
          type: {
            type: 'string',
            description: 'Memory type',
            enum: ['semantic', 'episodic', 'procedural'],
          },
          source: {
            type: 'string',
            description: 'Memory source',
            enum: ['conversation', 'document', 'skill', 'digest', 'manual'],
          },
          content: {
            type: 'string',
            description: 'Memory content',
          },
          terminal: {
            type: 'string',
            description: 'Terminal name (optional for shared tier)',
          },
          context: {
            type: 'string',
            description: 'Additional context (optional)',
          },
          salience: {
            type: 'number',
            description: 'Salience score 0.0-1.0 (default: 0.5)',
          },
        },
        required: ['tier', 'type', 'source', 'content'],
      },
    },
    async (args) => {
      const tier = args.tier as 'hot' | 'warm' | 'cold' | 'shared';
      const type = args.type as 'semantic' | 'episodic' | 'procedural';
      const source = args.source as 'conversation' | 'document' | 'skill' | 'digest' | 'manual';
      const content = String(args.content || '');
      const terminal = args.terminal ? String(args.terminal) : undefined;
      const context = args.context ? String(args.context) : undefined;
      const salience = args.salience ? Number(args.salience) : undefined;

      const memory = await saveTieredMemory({
        tier,
        type,
        source,
        content,
        terminal,
        context,
        salience,
      });

      return success({
        success: true,
        memory: {
          id: memory.id,
          tier: memory.tier,
          type: memory.type,
          content: memory.content.substring(0, 100) + (memory.content.length > 100 ? '...' : ''),
          salience: memory.salience,
        },
      });
    }
  );

  // ─── promote_memory ──────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'promote_memory',
      description:
        'Promote a memory to a higher tier (e.g., hot→warm, warm→cold, cold→shared)',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: {
            type: 'number',
            description: 'Memory ID to promote',
          },
          new_tier: {
            type: 'string',
            description: 'Target tier',
            enum: ['hot', 'warm', 'cold', 'shared'],
          },
          reason: {
            type: 'string',
            description: 'Reason for promotion',
          },
        },
        required: ['memory_id', 'new_tier', 'reason'],
      },
    },
    async (args) => {
      const memoryId = Number(args.memory_id || 0);
      const newTier = args.new_tier as 'hot' | 'warm' | 'cold' | 'shared';
      const reason = String(args.reason || '');

      await promoteMemory(memoryId, newTier, reason);

      return success({
        success: true,
        memoryId,
        newTier,
        reason,
        message: `Memory #${memoryId} promoted to ${newTier}`,
      });
    }
  );

  // ─── get_session_context ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_session_context',
      description:
        'Get cold start context for a terminal (hot+warm+shared memories)',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          task_id: {
            type: 'string',
            description: 'Task ID (optional)',
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const taskId = args.task_id ? String(args.task_id) : undefined;

      const context = await buildStartContext({
        terminal,
        taskId,
        inboxMessageId: taskId,
      });

      return success({
        terminal,
        taskId,
        memoriesLoaded: context.memoriesLoaded,
        hotMemories: context.hotMemories.length,
        warmMemories: context.warmMemories.length,
        sharedMemories: context.sharedMemories.length,
        contextTokens: context.contextTokens,
        contextMarkdown: context.contextMarkdown,
      });
    }
  );

  // ─── run_retrospective ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'run_retrospective',
      description:
        'Analyze session history and generate improvement proposals (skills, memory, workflow)',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          scope: {
            type: 'string',
            description: 'Analysis scope',
            enum: ['session', 'last-task', 'last-hour'],
          },
          focus: {
            type: 'string',
            description: 'Analysis focus',
            enum: ['skills', 'memory', 'workflow', 'all'],
          },
          session_id: {
            type: 'number',
            description: 'Specific session ID (required if scope=session)',
          },
        },
        required: ['terminal', 'scope', 'focus'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const scope = args.scope as 'session' | 'last-task' | 'last-hour';
      const focus = args.focus as 'skills' | 'memory' | 'workflow' | 'all';
      const sessionId = args.session_id ? Number(args.session_id) : undefined;

      const result = await runRetrospective({
        terminal,
        scope,
        focus,
        sessionId,
      });

      return success({
        success: true,
        sessionSummary: result.sessionSummary,
        proposalsCount: result.proposals.length,
        proposals: result.proposals.map((p) => ({
          id: p.id,
          type: p.type,
          action: p.action,
          target: p.target,
          reason: p.reason,
          priority: p.priority,
        })),
      });
    }
  );

  // ─── apply_retrospective ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'apply_retrospective',
      description:
        'Apply approved retrospective proposals (create skills, save memories, etc.)',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          proposal_ids: {
            type: 'array',
            description: 'Array of approved proposal IDs',
            items: { type: 'number' },
          },
        },
        required: ['terminal', 'proposal_ids'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const proposalIds = (args.proposal_ids as number[]) || [];

      const result = await applyRetrospective({
        terminal,
        approvedProposals: proposalIds,
      });

      return success({
        success: true,
        executedCount: result.executedCount,
        skillsCreated: result.skillsCreated,
        memoriesSaved: result.memoriesSaved,
        workflowsUpdated: result.workflowsUpdated,
        errors: result.errors,
      });
    }
  );

  // ─── generate_handoff ────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_handoff',
      description:
        'Generate HANDOFF.md document for session/task transfer',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          purpose: {
            type: 'string',
            description: 'Handoff purpose',
          },
          target: {
            type: 'string',
            description: 'Target terminal or "next-session" (optional)',
          },
          output: {
            type: 'string',
            description: 'Output format: file (save to disk) or message (return markdown)',
            enum: ['file', 'message'],
          },
          goal: {
            type: 'string',
            description: 'Goal description (optional)',
          },
        },
        required: ['terminal', 'purpose', 'output'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const purpose = String(args.purpose || '');
      const target = args.target ? String(args.target) : undefined;
      const output = args.output as 'file' | 'message';
      const goal = args.goal ? String(args.goal) : undefined;

      const result = await generateHandoff({
        terminal,
        purpose,
        target,
        output,
        goal,
      });

      return success({
        success: result.success,
        filePath: result.filePath,
        document: {
          purpose: result.document.purpose,
          from: result.document.from,
          to: result.document.to,
          goal: result.document.goal,
          currentProgress: result.document.currentProgress.length,
          nextSteps: result.document.nextSteps.length,
        },
        markdown: output === 'message' ? result.markdown : undefined,
      });
    }
  );

  // ─── generate_daily_digest ───────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_daily_digest',
      description:
        'Generate daily digest summary for a terminal (Track D)',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format (optional, defaults to today)',
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const date = args.date ? String(args.date) : new Date().toISOString().split('T')[0];

      const result = await generateDailyDigest({ terminal, date });

      return success({
        success: true,
        terminal: result.terminal,
        date: result.date,
        sessionCount: result.sessionCount,
        memoriesCreated: result.memoriesCreated,
        toolCallsTotal: result.toolCallsTotal,
        tasksCompleted: result.tasksCompleted,
        tasksBlocked: result.tasksBlocked,
        summary: result.summary,
        savedAsMemory: result.savedAsMemory,
        digestMarkdown: result.digestMarkdown,
      });
    }
  );
}
