#!/usr/bin/env node
/** Queue exactly one durable Conductor cycle after the previous one completes. */

import fs from 'node:fs';
import path from 'node:path';

const baseUrl = (process.env.AUTONOMY_SERVER_URL || 'http://127.0.0.1:3458').replace(/\/+$/, '');
const token = process.env.RUNNER_TOKEN;
const focusFile = process.env.AUTONOMY_FOCUS_FILE || '/opt/joinerytech/EPICS.yaml';
const stateFile = process.env.AUTONOMY_STATE_FILE || '/opt/joinerytech/logs/codex-runner/autonomy-enqueue-state.json';
const activeMarker = process.env.AUTONOMY_ACTIVE_MARKER || '/opt/joinerytech/logs/codex-runner/conductor/active.json';
const terminalStateFile = process.env.AUTONOMY_TERMINAL_STATE_FILE
  || '/opt/joinerytech/terminals/conductor/state.md';

if (!token) {
  console.error('[AutonomyEnqueue] RUNNER_TOKEN is required');
  process.exit(1);
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('state is not an object');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`state file is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveState(value) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname} failed: HTTP ${response.status}`);
  return response.json();
}

if (fs.existsSync(activeMarker)) {
  console.log('[AutonomyEnqueue] skipped: Conductor runner session is active');
  process.exit(0);
}

if (fs.existsSync(terminalStateFile)) {
  const terminalState = fs.readFileSync(terminalStateFile, 'utf8');
  const isBlocked = /^\s*(?:-\s*)?status:\s*blocked\b/im.test(terminalState);
  if (isBlocked) {
    console.log(`[AutonomyEnqueue] skipped: Conductor state is blocked (${terminalStateFile})`);
    process.exit(0);
  }
}

const state = readState();
const terminalStatus = await getJson(`${baseUrl}/api/epic-router/terminals/conductor`);
const claimedTask = terminalStatus?.terminal?.current_task_id;
if (claimedTask) {
  console.log(`[AutonomyEnqueue] skipped: Conductor has a claimed task (${claimedTask})`);
  process.exit(0);
}

if (state.lastMessageId) {
  const inbox = await getJson(`${baseUrl}/api/mailbox/conductor/inbox?status=UNREAD&metadata=true`);
  const previousPending = Array.isArray(inbox.messages)
    && inbox.messages.some((message) => message?.frontmatter?.id === state.lastMessageId);
  if (previousPending) {
    console.log(`[AutonomyEnqueue] skipped: previous autonomous task is still pending (${state.lastMessageId})`);
    process.exit(0);
  }
}

const now = new Date().toISOString();
const content = `# Autonomous Conductor cycle

## Goal

Continue the highest-value unblocked JoineryTech development task using the repository's canonical task and project state.

## Required start

1. Read AGENTS.md, CLAUDE.md, MEMORY.md, state.md and todo.md when present.
2. Read ${focusFile} and the relevant docs/tasks file.
3. State one precise goal, measurable success criteria, resource/retry limits and an explicit exit condition before changing files.

## Execution rules

- Respect QUALITY.md and all task dependencies.
- Delegate only through durable mailbox tasks; never start another CLI process directly.
- Stop and report BLOCKED when a required decision or authority is missing.
- Work for at most 30 minutes and retry a failing operation at most twice.
- Prefer targeted searches and bounded file sections; do not dump entire repositories or large files into context.
- Run proportionate tests and record commands, exit codes and evidence.
- Before completion update the task execution log, state.md, todo.md and MEMORY.md.
- Complete this inbox task through the MCP tool only after the evidence is recorded.

Generated: ${now}`;

const response = await fetch(`${baseUrl}/api/mailbox/conductor/inbox`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'task', content, priority: 'high', model: 'gpt-5.6-terra' }),
});

if (!response.ok) {
  console.error(`[AutonomyEnqueue] queue failed: HTTP ${response.status}`);
  process.exit(1);
}

const result = await response.json();
if (!result.id) {
  console.error('[AutonomyEnqueue] queue response did not include a message id');
  process.exit(1);
}
saveState({ lastMessageId: result.id, queuedAt: now });
console.log(`[AutonomyEnqueue] queued ${result.id} for conductor`);
