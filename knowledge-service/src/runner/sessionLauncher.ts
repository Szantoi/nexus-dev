/**
 * Starts one provider-neutral headless CLI session per terminal.
 *
 * The command and argv are supplied by a closed adapter registry. Prompt data
 * is written to stdin, never interpolated into a shell command. Processes run
 * in their own group so timeout, cancellation and shutdown can remove the full
 * tree on Linux and Windows.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../core/logger';
import { getCliAdapter } from './adapterRegistry';
import type { AdapterEvent, CliProvider } from './cliAdapter';
import type { RunnerConfig } from './runnerConfig';
import { buildTaskAssignmentPrompt } from './taskPrompt';

const SAFE_MESSAGE_ID = /^[A-Za-z0-9._-]+$/;

export interface LaunchRequest {
  terminal: string;
  messageId: string;
  model?: string;
}

export interface LaunchResult {
  started: boolean;
  reason?: string;
  provider?: CliProvider;
  model?: string;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type TerminateFn = (child: ChildProcess, platform: NodeJS.Platform) => void;

interface ActiveSession {
  child: ChildProcess;
  provider: CliProvider;
  timeout: NodeJS.Timeout;
  logStream: fs.WriteStream;
  finished: boolean;
  taskCompleted: boolean;
}

export function isSuccessfulTaskCompletion(event: AdapterEvent): boolean {
  if (!event.data || typeof event.data !== 'object') return false;
  const item = (event.data as Record<string, unknown>).item;
  if (!item || typeof item !== 'object') return false;
  const record = item as Record<string, unknown>;
  if (
    record.type !== 'mcp_tool_call' ||
    record.tool !== 'complete_task' ||
    record.status !== 'completed' ||
    record.error
  ) {
    return false;
  }
  const result = record.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as { success?: boolean; completed?: boolean };
    return parsed.success === true && parsed.completed === true;
  } catch {
    return false;
  }
}

export function terminateProcessTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (!child.pid) {
    child.kill('SIGTERM');
    return;
  }

  if (platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/pid', String(child.pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    killer.unref();
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function writeNormalizedEvent(stream: fs.WriteStream, event: AdapterEvent): void {
  stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function activeMarkerPath(config: RunnerConfig, terminal: string): string {
  return path.join(config.log_dir, terminal, 'active.json');
}

/** A systemd restart has already killed the old control group; clear its markers. */
export function clearStaleSessionMarkers(config: RunnerConfig): void {
  for (const terminal of Object.keys(config.terminals)) {
    try {
      fs.rmSync(activeMarkerPath(config, terminal), { force: true });
    } catch (error) {
      throw new Error(
        `cannot clear stale session marker for ${terminal}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export class SessionLauncher {
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    private readonly config: RunnerConfig,
    private readonly spawnFn: SpawnFn = spawn,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly terminateFn: TerminateFn = terminateProcessTree,
  ) {}

  isBusy(terminal: string): boolean {
    return this.active.has(terminal);
  }

  activeCount(): number {
    return this.active.size;
  }

  private resolveModel(terminal: string, requested?: string): string {
    const entry = this.config.terminals[terminal];
    return requested && entry.models.includes(requested) ? requested : entry.default_model;
  }

  launch(req: LaunchRequest): LaunchResult {
    const entry = this.config.terminals[req.terminal];
    if (!entry) return { started: false, reason: `terminal not whitelisted: ${req.terminal}` };
    if (!SAFE_MESSAGE_ID.test(req.messageId)) {
      return { started: false, reason: `unsafe message id rejected: ${req.messageId}` };
    }
    if (this.active.has(req.terminal)) {
      return { started: false, reason: `terminal busy: ${req.terminal}` };
    }
    if (!fs.existsSync(entry.workdir)) {
      return { started: false, reason: `workdir missing: ${entry.workdir}` };
    }
    for (const directory of entry.additional_write_dirs) {
      if (!fs.existsSync(directory)) {
        return { started: false, reason: `additional write directory missing: ${directory}` };
      }
    }

    const provider = entry.provider || this.config.default_provider;
    const providerConfig = this.config.providers[provider];
    if (!providerConfig) {
      return { started: false, reason: `provider not configured: ${provider}` };
    }
    const model = this.resolveModel(req.terminal, req.model);
    const adapter = getCliAdapter(provider);
    const childEnv = { ...process.env };
    if (providerConfig.auth_env_var) {
      if (!entry.credential_env) {
        return { started: false, reason: `credential_env missing for terminal: ${req.terminal}` };
      }
      const credential = process.env[entry.credential_env];
      if (!credential) {
        return { started: false, reason: `credential source unavailable: ${entry.credential_env}` };
      }
      childEnv[providerConfig.auth_env_var] = credential;
    }
    const prompt = buildTaskAssignmentPrompt(
      req.terminal,
      req.messageId,
      this.config.mcp_server_name,
    );
    const spec = adapter.buildLaunchSpec({
      workdir: entry.workdir,
      additionalWriteDirs: entry.additional_write_dirs,
      model,
      prompt,
      providerConfig,
    });

    const logDir = path.join(this.config.log_dir, req.terminal);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${req.messageId}.jsonl`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', (error) => {
      logger.warn(`[Runner] Session log write failed (${logFile}): ${error.message}`);
    });
    writeNormalizedEvent(logStream, {
      type: 'started',
      provider,
      text: `terminal=${req.terminal} message=${req.messageId} model=${model}`,
    });

    let child: ChildProcess;
    try {
      child = this.spawnFn(spec.command, spec.args, {
        cwd: spec.cwd,
        shell: false,
        detached: true,
        windowsHide: true,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      logStream.end();
      return {
        started: false,
        reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const timeout = setTimeout(() => {
      logger.warn(`[Runner] Session timeout (${req.terminal}/${req.messageId})`);
      this.cancel(req.terminal, 'timeout');
    }, this.config.session_timeout_ms);
    timeout.unref();

    const active: ActiveSession = {
      child,
      provider,
      timeout,
      logStream,
      finished: false,
      taskCompleted: false,
    };
    this.active.set(req.terminal, active);

    try {
      fs.writeFileSync(
        activeMarkerPath(this.config, req.terminal),
        `${JSON.stringify({
          terminal: req.terminal,
          messageId: req.messageId,
          provider,
          pid: child.pid,
          startedAt: new Date().toISOString(),
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (error) {
      this.active.delete(req.terminal);
      clearTimeout(timeout);
      this.terminateFn(child, this.platform);
      writeNormalizedEvent(logStream, {
        type: 'failed',
        provider,
        text: 'active session marker could not be persisted',
      });
      logStream.end();
      return {
        started: false,
        reason: `active marker persist failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let outputBytes = 0;
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > this.config.max_output_bytes) {
        writeNormalizedEvent(logStream, {
          type: 'failed',
          provider,
          text: `output limit exceeded (${this.config.max_output_bytes} bytes)`,
        });
        this.cancel(req.terminal, 'output-limit');
        return;
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const event = adapter.parseEvent(line);
        if (event) {
          if (isSuccessfulTaskCompletion(event)) active.taskCompleted = true;
          writeNormalizedEvent(logStream, event);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      writeNormalizedEvent(logStream, { type: 'progress', provider, text });
      if (outputBytes > this.config.max_output_bytes) this.cancel(req.terminal, 'output-limit');
    });

    const finish = (type: 'failed' | 'completed', text: string): void => {
      if (active.finished) return;
      active.finished = true;
      clearTimeout(active.timeout);
      if (stdoutBuffer) {
        const event = adapter.parseEvent(stdoutBuffer);
        if (event) {
          if (isSuccessfulTaskCompletion(event)) active.taskCompleted = true;
          writeNormalizedEvent(logStream, event);
        }
      }
      writeNormalizedEvent(logStream, { type, provider, text });
      logStream.end();
      this.active.delete(req.terminal);
      try {
        fs.rmSync(activeMarkerPath(this.config, req.terminal), { force: true });
      } catch (error) {
        logger.warn(
          `[Runner] Active marker cleanup failed (${req.terminal}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    child.on('error', (error) => {
      logger.error(`[Runner] Session error (${req.terminal}/${req.messageId}):`, error.message);
      finish('failed', `process error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      logger.info(
        `[Runner] Session exited (${req.terminal}/${req.messageId}) code=${code} signal=${signal || 'none'}`,
      );
      // Server-authoritative complete_task wins over recoverable intermediate
      // command/tool failures. Without that durable completion proof, exit 0
      // is not enough to call an autonomous task successful.
      const succeeded = code === 0 && active.taskCompleted;
      finish(succeeded ? 'completed' : 'failed', `exit code=${code} signal=${signal || 'none'}`);
    });

    child.stdin?.write(spec.stdin);
    child.stdin?.end();
    logger.info(
      `[Runner] Session started: ${req.terminal}/${req.messageId} provider=${provider} model=${model} log=${logFile}`,
    );
    return { started: true, provider, model };
  }

  cancel(terminal: string, reason = 'cancelled'): boolean {
    const active = this.active.get(terminal);
    if (!active || active.finished) return false;
    writeNormalizedEvent(active.logStream, {
      type: reason === 'timeout' ? 'failed' : 'cancelled',
      provider: active.provider,
      text: reason,
    });
    this.terminateFn(active.child, this.platform);
    return true;
  }

  cancelAll(reason = 'runner-shutdown'): number {
    let count = 0;
    for (const terminal of [...this.active.keys()]) {
      if (this.cancel(terminal, reason)) count++;
    }
    return count;
  }
}
