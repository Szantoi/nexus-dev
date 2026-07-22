/**
 * TerminalSink — the execution boundary between the poll loop (the single
 * launch authority) and however a terminal actually runs a task.
 *
 * The poll decides *whether* to launch; the sink only *executes*. Today the
 * only implementation is the {@link HeadlessSink} (an autonomous, one-shot CLI
 * session per task — see {@link SessionLauncher}). A future `attached` sink
 * (step 3, node-pty) will keep a live PTY session per terminal; it is the sole
 * reason `ensureReady` exists on the contract, hence its optionality here.
 *
 * Method names deliberately match the existing SessionLauncher surface so the
 * migration is behaviour-preserving: `dispatch` is the launch entry point,
 * `isBusy`/`cancel`/`cancelAll`/`activeCount` are unchanged.
 */

import type { LaunchRequest, LaunchResult, SessionLauncher } from './sessionLauncher';

export interface TerminalSink {
  /**
   * Execute a launch request the poll loop has already authorised. Returns the
   * same {@link LaunchResult} contract as the headless launcher: `started`
   * plus, on refusal, a `reason`. The sink never decides eligibility — it only
   * reports whether the (already-approved) launch could start.
   */
  dispatch(req: LaunchRequest): LaunchResult;

  /** True while a terminal already holds an active session (busy gate). */
  isBusy(terminal: string): boolean;

  /** Cancel a terminal's active session; false if there was nothing to cancel. */
  cancel(terminal: string, reason?: string): boolean;

  /** Cancel every active session; returns the number actually cancelled. */
  cancelAll(reason?: string): number;

  /** Number of terminals with an active session (used by graceful shutdown). */
  activeCount(): number;

  /**
   * Prepare the sink before dispatching (e.g. spawn a persistent PTY). Optional
   * because the headless sink is stateless between tasks and needs no warm-up;
   * the attached sink (step 3) will implement it.
   */
  ensureReady?(): void | Promise<void>;
}

/**
 * The headless (autonomous, one-shot) sink is exactly today's SessionLauncher:
 * one detached CLI process per task, no live terminal attachment. Exposed as a
 * named type so call sites and docs can speak in sink terms without changing
 * the concrete class.
 */
export type HeadlessSink = SessionLauncher;
