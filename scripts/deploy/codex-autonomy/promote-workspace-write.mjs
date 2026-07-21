#!/usr/bin/env node
/** Promote the verified Codex runner from read-only to workspace-write. */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const serviceRoot = process.argv[2] || '/opt/joinerytech/src/joinerytech-nexus/knowledge-service';
const configPath = path.join(serviceRoot, 'config/runner.yaml');

const requireFromService = createRequire(path.join(serviceRoot, 'package.json'));
const yaml = requireFromService('js-yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
if (!config?.providers?.codex) throw new Error('Codex provider missing from runner.yaml');
for (const terminal of Object.keys(config.terminals || {})) {
  const activeMarker = path.join(config.log_dir, terminal, 'active.json');
  if (fs.existsSync(activeMarker)) {
    throw new Error(`${terminal} session is active; stop/wait before sandbox promotion`);
  }
}
if (config.providers.codex.sandbox !== 'read-only') {
  throw new Error(`expected read-only sandbox, found ${String(config.providers.codex.sandbox)}`);
}

const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
const backupPath = `${configPath}.pre-workspace-write-${timestamp}`;
fs.copyFileSync(configPath, backupPath);
config.providers.codex.sandbox = 'workspace-write';
const temporary = `${configPath}.tmp`;
fs.writeFileSync(temporary, yaml.dump(config, { lineWidth: 120 }), { encoding: 'utf8', mode: 0o600 });
fs.renameSync(temporary, configPath);
console.log(`[CodexAutonomy] sandbox promoted to workspace-write; backup=${backupPath}`);
