/** Structural regression guard for the active autonomous launch paths. */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', relativePath), 'utf8');
}

describe('single autonomous launch authority', () => {
  it('keeps the inbox watcher notification-only', () => {
    const code = source('bootstrap/startup.ts');
    expect(code).not.toContain("from '../sessionStarter'");
    expect(code).not.toContain('startTerminalSession(');
    expect(code).toContain("mailboxEvents.emit('notification'");
  });

  it('queues autonomous, checkpoint, escalation and MCP work requests', () => {
    const autonomous = source('pipeline/autonomousDev.ts');
    const subscriptions = source('pipeline/subscriptionManager.ts');
    const escalation = source('pipeline/taskEscalation.ts');
    const sessionTools = source('interfaces/mcp/tools/session.tools.ts');

    expect(autonomous).toContain('enqueueConductorTask');
    expect(autonomous).not.toMatch(/newSession\(|claude --model/);
    expect(subscriptions).toContain('await createTask({');
    expect(subscriptions).not.toContain('startWorkSession(');
    expect(escalation).toContain('await createTask({');
    expect(escalation).not.toMatch(/startWorkSession\(|tmux kill-session/);
    expect(sessionTools).toContain('Work request queued as');
    expect(sessionTools).not.toContain("import('../../../sessionStarter')");
  });

  it('root-gates subscription mutation routes and defaults review to API mode', () => {
    expect(source('bootstrap/app.ts')).toContain(
      "app.use('/api/subscriptions', requireRootForMutations, subscriptionRoutes)",
    );
    expect(source('config/env.ts')).toContain(
      "REVIEW_MODE: z.enum(['terminal', 'api']).default('api')",
    );
  });

  it('keeps provider-specific CLI logic outside the runner core', () => {
    const launcher = source('runner/sessionLauncher.ts');
    expect(launcher).not.toMatch(/provider\s*===\s*['\"](?:codex|claude|antigravity)/);
    expect(launcher).not.toMatch(/codex exec|claude --model|agy -p/);
    expect(launcher).toContain('getCliAdapter(provider)');
  });
});
