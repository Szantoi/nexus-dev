/** ADR-053 EPICS.yaml checkpoint projection maintained after task completion. */

import * as fs from 'fs';
import { getEpicsPath } from '../config/paths';
import { log } from './common';

/** Mark the checkpoint whose DONE condition references the exact message ID. */
export function updateCheckpointStatus(epicId: string, messageId: string): void {
  const epicsPath = getEpicsPath();

  try {
    const content = fs.readFileSync(epicsPath, 'utf-8');
    const escapedMessageId = messageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const conditionPattern = new RegExp(
      `condition:\\s*["']${escapedMessageId}\\s+status=DONE["']`,
    );

    if (!conditionPattern.test(content)) return;

    log(`[EpicRouter] Checkpoint found for ${messageId} in ${epicId}`);
    const lines = content.split('\n');
    const updatedLines: string[] = [];
    let inTargetCheckpoint = false;
    let updated = false;

    for (const line of lines) {
      if (conditionPattern.test(line)) inTargetCheckpoint = true;

      if (inTargetCheckpoint && line.includes('status:') && line.includes('pending')) {
        updatedLines.push(line.replace('pending', 'done'));
        inTargetCheckpoint = false;
        updated = true;
        log(`[EpicRouter] Updated checkpoint status to done for ${messageId}`);
      } else {
        updatedLines.push(line);
      }

      if (inTargetCheckpoint && line.trim().startsWith('- id:') && !line.includes(messageId)) {
        inTargetCheckpoint = false;
      }
    }

    if (updated) {
      fs.writeFileSync(epicsPath, updatedLines.join('\n'), 'utf-8');
      log(`[EpicRouter] EPICS.yaml checkpoint updated for ${messageId}`);
    }
  } catch (error) {
    log(`[EpicRouter] Error updating checkpoint: ${error}`);
  }
}
