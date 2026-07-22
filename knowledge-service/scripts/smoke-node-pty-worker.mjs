import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Native worker; always invoke through smoke-node-pty.mjs for hard timeout. */
const pty = await import('node-pty');

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serviceDirectory = dirname(scriptDirectory);
const servicePackage = JSON.parse(
  readFileSync(join(serviceDirectory, 'package.json'), 'utf8'),
);
const expectedVersion = servicePackage.dependencies?.['node-pty'];
const installedEntryPoint = fileURLToPath(import.meta.resolve('node-pty'));
const installedPackage = JSON.parse(
  readFileSync(join(dirname(installedEntryPoint), '..', 'package.json'), 'utf8'),
);

if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? '')) {
  throw new Error('node-pty must be pinned to an exact production version');
}
if (installedPackage.version !== expectedVersion) {
  throw new Error(
    `node-pty version mismatch: expected ${expectedVersion}, got ${installedPackage.version}`,
  );
}

const workDirectory = mkdtempSync(join(tmpdir(), 'nexus pty árvíztűrő-'));
const cwdMarker = join(workDirectory, '.nexus-pty-cwd-ok');
const isWindows = process.platform === 'win32';
const shell = isWindows ? 'powershell.exe' : '/bin/sh';
const shellArgs = isWindows
  ? ['-NoLogo', '-NoProfile', '-NoExit']
  : [];

let childPid;
let terminal;
let output = '';

if (process.env.NEXUS_PTY_SMOKE_TEST_STDERR === '1') {
  process.stderr.write('NEXUS_INJECTED_UNEXPECTED_STDERR\n');
}

function trace(stage) {
  if (process.env.NEXUS_PTY_SMOKE_TRACE === '1') {
    process.stderr.write(`${JSON.stringify({ trace: stage, platform: process.platform })}\n`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function isProcessAlive(pid) {
  if (!isWindows) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function getLinuxPtySessionId(rootPid) {
  try {
    const sessionId = execFileSync(
      'ps',
      ['-o', 'sid=', '-p', String(rootPid)],
      { encoding: 'utf8' },
    ).trim();
    return /^\d+$/.test(sessionId) ? Number.parseInt(sessionId, 10) : undefined;
  } catch {
    return undefined;
  }
}

function listLinuxPtySessionPids(sessionId) {
  try {
    return execFileSync('ps', ['-o', 'pid=', '--sid', String(sessionId)], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .filter((value) => /^\d+$/.test(value))
      .map((value) => Number.parseInt(value, 10));
  } catch {
    return [];
  }
}

function signalLinuxPtySession(rootPid, sessionId, signal) {
  const pids = listLinuxPtySessionPids(sessionId);
  const descendantsFirst = [
    ...pids.filter((pid) => pid !== rootPid),
    ...(pids.includes(rootPid) ? [rootPid] : []),
  ];
  for (const pid of descendantsFirst) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function listWindowsDescendantPids(rootPid) {
  const command = [
    'Get-CimInstance Win32_Process',
    'Select-Object ProcessId,ParentProcessId',
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const json = execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  const records = json ? JSON.parse(json) : [];
  const processes = Array.isArray(records) ? records : [records];
  const descendants = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const processRecord of processes) {
      if (
        processRecord.ParentProcessId === parent &&
        !descendants.includes(processRecord.ProcessId)
      ) {
        descendants.push(processRecord.ProcessId);
        pending.push(processRecord.ProcessId);
      }
    }
  }
  return descendants;
}

async function terminatePtyProcessTree() {
  if (!terminal?.pid) {
    terminal?.kill();
    return;
  }

  if (isWindows) {
    const descendants = listWindowsDescendantPids(terminal.pid);
    terminal.kill();
    await delay(250);
    for (const pid of descendants.reverse()) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        // The PTY close may already have removed this descendant.
      }
    }
    return;
  }

  // Interactive jobs may use separate process groups, but they remain in the
  // forkpty session. Terminate descendants before the session leader, then
  // escalate after a short grace period.
  const sessionId = getLinuxPtySessionId(terminal.pid);
  if (sessionId === undefined) {
    throw new Error(`Cannot resolve forkpty session for PID ${terminal.pid}`);
  }
  signalLinuxPtySession(terminal.pid, sessionId, 'SIGTERM');
  await delay(250);
  signalLinuxPtySession(terminal.pid, sessionId, 'SIGKILL');
}

function cleanupProcessTree() {
  if (terminal) {
    try {
      terminal.kill();
    } catch {
      // The PTY may already be closed; child cleanup below is the fallback.
    }
  }
  if (!childPid || !isProcessAlive(childPid)) return;

  try {
    if (isWindows) {
      execFileSync('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(childPid, 'SIGKILL');
    }
  } catch {
    // Preserve the original smoke failure while making a best-effort cleanup.
  }
}

try {
  trace('before-spawn');
  terminal = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: workDirectory,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  trace('after-spawn');

  terminal.onData((data) => {
    output += data;
    const match = /NEXUS_CHILD_PID=(\d+)/.exec(output);
    if (match) childPid = Number.parseInt(match[1], 10);
  });

  await delay(250);
  trace('before-resize');
  terminal.resize(100, 32);
  await delay(150);
  trace('before-write');

  const command = isWindows
    ? [
        "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru",
        "Set-Content -LiteralPath '.nexus-pty-cwd-ok' -Value 'ok'",
        '$size = $Host.UI.RawUI.WindowSize',
        'Write-Output ("NEXUS_CHILD_PID=" + $child.Id)',
        'Write-Output ("NEXUS_SIZE=" + $size.Height + "x" + $size.Width)',
      ].join('; ')
    : [
        "sh -c 'trap \"\" TERM; sleep 60' & child=$!",
        ": > '.nexus-pty-cwd-ok'",
        'set -- $(stty size)',
        "printf 'NEXUS_CHILD_PID=%s\\nNEXUS_SIZE=%sx%s\\n' \"$child\" \"$1\" \"$2\"",
      ].join('; ');

  terminal.write(`${command}${isWindows ? '\r' : '\n'}`);

  await waitUntil(
    () => childPid !== undefined && existsSync(cwdMarker),
    'PTY write and child process creation',
  );
  if (!isProcessAlive(childPid)) {
    throw new Error(`PTY child process ${childPid} exited before tree-kill check`);
  }
  await waitUntil(
    () => output.includes('NEXUS_SIZE=32x100'),
    'PTY resize observation (32x100)',
  );

  const exitPromise = new Promise((resolve) => terminal.onExit(resolve));
  await terminatePtyProcessTree();
  await Promise.race([
    exitPromise,
    delay(5_000).then(() => {
      throw new Error('PTY root process did not exit after kill');
    }),
  ]);
  await waitUntil(
    () => !isProcessAlive(childPid),
    `PTY child tree ${childPid} to exit`,
    5_000,
  );

  process.stdout.write(
    `${JSON.stringify({
      status: 'PASS',
      nodePtyVersion: installedPackage.version,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      workDirectory: 'unicode-and-space',
      resize: '32x100',
      processTreeKill: 'PASS',
    })}\n`,
  );
} catch (error) {
  cleanupProcessTree();
  process.stderr.write(
    `${JSON.stringify({
      status: 'FAIL',
      platform: process.platform,
      node: process.version,
      error: error instanceof Error ? error.message : String(error),
      outputTail: output.slice(-1_000),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
