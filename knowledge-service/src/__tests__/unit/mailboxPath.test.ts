/**
 * Mailbox path regression test.
 * PINS the fix for the bug where the mailbox root resolved to
 * `__dirname/../../..` — one level ABOVE the repo (e.g. /opt instead of
 * /opt/nexus-dev) — so writes landed outside the deployment. The root
 * must now follow the config-driven TERMINALS_PATH.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TERMINALS_ROOT = vi.hoisted(() => {
  const runId = require('crypto').randomBytes(6).toString('hex');
  const root = require('path').join(require('os').tmpdir(), `mbx-${runId}`, 'terminals');
  require('fs').mkdirSync(require('path').join(root, 'backend', 'inbox'), { recursive: true });
  process.env.TERMINALS_PATH = root;
  return root;
});

import { sendMessage } from '../../mailbox';

afterAll(() => {
  fs.rmSync(path.dirname(TERMINALS_ROOT), { recursive: true, force: true });
});

describe('mailbox root honors TERMINALS_PATH (deploy-path regression)', () => {
  it('writes an inbox message INSIDE the configured terminals root, not its parent', async () => {
    const result = await sendMessage({
      to: 'backend',
      type: 'task',
      content: 'path regression check',
      priority: 'high',
    });

    // The file must live under <TERMINALS_PATH>/backend/inbox — never one
    // directory above the configured root (the pre-fix bug).
    const expectedPrefix = path.join(TERMINALS_ROOT, 'backend', 'inbox');
    expect(result.path.startsWith(expectedPrefix)).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);

    // Guard against the exact old failure: nothing written to the parent.
    const parentTerminals = path.join(path.dirname(path.dirname(TERMINALS_ROOT)), 'terminals');
    expect(result.path.startsWith(parentTerminals)).toBe(false);
  });
});
