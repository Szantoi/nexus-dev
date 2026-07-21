#!/usr/bin/env node
/**
 * lint-ratchet.mjs — Biome warning ratchet (TASK-QC-005)
 *
 * A meglévő Biome-warningok darabszáma rögzített baseline-ként él egy JSON
 * fájlban. A kapu szabálya:
 *   - Biome ERROR             → bukás (exit 1) — ez eddig is blokkolt.
 *   - warning > baseline      → bukás (exit 1) — új warning nem kerülhet be.
 *   - warning <= baseline     → átmegy; csökkenésnél a script jelzi, hogy a
 *                               baseline levihető (`--update`).
 * Az info-szintű diagnosztikák csak riportban jelennek meg, nem buktatnak.
 *
 * Baseline fájl (default: <dir>/.lint-baseline.json):
 *   { "maxWarnings": <szám>, "note": "..." }
 * A baseline-t emelni TILOS (csak dokumentált ADR-rel) — csökkenteni a
 * `--update` kapcsolóval lehet, amikor warningokat javítottunk.
 *
 * Használat (repo-gyökérből vagy package scriptből):
 *   node scripts/lint-ratchet.mjs                       # default: knowledge-service
 *   node scripts/lint-ratchet.mjs --dir knowledge-service
 *   node scripts/lint-ratchet.mjs --baseline path/to/baseline.json
 *   node scripts/lint-ratchet.mjs --update              # baseline leszorítása a mért értékre
 *
 * Exit: 0 = kapu zöld, 1 = ratchet-sértés vagy Biome error, 2 = konfigurációs hiba.
 * Node-only, külső függőség nélkül (a Biome-ot npx-en át hívja).
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── Argumentumok ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let dir = 'knowledge-service';
let baselinePath = null;
let update = false;
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--dir': dir = args[++i]; break;
    case '--baseline': baselinePath = resolve(args[++i]); break;
    case '--update': update = true; break;
    case '--help':
      console.log('Usage: node scripts/lint-ratchet.mjs [--dir <pkg>] [--baseline <json>] [--update]');
      process.exit(0);
      break;
    default:
      console.error(`[lint-ratchet] ERROR: unknown argument: ${args[i]}`);
      process.exit(2);
  }
}

const pkgDir = resolve(repoRoot, dir);
if (!existsSync(pkgDir)) {
  console.error(`[lint-ratchet] ERROR: package dir not found: ${pkgDir}`);
  process.exit(2);
}
baselinePath = baselinePath ?? join(pkgDir, '.lint-baseline.json');

// ── Biome futtatása (summary reporter, minden diagnosztika) ─────────────────
const cmd = 'npx biome check src --max-diagnostics=none --reporter=summary';
let output = '';
let biomeFailed = false;
try {
  output = execSync(cmd, { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  // Nem nulla exit = error-szintű diagnosztika (vagy futtatási hiba).
  biomeFailed = true;
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  if (!output.trim()) {
    console.error(`[lint-ratchet] ERROR: biome could not run: ${err.message}`);
    process.exit(2);
  }
}

/** Kinyeri a "Found N <kind>s." sort; hiányzó sor = 0 darab. */
function countOf(kind) {
  const m = output.match(new RegExp(`Found (\\d+) ${kind}s?\\.`));
  return m ? Number(m[1]) : 0;
}
const errors = countOf('error');
const warnings = countOf('warning');
const infos = countOf('info');

if (biomeFailed || errors > 0) {
  console.error(output.trim().split('\n').slice(-25).join('\n'));
  console.error(`\n[lint-ratchet] FAIL — Biome reported ${errors} error(s). Errors always block.`);
  console.error('[lint-ratchet] Reproduce locally: cd knowledge-service && npm run lint');
  process.exit(1);
}

// ── Baseline összevetés ──────────────────────────────────────────────────────
let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (err) {
  console.error(`[lint-ratchet] ERROR: cannot read baseline ${baselinePath}: ${err.message}`);
  console.error('[lint-ratchet] Create it with: node scripts/lint-ratchet.mjs --update');
  process.exit(2);
}
const maxWarnings = Number(baseline.maxWarnings);
if (!Number.isFinite(maxWarnings)) {
  console.error(`[lint-ratchet] ERROR: baseline ${baselinePath} has no numeric "maxWarnings".`);
  process.exit(2);
}

console.log(`[lint-ratchet] biome: ${warnings} warning(s), ${infos} info(s), ${errors} error(s)`);
console.log(`[lint-ratchet] baseline: max ${maxWarnings} warning(s) (${baselinePath})`);

if (update) {
  if (warnings > maxWarnings) {
    console.error('[lint-ratchet] REFUSED: --update cannot RAISE the baseline ' +
      `(${warnings} > ${maxWarnings}). Fix the new warnings instead (documented ADR required to raise).`);
    process.exit(1);
  }
  writeFileSync(baselinePath, `${JSON.stringify({ ...baseline, maxWarnings: warnings }, null, 2)}\n`);
  console.log(`[lint-ratchet] baseline updated: maxWarnings ${maxWarnings} -> ${warnings}`);
  process.exit(0);
}

if (warnings > maxWarnings) {
  console.error(`\n[lint-ratchet] FAIL — ${warnings} warning(s) > baseline ${maxWarnings}. ` +
    'New Biome warnings are not allowed.');
  console.error('[lint-ratchet] See the offending rules: cd knowledge-service && npm run lint');
  process.exit(1);
}
if (warnings < maxWarnings) {
  console.log(`[lint-ratchet] Nice — ${maxWarnings - warnings} warning(s) below baseline. ` +
    'Lower the floor: node scripts/lint-ratchet.mjs --update');
}
console.log('[lint-ratchet] OK — warning ratchet holds.');
process.exit(0);
