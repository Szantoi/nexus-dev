// Watch MCP Heartbeat - Detects sessions running without MCP registration
// If tmux session is running but Datahaven status is "idle", the terminal
// is NOT using MCP as required. This triggers a nudge to use MCP tools.

import {
  SESSIONS,
  listSessions,
  hasSession,
  capturePane,
  sendKeys,
  sendEnter,
  getState,
  setState,
  telegram,
  log,
} from './common';

const MCP_NUDGE_COOLDOWN = 600; // 10 minutes between MCP nudges

interface McpHeartbeatResult {
  session: string;
  terminal: string;
  reason: string;
}

// Get terminal status from local terminalStatus module
function getTerminalStatus(terminal: string): 'working' | 'idle' | 'unknown' {
  try {
    // Use the terminalStatus module directly
    const { isWorking } = require('../terminalStatus');
    if (isWorking(terminal)) return 'working';
    return 'idle';
  } catch {
    return 'unknown';
  }
}

export async function watchMcpHeartbeat(): Promise<{ processed: number; nudged: McpHeartbeatResult[] }> {
  const now = Math.floor(Date.now() / 1000);
  let processed = 0;
  const nudged: McpHeartbeatResult[] = [];

  const sessions = await listSessions();

  for (const sessionName of sessions) {
    const terminal = SESSIONS[sessionName];
    if (!terminal) continue;

    // Skip root - root may have different workflow
    if (sessionName === 'spaceos-root') continue;

    if (!(await hasSession(sessionName))) continue;

    processed++;

    // Check if session is actively working (has recent output)
    const paneOutput = await capturePane(sessionName, 20);

    // Check if session appears to be processing (not at empty prompt)
    const isAtPrompt = /^>\s*$/.test(paneOutput.split('\n').slice(-3).join('\n').trim()) ||
                       paneOutput.includes('shift+tab to cycle');
    const hasRecentActivity = paneOutput.length > 100;

    // If session is just at an empty prompt, might be legitimately idle
    // Only flag if it seems to be doing something but didn't register
    if (!hasRecentActivity && isAtPrompt) continue;

    // Get MCP status for this terminal
    const mcpStatus = await getTerminalStatus(terminal);

    // If tmux session is running AND MCP status is "idle", terminal is not using MCP
    if (mcpStatus !== 'working') {
      // Check cooldown
      const mcpNudgeKey = `${sessionName}_mcp_nudge_sent`;
      const lastSent = await getState(mcpNudgeKey);
      const elapsed = lastSent ? now - parseInt(lastSent, 10) : MCP_NUDGE_COOLDOWN + 1;

      if (elapsed <= MCP_NUDGE_COOLDOWN) continue;

      // Just send Enter - no text message needed
      await sendEnter(sessionName);
      await new Promise(r => setTimeout(r, 500));
      await sendEnter(sessionName);

      await setState(mcpNudgeKey, String(now));
      await log(`MCP heartbeat nudge küldve: ${sessionName} (status: ${mcpStatus})`);
      await telegram(`📡 *${terminal.toUpperCase()} MCP heartbeat* — tmux fut, de nincs MCP register_working. Nudge elküldve.`);

      nudged.push({
        session: sessionName,
        terminal,
        reason: `tmux running, MCP status: ${mcpStatus}`
      });
    }
  }

  return { processed, nudged };
}

// Run standalone
if (require.main === module) {
  watchMcpHeartbeat().then(result => {
    console.log(`[watchMcpHeartbeat] Processed: ${result.processed}, Nudged: ${result.nudged.length}`);
    result.nudged.forEach(n => console.log(`  - ${n.session} (${n.terminal}): ${n.reason}`));
  });
}
