/**
 * sessionLauncher.ts — Starts a local Claude Code session for one task.
 *
 * Windows-first: no tmux — a direct `claude -p` (headless print-mode)
 * process per task, working directory taken from the terminal whitelist.
 *
 * CLOSED COMMAND SET:
 * - argv is exactly [--model <whitelisted>, -p, ...config extra_args];
 *   every element comes from the local config file or a closed enum.
 * - The task-assignment prompt goes in via STDIN, never argv — so even
 *   on Windows (where .cmd shims force shell:true) nothing attacker-
 *   influenced touches the shell.
 * - The prompt itself only references terminal + message ID; content is
 *   fetched by the agent over authenticated MCP.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../core/logger';
import { MODELS, type ModelName, type RunnerConfig } from './runnerConfig';
import { buildTaskAssignmentPrompt } from './taskPrompt';

// Message IDs become log filenames — anything else is rejected outright.
const SAFE_MESSAGE_ID = /^[A-Za-z0-9._-]+$/;

export interface LaunchRequest {
  terminal: string;
  messageId: string;
  /** Model requested by the task frontmatter — honored only if whitelisted. */
  model?: string;
}

export interface LaunchResult {
  started: boolean;
  reason?: string;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export class SessionLauncher {
  /** terminal -> running child (one session per terminal at a time). */
  private readonly active = new Map<string, ChildProcess>();

  constructor(
    private readonly config: RunnerConfig,
    private readonly spawnFn: SpawnFn = spawn,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  isBusy(terminal: string): boolean {
    return this.active.has(terminal);
  }

  activeCount(): number {
    return this.active.size;
  }

  private resolveModel(terminal: string, requested?: string): ModelName {
    const entry = this.config.terminals[terminal];
    if (requested && (MODELS as readonly string[]).includes(requested)) {
      const model = requested as ModelName;
      if (entry.models.includes(model)) return model;
    }
    return entry.default_model;
  }

  launch(req: LaunchRequest): LaunchResult {
    const entry = this.config.terminals[req.terminal];
    if (!entry) {
      return { started: false, reason: `terminal not whitelisted: ${req.terminal}` };
    }
    if (!SAFE_MESSAGE_ID.test(req.messageId)) {
      return { started: false, reason: `unsafe message id rejected: ${req.messageId}` };
    }
    if (this.active.has(req.terminal)) {
      return { started: false, reason: `terminal busy: ${req.terminal}` };
    }
    if (!fs.existsSync(entry.workdir)) {
      return { started: false, reason: `workdir missing: ${entry.workdir}` };
    }

    const model = this.resolveModel(req.terminal, req.model);
    const args = ['--model', model, '-p', ...this.config.extra_args];

    const logDir = path.join(this.config.log_dir, req.terminal);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${req.messageId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', (err) => {
      // A broken log file must never take the runner down with it.
      logger.warn(`[Runner] Session log write failed (${logFile}): ${err.message}`);
    });
    logStream.write(
      `--- launch ${new Date().toISOString()} terminal=${req.terminal} model=${model} ---\n`,
    );

    let child: ChildProcess;
    try {
      // Windows: `claude` is usually a .cmd shim, which Node refuses to
      // spawn without a shell — and args-array + shell is DEP0190, so the
      // command is joined by hand. Safe: every part is SAFE_ARG-validated
      // (no whitespace/metacharacters) or a closed enum.
      child =
        this.platform === 'win32'
          ? this.spawnFn([this.config.claude_bin, ...args].join(' '), [], {
              cwd: entry.workdir,
              shell: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          : this.spawnFn(this.config.claude_bin, args, {
              cwd: entry.workdir,
              shell: false,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
    } catch (err) {
      logStream.end(`spawn failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return { started: false, reason: `spawn failed: ${this.config.claude_bin}` };
    }

    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });

    // Prompt via stdin — never argv (see module header).
    child.stdin?.write(buildTaskAssignmentPrompt(req.terminal, req.messageId));
    child.stdin?.end();

    this.active.set(req.terminal, child);

    child.on('error', (err) => {
      logger.error(`[Runner] Session error (${req.terminal}/${req.messageId}):`, err.message);
      logStream.end(`process error: ${err.message}\n`);
      this.active.delete(req.terminal);
    });

    child.on('exit', (code) => {
      logger.info(`[Runner] Session exited (${req.terminal}/${req.messageId}) code=${code}`);
      logStream.end(`--- exit code=${code} ${new Date().toISOString()} ---\n`);
      this.active.delete(req.terminal);
    });

    logger.info(
      `[Runner] Session started: ${req.terminal}/${req.messageId} model=${model} log=${logFile}`,
    );
    return { started: true };
  }
}
