#!/usr/bin/env node
/**
 * lint-ratchet.mjs — Biome warning ratchet (TASK-QC-005, expiry: TASK-DP-007)
 *
 * A meglévő Biome-warningok darabszáma rögzített baseline-ként él egy JSON
 * fájlban. A kapu szabálya:
 *   - Biome ERROR             → bukás (exit 1) — ez eddig is blokkolt.
 *   - warning > baseline      → bukás (exit 1) — új warning nem kerülhet be.
 *   - warning <= baseline     → átmegy; csökkenésnél a script jelzi, hogy a
 *                               baseline levihető (`--update`).
 *   - lejárt baseline         → bukás (exit 1) — a baseline kivétel-lista,
 *                               negyedévente felül kell vizsgálni: vagy
 *                               csökken (`--update`), vagy dokumentált
 *                               indokkal megújul az `expires` dátuma.
 * Az info-szintű diagnosztikák csak riportban jelennek meg, nem buktatnak.
 *
 * Baseline fájl (default: <dir>/.lint-baseline.json):
 *   { "maxWarnings": <szám>, "owner": "<felelős>", "expires": "ÉÉÉÉ-HH-NN",
 *     "task": "TASK-...", "note": "..." }
 * Mind a négy mező kötelező (hiányuk konfigurációs hiba, exit 2) — a
 * file-size allowlist mintája (check-file-size.mjs). A baseline-t emelni
 * TILOS (csak dokumentált ADR-rel) — csökkenteni a `--update` kapcsolóval
 * lehet, amikor warningokat javítottunk.
 *
 * Használat (repo-gyökérből vagy package scriptből):
 *   node scripts/lint-ratchet.mjs                       # default: knowledge-service
 *   node scripts/lint-ratchet.mjs --dir knowledge-service
 *   node scripts/lint-ratchet.mjs --baseline path/to/baseline.json
 *   node scripts/lint-ratchet.mjs --update              # baseline leszorítása a mért értékre
 *
 * Exit: 0 = kapu zöld, 1 = ratchet-sértés, lejárat vagy Biome error,
 * 2 = konfigurációs hiba.
 * Node-only, külső függőség nélkül (a Biome-ot npx-en át hívja).
 * Tesztek: scripts/__tests__/lint-ratchet.test.mjs (npm run test:tasks).
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// isMain: realpath-alapú összevetés — a Node a main modult realpath-olja, a
// process.argv[1] viszont a hívott (akár symlink/junction) útvonal marad; a
// sima resolve()-összevetés ilyenkor hamis, és a kapu NÉMÁN, exit 0-val
// kimaradna (TASK-DP-007 review P2-lelet). Ha a realpath nem oldható fel,
// resolve-fallback.
function pathsEqual(argvPath, moduleFileUrl) {
  const modulePath = fileURLToPath(moduleFileUrl);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return resolve(argvPath) === modulePath;
  }
}
const isMain = Boolean(process.argv[1]) && pathsEqual(process.argv[1], import.meta.url);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Kinyeri a "Found N <kind>s." sorokat a Biome summary kimenetéből; hiányzó sor = 0. */
export function parseCounts(output) {
  const countOf = (kind) => {
    const m = output.match(new RegExp(`Found (\\d+) ${kind}s?\\.`));
    return m ? Number(m[1]) : 0;
  };
  return { errors: countOf('error'), warnings: countOf('warning'), infos: countOf('info') };
}

/**
 * A baseline kötelező mezőinek ellenőrzése (fail-closed: hiányos baseline
 * konfigurációs hiba, nem néma átengedés). Hibaüzenet-listát ad vissza;
 * üres lista = érvényes.
 */
export function validateBaseline(baseline) {
  const errors = [];
  // Valódi, nem-negatív egész szám kell — a Number()-koerció ("784", null,
  // true, []) itt tudatosan NEM elég (review-lelet: koercios lyukak).
  if (typeof baseline?.maxWarnings !== 'number' ||
      !Number.isInteger(baseline.maxWarnings) || baseline.maxWarnings < 0) {
    errors.push('missing/invalid "maxWarnings" (non-negative integer required)');
  }
  if (typeof baseline?.owner !== 'string' || baseline.owner.trim() === '') {
    errors.push('missing "owner"');
  }
  if (typeof baseline?.expires !== 'string' || !DATE_RE.test(baseline.expires) ||
      !isRealCalendarDate(baseline.expires)) {
    errors.push('missing/invalid "expires" (real YYYY-MM-DD calendar date required)');
  }
  if (typeof baseline?.task !== 'string' || baseline.task.trim() === '') {
    errors.push('missing "task" (follow-up task reference required)');
  }
  return errors;
}

/**
 * Szemantikus dátum-ellenőrzés: a formátumra jó, de lehetetlen dátum
 * ("2026-13-99") nem járna le soha értelmesen — round-trip a Date-en át.
 */
export function isRealCalendarDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** Lejárt-e a baseline az adott napon (ISO YYYY-MM-DD összevetés). */
export function isExpired(baseline, today) {
  return baseline.expires < today;
}

if (isMain) {
  // ── Argumentumok ───────────────────────────────────────────────────────────
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

  // ── Baseline betöltés + séma-ellenőrzés (fail-closed) — a Biome-futás
  // ELŐTT: egy hibás/hiányos konfiguráció ne igényeljen perces lint-futást a
  // diagnózishoz. ─────────────────────────────────────────────────────────────
  let baseline;
  try {
    // BOM-strip: Windowson egy kézzel (pl. Notepaddal) mentett baseline UTF-8
    // BOM-ot (U+FEFF) kaphat, amin a JSON.parse elhasal.
    const raw = readFileSync(baselinePath, 'utf8');
    baseline = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    console.error(`[lint-ratchet] ERROR: cannot read baseline ${baselinePath}: ${err.message}`);
    console.error('[lint-ratchet] Create it with owner/expires/task fields — see the header comment.');
    process.exit(2);
  }
  const schemaErrors = validateBaseline(baseline);
  if (schemaErrors.length > 0) {
    for (const msg of schemaErrors) console.error(`[lint-ratchet] ERROR: baseline ${baselinePath}: ${msg}`);
    console.error('[lint-ratchet] The baseline is an exception list: owner, expires and a follow-up task are mandatory.');
    process.exit(2);
  }
  const maxWarnings = baseline.maxWarnings;
  const today = new Date().toISOString().slice(0, 10);

  // ── Lejárat (fail-closed) — a mérés és a ratchet-összevetés ELŐTT: a lejárt
  // baseline akkor is blokkol, ha a warning-szám a plafon alatt van. A --update
  // ág tudatosan kivétel (a csökkentéshez mérés kell; lejáratra ott WARN megy). ─
  if (!update && isExpired(baseline, today)) {
    console.error(`\n[lint-ratchet] FAIL — baseline EXPIRED ${baseline.expires} ` +
      `(owner: ${baseline.owner}, follow-up task: ${baseline.task}).`);
    console.error('[lint-ratchet] Quarterly review due: lower the baseline (fix warnings, then --update),');
    console.error('[lint-ratchet] or renew "expires" with a documented justification in the follow-up task.');
    process.exit(1);
  }

  // ── Biome futtatása (summary reporter, minden diagnosztika) ────────────────
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

  const { errors, warnings, infos } = parseCounts(output);

  if (biomeFailed || errors > 0) {
    console.error(output.trim().split('\n').slice(-25).join('\n'));
    console.error(`\n[lint-ratchet] FAIL — Biome reported ${errors} error(s). Errors always block.`);
    console.error('[lint-ratchet] Reproduce locally: cd knowledge-service && npm run lint');
    process.exit(1);
  }

  console.log(`[lint-ratchet] biome: ${warnings} warning(s), ${infos} info(s), ${errors} error(s)`);
  console.log(`[lint-ratchet] baseline: max ${maxWarnings} warning(s), owner ${baseline.owner}, ` +
    `expires ${baseline.expires}, task ${baseline.task} (${baselinePath})`);

  if (update) {
    if (warnings > maxWarnings) {
      console.error('[lint-ratchet] REFUSED: --update cannot RAISE the baseline ' +
        `(${warnings} > ${maxWarnings}). Fix the new warnings instead (documented ADR required to raise).`);
      process.exit(1);
    }
    writeFileSync(baselinePath, `${JSON.stringify({ ...baseline, maxWarnings: warnings }, null, 2)}\n`);
    console.log(`[lint-ratchet] baseline updated: maxWarnings ${maxWarnings} -> ${warnings}`);
    // A --update szándékosan nem nyúl az expires-hez (a megújítás dokumentált,
    // kézi döntés) — de lejárt baseline-nál hangosan jelezzük, hogy a CI-kapu
    // ettől még piros marad (review-lelet: néma lokális "siker" csapdája).
    if (isExpired(baseline, today)) {
      console.warn(`[lint-ratchet] WARN: the baseline is EXPIRED (${baseline.expires}) — ` +
        `the CI gate still FAILS until "expires" is renewed with a documented justification (${baseline.task}).`);
    }
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
}
