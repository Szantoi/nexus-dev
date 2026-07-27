import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const gateScript = path.join(process.cwd(), 'scripts', 'runner-gate.mjs');

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { directory: string; configPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-gate-cli-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'runner.yaml');
  fs.writeFileSync(
    configPath,
    ['log_dir: logs', 'terminals:', '  explorer: {}', '  backend: {}', ''].join('\n'),
    'utf8',
  );
  return { directory, configPath };
}

function runGate(fixtureData: { directory: string; configPath: string }, ...args: string[]) {
  return childProcess.spawnSync(process.execPath, [gateScript, ...args], {
    cwd: fixtureData.directory,
    encoding: 'utf8',
    env: { ...process.env, RUNNER_CONFIG_PATH: fixtureData.configPath },
  });
}

function status(fixtureData: { directory: string; configPath: string }) {
  const result = runGate(fixtureData, 'status');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    gateFile: string;
    locked: boolean;
    terminals: Array<{
      terminal: string;
      grants: string[];
      active: { messageId?: string } | null;
      latestEvent: { file: string; at: string; type: string; rawType: string | null } | null;
    }>;
  };
}

describe('runner-gate CLI', () => {
  it('grants one named task, reports safe operational state, and pauses the terminal', () => {
    const testFixture = fixture();
    const terminalLogDirectory = path.join(testFixture.directory, 'logs', 'explorer');
    fs.mkdirSync(terminalLogDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(terminalLogDirectory, 'active.json'),
      `${JSON.stringify({ terminal: 'explorer', messageId: 'MSG-CANARY-1' })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(terminalLogDirectory, 'MSG-CANARY-1.jsonl'),
      [
        JSON.stringify({ at: '2026-07-27T18:00:00.000Z', type: 'started' }),
        JSON.stringify({ at: '2026-07-27T18:00:01.000Z', type: 'completed' }),
        '',
      ].join('\n'),
      'utf8',
    );

    expect(runGate(testFixture, 'grant', 'explorer', 'MSG-CANARY-1').status).toBe(0);
    expect(runGate(testFixture, 'grant', 'explorer', 'MSG-CANARY-1').status).toBe(0);

    const granted = status(testFixture);
    expect(granted.locked).toBe(false);
    expect(granted.terminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          terminal: 'explorer',
          grants: ['MSG-CANARY-1'],
          active: { terminal: 'explorer', messageId: 'MSG-CANARY-1' },
          latestEvent: {
            file: 'MSG-CANARY-1.jsonl',
            at: '2026-07-27T18:00:01.000Z',
            type: 'completed',
            rawType: null,
          },
        }),
        expect.objectContaining({ terminal: 'backend', grants: [], active: null, latestEvent: null }),
      ]),
    );

    expect(runGate(testFixture, 'pause', 'explorer').status).toBe(0);
    expect(status(testFixture).terminals.find((entry) => entry.terminal === 'explorer')?.grants).toEqual([]);
  });

  it('rejects an unsafe or unknown grant without creating a gate file', () => {
    const testFixture = fixture();
    const result = runGate(testFixture, 'grant', 'unknown', 'MSG-CANARY-1');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown or unsafe terminal: unknown');
    expect(fs.existsSync(path.join(testFixture.directory, 'logs', 'dispatch-gates.json'))).toBe(false);
  });

  it('fails closed when another gate mutation owns the lock', () => {
    const testFixture = fixture();
    const lockPath = path.join(testFixture.directory, 'logs', 'dispatch-gates.json.lock');
    fs.mkdirSync(lockPath, { recursive: true });

    const result = runGate(testFixture, 'grant', 'explorer', 'MSG-CANARY-1');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dispatch gate is busy; retry the operation');
    expect(status(testFixture).locked).toBe(true);
  });
});
