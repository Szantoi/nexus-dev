import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const maximumOutputBytes = 64 * 1024;
const workerPath = fileURLToPath(
  new URL('./smoke-node-pty-worker.mjs', import.meta.url),
);

function classifyWorkerStderr(value) {
  if (process.platform !== 'win32') return { fallbackCount: 0, residual: value };

  const lines = value.split(/\r?\n/);
  const residual = [];
  let fallbackCount = 0;
  for (let index = 0; index < lines.length; ) {
    const firstLine = lines[index];
    if (!/node_modules[\\/]node-pty[\\/]lib[\\/]conpty_console_list_agent\.js:13$/.test(firstLine)) {
      residual.push(firstLine);
      index++;
      continue;
    }

    const nodeVersionOffset = lines
      .slice(index)
      .findIndex((line) => /^Node\.js v\d+\.\d+\.\d+$/.test(line));
    if (nodeVersionOffset < 0) {
      residual.push(firstLine);
      index++;
      continue;
    }
    const end = index + nodeVersionOffset;
    const candidate = lines.slice(index, end + 1);
    const isExactKnownBlock =
      candidate.includes('Error: AttachConsole failed') &&
      candidate.every(
        (line) =>
          line === firstLine ||
          line === 'var consoleProcessList = getConsoleProcessList(shellPid);' ||
          /^\s*\^\s*$/.test(line) ||
          line === '' ||
          line === 'Error: AttachConsole failed' ||
          /^\s+at .+/.test(line) ||
          /^Node\.js v\d+\.\d+\.\d+$/.test(line),
      );
    if (!isExactKnownBlock) {
      residual.push(firstLine);
      index++;
      continue;
    }

    fallbackCount++;
    index = end + 1;
  }

  return { fallbackCount, residual: residual.join('\n').trim() };
}

function terminateWorkerTree(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = [];
  const pending = [pid];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const [candidate, candidateParent] of rows) {
      if (candidateParent === parent && !descendants.includes(candidate)) {
        descendants.push(candidate);
        pending.push(candidate);
      }
    }
  }
  for (const candidate of [...descendants.reverse(), pid]) {
    try {
      process.kill(candidate, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

await new Promise((resolve) => {
  const worker = spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let finished = false;
  const appendBounded = (current, chunk) =>
    (current + String(chunk)).slice(-maximumOutputBytes);
  worker.stdout.on('data', (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  worker.stderr.on('data', (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });

  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    const classifiedStderr = classifyWorkerStderr(stderr);
    if (stdout) process.stdout.write(stdout);
    if (classifiedStderr.fallbackCount > 0) {
      process.stdout.write(
        `${JSON.stringify({
          status: 'INFO',
          nativeKillHelper: 'AttachConsole unavailable',
          validatedFallback: 'descendant PID snapshot + taskkill',
          occurrences: classifiedStderr.fallbackCount,
        })}\n`,
      );
    }
    stderr = classifiedStderr.residual;
    if (stderr) {
      process.stderr.write(`${stderr}\n`);
      if (code === 0 && !error) {
        code = 1;
        error = 'PTY smoke worker emitted unexpected stderr';
      }
    }
    if (error) {
      process.stderr.write(`${JSON.stringify({ status: 'FAIL', error })}\n`);
    }
    if (code !== 0) process.exitCode = 1;
    resolve();
  };
  const timeout = setTimeout(() => {
    try {
      terminateWorkerTree(worker.pid);
    } catch (error) {
      stderr = appendBounded(stderr, `\ncleanup failed: ${error.message}`);
      try {
        worker.kill('SIGKILL');
      } catch {
        // The worker may have exited between tree cleanup and fallback.
      }
    }
    finish(1, 'PTY smoke worker exceeded 30 second hard timeout');
  }, 30_000);

  worker.on('error', (error) =>
    finish(1, `PTY smoke worker failed: ${error.message}`),
  );
  worker.on('exit', (code, signal) =>
    finish(code ?? 1, signal ? `PTY smoke worker exited by ${signal}` : undefined),
  );
});
