// watchResponse.ts - Outbox response routing to target terminals
// 2026-07-01: ISSUE-006 fix - Root outbox → Conductor inbox routing
//
// Figyeli a `type: response` outbox üzeneteket és:
// 1. Ha van `to:` mező, automatikusan wake-olja a target terminált
// 2. SSE event-et emit-ol a target terminálnak
// 3. Opcionálisan másolhatja az üzenetet a target inbox-ba

import * as path from 'path';
import * as fs from 'fs';
import {
  hasSession,
  sendKeys,
  sendEnter,
  getState,
  setState,
  log,
} from './common';
import { queryMessages } from '../messageRegistry';
import { pipelineEvents } from './eventBus';

const RESPONSE_COOLDOWN = 300; // 5 perc cooldown ugyanarra a response-ra
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';

interface ResponseMessage {
  messageId: string;
  filePath: string;
  fromTerminal: string;
  toTerminal: string;
  priority: string;
  ref?: string;
}

/**
 * Find UNREAD response messages in outbox using DB query.
 */
function findUnreadResponses(): ResponseMessage[] {
  // Query DB for UNREAD messages of type 'response' in outbox
  const messages = queryMessages({
    box: 'outbox',
    type: 'response',
    status: 'UNREAD',
  });

  return messages
    .filter(m => m.filePath && m.toTerminal && m.toTerminal !== m.terminal)
    .map(m => ({
      messageId: m.messageId,
      filePath: m.filePath,
      fromTerminal: m.terminal,
      toTerminal: m.toTerminal,
      priority: m.priority || 'medium',
      ref: m.refMessageId,
    }));
}

/**
 * Parse frontmatter from a markdown file.
 */
async function parseFrontmatter(filePath: string): Promise<Record<string, string> | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter: Record<string, string> = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        frontmatter[key] = value;
      }
    }
    return frontmatter;
  } catch {
    return null;
  }
}

/**
 * Get title from file (first H1 heading).
 */
async function getTitle(filePath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1] : path.basename(filePath, '.md');
  } catch {
    return path.basename(filePath, '.md');
  }
}

export async function watchResponse(): Promise<{
  found: number;
  routed: string[];
  skipped: string[];
}> {
  const now = Math.floor(Date.now() / 1000);
  const routed: string[] = [];
  const skipped: string[] = [];

  // 1. Keress UNREAD response üzeneteket
  const responses = findUnreadResponses();

  if (responses.length === 0) {
    return { found: 0, routed, skipped };
  }

  for (const response of responses) {
    const stateKey = `watchResponse_${response.messageId}`;
    const lastRoute = await getState(stateKey);

    // Cooldown ellenőrzés
    if (lastRoute) {
      const elapsed = now - parseInt(lastRoute, 10);
      if (elapsed < RESPONSE_COOLDOWN) {
        skipped.push(response.messageId);
        continue;
      }
    }

    // 2. Target terminál session ellenőrzése
    const targetSession = `spaceos-${response.toTerminal}`;
    const sessionExists = await hasSession(targetSession);

    // 3. SSE event emit a target terminálnak
    pipelineEvents.emit('response:routed', {
      terminal: response.toTerminal,
      messageId: response.messageId,
      data: {
        from: response.fromTerminal,
        priority: response.priority,
        ref: response.ref,
        filePath: response.filePath,
      },
    });

    await log(`[watchResponse] SSE event: ${response.fromTerminal} → ${response.toTerminal} (${response.messageId})`);

    // 4. Ha a target terminál session fut, nudge-olj
    if (sessionExists) {
      const title = await getTitle(response.filePath);
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

      const nudgeMsg = `[${timestamp}] [RESPONSE] Válasz érkezett ${response.fromTerminal} terminálról:
- Message: ${response.messageId}
- Title: ${title}
- Priority: ${response.priority}
${response.ref ? `- Ref: ${response.ref}` : ''}

Olvasd el a választ: ${response.filePath}`;

      await sendKeys(targetSession, nudgeMsg);
      await new Promise(r => setTimeout(r, 300));
      await sendEnter(targetSession);

      await log(`[watchResponse] Nudge sent: ${targetSession} (${response.messageId})`);
    } else {
      // 5. Ha nincs session, wake-up a target terminálnak
      // (watchInbox fogja elindítani ha van UNREAD inbox)
      await log(`[watchResponse] No session for ${response.toTerminal}, will wake via watchInbox if needed`);
    }

    await setState(stateKey, String(now));
    routed.push(response.messageId);
  }

  return {
    found: responses.length,
    routed,
    skipped
  };
}

// Standalone futtatás
if (require.main === module) {
  watchResponse().then(result => {
    console.log(`[watchResponse] Found: ${result.found}, Routed: ${result.routed.join(', ') || 'none'}, Skipped: ${result.skipped.join(', ') || 'none'}`);
  });
}
