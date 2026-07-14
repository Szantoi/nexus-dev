/**
 * TaskMessageBox
 *
 * DB-backed message/task system with file rendering for human readability.
 *
 * Features:
 * - SQLite as single source of truth
 * - Automatic .md file rendering (readonly view)
 * - Full CRUD operations via MCP API
 * - Terminal status tracking
 * - RAG-friendly rendered files
 */

export * from './types';
export * from './store';
export * from './mcp-tools';

// Re-export store as default
export { default as TaskMessageBox } from './store';
