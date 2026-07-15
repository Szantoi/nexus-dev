/**
 * Identity MCP tools — terminal identity and memory management.
 *
 * Tools: get_identity, list_terminals, read_memory, write_memory,
 *        append_memory, get_capabilities
 */

import { toolRegistry, success } from './base-tool';
import {
  getIdentity,
  listTerminals,
  readMemory,
  writeMemory,
  appendMemory,
  getCapabilities,
  TERMINALS,
} from '../../../identity';

export function registerIdentityTools(): void {
  // ─── get_identity ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_identity',
      description:
        'Get terminal identity including CLAUDE.md instructions and memory file. Use this to understand what a terminal does and its current state.',
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
      const identity = await getIdentity(terminal);
      return success(identity);
    }
  );

  // ─── list_terminals ──────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_terminals',
      description:
        'List all SpaceOS terminals with their paths and status (has CLAUDE.md, has memory).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const terminals = await listTerminals();
      return success({ count: terminals.length, terminals });
    }
  );

  // ─── read_memory ─────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'read_memory',
      description:
        'Read the memory file for a specific terminal. Memory contains session state, learned patterns, and context.',
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
      const memory = await readMemory(terminal);
      return success({ terminal, hasMemory: memory !== null, memory });
    }
  );

  // ─── write_memory ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'write_memory',
      description:
        'Write/replace the entire memory file for a terminal. Use with caution - this overwrites existing memory.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: 'Terminal name',
          },
          content: {
            type: 'string',
            description: 'Full memory content (markdown format)',
          },
        },
        required: ['terminal', 'content'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const content = String(args.content || '');
      const result = await writeMemory(terminal, content);
      return success({ terminal, ...result });
    }
  );

  // ─── append_memory ───────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'append_memory',
      description:
        'Append new content to terminal memory. Safer than write_memory - preserves existing content.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: 'Terminal name',
          },
          content: {
            type: 'string',
            description: 'Content to append (markdown format)',
          },
        },
        required: ['terminal', 'content'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const content = String(args.content || '');
      const result = await appendMemory(terminal, content);
      return success({ terminal, ...result });
    }
  );

  // ─── get_capabilities ────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_capabilities',
      description:
        'List all available MCP capabilities/tools, optionally filtered by category.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Filter by category (optional)',
            enum: ['knowledge', 'mailbox', 'identity', 'tasks', 'system'],
          },
        },
      },
    },
    async (args) => {
      const category = args.category ? String(args.category) : undefined;
      const capabilities = getCapabilities(category);
      return success({
        count: capabilities.length,
        filter: category || 'all',
        capabilities,
      });
    }
  );
}
