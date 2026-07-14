/**
 * Dispatch Control — Public API
 *
 * Exports all dispatch control functionality for use in server.ts
 */

export {
  // Database
  initDispatchDb,
  closeDispatchDb,

  // Dispatch Mode
  getDispatchMode,
  setDispatchMode,
  type DispatchMode,

  // Token Usage
  recordTokenUsage,
  type TokenUsage,

  // Budget Status
  getTerminalBudgetStatus,
  getDailyBudgetSummary,
  type BudgetStatus,
  type DailyBudgetSummary,

  // Dispatch Check
  canDispatch,
  type DispatchCheck,

  // Budget Configuration
  setTerminalBudget,
  getAllBudgetConfigs,

  // Dispatch Queue
  queueDispatch,
  getDispatchQueue,
  markDispatchExecuting,
  markDispatchCompleted,
  markDispatchFailed,
  type QueuedDispatch,

  // Statistics
  getUsageStats,
  type UsageStats,
} from './tokenBudget';

// Dispatch Proposals (Conductor Orchestration)
export {
  setProposalDb,
  createProposal,
  getPendingProposals,
  getProposal,
  decideProposal,
  approveAllPending,
  expireOldProposals,
  notifyNewProposal,
  getProposalStats,
  type DispatchProposal,
  type ProposalCreateParams,
  type ProposalDecision,
  type DecisionResult,
  type ProposalStats,
} from './dispatchProposal';

// Scheduled Windows (Time-Based Dispatch)
export {
  setWindowsDb,
  addWindow,
  removeWindow,
  getWindows,
  setDefaultMode,
  getDefaultMode,
  getCurrentWindow,
  getNextWindow,
  checkWindowForTerminal,
  registerWindowSession,
  endWindowSession,
  getActiveSessionsInWindow,
  getAllActiveSessions,
  loadDefaultWindows,
  getWindowStats,
  type DispatchWindow,
  type DayOfWeek,
  type WindowConfig,
  type WindowCheck,
  type ActiveSession,
  type WindowStats,
} from './scheduledWindows';
