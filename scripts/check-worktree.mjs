#!/usr/bin/env node
/**
 * check-worktree.mjs — worktree-változatlanság kapu (TASK-DP-007)
 *
 * A hermetikus gate-suite nem írhat a repóba. A korábbi inline CI-kapu
 * (`git status --porcelain`) VAK volt a gitignore-olt runtime-könyvtárakra
 * (pl. `knowledge-service/data/`) — pont arra, amit védeni hivatott
 * (független review P1-lelet). Ez a script snapshot/verify párban dolgozik,
 * és az ignorált útvonalakat IS figyeli (`--ignored=matching`):
 *
 *   node scripts/check-worktree.mjs snapshot [--file <path>]
 *   node scripts/check-worktree.mjs verify   [--file <path>]
 *
 * - `snapshot`: elmenti a worktree aktuális állapotát: tracked módosítások +
 *   untracked fájlok (`git status --porcelain -uall`, fájlszinten) ÉS az
 *   ignorált FÁJLOK egyenkénti listája (`git ls-files --others --ignored
 *   --exclude-standard`) — utóbbi azért fájlszinten, mert a porcelain a
 *   MEGLÉVŐ ignorált könyvtárat egyetlen sorrá kollabálja, és a beleírás
 *   láthatatlan maradna (élő próbán igazolt vakfolt).
 * - `verify`: újraméri, és FAIL (exit 1), ha a két lista szimmetrikus
 *   differenciája nem üres. A várt gate-kimenetek (node_modules, dist,
 *   coverage) már CAPTURE-kor kiszűrődnek — ezeket install/build/coverage
 *   legitim módon írja. Az "eltűnt" bejegyzés is hiba: azt jelenti, a suite
 *   MÓDOSÍTOTT/TÖRÖLT egy előtte létező fájlt (lokálisan adatvesztés lehet).
 *
 * A snapshot-modell lokálisan is működik (piszkos fejlesztői fán a meglévő
 * ignorált fájlok a snapshotban vannak, csak az ÚJ írás bukik) — így a CI és
 * a lokális `npm run gate` ugyanazt a scriptet futtatja (paritás-elv).
 *
 * ISMERT KORLÁT (dokumentált): a lista tartalom-hash nélküli, így egy a
 * snapshot ELŐTT már létező (piszkos vagy ignorált) fájl TARTALMI módosítását
 * a delta nem látja. CI-ben a fa tiszta checkoutból indul, ott ez az eset
 * nem létezik; lokálisan a kapu a meglévő fájlokra best-effort.
 *
 * Exit: 0 = kapu zöld, 1 = a suite írt a repóba, 2 = konfigurációs hiba.
 * Node-only, külső függőség nélkül. Tesztek:
 * scripts/__tests__/check-worktree.test.mjs (npm run test:tasks).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Várt gate-kimenetek: ezek alá a suite legitim módon ír (install/build/
 * coverage), minden más ignorált vagy untracked írás hiba. A repo-relatív,
 * POSIX-szeparátoros útvonal-prefixre illesztjük.
 */
export const EXPECTED_OUTPUT_PREFIXES = [
  'node_modules/',
  'knowledge-service/node_modules/',
  'knowledge-service/dist/',
  'knowledge-service/coverage/',
];

/** Sorokra bont, CR-t levág, üres sorokat eldob, rendez. */
export function normalizeStatus(raw) {
  return raw
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '')
    .sort();
}

/** A snapshot-sorból a repo-relatív útvonal (státuszkód + idézőjel-kezelés). */
export function pathOfStatusLine(line) {
  // Formátum: XY <path>  vagy  XY "<quoted path>"  vagy  XY <from> -> <to>
  let p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  if (arrow !== -1) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p;
}

/** Illik-e a sor valamelyik várt kimenet-prefixre. */
export function isExpectedOutput(line, prefixes = EXPECTED_OUTPUT_PREFIXES) {
  const p = pathOfStatusLine(line);
  return prefixes.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

/** A várt gate-kimenetek kiszűrése CAPTURE-kor (a snapshot kicsi marad). */
export function filterExpected(lines, prefixes = EXPECTED_OUTPUT_PREFIXES) {
  return lines.filter((l) => !isExpectedOutput(l, prefixes));
}

/**
 * A snapshot és a friss mérés tiszta szimmetrikus differenciája (az allowlist
 * capture-kor már érvényesült). Üres mindkettő = a worktree változatlan.
 */
export function diffStatus(beforeLines, afterLines) {
  const before = new Set(beforeLines);
  const after = new Set(afterLines);
  const appeared = afterLines.filter((l) => !before.has(l));
  const disappeared = beforeLines.filter((l) => !after.has(l));
  return { appeared, disappeared };
}

/**
 * A worktree teljes állapota: tracked/untracked a porcelain-ból (-uall:
 * fájlszintű untracked), ignorált fájlok a ls-files-ból (`!! ` előtaggal,
 * fájlszinten — a kollabált `!! dir/` sor vakfoltja ellen).
 */
function gitStatusLines(cwd) {
  const status = execFileSync('git', ['status', '--porcelain', '-uall'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ignored = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ignoredLines = ignored
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => `!! ${l}`);
  return filterExpected(normalizeStatus(`${status}\n${ignoredLines.join('\n')}`));
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return resolve(process.argv[1]) === modulePath;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const mode = args.shift();
  let file = join(tmpdir(), 'nexus-worktree-gate.snapshot');
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file': file = resolve(args[++i]); break;
      case '--help':
        console.log('Usage: node scripts/check-worktree.mjs <snapshot|verify> [--file <path>]');
        process.exit(0);
        break;
      default:
        console.error(`[check-worktree] ERROR: unknown argument: ${args[i]}`);
        process.exit(2);
    }
  }
  if (mode !== 'snapshot' && mode !== 'verify') {
    console.error(`[check-worktree] ERROR: mode must be 'snapshot' or 'verify' (got: ${mode ?? '<none>'}).`);
    process.exit(2);
  }

  let lines;
  try {
    lines = gitStatusLines(repoRoot);
  } catch (err) {
    console.error(`[check-worktree] ERROR: git status failed: ${err.message}`);
    process.exit(2);
  }

  if (mode === 'snapshot') {
    writeFileSync(file, `${lines.join('\n')}\n`);
    console.log(`[check-worktree] snapshot: ${lines.length} entr(y/ies) recorded -> ${file}`);
    process.exit(0);
  }

  // verify
  if (!existsSync(file)) {
    console.error(`[check-worktree] ERROR: snapshot file not found: ${file}`);
    console.error("[check-worktree] Run the 'snapshot' mode before the suite (fail-closed: no snapshot, no pass).");
    process.exit(2);
  }
  const before = normalizeStatus(readFileSync(file, 'utf8'));
  const { appeared, disappeared } = diffStatus(before, lines);

  if (appeared.length === 0 && disappeared.length === 0) {
    console.log('[check-worktree] OK — the worktree is unchanged (tracked, untracked AND ignored paths).');
    process.exit(0);
  }
  console.error('[check-worktree] FAIL — the gate suite modified the repository worktree:');
  for (const l of appeared) console.error(`  + ${l}`);
  for (const l of disappeared) console.error(`  - ${l} (entry disappeared: a pre-existing file was modified/removed)`);
  console.error('[check-worktree] Tests must write ONLY under os.tmpdir(). Expected build outputs are allowlisted: ' +
    EXPECTED_OUTPUT_PREFIXES.join(', '));
  process.exit(1);
}
