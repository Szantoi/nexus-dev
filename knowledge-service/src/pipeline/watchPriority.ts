// Watch Priority - TypeScript equivalent of watch-priority.sh
// Ensures priority sessions (Conductor) are always running
// ADR-046: Uses startTerminalSession for cold-start context injection

import {
  PRIORITY_SESSIONS,
  SESSIONS,
  hasSession,
  getInboxModel,
  telegram,
  log,
} from './common';
import { startTerminalSession } from '../sessionStarter';

export async function watchPriority(): Promise<{ checked: number; started: string[] }> {
  const started: string[] = [];

  for (const sessionName of PRIORITY_SESSIONS) {
    const terminal = SESSIONS[sessionName];

    // Check if session is running
    if (await hasSession(sessionName)) {
      // Session is running - nothing to do
      continue;
    }

    // Session not running → start it with cold-start context (ADR-046)
    const wantedModel = await getInboxModel(terminal);
    // Priority sessions default to sonnet
    const model = wantedModel || 'sonnet';

    try {
      // Use sessionStarter for cold-start context injection
      // Priority sessions get a synthetic messageId for context tracking
      const messageId = `PRIORITY-${terminal.toUpperCase()}-${Date.now()}`;
      await startTerminalSession(terminal, messageId, model);

      await log(`Priority session indítva (cold-start): ${sessionName} (model: ${model})`);
      await telegram(`🚀 *${terminal.toUpperCase()} priority session indítva*\nModell: \`${model}\`\n_Cold-start context injektálva_`);

      started.push(sessionName);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await log(`Priority session start failed: ${sessionName} - ${errMsg}`);
      await telegram(`❌ *${terminal.toUpperCase()} priority session FAILED*\n\`${errMsg}\``);
    }
  }

  return { checked: PRIORITY_SESSIONS.length, started };
}

// Run standalone
if (require.main === module) {
  watchPriority().then(result => {
    console.log(`[watchPriority] Checked: ${result.checked}, Started: ${result.started.length}`);
    result.started.forEach(s => console.log(`  - ${s}`));
  });
}
