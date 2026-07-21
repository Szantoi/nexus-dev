import { describe, expect, it } from 'vitest';
import { AntigravityAdapter } from '../../runner/antigravityAdapter';
import { ClaudeAdapter } from '../../runner/claudeAdapter';
import { CodexAdapter } from '../../runner/codexAdapter';
import type { LaunchContext } from '../../runner/cliAdapter';

function context(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    workdir: '/workspace with spaces',
    additionalWriteDirs: ['/shared source'],
    model: 'gpt-5.6-terra',
    prompt: 'Do the assigned task safely.',
    providerConfig: {
      binary: '/opt/codex bin/codex',
      sandbox: 'workspace-write',
      ephemeral: true,
      skip_git_repo_check: true,
      extra_args: [],
    },
    ...overrides,
  };
}

describe('CLI adapters', () => {
  it('builds a shell-free Codex exec spec with stdin prompt and path argv', () => {
    const spec = new CodexAdapter().buildLaunchSpec(context());
    expect(spec.command).toBe('/opt/codex bin/codex');
    expect(spec.cwd).toBe('/workspace with spaces');
    expect(spec.stdin).toBe('Do the assigned task safely.');
    expect(spec.args).toEqual([
      'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write',
      '--model', 'gpt-5.6-terra', '--cd', '/workspace with spaces',
      '--ephemeral', '--skip-git-repo-check', '--add-dir', '/shared source', '-',
    ]);
  });

  it('normalizes Codex lifecycle, tool and malformed JSONL events', () => {
    const adapter = new CodexAdapter();
    expect(adapter.parseEvent('{"type":"thread.started","thread_id":"t1"}')?.type).toBe('started');
    expect(
      adapter.parseEvent('{"type":"item.completed","item":{"type":"command_execution"}}')?.type,
    ).toBe('tool');
    expect(
      adapter.parseEvent('{"type":"item.completed","item":{"type":"command_execution","status":"failed"}}')?.type,
    ).toBe('failed');
    expect(adapter.parseEvent('{"type":"turn.completed"}')?.type).toBe('completed');
    expect(adapter.parseEvent('{broken')?.type).toBe('output');
  });

  it('maps Claude sandbox and resource limits without bypass flags', () => {
    const adapter = new ClaudeAdapter();
    const spec = adapter.buildLaunchSpec(context({
      model: 'sonnet',
      providerConfig: {
        binary: 'claude',
        sandbox: 'read-only',
        ephemeral: true,
        skip_git_repo_check: false,
        max_turns: 12,
        max_budget_usd: 3,
        extra_args: [],
      },
    }));
    expect(spec.args).toEqual(expect.arrayContaining([
      '--print', '--output-format', 'stream-json', '--permission-mode', 'plan',
      '--max-turns', '12', '--max-budget-usd', '3',
    ]));
    expect(spec.args.join(' ')).not.toMatch(/dangerously|bypass/i);
  });

  it('declares Antigravity plain-text capability honestly', () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.capabilities.structuredOutputFormats).toEqual([]);
    expect(adapter.parseEvent('working')?.type).toBe('output');
  });
});
