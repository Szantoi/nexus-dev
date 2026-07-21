/**
 * taskPrompt.ts — Task-assignment prompt for locally spawned sessions.
 *
 * Mirrors the server-side sessionStarter MCP variant: the prompt only
 * references the terminal and the message ID — the task CONTENT is
 * fetched by the agent itself over authenticated MCP (fetch_task).
 * Network data therefore never reaches a command line or shell.
 */

export function buildTaskAssignmentPrompt(
  terminal: string,
  messageId: string,
  mcpServerName = 'spaceos-knowledge',
): string {
  return `[TASK ASSIGNED] Task ID: ${messageId}

Neked egy feladat lett kiosztva. Használd az MCP eszközöket a task kezeléséhez:

1. TASK LEKÉRÉSE:
   mcp__${mcpServerName}__fetch_task
     terminal: "${terminal}"
     message_id: "${messageId}"

2. TASK FOGADÁS MEGERŐSÍTÉSE:
   mcp__${mcpServerName}__ack_task
     terminal: "${terminal}"
     message_id: "${messageId}"

3. TASK BEFEJEZÉSE (amikor KÉSZ vagy):
   mcp__${mcpServerName}__complete_task
     terminal: "${terminal}"
     message_id: "${messageId}"

FONTOS: Csak ezt az egy feladatot dolgozhatod fel. Más feladathoz nincs hozzáférésed.
A token az MCP regisztrációdban van, automatikusan autentikált.`;
}
