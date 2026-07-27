#!/usr/bin/env node
/** Manage single-use local runner dispatch grants without exposing secrets. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as yaml from 'js-yaml';

const SAFE_TERMINAL = /^[a-z][a-z0-9-]*$/;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const args = process.argv.slice(2);
const configPath = process.env.RUNNER_CONFIG_PATH ?? path.join('config', 'runner.yaml');

function fail(message) {
  process.stderr.write(`runner-gate: ${message}\n`);
  process.exitCode = 1;
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/runner-gate.mjs <status | grant <terminal> <message-id> | pause <terminal>>\n',
  );
}

function readConfig() {
  const value = yaml.load(fs.readFileSync(configPath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid runner config');
  const config = value;
  if (typeof config.log_dir !== 'string' || !config.log_dir) throw new Error('runner config has no log_dir');
  if (!config.terminals || typeof config.terminals !== 'object') throw new Error('runner config has no terminals');
  return config;
}

function gatePath(config) {
  return path.resolve(process.cwd(), config.log_dir, 'dispatch-gates.json');
}

function gateLockPath(file) {
  return `${file}.lock`;
}

function withGateLock(file, operation) {
  const lock = gateLockPath(file);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('dispatch gate is busy; retry the operation');
    throw error;
  }
  try {
    return operation();
  } finally {
    fs.rmdirSync(lock);
  }
}

function readGate(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1 || !value.terminals || typeof value.terminals !== 'object') {
      throw new Error('invalid dispatch gate shape');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, terminals: {} };
    throw error;
  }
}

function writeGate(file, gate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(gate, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validateTerminal(config, terminal) {
  if (!SAFE_TERMINAL.test(terminal) || !(terminal in config.terminals)) {
    throw new Error(`unknown or unsafe terminal: ${terminal}`);
  }
}

function latestEvent(logDirectory, terminal) {
  try {
    const entries = fs.readdirSync(path.join(logDirectory, terminal))
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => ({ entry, mtime: fs.statSync(path.join(logDirectory, terminal, entry)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime);
    const file = entries[0]?.entry;
    if (!file) return null;
    const lines = fs.readFileSync(path.join(logDirectory, terminal, file), 'utf8').trim().split(/\r?\n/);
    const last = JSON.parse(lines.at(-1));
    return { file, at: last.at, type: last.type, rawType: last.rawType ?? null };
  } catch {
    return null;
  }
}

try {
  const config = readConfig();
  const [command, terminal, messageId] = args;
  const file = gatePath(config);

  if (command === 'grant') {
    validateTerminal(config, terminal);
    if (!SAFE_MESSAGE_ID.test(messageId ?? '')) throw new Error(`unsafe message ID: ${messageId ?? ''}`);
    withGateLock(file, () => {
      const gate = readGate(file);
      const grants = gate.terminals[terminal] ?? [];
      if (!grants.includes(messageId)) grants.push(messageId);
      gate.terminals[terminal] = grants;
      writeGate(file, gate);
    });
    process.stdout.write(`Granted ${terminal}/${messageId}; it closes automatically after launch.\n`);
  } else if (command === 'pause') {
    validateTerminal(config, terminal);
    withGateLock(file, () => {
      const gate = readGate(file);
      delete gate.terminals[terminal];
      writeGate(file, gate);
    });
    process.stdout.write(`Paused dynamic grants for ${terminal}.\n`);
  } else if (command === 'status') {
    const gate = readGate(file);
    const logDirectory = path.resolve(process.cwd(), config.log_dir);
    const terminals = Object.keys(config.terminals).map((name) => {
      const activePath = path.join(logDirectory, name, 'active.json');
      let active = null;
      try { active = JSON.parse(fs.readFileSync(activePath, 'utf8')); } catch {}
      return { terminal: name, grants: gate.terminals[name] ?? [], active, latestEvent: latestEvent(logDirectory, name) };
    });
    process.stdout.write(`${JSON.stringify({ gateFile: file, locked: fs.existsSync(gateLockPath(file)), terminals }, null, 2)}\n`);
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
