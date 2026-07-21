#!/usr/bin/env node
/**
 * secret-scan.mjs — dependency-free secret scanner for the tracked snapshot.
 *
 * Scans every git-tracked file (current working-tree content, i.e. what would
 * be committed) for known secret patterns: private key blocks, AWS/GitHub/
 * Telegram/Slack/Anthropic/OpenAI/npm tokens, JWTs and generic
 * password/secret assignments.
 *
 * Configuration lives in `.secret-scan.json` at the repo root:
 *   - patterns:          [{ id, description, regex, flags? }]
 *   - allowedPaths:      regexes for paths excluded from scanning
 *                        (docs that *describe* patterns, the scanner itself)
 *   - allowedLineMarker: inline marker that suppresses a single line
 *                        (append `secret-scan:allow` in a comment)
 *   - skipExtensions:    binary-ish extensions to skip
 *
 * Usage:   node scripts/secret-scan.mjs [--config path] [--include-untracked]
 * Exit:    0 = clean, 1 = findings, 2 = configuration/runtime error
 *
 * CI note: intended as a quality gate — wire it into the pipeline as
 * `node scripts/secret-scan.mjs` (see TASK-QC-005).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── Config ───────────────────────────────────────────────────────────────────
const configArgIdx = process.argv.indexOf('--config');
const configPath =
  configArgIdx !== -1 && process.argv[configArgIdx + 1]
    ? process.argv[configArgIdx + 1]
    : join(repoRoot, '.secret-scan.json');

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`[secret-scan] ERROR: cannot read config ${configPath}: ${err.message}`);
  process.exit(2);
}

const patterns = (config.patterns ?? []).map(p => ({
  id: p.id,
  description: p.description ?? '',
  // No 'g' flag: one finding per line per pattern is enough for a gate.
  regex: new RegExp(p.regex, p.flags ?? ''),
}));
const allowedPaths = (config.allowedPaths ?? []).map(r => new RegExp(r));
const allowedLineMarker = config.allowedLineMarker ?? 'secret-scan:allow';
const skipExtensions = new Set(config.skipExtensions ?? []);

if (patterns.length === 0) {
  console.error('[secret-scan] ERROR: config contains no patterns.');
  process.exit(2);
}

// ── File list: tracked snapshot, optionally plus untracked publish candidates ─
const includeUntracked = process.argv.includes('--include-untracked');
let files;
try {
  const gitArgs = includeUntracked
    ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    : ['ls-files', '-z'];
  files = execFileSync('git', gitArgs, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((file, index, all) => all.indexOf(file) === index);
} catch (err) {
  console.error(`[secret-scan] ERROR: git ls-files failed: ${err.message}`);
  process.exit(2);
}

// ── Scan ─────────────────────────────────────────────────────────────────────
const redact = s => (s.length <= 12 ? s[0] + '***' : `${s.slice(0, 6)}…${s.slice(-3)} (len ${s.length})`);

const findings = [];
let scanned = 0;

for (const file of files) {
  if (allowedPaths.some(r => r.test(file))) continue;
  const dot = file.lastIndexOf('.');
  if (dot !== -1 && skipExtensions.has(file.slice(dot).toLowerCase())) continue;

  let buf;
  try {
    buf = readFileSync(join(repoRoot, file));
  } catch {
    continue; // tracked but locally deleted — nothing to scan in the worktree
  }
  if (buf.includes(0)) continue; // binary
  scanned++;

  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(allowedLineMarker)) continue;
    for (const p of patterns) {
      const m = p.regex.exec(line);
      if (m) findings.push({ file, line: i + 1, id: p.id, match: redact(m[0]) });
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const scanScope = includeUntracked ? 'tracked and untracked non-ignored files' : 'tracked files';
if (findings.length > 0) {
  console.error(`[secret-scan] FAIL — ${findings.length} finding(s) in ${scanned} scanned ${scanScope}:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.id}]  ${f.match}`);
  }
  console.error('[secret-scan] If a finding is a known false positive, append the');
  console.error(`[secret-scan] inline marker "${allowedLineMarker}" to that line, or extend`);
  console.error(`[secret-scan] allowedPaths in ${configPath}. Real secrets must be`);
  console.error('[secret-scan] removed and rotated by a human — never commit them.');
  process.exit(1);
}

console.log(`[secret-scan] OK — no findings in ${scanned} scanned ${scanScope} (${patterns.length} patterns).`);
process.exit(0);
