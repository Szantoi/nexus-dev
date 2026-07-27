import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileDispatchGate } from '../../runner/dispatchGate';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function gate(): FileDispatchGate {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-gate-'));
  temporaryDirectories.push(directory);
  return new FileDispatchGate(path.join(directory, 'dispatch-gates.json'));
}

describe('FileDispatchGate', () => {
  it('grants one exact task and consumes it atomically after launch', () => {
    const store = gate();

    store.grant('explorer', 'MSG-CANARY-1');
    expect(store.allows('explorer', 'MSG-CANARY-1')).toBe(true);
    expect(store.allows('explorer', 'MSG-OTHER')).toBe(false);

    store.consume('explorer', 'MSG-CANARY-1');
    expect(store.allows('explorer', 'MSG-CANARY-1')).toBe(false);
    expect(store.snapshot()).toEqual({ version: 1, terminals: {} });
  });

  it('keeps grants terminal-scoped and pauses one terminal only', () => {
    const store = gate();
    store.grant('explorer', 'MSG-CANARY-1');
    store.grant('backend', 'MSG-CANARY-2');

    store.pause('explorer');

    expect(store.allows('explorer', 'MSG-CANARY-1')).toBe(false);
    expect(store.allows('backend', 'MSG-CANARY-2')).toBe(true);
  });

  it('fails closed for corrupt gate state and unsafe identities', () => {
    const store = gate();
    fs.writeFileSync(store.filePath, '{not json}', 'utf8');
    expect(() => store.snapshot()).toThrow();
    expect(() => store.grant('Explorer', 'MSG-CANARY-1')).toThrow(/unsafe terminal/);
    expect(() => store.grant('explorer', '../MSG')).toThrow(/unsafe message ID/);
  });

  it('fails closed rather than overwriting a concurrent pause or consume', () => {
    const store = gate();
    fs.mkdirSync(`${store.filePath}.lock`);

    expect(() => store.grant('explorer', 'MSG-CANARY-1')).toThrow(/dispatch gate is busy/);
    expect(fs.existsSync(store.filePath)).toBe(false);
  });
});
