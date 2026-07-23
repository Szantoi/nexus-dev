/**
 * TerminalSink — the execution boundary between the poll loop (the single
 * launch authority) and however a terminal actually runs a task.
 *
 * The poll decides *whether* to launch; the sink only *executes*. The default
 * implementation is the {@link HeadlessSink} (an autonomous, one-shot CLI
 * session per task — see {@link SessionLauncher}). The staged `attached`
 * implementation keeps a live PTY session per terminal; it is the reason
 * `ensureReady` and awaited `shutdown` exist on the contract.
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

  /** Smallest safe runner grace period when the sink owns native cleanup. */
  minimumShutdownGraceMs?(): number;

  /**
   * Prepare the sink before dispatching (e.g. spawn a persistent PTY). Optional
   * because the headless sink is stateless between tasks and needs no warm-up.
   */
  ensureReady?(): void | Promise<void>;

  /** Await complete resource cleanup during failed preflight or shutdown. */
  shutdown?(reason?: string): Promise<void>;
}

/**
 * The headless (autonomous, one-shot) sink is exactly today's SessionLauncher:
 * one detached CLI process per task, no live terminal attachment. Exposed as a
 * named type so call sites and docs can speak in sink terms without changing
 * the concrete class.
 */
export type HeadlessSink = SessionLauncher;
