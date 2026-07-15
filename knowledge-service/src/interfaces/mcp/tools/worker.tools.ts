/**
 * Worker MCP tools — parallel work sessions, worker management, subscriptions.
 *
 * Tools: spawn_parallel_workers, spawn_raw_workers, get_worker_status, get_service_status,
 *        scaffold_react_hook, subscription tools (subscribe_to_task, subscribe_to_terminal, etc.)
 */

import { toolRegistry, success, error } from './base-tool';
import { TERMINALS } from '../../../identity';
import { logger } from '../../../core/logger';
import { getDocumentCount, usingChroma } from '../../../vectorStore';
import { embeddingBackend } from '../../../embeddings';
import {
  startParallelWorkSession,
  spawnRawWorkers,
  collectRawResults,
} from '../../../sessionStarter';
import {
  getActiveWorkers,
  registerWorker,
  markWorkerDone,
  markWorkerFailed,
} from '../../../pipeline/workerRegistry';
import {
  validateDependencies,
  getParallelBatches,
} from '../../../pipeline/dagValidator';
import {
  getCurrentHourlyCost,
  calculateMaxParallel,
  checkCostAlerts,
} from '../../../pipeline/costLimiter';
import {
  selectBestResultWithChat,
  selectBestResultAutomatic,
  type RawResult,
} from '../../../pipeline/bestOfN';
import {
  SUBSCRIPTION_TOOLS,
  handleSubscriptionTool,
} from '../../../pipeline/subscriptionTools';

export function registerWorkerTools(): void {
  // ─── spawn_parallel_workers ──────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'spawn_parallel_workers',
      description:
        'Spawn multiple parallel work sessions for independent tasks with dependency management',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: 'Terminal name to spawn workers for',
          },
          tasks: {
            type: 'array',
            description: 'Array of tasks to spawn',
            items: { type: 'object' },
          },
        },
        required: ['terminal', 'tasks'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal);
      const tasks = args.tasks as Array<{
        id: string;
        prompt: string;
        model?: 'haiku' | 'sonnet' | 'opus';
        depends_on?: string[];
      }>;

      if (!terminal || !tasks || !Array.isArray(tasks)) {
        return error('terminal and tasks array are required');
      }

      const workTasks = tasks.map(t => ({
        id: t.id,
        depends_on: t.depends_on || [],
      }));
      const validation = validateDependencies(workTasks);

      if (!validation.valid) {
        return success({
          success: false,
          error: validation.error,
        });
      }

      const batches = getParallelBatches(workTasks);
      const firstBatch = batches[0] || [];
      const results = await Promise.all(
        firstBatch.map(async (taskId) => {
          const task = tasks.find(t => t.id === taskId);
          if (!task) {
            return {
              taskId,
              success: false,
              message: 'Task not found',
            };
          }

          const result = await startParallelWorkSession({
            terminal,
            taskId: task.id,
            prompt: task.prompt,
            model: task.model || 'sonnet',
            depends_on: task.depends_on,
          });

          return {
            taskId: task.id,
            success: result.success,
            workerId: result.workerId,
            message: result.message,
          };
        })
      );

      return success({
        success: true,
        started: results,
        queued: batches.slice(1).flat(),
        totalBatches: batches.length,
        executionOrder: validation.executionOrder,
      });
    }
  );

  // ─── spawn_raw_workers ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'spawn_raw_workers',
      description:
        'Spawn multiple raw workers for quick prototyping or best-of-N selection',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: 'Terminal name to spawn workers for',
          },
          task: {
            type: 'string',
            description: 'Task prompt to execute',
          },
          count: {
            type: 'number',
            description: 'Number of workers to spawn (2-5)',
          },
          model: {
            type: 'string',
            description: 'Model to use (default: haiku)',
            enum: ['haiku', 'sonnet'],
          },
          criteria: {
            type: 'string',
            description: 'Selection criteria for choosing best result',
          },
        },
        required: ['terminal', 'task', 'count', 'criteria'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal);
      const task = String(args.task);
      const count = Number(args.count);
      const model = (args.model as 'haiku' | 'sonnet') || 'haiku';
      const criteria = String(args.criteria);

      if (!terminal || !task || !count || !criteria) {
        return error('terminal, task, count, and criteria are required');
      }

      if (count < 2 || count > 5) {
        return error('count must be between 2 and 5');
      }

      const spawnResult = await spawnRawWorkers({
        terminal,
        task,
        count,
        model,
      });

      if (!spawnResult.success || !spawnResult.workerIds) {
        return success({
          success: false,
          message: spawnResult.message,
        });
      }

      const timeout = 5 * 60 * 1000;
      const startTime = Date.now();
      let allDone = false;
      let results: Array<{ workerId: string; output: string; status: 'done' | 'running' | 'failed' }> = [];

      while (!allDone && (Date.now() - startTime) < timeout) {
        results = await collectRawResults(terminal, spawnResult.workerIds);
        allDone = results.every(r => r.status === 'done' || r.status === 'failed');

        if (!allDone) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      const completedResults = results.filter(r => r.status === 'done');

      if (completedResults.length === 0) {
        return success({
          success: false,
          message: 'No workers completed successfully within timeout',
          results,
        });
      }

      const rawResults: RawResult[] = completedResults.map(r => ({
        workerId: r.workerId,
        output: r.output,
        status: r.status,
      }));

      const selection = selectBestResultAutomatic(rawResults, criteria);

      return success({
        success: true,
        bestResult: selection,
        totalWorkers: count,
        completedWorkers: completedResults.length,
        criteria,
      });
    }
  );

  // ─── get_worker_status ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_worker_status',
      description:
        'Get status of all workers for a terminal, including cost and capacity information',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: 'Terminal name to get worker status for',
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal);

      if (!terminal) {
        return error('terminal is required');
      }

      const workers = getActiveWorkers(terminal);
      const currentHourlyCost = getCurrentHourlyCost(terminal);
      const maxParallel = calculateMaxParallel(terminal);
      const costAlert = checkCostAlerts(terminal);

      return success({
        terminal,
        workers: workers.map(w => ({
          id: w.id,
          taskId: w.taskId,
          status: w.status,
          model: w.model,
          startedAt: w.startedAt,
          depends_on: w.depends_on,
          sessionName: w.sessionName,
        })),
        activeCount: workers.filter(w => w.status === 'running').length,
        queuedCount: workers.filter(w => w.status === 'queued').length,
        currentHourlyCost,
        maxParallel,
        alertLevel: costAlert,
        capacity: {
          current: workers.filter(w => w.status === 'running').length,
          max: maxParallel,
          available: Math.max(0, maxParallel - workers.filter(w => w.status === 'running').length),
        },
      });
    }
  );

  // ─── get_service_status ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_service_status',
      description:
        'Get the health status of the SpaceOS Knowledge Service.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const count = await getDocumentCount();
      // Note: TOOLS.length won't work after migration; use toolRegistry
      const { toolRegistry: reg } = await import('./base-tool');
      const toolCount = reg.getDefinitions().length;

      return success({
        status: 'ok',
        vectorBackend: usingChroma() ? 'chromadb' : 'memory',
        embeddingBackend: embeddingBackend(),
        documents: count,
        terminals: TERMINALS.length,
        tools: toolCount,
      });
    }
  );

  // ─── scaffold_react_hook ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'scaffold_react_hook',
      description:
        'Generate React hook scaffold with tests and optional caching.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Hook name (e.g., useCostBudget, useQuoteRequest)',
          },
          type: {
            type: 'string',
            description: 'Hook type',
            enum: ['query', 'mutation', 'state', 'effect'],
          },
          with_test: {
            type: 'boolean',
            description: 'Generate tests (default: true)',
          },
          with_cache: {
            type: 'boolean',
            description: 'Add caching logic (default: false)',
          },
          endpoint: {
            type: 'string',
            description: 'API endpoint for query hooks (optional)',
          },
        },
        required: ['name', 'type'],
      },
    },
    async (args) => {
      // This is a simpler scaffold tool, not the full generateHook
      const name = String(args.name || '');
      const type = String(args.type) as 'query' | 'mutation' | 'state' | 'effect';
      const withTest = args.with_test !== false;
      const withCache = Boolean(args.with_cache);
      const endpoint = args.endpoint ? String(args.endpoint) : undefined;

      const scaffoldContent = `// Generated hook scaffold: ${name}
// Type: ${type}
// Cache: ${withCache}
// Endpoint: ${endpoint || 'N/A'}

import { ${type === 'query' || type === 'mutation' ? 'useQuery, useMutation' : 'useState, useEffect'} } from '${type === 'query' || type === 'mutation' ? '@tanstack/react-query' : 'react'}';

export function ${name}() {
  // TODO: Implement ${type} hook
  ${type === 'query' ? `return useQuery({
    queryKey: ['${name.replace(/^use/, '').toLowerCase()}'],
    queryFn: async () => {
      const response = await fetch('${endpoint || '/api/todo'}');
      return response.json();
    },
  });` : ''}
  ${type === 'mutation' ? `return useMutation({
    mutationFn: async (data: unknown) => {
      const response = await fetch('${endpoint || '/api/todo'}', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return response.json();
    },
  });` : ''}
  ${type === 'state' ? `const [state, setState] = useState(null);
  return { state, setState };` : ''}
  ${type === 'effect' ? `useEffect(() => {
    // TODO: Implement effect
  }, []);` : ''}
}
`;

      return success({
        success: true,
        hookName: name,
        type,
        withTest,
        withCache,
        scaffold: scaffoldContent,
        message: `Scaffold generated for ${name}`,
      });
    }
  );

  // ─── subscription tools ──────────────────────────────────────────────────────
  // Register subscription tools as adapters
  for (const def of SUBSCRIPTION_TOOLS) {
    toolRegistry.register(
      def as any,
      async (args) => {
        const result = handleSubscriptionTool(def.name, args);
        return success(result);
      }
    );
  }
}
