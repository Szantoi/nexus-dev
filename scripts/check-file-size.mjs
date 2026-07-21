#!/usr/bin/env node
/**
 * check-file-size.mjs — production TS fájlméret-kapu (TASK-QC-008)
 *
 * QUALITY.md 3. szakasz: "Nincsenek nagy fájlok — bontsd fel, ha nő."
 * A kapu szabálya:
 *   - Minden production TypeScript-fájl (src/**, kivéve __tests__, *.test.ts,
 *     *.d.ts) legfeljebb 800 soros lehet.
 *   - A limit felett CSAK allowlistelt fájl mehet át; minden allowlist-tétel
 *     kötelezően tartalmaz lejárati dátumot (expires), felelőst (owner) és
 *     indoklást/követő taskot. Lejárt tétel → bukás (bontsd fel a fájlt, vagy
 *     dokumentált indokkal hosszabbíts).
 *   - Új vagy módosított fájl így automatikusan a kapu alá esik: allowlistre
 *     csak dokumentált follow-up taskkal kerülhet fel bármi.
 *
 * Allowlist fájl (default: <dir>/.file-size-allowlist.json):
 *   {
 *     "defaultMaxLines": 800,
 *     "entries": [
 *       { "file": "src/big.ts", "owner": "backend", "expires": "2026-10-18",
 *         "reason": "...", "task": "TASK-QC-008A" }
 *     ]
 *   }
 *
 * Használat (repo-gyökérből vagy package scriptből):
 *   node scripts/check-file-size.mjs                      # default: knowledge-service
 *   node scripts/check-file-size.mjs --dir knowledge-service
 *   node scripts/check-file-size.mjs --allowlist path/to/allowlist.json
 *
 * Lokális repro CI-hibánál: cd knowledge-service && npm run check:size
 *
 * Exit: 0 = kapu zöld, 1 = méretsértés vagy lejárt allowlist-tétel,
 *       2 = konfigurációs hiba. Node-only, külső függőség nélkül.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── Argumentumok ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let dir = 'knowledge-service';
let allowlistPath = null;
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--dir': dir = args[++i]; break;
    case '--allowlist': allowlistPath = resolve(args[++i]); break;
    case '--help':
      console.log('Usage: node scripts/check-file-size.mjs [--dir <pkg>] [--allowlist <json>]');
      process.exit(0);
      break;
    default:
      console.error(`[check-size] ERROR: unknown argument: ${args[i]}`);
      process.exit(2);
  }
}

const pkgDir = resolve(repoRoot, dir);
if (!existsSync(pkgDir)) {
  console.error(`[check-size] ERROR: package dir not found: ${pkgDir}`);
  process.exit(2);
}
allowlistPath = allowlistPath ?? join(pkgDir, '.file-size-allowlist.json');

// ── Allowlist beolvasása és validálása ──────────────────────────────────────
let allowlist = { defaultMaxLines: 800, entries: [] };
if (existsSync(allowlistPath)) {
  try {
    allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (err) {
    console.error(`[check-size] ERROR: cannot parse allowlist ${allowlistPath}: ${err.message}`);
    process.exit(2);
  }
}
const maxLines = Number(allowlist.defaultMaxLines ?? 800);
if (!Number.isFinite(maxLines) || maxLines <= 0) {
  console.error(`[check-size] ERROR: allowlist has no valid numeric "defaultMaxLines".`);
  process.exit(2);
}

const entries = Array.isArray(allowlist.entries) ? allowlist.entries : [];
const configErrors = [];
for (const e of entries) {
  if (!e.file) configErrors.push(`entry without "file": ${JSON.stringify(e)}`);
  if (!e.owner) configErrors.push(`${e.file}: missing "owner"`);
  if (!e.expires || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) {
    configErrors.push(`${e.file}: missing/invalid "expires" (YYYY-MM-DD required)`);
  }
  if (!e.reason && !e.task) configErrors.push(`${e.file}: missing "reason" or "task"`);
}
if (configErrors.length > 0) {
  console.error('[check-size] ERROR: invalid allowlist entries:');
  for (const msg of configErrors) console.error(`  - ${msg}`);
  process.exit(2);
}
const allowByFile = new Map(entries.map((e) => [e.file.replaceAll('\\', '/'), e]));

// ── Production TS fájlok felderítése ────────────────────────────────────────
function collectTsFiles(root) {
  const found = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
        walk(full);
      } else if (
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.d.ts')
      ) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

const srcDir = join(pkgDir, 'src');
if (!existsSync(srcDir)) {
  console.error(`[check-size] ERROR: src dir not found: ${srcDir}`);
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const violations = [];
const expired = [];
const allowlisted = [];
const staleEntries = [];
const seenFiles = new Set();

for (const file of collectTsFiles(srcDir)) {
  const rel = relative(pkgDir, file).split(sep).join('/');
  seenFiles.add(rel);
  const lines = readFileSync(file, 'utf8').split('\n').length;
  if (lines <= maxLines) {
    if (allowByFile.has(rel)) staleEntries.push(`${rel} (${lines} lines — under the limit, remove the entry)`);
    continue;
  }

  const entry = allowByFile.get(rel);
  if (!entry) {
    violations.push(`${rel}: ${lines} lines > ${maxLines}`);
  } else if (entry.expires < today) {
    expired.push(`${rel}: ${lines} lines, allowlist EXPIRED ${entry.expires} (owner: ${entry.owner}, task: ${entry.task ?? '-'})`);
  } else {
    allowlisted.push(`${rel}: ${lines} lines (until ${entry.expires}, owner: ${entry.owner}, task: ${entry.task ?? '-'})`);
  }
}

// Allowlist-tétel nemlétező fájlra: takarítási jelzés (nem bukás).
for (const [file] of allowByFile) {
  if (!seenFiles.has(file)) staleEntries.push(`${file} (file no longer exists — remove the entry)`);
}

// ── Riport ──────────────────────────────────────────────────────────────────
console.log(`[check-size] limit: ${maxLines} lines, scanned: ${seenFiles.size} production TS file(s) in ${dir}/src`);
if (allowlisted.length > 0) {
  console.log(`[check-size] allowlisted over-limit files (${allowlisted.length}):`);
  for (const msg of allowlisted) console.log(`  ~ ${msg}`);
}
if (staleEntries.length > 0) {
  console.log('[check-size] NOTE: stale allowlist entries (clean these up):');
  for (const msg of staleEntries) console.log(`  ? ${msg}`);
}

if (violations.length > 0 || expired.length > 0) {
  if (violations.length > 0) {
    console.error(`\n[check-size] FAIL — file(s) over the ${maxLines}-line limit without allowlist:`);
    for (const msg of violations) console.error(`  ✗ ${msg}`);
    console.error('[check-size] Split the file by responsibility (QUALITY.md §3), or add a dated,');
    console.error(`[check-size] owned allowlist entry with a follow-up task to ${relative(repoRoot, allowlistPath)}.`);
  }
  if (expired.length > 0) {
    console.error('\n[check-size] FAIL — expired allowlist entries:');
    for (const msg of expired) console.error(`  ✗ ${msg}`);
    console.error('[check-size] Split the file, or renew the entry with a documented justification.');
  }
  console.error('[check-size] Reproduce locally: cd knowledge-service && npm run check:size');
  process.exit(1);
}

console.log('[check-size] OK — no oversized production files outside the allowlist.');
process.exit(0);
