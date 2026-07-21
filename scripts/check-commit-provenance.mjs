#!/usr/bin/env node
/**
 * check-commit-provenance.mjs — branch-név és commit-üzenet provenance-ellenőrző (TASK-DP-006)
 *
 * Cél: minden aktív változás (ember VAGY bot/agent által létrehozott commit
 * egyaránt — NINCS kivétel-szabály automatizálásra) egy `TASK-*` azonosítóhoz
 * legyen köthető, hogy egy tetszőleges merged sortól visszakereshető legyen a
 * task, a branch és a commit-sorozat (program README "Mikor jó?" 1. pontja).
 *
 * Ellenőrzi:
 *   1. branch-nevet: `task/TASK-<PROGRAM>-<NNN>-<kebab-slug>` vagy
 *      `hotfix/TASK-<PROGRAM>-<NNN>-<kebab-slug>` mintát;
 *   2. commit-üzenet SUBJECT sorát: `[TASK-<PROGRAM>-<NNN>]` vagy
 *      `[TASK-<PROGRAM>-<NNN>-REVERT]` kötelező prefixet;
 *   3. egy commit-tartományt (`range base..head`): minden egyes commit
 *      subject-jét egyenként ellenőrzi — ez a mód szolgál CI-required-check
 *      alapjául, mert a teljes PR-tartományt nézi, nem csak a HEAD-et, és
 *      NEM tesz kivételt bot-szerzőre (dependabot, github-actions[bot],
 *      agent Co-Authored-By trailer stb.) — ez zárja a "generált/bot commit
 *      megkerüli a kaput" rést.
 *
 * Node-only, külső függőség nélkül. Bármely szabálysértésnél nem-nulla exit
 * kóddal áll le, és megmondja, melyik minta nem teljesült (ACI: a hibaüzenet
 * jelzi a következő lépést — QUALITY.md 8. "Tool-ergonómia").
 *
 * Config-vezérelt (QUALITY.md 3.: nincs hardcodolt adat): a minták felülírhatók
 * `--config <json-fájl>`-lal, vagy egyedi flag-ekkel. Alapértelmezésben a
 * repo-gyökér `scripts/check-commit-provenance.config.json` fájlját olvassa be,
 * ha létezik.
 *
 * Használat (repo-gyökérből):
 *   node scripts/check-commit-provenance.mjs branch task/TASK-QC-005-ci-gates
 *   node scripts/check-commit-provenance.mjs commit-msg "[TASK-QC-005] ci: gate"
 *   node scripts/check-commit-provenance.mjs commit-msg-file .git/COMMIT_EDITMSG
 *   node scripts/check-commit-provenance.mjs range origin/main..HEAD
 *   node scripts/check-commit-provenance.mjs --help
 *
 * Paraméterek:
 *   --root <dir>            repo-gyökér (default: a script szülőkönyvtárának szülője)
 *   --config <file>          JSON konfig-fájl a minták felülírására
 *   --task-id-pattern <re>   task-azonosító regex-forrás (default lásd DEFAULT_CONFIG)
 *   --branch-pattern <re>    branch-név regex-forrás
 *   --commit-pattern <re>    commit-subject regex-forrás
 *   --allow-merge-commits    a "Merge pull request #N..." / "Merge branch..."
 *                            alakú, platform-generált merge-commit subject-eket
 *                            kivételként engedi (alapból KIKAPCSOLVA — az ADR-086
 *                            javaslata szerint a repo csak squash-merge-t
 *                            engedélyezzen, így ilyen subject soha nem kerül
 *                            a fő ágra és nincs szükség kivételre)
 *   --quiet                  csak a hibák kiírása
 *   --help                   súgó
 *
 * Kilépési kódok: 0 = minden szabály teljesült; 1 = szabálysértés; 2 = használati hiba.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// ─── Alapértelmezett config (felülírható --config / flag-ekkel) ───────────────
const DEFAULT_CONFIG = {
  // Egy TASK-azonosító: TASK-<2-10 nagybetű/szám>-<1-6 számjegy>, pl. TASK-QC-005, TASK-DP-006, TASK-ISL-011.
  taskIdPattern: 'TASK-[A-Z][A-Z0-9]{1,9}-\\d{1,6}',
  // Branch: task/ vagy hotfix/ prefix + a fenti task-id + kötelező kebab-case leíró szlug.
  branchPatternTemplate: '^(task|hotfix)/{TASK_ID}-[a-z0-9]+(?:-[a-z0-9]+)*$',
  // Commit subject: [TASK-XXX-NNN] vagy [TASK-XXX-NNN-REVERT] prefix, utána kötelező, nem üres leírás.
  commitPatternTemplate: '^\\[{TASK_ID}(?:-REVERT)?\\] \\S.+$',
};

// ─── Argumentum-feldolgozás ─────────────────────────────────────────────────

function printHelp() {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(src.split('*/')[0] + '*/');
}

function parseArgs(argv) {
  const opts = {
    root: resolve(scriptDir, '..'),
    config: null,
    taskIdPattern: null,
    branchPattern: null,
    commitPattern: null,
    allowMergeCommits: false,
    quiet: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--root': opts.root = resolve(argv[++i]); break;
      case '--config': opts.config = argv[++i]; break;
      case '--task-id-pattern': opts.taskIdPattern = argv[++i]; break;
      case '--branch-pattern': opts.branchPattern = argv[++i]; break;
      case '--commit-pattern': opts.commitPattern = argv[++i]; break;
      case '--allow-merge-commits': opts.allowMergeCommits = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': printHelp(); process.exit(0); break;
      default: positional.push(a);
    }
  }
  return { opts, positional };
}

/** Config összeállítása: DEFAULT_CONFIG <- json fájl <- CLI flag-ek (utóbbi nyer). */
function buildConfig(opts) {
  let fileConfig = {};
  const configPath = opts.config
    ? resolve(opts.config)
    : resolve(opts.root, 'scripts/check-commit-provenance.config.json');
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error(`Config-parse hiba (${configPath}): ${e.message}`);
      process.exit(2);
    }
  }
  const merged = { ...DEFAULT_CONFIG, ...fileConfig };
  const taskIdPattern = opts.taskIdPattern || merged.taskIdPattern;
  const branchPatternSrc = (opts.branchPattern || merged.branchPatternTemplate).replace(
    '{TASK_ID}',
    taskIdPattern
  );
  const commitPatternSrc = (opts.commitPattern || merged.commitPatternTemplate).replace(
    '{TASK_ID}',
    taskIdPattern
  );
  return {
    taskIdPattern,
    branchRegex: new RegExp(branchPatternSrc),
    commitRegex: new RegExp(commitPatternSrc),
    mergeCommitRegex: /^Merge (pull request #\d+|branch )/,
  };
}

// ─── Ellenőrző függvények (tiszta, tesztelhető logika) ─────────────────────

/** @returns {{ok: boolean, reason?: string}} */
function checkBranchName(name, cfg) {
  if (cfg.branchRegex.test(name)) return { ok: true };
  return {
    ok: false,
    reason:
      `Branch-név "${name}" nem felel meg a mintának: ${cfg.branchRegex.source}\n` +
      `  Elvárt forma: task/TASK-<PROGRAM>-<NNN>-leiro-szlug vagy hotfix/... ` +
      `— pl. task/TASK-QC-005-ci-gates`,
  };
}

/** @returns {{ok: boolean, reason?: string}} */
function checkCommitSubject(subject, cfg, opts) {
  if (opts.allowMergeCommits && cfg.mergeCommitRegex.test(subject)) return { ok: true };
  if (cfg.commitRegex.test(subject)) return { ok: true };
  return {
    ok: false,
    reason:
      `Commit-subject "${subject}" nem kezdődik érvényes [TASK-*] prefixszel.\n` +
      `  Elvárt minta: ${cfg.commitRegex.source}\n` +
      `  Példa: [TASK-QC-005] ci(quality-gates): lint ratchet bevezetése`,
  };
}

/** Egy `base..head` tartomány minden commit-subjectjét lekéri és ellenőrzi. */
function checkRange(root, range, cfg, opts) {
  const sep = '\x1f';
  let out;
  try {
    out = execFileSync(
      'git',
      ['log', `--format=%H${sep}%an${sep}%ae${sep}%s`, range],
      { cwd: root, encoding: 'utf8' }
    );
  } catch (e) {
    return { ok: false, failures: [{ line: range, reason: `git log hiba: ${e.message}` }] };
  }
  const lines = out.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { ok: false, failures: [{ line: range, reason: 'A tartomány üres (0 commit) — ellenőrizd a base/head hivatkozást.' }] };
  }
  const failures = [];
  for (const line of lines) {
    const [hash, author, email, subject] = line.split(sep);
    // FONTOS: a szerző/e-mail-mező NEM ad kivételt — bot vagy agent szerző
    // (pl. "dependabot[bot]", "actions@github.com", "Claude Sonnet 5"
    // Co-Authored-By) ugyanazt a mintát kell teljesítse, mint egy ember.
    const res = checkCommitSubject(subject, cfg, opts);
    if (!res.ok) {
      failures.push({ line: `${hash.slice(0, 8)} (${author} <${email}>)`, reason: res.reason });
    }
  }
  return { ok: failures.length === 0, failures };
}

// ─── Belépési pont ──────────────────────────────────────────────────────────

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const cfg = buildConfig(opts);
  const [mode, ...rest] = positional;

  if (!mode) {
    console.error('Hiányzó mód. Használat: branch | commit-msg | commit-msg-file | range (lásd --help)');
    process.exit(2);
  }

  const log = (...m) => { if (!opts.quiet) console.log(...m); };

  switch (mode) {
    case 'branch': {
      const name = rest[0];
      if (!name) { console.error('Hiányzó branch-név argumentum.'); process.exit(2); }
      const res = checkBranchName(name, cfg);
      if (res.ok) { log(`OK — branch-név érvényes: ${name}`); process.exit(0); }
      console.error(`HIBA — ${res.reason}`);
      process.exit(1);
      break;
    }
    case 'commit-msg': {
      const subject = (rest[0] || '').split('\n')[0];
      if (!subject) { console.error('Hiányzó commit-üzenet argumentum.'); process.exit(2); }
      const res = checkCommitSubject(subject, cfg, opts);
      if (res.ok) { log(`OK — commit-subject érvényes: ${subject}`); process.exit(0); }
      console.error(`HIBA — ${res.reason}`);
      process.exit(1);
      break;
    }
    case 'commit-msg-file': {
      const file = rest[0];
      if (!file || !existsSync(file)) { console.error(`Fájl nem található: ${file}`); process.exit(2); }
      const subject = readFileSync(file, 'utf8').split('\n')[0];
      const res = checkCommitSubject(subject, cfg, opts);
      if (res.ok) { log(`OK — commit-subject érvényes: ${subject}`); process.exit(0); }
      console.error(`HIBA — ${res.reason}`);
      process.exit(1);
      break;
    }
    case 'range': {
      const range = rest[0];
      if (!range || !range.includes('..')) {
        console.error('Használat: range <base>..<head>');
        process.exit(2);
      }
      const res = checkRange(opts.root, range, cfg, opts);
      if (res.ok) { log(`OK — minden commit a tartományban (${range}) érvényes provenance-t hordoz.`); process.exit(0); }
      for (const f of res.failures) console.error(`HIBA — ${f.line}\n  ${f.reason}`);
      process.exit(1);
      break;
    }
    default:
      console.error(`Ismeretlen mód: ${mode} (lásd --help)`);
      process.exit(2);
  }
}

main();
