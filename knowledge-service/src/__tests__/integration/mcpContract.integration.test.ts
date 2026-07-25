/**
 * MCP public contract tests (TASK-QC-008)
 *
 * PINS the public MCP surface served by src/mcp.ts after the legacy TOOLS
 * array + switch fallback removal:
 *
 *  - the exact tool-name set (124 tools) and its uniqueness,
 *  - the schema shape of every definition + exact schemas of critical tools,
 *  - initialize / tools/list / tools/call JSON-RPC behavior,
 *  - permission filtering (tools/list and tools/call, island/terminal aware),
 *  - unknown tool -> standard JSON-RPC -32602 error,
 *  - handler errors -> legacy {"error": msg} content shape (unchanged).
 *
 * Contract background (2026-07-18 diff, see task file): all 105 legacy TOOLS
 * entries exist in the registry; the registry additionally serves 16 tools
 * (search_knowledge, tmb_*, workflow group) that were already registry-only.
 * Where legacy and registry definitions differed, the registry definition is
 * the effective contract because dispatch has been registry-first since
 * EPIC-KS-MCP-SPLIT (the legacy switch branches for those names were dead).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';

// Hoisted: point tokenAuth at a temp agents.yaml BEFORE any import loads it.
const AGENTS_PATH = vi.hoisted(() => {
  const runId = require('crypto').randomBytes(6).toString('hex');
  const p = require('path').join(require('os').tmpdir(), `mcp-contract-${runId}.yaml`);
  process.env.AGENTS_CONFIG_PATH = p;
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.AUTH_MODE;
  return p;
});

import { loadAgentTokens, resetAuthStateForTests } from '../../auth/tokenAuth';
import { toolRegistry, registerAllTools } from '../../interfaces/mcp/tools';
import mcpRouter from '../../mcp';

// ─── The pinned public tool-name contract (sorted) ───────────────────────────
// Any change here is a PUBLIC MCP contract change and needs explicit approval.
const EXPECTED_TOOL_NAMES = [
  'ack_task',
  'add_focus_item',
  'advance_workflow',
  'analyze_bundle_size',
  'append_checkpoint_to_md',
  'append_memory',
  'append_to_message',
  'apply_retrospective',
  'build_session_start_context',
  'check_api_client_status',
  'check_goal_criteria',
  'complete_goal',
  'complete_inbox_message',
  'complete_task',
  'compress_memory',
  'create_goal',
  'create_project',
  'create_skill',
  'create_task',
  'delete_skill',
  'detect_task_domains',
  'dispatch_next',
  'extract_patterns',
  'fetch_task',
  'generate_api_client',
  'generate_component',
  'generate_daily_digest',
  'generate_endpoint',
  'generate_handoff',
  'generate_hook',
  'generate_module',
  'generate_skeleton',
  'generate_workflow_task',
  'get_all_context_files_status',
  'get_all_epics_progress',
  'get_capabilities',
  'get_checkpoint_status',
  'get_codegen_status',
  'get_context_files_status',
  'get_context_saturation',
  'get_dependencies',
  'get_epic_progress',
  'get_focus_queue',
  'get_goal',
  'get_identity',
  'get_project_context',
  'get_project_status',
  'get_service_status',
  'get_session_context',
  'get_skill',
  'get_skill_metadata',
  'get_subscriptions',
  'get_task_status',
  'get_telegram_history',
  'get_terminal_docs',
  'get_terminal_setup',
  'get_terminal_status',
  'get_terminal_status_aggregate',
  'get_terminals_index',
  'get_worker_status',
  'get_workflow',
  'get_workflow_details',
  'get_workflow_state',
  'impact_analysis',
  'increment_turn_count',
  'list_all_skills',
  'list_blocked',
  'list_domain_memories',
  'list_epics',
  'list_goals',
  'list_inbox',
  'list_skills',
  'list_terminal_docs',
  'list_terminals',
  'list_workflows',
  'match_domain_pattern',
  'memory_health_report',
  'promote_memory',
  'read_checkpoints_md',
  'read_inbox_message',
  'read_memory',
  'read_session_state',
  'read_terminal_status_md',
  'refresh_checkpoint_subscriptions',
  'register_idle',
  'register_working',
  'request_review',
  'request_work_session',
  'reset_turn_count',
  'resolve_epic_dependencies',
  'run_retrospective',
  'save_tiered_memory',
  'scaffold_from_pattern',
  'scaffold_react_hook',
  'search_graph',
  'search_knowledge',
  'send_message',
  'set_active_task',
  'set_focus_queue',
  'set_task_status',
  'set_workflow_step',
  'spawn_parallel_workers',
  'spawn_raw_workers',
  'spawn_work_session',
  'submit_done',
  'subscribe_to_task',
  'subscribe_to_terminal',
  'telegram_broadcast',
  'telegram_reply',
  'tmb_append_note',
  'tmb_complete_message',
  'tmb_create_task',
  'tmb_get_inbox',
  'tmb_get_outbox',
  'tmb_read_message',
  'transfer_session_context',
  'trigger_goal',
  'unsubscribe',
  'update_epic',
  'verify_frontend_build',
  'workflow_summary',
  'write_memory',
  'write_session_state',
  'write_terminal_status_md',
];

const MASTER_TOKEN = 'contract-master-token';
const BACKEND_TOKEN = 'contract-backend-token';

let request: any;
let app: any;

function rpc(body: Record<string, unknown>, token: string = MASTER_TOKEN) {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: 1, ...body });
}

beforeAll(async () => {
  fs.writeFileSync(
    AGENTS_PATH,
    `master_token: "${MASTER_TOKEN}"\nagents:\n  "${BACKEND_TOKEN}": backend\n`,
    'utf-8',
  );
  resetAuthStateForTests();
  loadAgentTokens();
  registerAllTools();

  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;

  const server = express();
  server.use(express.json());
  server.use('/mcp', mcpRouter); // same mount point as bootstrap/app.ts
  app = server;
  request = supertest;
});

afterAll(() => {
  if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetAuthStateForTests();
});

// ─── Registry-level contract (definitions) ───────────────────────────────────

describe('MCP tool-set contract (registry definitions)', () => {
  it('serves exactly the pinned tool-name set — no additions, removals, or renames', () => {
    const names = toolRegistry.getDefinitions().map((d) => d.name).sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(names.length).toBe(124);
  });

  it('every tool name is unique', () => {
    const names = toolRegistry.getDefinitions().map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every definition has name, description and an object inputSchema', () => {
    for (const def of toolRegistry.getDefinitions()) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe('object');
      expect(def.inputSchema.properties).toBeDefined();
    }
  });

  it('every listed tool has a handler', () => {
    for (const def of toolRegistry.getDefinitions()) {
      expect(toolRegistry.getHandler(def.name), `missing handler: ${def.name}`).toBeDefined();
    }
  });

  it('pins the search_knowledge schema exactly', () => {
    const def = toolRegistry.getDefinitions().find((d) => d.name === 'search_knowledge')!;
    expect(def.inputSchema).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (semantic search)' },
        limit: { type: 'number', description: 'Maximum number of results (default: 5, max: 20)' },
      },
      required: ['query'],
    });
  });

  it('pins critical tool schemas (property names + required arguments)', () => {
    const pin = (name: string) => {
      const def = toolRegistry.getDefinitions().find((d) => d.name === name);
      expect(def, `missing critical tool: ${name}`).toBeDefined();
      return {
        properties: Object.keys(def!.inputSchema.properties).sort(),
        required: [...(def!.inputSchema.required ?? [])].sort(),
      };
    };

    expect(pin('get_identity')).toEqual({ properties: ['terminal'], required: ['terminal'] });
    expect(pin('list_terminals')).toEqual({ properties: [], required: [] });
    expect(pin('list_inbox')).toEqual({
      properties: ['include_content', 'status', 'terminal'],
      required: ['terminal'],
    });
    expect(pin('create_task')).toEqual({
      properties: [
        'acceptance_criteria', 'context', 'description', 'epic_id', 'from', 'model',
        'priority', 'project_id', 'queue_only', 'ref', 'title', 'to',
      ],
      required: ['description', 'from', 'priority', 'title', 'to'],
    });
    expect(pin('send_message')).toEqual({
      properties: ['content', 'model', 'priority', 'ref', 'to', 'type'],
      required: ['content', 'priority', 'to', 'type'],
    });
    expect(pin('set_focus_queue')).toEqual({ properties: ['items'], required: ['items'] });
    expect(pin('fetch_task')).toEqual({
      properties: ['message_id', 'terminal'],
      required: ['message_id', 'terminal'],
    });
  });
});

// ─── Transport-level contract (JSON-RPC over HTTP) ───────────────────────────

describe('MCP JSON-RPC transport contract', () => {
  it('initialize returns protocol version and server info', async () => {
    const r = await rpc({ method: 'initialize' });
    expect(r.status).toBe(200);
    expect(r.body.result.protocolVersion).toBe('2024-11-05');
    expect(r.body.result.serverInfo.name).toBe('spaceos-knowledge-service');
    expect(r.body.result.capabilities.tools).toBeDefined();
  });

  it('rejects non-2.0 jsonrpc with -32600', async () => {
    const r = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${MASTER_TOKEN}`)
      .send({ jsonrpc: '1.0', method: 'initialize', id: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32600);
  });

  it('unknown method returns -32601', async () => {
    const r = await rpc({ method: 'no/such/method' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32601);
  });

  it('tools/list (root) returns the full pinned set with NO duplicates', async () => {
    const r = await rpc({ method: 'tools/list' });
    expect(r.status).toBe(200);
    const names = r.body.result.tools.map((t: any) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect([...names].sort()).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('tools/list is permission-filtered for non-root terminals', async () => {
    const r = await rpc({ method: 'tools/list' }, BACKEND_TOKEN);
    expect(r.status).toBe(200);
    const names = r.body.result.tools.map((t: any) => t.name);
    // restricted to root/conductor in config/tool-permissions.yaml:
    expect(names).not.toContain('set_focus_queue');
    expect(names).not.toContain('dispatch_next');
    // open tools remain visible:
    expect(names).toContain('search_knowledge');
    expect(names).toContain('list_inbox');
  });

  it('tools/call executes an allowed tool (list_terminals) and returns MCP content', async () => {
    const r = await rpc({ method: 'tools/call', params: { name: 'list_terminals', arguments: {} } });
    expect(r.status).toBe(200);
    expect(r.body.result.content).toHaveLength(1);
    expect(r.body.result.content[0].type).toBe('text');
    const payload = JSON.parse(r.body.result.content[0].text);
    expect(payload.count).toBeGreaterThan(0);
    expect(Array.isArray(payload.terminals)).toBe(true);
  });

  it('tools/call denies a restricted tool for an unauthorized terminal (-32003)', async () => {
    const r = await rpc(
      { method: 'tools/call', params: { name: 'set_focus_queue', arguments: { items: [] } } },
      BACKEND_TOKEN,
    );
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe(-32003);
    expect(r.body.error.message).toContain('backend');
    expect(r.body.error.message).toContain('set_focus_queue');
  });

  it('tools/call without a name returns -32602', async () => {
    const r = await rpc({ method: 'tools/call', params: {} });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32602);
  });

  it('unknown tool returns the standard MCP -32602 error (no silent 200)', async () => {
    const r = await rpc({
      method: 'tools/call',
      params: { name: 'nonexistent_tool_xyz', arguments: {} },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32602);
    expect(r.body.error.message).toBe('Unknown tool: nonexistent_tool_xyz');
  });

  it('handler errors keep the legacy {"error": msg} content shape', async () => {
    // Register a throwing tool directly in the (per-test-file) registry.
    toolRegistry.register(
      {
        name: 'qc008_throwing_tool',
        description: 'test-only tool that always throws',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => {
        throw new Error('boom from handler');
      },
    );

    const r = await rpc({
      method: 'tools/call',
      params: { name: 'qc008_throwing_tool', arguments: {} },
    });
    expect(r.status).toBe(200);
    expect(r.body.result.content[0].type).toBe('text');
    expect(JSON.parse(r.body.result.content[0].text)).toEqual({ error: 'boom from handler' });
  });

  it('unauthenticated request without configured default agent is rejected', async () => {
    const r = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe(-32001);
  });

  it('invalid token is rejected with 403 / -32002', async () => {
    const r = await rpc({ method: 'tools/list' }, 'not-a-valid-token');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe(-32002);
  });

  it('GET /mcp info endpoint reports the full registry tool set', async () => {
    const r = await request(app).get('/mcp');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('spaceos-knowledge-service');
    // Robust against the test-only qc008_throwing_tool registered above:
    expect(r.body.toolCount).toBe(toolRegistry.getDefinitions().length);
    expect(r.body.toolCount).toBeGreaterThanOrEqual(EXPECTED_TOOL_NAMES.length);
    expect(r.body.tools).toContain('search_knowledge');
  });
});
