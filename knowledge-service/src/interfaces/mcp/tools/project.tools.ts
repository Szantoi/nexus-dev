/**
 * Project Automation MCP tools — project lifecycle, task dispatch, skeleton generation.
 *
 * Tools: create_project, get_project_status, dispatch_next, list_blocked,
 *        generate_skeleton, generate_endpoint
 */

import { toolRegistry, success } from './base-tool';
import {
  handleCreateProject,
  handleGetProjectStatus,
  handleDispatchNext,
  handleListBlocked,
  handleGenerateSkeleton,
  handleGenerateEndpoint,
} from '../../../projectTools';

export function registerProjectTools(): void {
  // ─── create_project ──────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'create_project',
      description:
        'Create a new project structure with PROJECT.md, TASKS.yaml, STATUS.md',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Project slug (lowercase, no spaces)',
          },
          name: {
            type: 'string',
            description: 'Human-readable project name',
          },
          description: {
            type: 'string',
            description: 'Project description',
          },
          milestones: {
            type: 'array',
            description: 'Project milestones',
            items: { type: 'object' },
          },
        },
        required: ['slug', 'name'],
      },
    },
    async (args) => {
      const result = await handleCreateProject(args as any);
      return success(result);
    }
  );

  // ─── get_project_status ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_project_status',
      description:
        'Get current status of a project including task completion',
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Project slug',
          },
        },
        required: ['project'],
      },
    },
    async (args) => {
      const result = await handleGetProjectStatus(args as any);
      return success(result);
    }
  );

  // ─── dispatch_next ───────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'dispatch_next',
      description:
        'Manually dispatch the next unblocked task(s) for a project',
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Project slug',
          },
          task_id: {
            type: 'string',
            description: 'Specific task to dispatch (optional)',
          },
        },
        required: ['project'],
      },
    },
    async (args) => {
      const result = await handleDispatchNext(args as any);
      return success(result);
    }
  );

  // ─── list_blocked ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_blocked',
      description:
        'List all blocked tasks across all projects',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const result = await handleListBlocked();
      return success(result);
    }
  );

  // ─── generate_skeleton ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_skeleton',
      description:
        'Generate domain layer skeleton for a new aggregate',
      inputSchema: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'Module path (e.g., spaceos-modules-procurement)',
          },
          aggregate: {
            type: 'string',
            description: 'Aggregate name (PascalCase)',
          },
          states: {
            type: 'array',
            description: 'FSM states for the aggregate',
            items: { type: 'string' },
          },
          endpoints: {
            type: 'array',
            description: 'Endpoints to generate (optional)',
            items: { type: 'string' },
          },
          properties: {
            type: 'array',
            description: 'Additional properties (optional)',
            items: { type: 'object' },
          },
        },
        required: ['module', 'aggregate', 'states'],
      },
    },
    async (args) => {
      const result = await handleGenerateSkeleton(args as any);
      return success(result);
    }
  );

  // ─── generate_endpoint ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_endpoint',
      description:
        'Generate API endpoint with command, handler, and tests',
      inputSchema: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'Module path',
          },
          aggregate: {
            type: 'string',
            description: 'Aggregate name',
          },
          action: {
            type: 'string',
            description: 'Action name (e.g., Create, Submit, Resolve)',
          },
          http: {
            type: 'string',
            description: 'HTTP method',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          },
          route: {
            type: 'string',
            description: 'API route (e.g., /api/complaints/{id}/resolve)',
          },
          requestBody: {
            type: 'array',
            description: 'Request body fields',
            items: { type: 'object' },
          },
          responseType: {
            type: 'string',
            description: 'Response type (optional)',
          },
        },
        required: ['module', 'aggregate', 'action', 'http', 'route'],
      },
    },
    async (args) => {
      const result = await handleGenerateEndpoint(args as any);
      return success(result);
    }
  );
}
