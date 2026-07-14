// Watch Idle - TypeScript equivalent of watch-idle.sh
// Shuts down idle sessions that have no UNREAD inbox
// 2026-07-01: Added INJECTED message escalation handling
// 2026-07-04: Migrated to NWT (Nightwatch Tick) time units

import {
  SESSIONS,
  listSessions,
  hasSession,
  getSessionActivity,
  hasUnreadInbox,
  isPrioritySession,
  sendKeys,
  sendEnter,
  killSession,
  getState,
  setState,
  deleteState,
  telegram,
  log,
} from './common';
import { getInjectedMessages, buildEscalatedPrompt } from '../sessionStarter';
import { NWT_TIMEOUTS, nwtToMs } from '../constants/nwt';

// NWT-based timeouts (1 NWT = 2 minutes = 120 seconds)
// IDLE_SHUTDOWN = 8 NWT ≈ 16 minutes, but we use 7.5 NWT for smoother 15 min
const IDLE_TIMEOUT = Math.floor(nwtToMs(NWT_TIMEOUTS.IDLE_SHUTDOWN) * 0.94 / 1000); // ~15 minutes
// INBOX_NUDGE × 1.67 ≈ 5 minutes for escalation
const INJECTED_ESCALATION_TIMEOUT = Math.floor(nwtToMs(NWT_TIMEOUTS.INBOX_NUDGE) * 1.67 / 1000); // ~5 minutes
// IDLE_WARNING × 1 = 10 minutes for monitor alert
const INJECTED_MONITOR_TIMEOUT = Math.floor(nwtToMs(NWT_TIMEOUTS.IDLE_WARNING) / 1000); // ~10 minutes

async function shutdownSession(sessionName: string, terminal: string): Promise<void> {
  // Step 1: Send graceful shutdown message - ask terminal to save memory first
  const gracefulMsg = `⏰ GRACEFUL SHUTDOWN: Nincs több feladat. Mentsd el a memóriát és zárd le a session-t:
1. mcp__spaceos-knowledge__save_tiered_memory terminal:"${terminal}" tier:"episodic" content:"Session lezárás - idle shutdown"
2. mcp__spaceos-knowledge__register_idle terminal:"${terminal}"
3. Majd írd: /exit`;

  await sendKeys(sessionName, gracefulMsg);
  await new Promise(r => setTimeout(r, 500));
  await sendEnter(sessionName);
  await new Promise(r => setTimeout(r, 1000));
  await sendEnter(sessionName);

  // Step 2: Wait for terminal to process (give it time to save memory)
  await new Promise(r => setTimeout(r, 15000)); // 15 seconds grace period

  // Step 3: If still running, send /exit
  if (await hasSession(sessionName)) {
    await sendKeys(sessionName, '/exit');
    await new Promise(r => setTimeout(r, 500));
    await sendEnter(sessionName);
    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 4: If STILL running, force kill
  if (await hasSession(sessionName)) {
    await killSession(sessionName);
    await log(`Session FORCE KILLED (nem válaszolt): ${sessionName}`);
  }

  await log(`Session leállítva (idle + no task): ${sessionName}`);
  await telegram(`💤 *${terminal.toUpperCase()} leállítva*\nOk: nincs feladat, graceful shutdown`);
}

export async function watchIdle(): Promise<{ processed: number; shutdown: number; escalated: number; alerted: number }> {
  const now = Math.floor(Date.now() / 1000);
  let processed = 0;
  let shutdown = 0;
  let escalated = 0;
  let alerted = 0;

  const sessions = await listSessions();

  for (const sessionName of sessions) {
    const terminal = SESSIONS[sessionName];
    if (!terminal) continue;

    processed++;

    // Skip priority sessions (root, conductor)
    if (isPrioritySession(sessionName)) {
      continue;
    }

    // ─── INJECTED Message Handling (2026-07-01) ─────────────────────────
    // Check for INJECTED messages that haven't been ACK'd
    const injectedMsgs = await getInjectedMessages(terminal);
    for (const msg of injectedMsgs) {
      const injectedKey = `${sessionName}_injected_${msg.messageId}`;
      const firstSeen = await getState(injectedKey);

      if (!firstSeen) {
        // First time seeing this INJECTED message
        await setState(injectedKey, String(now));
        continue;
      }

      const elapsed = now - parseInt(firstSeen, 10);

      // Stage 1: After 5 minutes - send escalated prompt
      if (elapsed >= INJECTED_ESCALATION_TIMEOUT && elapsed < INJECTED_MONITOR_TIMEOUT) {
        const escalatedKey = `${injectedKey}_escalated`;
        const alreadyEscalated = await getState(escalatedKey);

        if (!alreadyEscalated) {
          // Send detailed instructions
          const escalatedPrompt = buildEscalatedPrompt(terminal, msg.messageId);
          await sendKeys(sessionName, escalatedPrompt);
          await new Promise(r => setTimeout(r, 500));
          await sendEnter(sessionName);

          await setState(escalatedKey, String(now));
          await log(`INJECTED eszkaláció: ${sessionName} / ${msg.messageId}`);
          escalated++;
        }
      }

      // Stage 2: After 10 minutes - alert monitor (root/conductor)
      if (elapsed >= INJECTED_MONITOR_TIMEOUT) {
        const alertedKey = `${injectedKey}_alerted`;
        const alreadyAlerted = await getState(alertedKey);

        if (!alreadyAlerted) {
          await setState(alertedKey, String(now));
          await log(`MONITOR INTERVENTION: ${sessionName} / ${msg.messageId} - nincs válasz 10+ perce`);
          // Self-healing: monitor terminal will check logs and resolve
          alerted++;
        }
      }
    }

    // Has UNREAD inbox?
    if (await hasUnreadInbox(terminal)) {
      // Has work to do, don't shut down
      await deleteState(`${sessionName}_shutdown_pending`);
      continue;
    }

    // Has INJECTED messages? Don't shutdown, they're pending
    if (injectedMsgs.length > 0) {
      await deleteState(`${sessionName}_shutdown_pending`);
      continue;
    }

    // Get idle time
    const activity = await getSessionActivity(sessionName);
    const idleTime = activity > 0 ? now - activity : 0;

    if (idleTime <= IDLE_TIMEOUT) {
      // Not idle enough
      await deleteState(`${sessionName}_shutdown_pending`);
      continue;
    }

    // Idle + no UNREAD + no INJECTED → check shutdown pending state
    const shutdownKey = `${sessionName}_shutdown_pending`;
    const lastShutdown = await getState(shutdownKey);

    if (!lastShutdown || lastShutdown === '0') {
      // First detection: mark and wait one more cycle
      await setState(shutdownKey, String(now));
      await log(`Idle session jelölve: ${sessionName} (vár még egy ciklust)`);
    } else {
      const elapsed = now - parseInt(lastShutdown, 10);
      if (elapsed > 120) {
        // Marked for 2+ minutes → shutdown
        await shutdownSession(sessionName, terminal);
        await deleteState(shutdownKey);
        shutdown++;
      }
    }
  }

  return { processed, shutdown, escalated, alerted };
}

// Run standalone
if (require.main === module) {
  watchIdle().then(result => {
    console.log(`[watchIdle] Processed: ${result.processed}, Shutdown: ${result.shutdown}, Escalated: ${result.escalated}, Alerted: ${result.alerted}`);
  });
}
