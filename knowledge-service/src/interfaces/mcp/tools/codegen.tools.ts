/**
 * Code Generation MCP tools — API client, component, module, hook generation.
 *
 * Tools: generate_api_client, generate_component, generate_module, generate_hook,
 *        get_codegen_status, check_api_client_status, verify_frontend_build,
 *        scaffold_from_pattern, analyze_bundle_size
 */

import { toolRegistry, success, error } from './base-tool';
import { logger } from '../../../core/logger';
import {
  generateApiClient,
  generateComponent,
  generateModule,
  generateHook,
  getCodegenStatus,
  checkApiClientStatus,
  verifyFrontendBuild,
  analyzeBundleSize,
  scaffoldFromPattern,
  listAvailablePatterns,
  type GenerateApiClientParams,
  type GenerateComponentParams,
  type GenerateModuleParams,
  type GenerateHookParams,
  type CheckApiClientStatusParams,
  type VerifyFrontendBuildParams,
  type AnalyzeBundleSizeParams,
  type ScaffoldFromPatternParams,
} from '../../../codegen/index';

export function registerCodegenTools(): void {
  // ─── generate_api_client ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_api_client',
      description:
        'Generate API client code from OpenAPI spec. Uses Orval for Portal (React Query hooks) or NSwag for Orchestrator (TypeScript client).',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Source API to generate client for',
            enum: ['kernel', 'orchestrator'],
          },
          target: {
            type: 'string',
            description: 'Target project for generated client',
            enum: ['portal', 'orchestrator'],
          },
          outputDir: {
            type: 'string',
            description: 'Custom output directory (optional)',
          },
        },
        required: ['source', 'target'],
      },
    },
    async (args) => {
      try {
        const params: GenerateApiClientParams = {
          source: String(args.source) as 'kernel' | 'orchestrator',
          target: String(args.target) as 'portal' | 'orchestrator',
          outputDir: args.outputDir ? String(args.outputDir) : undefined,
        };

        const result = await generateApiClient(params);

        return success({
          success: result.success,
          target: result.target,
          filesGenerated: result.filesGenerated,
          duration: `${result.duration}ms`,
          error: result.error,
        });
      } catch (err) {
        logger.error('[MCP] generate_api_client error:', err);
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── generate_component ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_component',
      description:
        'Generate a React component with SpaceOS patterns. Creates component file, CSS module, index, and optionally test and Storybook files.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Component name (PascalCase, e.g., FlowEpicCard)',
          },
          category: {
            type: 'string',
            description: 'Component category for file organization',
            enum: ['feature', 'ui', 'layout'],
          },
          withTest: {
            type: 'boolean',
            description: 'Generate test file (default: false)',
          },
          withStory: {
            type: 'boolean',
            description: 'Generate Storybook story (default: false)',
          },
          props: {
            type: 'array',
            description: 'Component props definition (optional)',
            items: { type: 'object' },
          },
        },
        required: ['name', 'category'],
      },
    },
    async (args) => {
      try {
        const params: GenerateComponentParams = {
          name: String(args.name),
          category: String(args.category) as 'feature' | 'ui' | 'layout',
          withTest: Boolean(args.withTest),
          withStory: Boolean(args.withStory),
          props: args.props as GenerateComponentParams['props'],
        };

        const result = await generateComponent(params);

        return success({
          success: result.success,
          componentPath: result.componentPath,
          filesCreated: result.filesCreated,
          error: result.error,
          usage: result.success
            ? `import { ${params.name} } from '@/components/${params.category === 'feature' ? 'features' : params.category}/${params.name}';`
            : undefined,
        });
      } catch (err) {
        logger.error('[MCP] generate_component error:', err);
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── generate_module ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_module',
      description:
        'Generate a .NET module with DDD structure. Creates aggregate, states, events, and optionally API endpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Module name (PascalCase, e.g., Pricing)',
          },
          aggregate: {
            type: 'string',
            description: 'Aggregate root name (default: same as module)',
          },
          states: {
            type: 'array',
            description: 'FSM states (e.g., ["Draft", "Submitted", "Approved"])',
            items: { type: 'string' },
          },
          events: {
            type: 'array',
            description: 'Domain events (optional)',
            items: { type: 'string' },
          },
          endpoints: {
            type: 'array',
            description: 'API endpoints to generate (optional)',
            items: { type: 'object' },
          },
        },
        required: ['name', 'aggregate', 'states'],
      },
    },
    async (args) => {
      try {
        const params: GenerateModuleParams = {
          name: String(args.name),
          aggregate: String(args.aggregate || args.name),
          states: (args.states as string[]) || [],
          events: args.events as string[] | undefined,
          endpoints: args.endpoints as GenerateModuleParams['endpoints'],
        };

        const result = await generateModule(params);

        return success({
          success: result.success,
          modulePath: result.modulePath,
          filesCreated: result.filesCreated,
          error: result.error,
        });
      } catch (err) {
        logger.error('[MCP] generate_module error:', err);
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── generate_hook ───────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'generate_hook',
      description:
        'Generate a React hook with SpaceOS patterns. Supports query, mutation, state, and effect hook types with optional TanStack Query integration.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Hook name (camelCase without "use" prefix, e.g., "Orders" generates "useOrders")',
          },
          type: {
            type: 'string',
            description: 'Hook type',
            enum: ['query', 'mutation', 'state', 'effect'],
          },
          withTest: {
            type: 'boolean',
            description: 'Generate test file (default: false)',
          },
          withCache: {
            type: 'boolean',
            description: 'Use TanStack Query for caching (query/mutation types only, default: false)',
          },
          endpoint: {
            type: 'string',
            description: 'API endpoint path for query/mutation hooks (e.g., "/api/orders")',
          },
        },
        required: ['name', 'type'],
      },
    },
    async (args) => {
      try {
        const params: GenerateHookParams = {
          name: String(args.name),
          type: String(args.type) as 'query' | 'mutation' | 'state' | 'effect',
          withTest: Boolean(args.withTest),
          withCache: Boolean(args.withCache),
          endpoint: args.endpoint ? String(args.endpoint) : undefined,
        };

        const result = await generateHook(params);

        return success({
          success: result.success,
          hookPath: result.hookPath,
          filesCreated: result.filesCreated,
          error: result.error,
          usage: result.success
            ? `import { use${params.name.charAt(0).toUpperCase() + params.name.slice(1)} } from '@/hooks/use${params.name.charAt(0).toUpperCase() + params.name.slice(1)}';`
            : undefined,
        });
      } catch (err) {
        logger.error('[MCP] generate_hook error:', err);
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── get_codegen_status ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_codegen_status',
      description:
        'Get the status of code generation configuration and generated files.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const status = await getCodegenStatus();

      return success({
        configuration: {
          orvalConfig: status.orvalConfigExists ? 'Found' : 'Missing',
          nswagConfig: status.nswagConfigExists ? 'Found' : 'Missing',
        },
        generated: {
          portalApi: status.portalApiGenerated ? `${status.generatedFiles.portal} files` : 'Not generated',
          orchestratorApi: status.orchestratorApiGenerated ? 'Generated' : 'Not generated',
        },
        commands: {
          generateAll: 'spaceos generate api-client',
          generatePortal: 'spaceos generate api-client portal',
          generateOrchestrator: 'spaceos generate api-client orchestrator',
        },
      });
    }
  );

  // ─── check_api_client_status ─────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'check_api_client_status',
      description:
        'Check Orval-generated API client status for a JoineryTech module. Verifies OpenAPI spec, Orval config, generated client, and detects manual hooks.',
      inputSchema: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'JoineryTech module name (e.g., "ehs", "crm", "maintenance")',
          },
        },
        required: ['module'],
      },
    },
    async (args) => {
      try {
        const params: CheckApiClientStatusParams = {
          module: String(args.module),
        };
        const result = await checkApiClientStatus(params);
        return success(result);
      } catch (err) {
        logger.error('[MCP] check_api_client_status error:', err);
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── verify_frontend_build ───────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'verify_frontend_build',
      description:
        'Verify frontend build status. Runs TypeScript check, estimates build time, and reports bundle size.',
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Project path relative to SPACEOS_ROOT (e.g., "datahaven-web/client")',
          },
          run_tests: {
            type: 'boolean',
            description: 'Run tests as part of verification (default: false)',
          },
        },
        required: ['project'],
      },
    },
    async (args) => {
      try {
        const params: VerifyFrontendBuildParams = {
          project: String(args.project),
          run_tests: Boolean(args.run_tests || false),
        };
        const result = await verifyFrontendBuild(params);
        return success(result);
      } catch (err) {
        logger.error('[MCP] verify_frontend_build error:', err);
        return success({
          typescript_errors: 999,
          build_time_estimate: 'unknown',
          bundle_size_mb: 0,
          chunk_warnings: [String(err)],
          buildable: false,
        });
      }
    }
  );

  // ─── scaffold_from_pattern ───────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'scaffold_from_pattern',
      description:
        'Scaffold component from documented UI pattern. Available patterns: dashboard-with-kpi-strip, data-table-with-actions, form-wizard-offline-first.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Pattern name (e.g., "dashboard-with-kpi-strip")',
          },
          module: {
            type: 'string',
            description: 'JoineryTech module (e.g., "safety", "ehs")',
          },
          entity: {
            type: 'string',
            description: 'Entity name (e.g., "Audit", "Incident")',
          },
        },
        required: ['pattern', 'module', 'entity'],
      },
    },
    async (args) => {
      try {
        const params: ScaffoldFromPatternParams = {
          pattern: String(args.pattern),
          module: String(args.module),
          entity: String(args.entity),
        };
        const result = await scaffoldFromPattern(params);
        return success(result);
      } catch (err) {
        logger.error('[MCP] scaffold_from_pattern error:', err);
        return success({
          success: false,
          filesCreated: [],
          componentPath: '',
          error: String(err),
        });
      }
    }
  );

  // ─── analyze_bundle_size ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'analyze_bundle_size',
      description:
        'Analyze bundle size and provide optimization recommendations. Identifies lazy loading candidates and large chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Project path relative to SPACEOS_ROOT (e.g., "datahaven-web/client")',
          },
        },
        required: ['project'],
      },
    },
    async (args) => {
      try {
        const params: AnalyzeBundleSizeParams = {
          project: String(args.project),
        };
        const result = await analyzeBundleSize(params);
        return success(result);
      } catch (err) {
        logger.error('[MCP] analyze_bundle_size error:', err);
        return success({
          total_size_mb: 0,
          gzip_size_mb: 0,
          top_chunks: [],
          lazy_loading_candidates: [],
          recommendations: [String(err)],
        });
      }
    }
  );
}
