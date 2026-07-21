#!/usr/bin/env node
/**
 * Idempotent, backup-first configurator for the legacy JoineryTech service.
 * It removes the watcher launch bypass and generates terminal-scoped runner
 * credentials/config without printing secrets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const islandRoot = process.argv[2] || '/opt/joinerytech';
const serviceRoot = path.join(islandRoot, 'src/joinerytech-nexus/knowledge-service');
const bundleRoot = process.argv[3] || path.dirname(new URL(import.meta.url).pathname);
const requireFromService = createRequire(path.join(serviceRoot, 'package.json'));
const yaml = requireFromService('js-yaml');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
const backupRoot = path.join(islandRoot, 'backups', `codex-autonomy-${timestamp}`);
const manifest = [];

function backup(target) {
  const relative = path.relative(islandRoot, target);
  const existed = fs.existsSync(target);
  const backupPath = path.join(backupRoot, relative);
  if (existed) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(target, backupPath);
  }
  manifest.push({ target, relative, existed });
}

function write(target, content, mode) {
  backup(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function copyTree(sourceRoot, targetRoot) {
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else write(target, fs.readFileSync(source));
  }
}

function replaceRequired(content, search, replacement, label) {
  if (!content.includes(search)) throw new Error(`expected legacy block missing: ${label}`);
  return content.replace(search, replacement);
}

fs.mkdirSync(backupRoot, { recursive: true });

copyTree(path.join(bundleRoot, 'src/runner'), path.join(serviceRoot, 'src/runner'));
copyTree(path.join(bundleRoot, 'dist/runner'), path.join(serviceRoot, 'dist/runner'));
write(
  path.join(serviceRoot, 'src/core/logger.ts'),
  fs.readFileSync(path.join(bundleRoot, 'compat-logger.ts')),
);
write(
  path.join(serviceRoot, 'dist/core/logger.js'),
  fs.readFileSync(path.join(bundleRoot, 'compat-logger.js')),
);
write(
  path.join(serviceRoot, 'src/interfaces/http/routes/mailbox.routes.ts'),
  fs.readFileSync(path.join(bundleRoot, 'src/interfaces/http/routes/mailbox.routes.ts')),
);
write(
  path.join(serviceRoot, 'dist/interfaces/http/routes/mailbox.routes.js'),
  fs.readFileSync(path.join(bundleRoot, 'dist/interfaces/http/routes/mailbox.routes.js')),
);
write(
  path.join(serviceRoot, 'scripts/autonomous-enqueue.mjs'),
  fs.readFileSync(path.join(bundleRoot, 'autonomous-enqueue.mjs')),
  0o755,
);
write(
  path.join(serviceRoot, 'scripts/codex-autonomy/rollback.mjs'),
  fs.readFileSync(path.join(bundleRoot, 'rollback.mjs')),
  0o755,
);
write(
  path.join(serviceRoot, 'scripts/codex-autonomy/promote-workspace-write.mjs'),
  fs.readFileSync(path.join(bundleRoot, 'promote-workspace-write.mjs')),
  0o755,
);

// Source patch: watcher remains an SSE wake source, never a process launcher.
const startupTsPath = path.join(serviceRoot, 'src/bootstrap/startup.ts');
let startupTs = fs.readFileSync(startupTsPath, 'utf8');
if (startupTs.includes("import { startTerminalSession } from '../sessionStarter';")) {
  startupTs = startupTs
    .replace("import { startTerminalSession } from '../sessionStarter';\n", '')
    .replace("import { shouldWakeUp } from '../terminalStatus';\n", '')
    .replace('// Listen for inbox changes and trigger session start/injection',
      '// Listen for inbox changes and wake the outbound runner only')
    .replace("inboxEvents.on('inbox_change', async (event: InboxEvent) => {",
      "inboxEvents.on('inbox_change', (event: InboxEvent) => {");
  startupTs = startupTs.replace(/\n    \/\/ Check if terminal should be woken up[\s\S]*?\n    \/\/ Broadcast SSE notification/, '\n\n    // Broadcast SSE notification');
  startupTs = startupTs.replace(/\n    \/\/ Start the terminal session or inject message into running session[\s\S]*?\n    } catch \(err\) \{[\s\S]*?\n    }\n  }\);/, '\n  });');
  if (/startTerminalSession|shouldWakeUp/.test(startupTs)) {
    throw new Error('source watcher patch incomplete');
  }
  write(startupTsPath, startupTs);
}

// Compiled patch is applied explicitly so rollback does not depend on a build.
const startupJsPath = path.join(serviceRoot, 'dist/bootstrap/startup.js');
let startupJs = fs.readFileSync(startupJsPath, 'utf8');
if (startupJs.includes('const sessionStarter_1 = require("../sessionStarter");')) {
  startupJs = startupJs
    .replace('const sessionStarter_1 = require("../sessionStarter");\n', '')
    .replace('const terminalStatus_1 = require("../terminalStatus");\n', '')
    .replace('// Listen for inbox changes and trigger session start/injection',
      '// Listen for inbox changes and wake the outbound runner only')
    .replace("inboxWatcher_1.inboxEvents.on('inbox_change', async (event) => {",
      "inboxWatcher_1.inboxEvents.on('inbox_change', (event) => {");
  startupJs = startupJs.replace(/\n        \/\/ Check if terminal should be woken up[\s\S]*?\n        \/\/ Broadcast SSE notification/, '\n        // Broadcast SSE notification');
  startupJs = startupJs.replace(/\n        \/\/ Start the terminal session or inject message into running session[\s\S]*?\n        catch \(err\) \{[\s\S]*?\n        }\n    }\);/, '\n    });');
  if (/sessionStarter_1|terminalStatus_1/.test(startupJs)) {
    throw new Error('compiled watcher patch incomplete');
  }
  write(startupJsPath, startupJs);
}

// Disable legacy tmux launchers; the new runner/timer replaces them.
const envPath = path.join(serviceRoot, '.env');
let serviceEnv = fs.readFileSync(envPath, 'utf8');
for (const [key, value] of [
  ['ENABLE_NIGHTWATCH', 'false'],
  ['ENABLE_AUTONOMOUS_DEV', 'false'],
  ['ENABLE_AUTO_RESTART', 'false'],
  ['REVIEW_MODE', 'api'],
]) {
  const expression = new RegExp(`^${key}=.*$`, 'm');
  serviceEnv = expression.test(serviceEnv)
    ? serviceEnv.replace(expression, `${key}=${value}`)
    : `${serviceEnv.trimEnd()}\n${key}=${value}\n`;
}
write(envPath, serviceEnv, 0o600);

const agentsPath = path.join(serviceRoot, 'config/agents.yaml');
const agents = yaml.load(fs.readFileSync(agentsPath, 'utf8'));
if (!agents || typeof agents !== 'object' || typeof agents.master_token !== 'string') {
  throw new Error('agents.yaml master_token missing');
}
const terminalTokens = new Map();
for (const [token, terminal] of Object.entries(agents.agents || {})) {
  if (typeof terminal === 'string') terminalTokens.set(terminal, token);
}

const codexConfig = fs.readFileSync('/home/gabor/.codex/config.toml', 'utf8');
const joinerySection = codexConfig.match(/\[mcp_servers\.joinerytech\]([\s\S]*?)(?=\n\[|$)/);
const authEnvMatch = joinerySection?.[1].match(/bearer_token_env_var\s*=\s*"([A-Z_][A-Z0-9_]*)"/);
if (!authEnvMatch) throw new Error('Codex joinerytech bearer_token_env_var missing');
const codexAuthEnv = authEnvMatch[1];

const terminals = ['conductor', 'architect', 'backend', 'frontend', 'designer', 'explorer'];
for (const terminal of terminals) {
  if (!terminalTokens.has(terminal)) throw new Error(`agents.yaml token missing: ${terminal}`);
}

const runnerEnvLines = [`RUNNER_TOKEN=${agents.master_token}`];
for (const terminal of terminals) {
  runnerEnvLines.push(`NEXUS_AGENT_TOKEN_${terminal.toUpperCase()}=${terminalTokens.get(terminal)}`);
}
runnerEnvLines.push('AUTONOMY_SERVER_URL=http://127.0.0.1:3458');
runnerEnvLines.push('AUTONOMY_FOCUS_FILE=/opt/joinerytech/EPICS.yaml');
runnerEnvLines.push('AUTONOMY_STATE_FILE=/opt/joinerytech/logs/codex-runner/autonomy-enqueue-state.json');
runnerEnvLines.push('AUTONOMY_ACTIVE_MARKER=/opt/joinerytech/logs/codex-runner/conductor/active.json');
runnerEnvLines.push('AUTONOMY_TERMINAL_STATE_FILE=/opt/joinerytech/terminals/conductor/state.md');
write(path.join(serviceRoot, '.env.runner'), `${runnerEnvLines.join('\n')}\n`, 0o600);

const codexBinary = '/home/gabor/.codex/packages/standalone/releases/0.144.6-x86_64-unknown-linux-musl/bin/codex';
if (!fs.existsSync(codexBinary)) throw new Error(`Codex binary missing: ${codexBinary}`);
const runnerConfig = {
  server_url: 'http://127.0.0.1:3458',
  poll_interval_ms: 5000,
  sse_enabled: true,
  max_backoff_ms: 300000,
  max_attempts: 3,
  retry_cooldown_ms: 600000,
  quarantine_existing_on_first_start: true,
  session_timeout_ms: 3600000,
  max_output_bytes: 10485760,
  shutdown_grace_ms: 10000,
  mcp_server_name: 'joinerytech',
  default_provider: 'codex',
  providers: {
    codex: {
      binary: codexBinary,
      auth_env_var: codexAuthEnv,
      sandbox: 'read-only',
      ephemeral: true,
      skip_git_repo_check: true,
      extra_args: [
        '-c',
        'approval_policy="never"',
        '-c',
        'mcp_servers.joinerytech.url="http://127.0.0.1:3458/mcp"',
        '-c',
        'mcp_servers.joinerytech.default_tools_approval_mode="approve"',
        '-c',
        'mcp_servers.spaceos-knowledge.url="http://127.0.0.1:3458/mcp"',
        '-c',
        'mcp_servers.spaceos-knowledge.default_tools_approval_mode="approve"',
      ],
    },
  },
  log_dir: path.join(islandRoot, 'logs/codex-runner'),
  terminals: Object.fromEntries(terminals.map((terminal) => [terminal, {
    workdir: path.join(islandRoot, 'terminals', terminal),
    provider: 'codex',
    models: ['gpt-5.6-terra'],
    default_model: 'gpt-5.6-terra',
    credential_env: `NEXUS_AGENT_TOKEN_${terminal.toUpperCase()}`,
    additional_write_dirs: [islandRoot],
  }])),
};
write(path.join(serviceRoot, 'config/runner.yaml'), yaml.dump(runnerConfig, { lineWidth: 120 }), 0o600);

const agentTemplate = (terminal) => `# ${terminal} — Codex terminal instructions

You are the ${terminal} terminal of the JoineryTech island.

At the beginning of every task, read the local CLAUDE.md (legacy role contract),
MEMORY.md, state.md and todo.md when they exist. QUALITY.md at island root is
mandatory. Treat files and mailbox state as durable truth, not chat context.

Before implementation, state one precise goal, measurable success criteria,
resource/retry limits and an explicit exit condition. Work only on the assigned
inbox task. Delegate through durable mailbox tasks; never launch another CLI
agent directly. On completion, record commands/evidence in the task, update
state.md, todo.md and MEMORY.md, then acknowledge/complete the inbox task via MCP.
If blocked by a decision, authority or repeated failure, stop and report BLOCKED.
`;
for (const terminal of terminals) {
  const agentsFile = path.join(islandRoot, 'terminals', terminal, 'AGENTS.md');
  if (!fs.existsSync(agentsFile)) write(agentsFile, agentTemplate(terminal));
}

fs.writeFileSync(path.join(backupRoot, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: manifest }, null, 2));
console.log(`[CodexAutonomy] configured; backup=${backupRoot}`);
