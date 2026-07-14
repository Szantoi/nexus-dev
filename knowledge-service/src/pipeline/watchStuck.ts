// Watch Stuck - TypeScript equivalent of watch-stuck.sh
// Detects stuck sessions and sends nudge
// 2026-06-24: Optimized to use messageRegistry DB
// 2026-07-04: Migrated to NWT (Nightwatch Tick) time units

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SESSIONS,
  listSessions,
  hasSession,
  capturePane,
  sendKeys,
  sendEnter,
  getState,
  setState,
  getInboxModel,
  telegram,
  log,
} from './common';
import { getUnreadMessages } from '../messageRegistry';
import { NWT_TIMEOUTS, nwtToMs } from '../constants/nwt';

// 2.5 NWT ≈ 5 minutes between nudges (using STUCK_NUDGE × 1.25 for cooldown)
const STUCK_COOLDOWN = Math.floor(nwtToMs(NWT_TIMEOUTS.STUCK_NUDGE) * 1.25 / 1000); // ~5 min in seconds

interface StuckResult {
  session: string;
  reason: string;
}

// Get first UNREAD inbox file for terminal - now uses DB query
function getUnreadInboxFile(terminal: string): string | null {
  try {
    const unread = getUnreadMessages(terminal, 'inbox');
    if (unread.length > 0 && unread[0].filePath) {
      return unread[0].filePath;
    }
  } catch {
    // DB not ready
  }
  return null;
}

async function getFilesFromInbox(inboxFile: string): Promise<string> {
  try {
    const content = await fs.readFile(inboxFile, 'utf-8');
    const lines = content.split('\n');
    let inFrontmatter = false;
    const files: string[] = [];

    for (const line of lines) {
      if (line === '---') {
        inFrontmatter = !inFrontmatter;
        continue;
      }
      if (inFrontmatter && line.match(/^\s*-\s+/)) {
        files.push(line.replace(/^\s*-\s+/, '').trim());
      }
    }

    return files.slice(0, 5).join(' ');
  } catch {
    return '';
  }
}

export async function watchStuck(): Promise<{ processed: number; nudged: StuckResult[] }> {
  const now = Math.floor(Date.now() / 1000);
  let processed = 0;
  const nudged: StuckResult[] = [];

  const sessions = await listSessions();

  for (const sessionName of sessions) {
    const terminal = SESSIONS[sessionName];
    if (!terminal) continue;

    // Skip root - doesn't get automatic triggers
    if (sessionName === 'spaceos-root') continue;

    if (!(await hasSession(sessionName))) continue;

    processed++;

    const paneOutput = await capturePane(sessionName, 10);

    // Model selector handling
    const modelSelectorPattern = /claude opus|claude sonnet|claude haiku|Choose a model|Select model|which model|Default model/i;
    if (modelSelectorPattern.test(paneOutput)) {
      const wantedModel = await getInboxModel(terminal);
      await sendKeys(sessionName, wantedModel);
      await sendEnter(sessionName);
      await log(`Model választó kezelve: ${sessionName} → ${wantedModel}`);
      await telegram(`🤖 *${terminal.toUpperCase()} model választó* — \`${wantedModel}\` kiválasztva`);
      nudged.push({ session: sessionName, reason: 'model-selector' });
      continue;
    }

    // Stuck state detection
    let stuck = false;
    let stuckReason = '';

    if (paneOutput.includes('Press up to edit queued messages')) {
      stuck = true;
      stuckReason = 'queued-messages prompt';
    } else if (/Choose a model|Select model|which model/i.test(paneOutput)) {
      stuck = true;
      stuckReason = 'model-selector';
    }
    // NOTE: "shift+tab to cycle" and empty prompt are NOT stuck states!
    // That's normal input waiting. watch-inbox.sh handles nudging if there's UNREAD.

    if (!stuck) continue;

    // Check cooldown
    const stuckKey = `${sessionName}_stuck_sent`;
    const lastSent = await getState(stuckKey);
    const elapsed = lastSent ? now - parseInt(lastSent, 10) : STUCK_COOLDOWN + 1;

    if (elapsed <= STUCK_COOLDOWN) continue;

    // Just send Enter to unstick - no text message needed
    // The terminal already has its CLAUDE.md instructions
    await sendEnter(sessionName);
    await new Promise(r => setTimeout(r, 500));
    await sendEnter(sessionName);

    await setState(stuckKey, String(now));
    await log(`Escape+Enter küldve: ${sessionName} (${stuckReason})`);
    await telegram(`🔧 *${terminal.toUpperCase()} beakadt* (${stuckReason}) — Escape+Enter elküldve`);

    nudged.push({ session: sessionName, reason: stuckReason });
  }

  return { processed, nudged };
}

// Run standalone
if (require.main === module) {
  watchStuck().then(result => {
    console.log(`[watchStuck] Processed: ${result.processed}, Nudged: ${result.nudged.length}`);
    result.nudged.forEach(n => console.log(`  - ${n.session}: ${n.reason}`));
  });
}
