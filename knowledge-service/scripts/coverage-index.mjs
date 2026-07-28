#!/usr/bin/env node
/**
 * coverage-index.mjs — a COVERS (teszt→kód) réteg frissítése EGY paranccsal
 * (npm run coverage:index) a coverage-t termelő gépen (COVERAGE-GRAPH-WIRING
 * follow-up (c) — eddig két kézi lépés volt).
 *
 * 1. Teljes coverage-futás (vitest --coverage → coverage/coverage-final.json).
 * 2. Gráf-indexelés env-kapuzott coverage-forrással: a NEXUS_COVERAGE_ROOT a
 *    2. lépésre kap értéket. EGY-ÍRÓ szabály: ezt a parancsot csak azon a
 *    gépen futtasd, ahol a coverage keletkezik (ma: a Windows dev gép).
 *
 * A kapu- és index-út SZÁNDÉKOSAN a kanonikus vitest-kimenet
 * (<knowledge-service>/coverage), NEM a hívó env-jéből örökölt
 * NEXUS_COVERAGE_ROOT: az 1. lépés feltétel nélkül ide ír, egy ottfelejtett
 * env-export pedig egy RÉGI coverage-fát indexelne FRESH bélyeggel — pontosan
 * a "magabiztos elavult válasz" hibaosztály (független review P2-lelet).
 *
 * Fail-closed kapuk a 2. lépés előtt:
 *  - a coverage-final.json létezik ÉS az 1. lépés indítása UTÁN íródott
 *    (mtime-kapu: egy korábbi futás maradványa nem mehet a gráfba);
 *  - megjegyzés: a test:coverage a coverage-KÜSZÖBÖKÖN is bukhat — ilyenkor a
 *    frissítés tudatosan elmarad (konzervatív: küszöb-bukás mellett nem
 *    bélyegzünk frissnek).
 */

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ksRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coverageRoot = join(ksRoot, 'coverage');
const finalJson = join(coverageRoot, 'coverage-final.json');

const startedAt = Date.now();
console.log('[coverage:index] 1/2 — full coverage run (vitest --coverage)...');
execSync('npm run test:coverage', { cwd: ksRoot, stdio: 'inherit' });

const stat = statSync(finalJson, { throwIfNoEntry: false });
if (stat === undefined || stat.mtimeMs < startedAt) {
  console.error(
    `[coverage:index] FAIL — ${finalJson} ${stat === undefined ? 'does not exist' : 'predates this run'}; ` +
      'refusing to index (a stale/absent coverage tree must not be stamped fresh into the graph).'
  );
  process.exit(1);
}

console.log(`[coverage:index] 2/2 — graph index with coverage source (${coverageRoot})...`);
execSync('npm run graph:index', {
  cwd: ksRoot,
  stdio: 'inherit',
  env: { ...process.env, NEXUS_COVERAGE_ROOT: coverageRoot },
});
console.log('[coverage:index] done — COVERS layer refreshed for this island.');
