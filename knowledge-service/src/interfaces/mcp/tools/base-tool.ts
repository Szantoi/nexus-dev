/**
 * Base MCP Tool Definition
 * Provides type-safe tool registration
 */

// ─── Tool Schema Types ────────────────────────────────────────────────────────

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  enum?: string[];
  items?: { type: string };
  default?: any;
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export type ToolHandler = (
  args: Record<string, any>,
  context: ToolContext
) => Promise<ToolResult>;

export interface ToolContext {
  terminal?: string;
  agentId?: string;
  permissions?: string[];
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, {
    definition: ToolDefinition;
    handler: ToolHandler;
  }>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async call(
    name: string,
    args: Record<string, any>,
    context: ToolContext = {}
  ): Promise<ToolResult> {
    const handler = this.getHandler(name);
    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      return await handler(args, context);
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

export function success(data: any): ToolResult {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

export function error(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function formatList(items: string[], title?: string): string {
  if (items.length === 0) return title ? `${title}: (empty)` : '(empty)';
  const list = items.map(item => `- ${item}`).join('\n');
  return title ? `${title}:\n${list}` : list;
}

// ─── Global Registry ──────────────────────────────────────────────────────────

export const toolRegistry = new ToolRegistry();
