#!/usr/bin/env node
/**
 * check-tasks.mjs — task-séma és konzisztencia CI-kapu (TASK-DP-003)
 *
 * QUALITY.md 1./4. pont + ADR-068 (kanonikus projekt- és taskállapot):
 * a task-fájl frontmatterje a design-intent kanonikus forrás task-szinten,
 * a `docs/projects/EPICS.yaml` a program/mérföldkő/epic szinten. Ez a kapu
 * mindkettőt és a kettő közötti konzisztenciát géppel ellenőrzi.
 *
 * Ellenőrzi:
 *   1. Task-frontmatter séma (docs/tasks/task-schema.json): kötelező mezők,
 *      enumok, dátumformátum, `blocked` → `blocked_reason` kötelező.
 *   2. ID-egyediség a teljes felfedezett halmazban (aktív + archivált).
 *   3. depends_on / parallel_with: hivatkozott ID létezik, önhivatkozás tilos,
 *      a depends_on-gráf körmentes (DAG).
 *   4. EPICS-tagság kétirányban: minden task-fájl szerepel valamelyik
 *      `epics[].tasks[]`-ben A HELYES fájlútvonallal, és minden
 *      `epics[].tasks[]`-bejegyzés létező task-fájlra mutat (docs/tasks/README.md
 *      "programReadmeIndex" — ld. task-schema.json).
 *   5. Program-README "Feladatok" táblázat linkjei léteznek (laza ellenőrzés).
 *   6. Archívum-invariánsok programonként eltérő szigorral
 *      (task-schema.json `archivePolicy.perProgram`): `status: done`,
 *      `## Implementáció` szakasz, a development-process programnál emellett
 *      kötelező, géppel olvasható `execution_evidence` blokk függetlenített,
 *      PASS reviewerrel.
 *
 * Tervezési döntés — miért NEM hand-rolled YAML-parser:
 *   A gyökér repo szándékosan nem kap saját package.json/node_modules-t (lásd
 *   a többi scripts/*.mjs fájlt). Ahelyett, hogy egy törékeny, kézzel írt YAML-
 *   parsert vezetnénk be (ami pont az itt vadászott hibaosztályt — érvénytelen
 *   YAML, ld. TASK-QC-008A…E — hamisan zöldre értékelhetné), a script a MÁR
 *   függőségként jelenlévő `gray-matter`/`js-yaml` csomagot használja a
 *   `knowledge-service/node_modules`-ból, `node:module` `createRequire`-rel.
 *   Ez a script maga NEM kerül be `knowledge-service/package.json`
 *   dependencies közé — csak a MÁR ott lévő könyvtárt kölcsönzi újrahasznosítás
 *   céljából (QUALITY.md 5. pont: ne generáljunk újra, ami már megvan).
 *
 * Tervezési döntés — státuszátmenet-kényszerítés:
 *   Egyetlen fájlrendszer-pillanatkép NEM tudja eldönteni, hogy egy
 *   `done → ready` váltás jogosulatlan volt-e — ehhez előző állapot kell. A
 *   `isAllowedTransition(from, to)` függvény ezért export-olt, unit-tesztelt
 *   tiszta függvény (ld. scripts/__tests__/check-tasks.test.mjs), és a CLI
 *   git-alapú előző-állapot összehasonlítást is végez, ha git-repóban fut.
 *
 *   ALAPÉRTELMEZETTEN (flag nélkül) a script megpróbálja `HEAD~1`-et
 *   diff-bázisként használni, HA `--root` egy git-repó GYÖKERE (nem
 *   fixture-alkönyvtár) ÉS van szülő-commit (ld. `resolveDefaultDiffBase`).
 *   Ez zárja be a TASK-DP-003 független reviewjának (2026-07-18, 1. kör)
 *   talált 2. rését: korábban a `--diff-base` implementálva és
 *   unit-tesztelve volt, de sem a helyi `npm run check:tasks`, sem a CI
 *   soha nem adta át — a "jogosulatlan átmenet ... lokálisan ÉS CI-ben is
 *   megbukik" ígéret emiatt ténylegesen nem teljesült. `--no-diff-base`-zel
 *   explicit kikapcsolható, `--diff-base <ref>`-fel explicit felülírható.
 *   Fixture-futásoknál (`--root` egy alkönyvtárra mutat) az auto-detektálás
 *   biztonságosan, csendben NO-OP (ld. a függvény fejléce a pontos okért).
 *
 * Használat (repo-gyökérből vagy package scriptből):
 *   node scripts/check-tasks.mjs
 *   node scripts/check-tasks.mjs --root scripts/__fixtures__/tasks/positive
 *   node scripts/check-tasks.mjs --diff-base origin/main
 *   node scripts/check-tasks.mjs --no-diff-base
 *   node scripts/check-tasks.mjs --quiet
 *
 * Lokális repro CI-hibánál: cd knowledge-service && npm run check:tasks
 *
 * Paraméterek:
 *   --root <dir>        repo-gyökér vagy fixture-gyökér (default: e script
 *                        szülőkönyvtárának szülője)
 *   --tasks-dir <dir>   docs/tasks gyökere, root-hoz relatív (default: docs/tasks)
 *   --epics <file>      EPICS.yaml útvonala, root-hoz relatív
 *                        (default: docs/projects/EPICS.yaml)
 *   --schema <file>     séma-JSON útvonala, root-hoz relatív
 *                        (default: docs/tasks/task-schema.json)
 *   --diff-base <ref>   git-ref, amihez képest a frontmatter `status`
 *                        átmenetét ellenőrzi (default: auto-detektált
 *                        `HEAD~1`, ld. fent — csak akkor NINCS ellenőrzés,
 *                        ha az auto-detektálás sem talál semmit)
 *   --no-diff-base      explicit letiltja a státuszátmenet-ellenőrzést
 *                        (auto-detektálás nélkül is)
 *   --quiet             csak a hibák kiírása
 *   --help              súgó
 *
 * Exit: 0 = kapu zöld, 1 = séma-/konzisztencia-hiba, 2 = konfigurációs hiba
 *       (pl. hiányzó könyvtár, betölthetetlen séma).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRootDefault = resolve(scriptDir, '..');
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ─── gray-matter / js-yaml kölcsönzése a knowledge-service node_modules-ból ─

function loadYamlLibs(repoRoot) {
  const pkgJsonPath = resolve(repoRoot, 'knowledge-service/package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(
      `A gray-matter/js-yaml betöltéséhez szükséges knowledge-service/package.json nem található: ${pkgJsonPath}`
    );
  }
  const req = createRequire(pkgJsonPath);
  const rawYaml = req('js-yaml');
  const rawMatter = req('gray-matter');

  // Miért JSON_SCHEMA, nem gray-matter's alapértelmezett YAML-engine-je:
  // a gyökér-ok NEM a repo top-level `js-yaml` csomagja (ma v5.2.1 — ennek
  // sémá-választás nélküli `yaml.load()`-ja `created: 2026-07-18`-ra már
  // stringet ad, nem Date-et). A tényleges gyökér-ok: a `gray-matter@^4.0.3`
  // SAJÁT, BEÁGYAZOTT `js-yaml@3.15.0`-t hordoz
  // (`gray-matter/node_modules/js-yaml`, a `gray-matter` "^3.13.1" függősége
  // miatt), és a `gray-matter` alapértelmezett YAML-engine-je
  // (`gray-matter/lib/engines.js`: `{ parse: yaml.safeLoad.bind(yaml) }`)
  // EZT a beágyazott, régi v3-as példányt hívja — aminek `safeLoad`-ja
  // (SAFE_SCHEMA) MÉG feloldja a YAML 1.1 `!!timestamp` típust, tehát az
  // idézőjel nélküli, `YYYY-MM-DD` mintájú skalárokat (pl.
  // `created: 2026-07-18`, pontosan a séma előírt formátuma) natív JS
  // `Date`-té alakítja parse-oláskor, nem stringgé. Ez a VALÓS repo teljes
  // task-halmazán bukást okozott volna: a `validateFrontmatter` DATE_RE
  // reguláris kifejezése egy `Date.prototype.toString()` kimenetet kapott
  // volna ("Sat Jul 18 2026 00:00:00 GMT+0000 ...") minden egyes
  // `created`/`updated` mezőn — ezt a hibát a validátor VALÓS repo-futtatása
  // tárta fel (ld. TASK-DP-003 Implementáció-szakasz), NEM csak elméleti
  // kockázat; a független review saját, izolált szkripttel megerősítette a
  // pontos gyökér-okot (gray-matter beágyazott v3 engine-je, nem a
  // top-level v5 csomag).
  //
  // A javítás: egy egyedi `yaml` engine-t adunk át a `gray-matter`
  // `options.engines`-nek, amely a REPO TOP-LEVEL, friss `js-yaml@5.2.1`
  // csomagot hívja `JSON_SCHEMA`-val (JSON-kompatibilis skalár-feloldás:
  // string/number/bool/null, `!!timestamp`/`!!merge`/oktális szám NÉLKÜL —
  // a flow-tömbök/mapek, pl. `depends_on: [TASK-X]`, szerkezeti
  // parse-olását ez nem érinti). Ez azért működik, mert a `gray-matter`
  // `lib/defaults.js`-e `opts.engines = Object.assign({}, engines,
  // opts.parsers, opts.engines)` alakú SEKÉLY (shallow) merge-öt végez: az
  // általunk átadott `{ yaml: yamlLoad }` bejegyzés TELJESEN felülírja a
  // beépített `yaml` kulcsot (nem csak kiegészíti azt), így a beágyazott
  // v3-as `js-yaml` soha nem aktiválódik.
  const yamlLoad = (source) => rawYaml.load(source, { schema: rawYaml.JSON_SCHEMA });
  const matter = (raw) => rawMatter(raw, { engines: { yaml: yamlLoad } });

  return { matter, yaml: { load: yamlLoad } };
}

// ─── Segédek ────────────────────────────────────────────────────────────────

/** Rekurzív fájllista egy könyvtárban (nem rekurzív alkönyvtárba, csak a megadott mélységig hívjuk kézzel). */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => join(dir, e.name));
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

const toPosix = (p) => p.split(sep).join('/');

// ─── Task-fájlok felfedezése ────────────────────────────────────────────────

/**
 * @returns {Array<{id: string|null, file: string, relFile: string, programDir: string,
 *   archived: boolean, data: object|null, content: string|null, parseError: Error|null}>}
 */
function discoverTasks({ root, tasksDir, matter }) {
  const tasksRoot = resolve(root, tasksDir);
  const results = [];
  for (const programDir of listDirs(tasksRoot)) {
    const programPath = join(tasksRoot, programDir);

    // Aktív taskok: közvetlenül a programkönyvtárban, README.md kivételével.
    for (const file of listFiles(programPath)) {
      if (file.toLowerCase().endsWith(`${sep}readme.md`)) continue;
      results.push(readTaskFile({ root, file, programDir, archived: false, matter }));
    }

    // Archivált taskok: programkönyvtár/archive alatt, README.md kivételével.
    const archivePath = join(programPath, 'archive');
    for (const file of listFiles(archivePath)) {
      if (file.toLowerCase().endsWith(`${sep}readme.md`)) continue;
      results.push(readTaskFile({ root, file, programDir, archived: true, matter }));
    }
  }
  return results;
}

function readTaskFile({ root, file, programDir, archived, matter }) {
  const relFile = toPosix(relative(root, file));
  const raw = readFileSync(file, 'utf8');
  try {
    const parsed = matter(raw);
    return {
      id: typeof parsed.data?.id === 'string' ? parsed.data.id : null,
      file,
      relFile,
      programDir,
      archived,
      data: parsed.data,
      content: parsed.content,
      parseError: null,
    };
  } catch (err) {
    return {
      id: null, file, relFile, programDir, archived,
      data: null, content: null, parseError: err,
    };
  }
}

// ─── Séma-validáció egy task-frontmatterre ──────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^TASK-[A-Z]+-\d{3}[A-Z]?$/;

/**
 * @returns {Array<{field: string, message: string}>} mezőnkénti hibák.
 */
function validateFrontmatter(data, schema) {
  const errors = [];
  const fm = schema.taskFrontmatter;
  if (!data || typeof data !== 'object') {
    return [{ field: '(frontmatter)', message: 'A frontmatter nem objektum vagy hiányzik.' }];
  }

  for (const field of fm.requiredFields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      errors.push({ field, message: `Kötelező mező hiányzik: '${field}'.` });
    }
  }

  if (data.id !== undefined && !ID_RE.test(String(data.id))) {
    errors.push({
      field: 'id',
      message: `'id' nem illeszkedik a mintára ${ID_RE} — kapott érték: '${data.id}'. Várt: TASK-<PROGRAM>-NNN[A].`,
    });
  }

  if (data.status !== undefined && !fm.fields.status.enum.includes(data.status)) {
    errors.push({
      field: 'status',
      message: `Érvénytelen 'status' érték: '${data.status}'. Engedélyezett: ${fm.fields.status.enum.join(', ')}.`,
    });
  }

  if (data.priority !== undefined && !fm.fields.priority.enum.includes(data.priority)) {
    errors.push({
      field: 'priority',
      message: `Érvénytelen 'priority' érték: '${data.priority}'. Engedélyezett: ${fm.fields.priority.enum.join(', ')}.`,
    });
  }

  if (data.created !== undefined && !DATE_RE.test(String(data.created))) {
    errors.push({
      field: 'created',
      message: `'created' nem YYYY-MM-DD formátumú: '${data.created}'.`,
    });
  }

  if (data.updated !== undefined && !DATE_RE.test(String(data.updated))) {
    errors.push({
      field: 'updated',
      message: `'updated' nem YYYY-MM-DD formátumú: '${data.updated}'.`,
    });
  }

  for (const field of ['depends_on', 'parallel_with']) {
    if (data[field] !== undefined && !Array.isArray(data[field])) {
      errors.push({ field, message: `'${field}' tömb kell legyen, kapott típus: ${typeof data[field]}.` });
    }
  }

  if (data.status === 'blocked') {
    if (!data.blocked_reason || String(data.blocked_reason).trim() === '') {
      errors.push({
        field: 'blocked_reason',
        message: "'status: blocked' esetén kötelező a 'blocked_reason' mező (ADR-068 életciklus-szabály).",
      });
    }
  }

  return errors;
}

// ─── DAG: kör- és önhivatkozás-ellenőrzés ───────────────────────────────────

/**
 * @param {Map<string, string[]>} graph task-id → depends_on id-lista
 * @returns {Array<string[]>} a talált körök listája (id-sorozatként)
 */
function detectCycles(graph) {
  const cycles = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
  const stack = [];

  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue; // hiányzó dependency külön hibaként kezelve
      if (color.get(dep) === GRAY) {
        const idx = stack.indexOf(dep);
        cycles.push([...stack.slice(idx), dep]);
      } else if (color.get(dep) === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) visit(node);
  }
  return cycles;
}

// ─── Státuszátmenet ─────────────────────────────────────────────────────────

/**
 * Tiszta, unit-tesztelhető függvény: engedélyezett-e a from→to átmenet az
 * ADR-068 állapotgépe szerint (task-schema.json statusTransitions.allowedEdges).
 * `from === null` esetben (új fájl, nincs korábbi verzió) mindig engedélyezett.
 */
function isAllowedTransition(from, to, schema) {
  if (from === null || from === undefined) return true;
  if (from === to) return true; // checkpoint / nincs állapotváltás
  return schema.statusTransitions.allowedEdges.some(([f, t]) => f === from && t === to);
}

/**
 * Alapértelmezett `--diff-base` meghatározása, ha a hívó nem adott meg
 * explicit értéket (és nem is tiltotta le `--no-diff-base`-zel).
 *
 * Miért kell ez: a független review (2026-07-18, 1. kör, REQUEST_CHANGES)
 * feltárta, hogy az `isAllowedTransition`/`--diff-base` út helyesen
 * implementált és unit-tesztelt, DE a valós `npm run check:tasks` és a CI
 * SOHA nem adta át a flaget — így a task saját "Mikor jó?" ígérete
 * ("jogosulatlan státuszátmenet ... lokálisan ÉS CI-ben is ... megbukik")
 * ténylegesen nem teljesült. A javítás: alapértelmezetten, flag NÉLKÜL is,
 * a CLI megpróbálja a `HEAD~1`-et diff-bázisként használni, ha `root`
 * ténylegesen egy git-repó GYÖKERE (nem egy fixture-alkönyvtár!) ÉS van
 * szülő-commit.
 *
 * A "root === repo top-level" ellenőrzés KRITIKUS biztonsági korlát: a
 * `previousStatus()` a `relFile`-t `root`-hoz KÉPEST relatív útvonalként
 * adja át a `git show <rev>:<path>`-nek, ami a git-repó GYÖKERÉHEZ képest
 * relatív utat vár. Ha `root` egy fixture-alkönyvtár (pl.
 * `scripts/__fixtures__/tasks/positive`) a valódi nexus-dev repón BELÜL,
 * a `git rev-parse --show-toplevel` a BEFOGLALÓ repo gyökerét adná vissza,
 * ami NEM egyezik `root`-tal — enélkül az ellenőrzés nélkül a diff-base
 * csendben rossz (vagy véletlenül egyező, de félrevezető) útvonalakat
 * próbálna feloldani. Ha a top-level nem egyezik `root`-tal, VAGY nincs
 * git, VAGY nincs szülő-commit (`HEAD~1` nem oldható fel), a függvény
 * `null`-t ad vissza — ez pontosan a korábbi ("nincs diff-base megadva")
 * viselkedés, tehát fixture-futásokat és sekély/első-commit eseteket
 * biztonságosan, csendben kihagy, nem hibáztat.
 */
function resolveDefaultDiffBase(root) {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (resolve(topLevel) !== resolve(root)) return null;
    execFileSync('git', ['rev-parse', '--verify', 'HEAD~1'], {
      cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 'HEAD~1';
  } catch {
    return null; // nincs git, nem git-repó, vagy nincs szülő-commit (pl. első commit)
  }
}

/** Előző frontmatter-status lekérése git-refből, ha elérhető. Hiba/hiányzó fájl esetén null. */
function previousStatus({ root, relFile, diffBase, matter }) {
  if (!diffBase) return undefined; // nincs bekérve → nem ellenőrizzük
  try {
    const raw = execFileSync('git', ['show', `${diffBase}:${relFile}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = matter(raw);
    return parsed.data?.status ?? null;
  } catch {
    return null; // a fájl nem létezett a diffBase-ben (új task) → null = "nincs előző"
  }
}

// ─── EPICS.yaml betöltés és tagság-ellenőrzés ───────────────────────────────

function loadEpics({ root, epicsPath, yaml }) {
  const abs = resolve(root, epicsPath);
  if (!existsSync(abs)) return { error: `Az EPICS.yaml nem található: ${epicsPath}`, doc: null };
  try {
    const doc = yaml.load(readFileSync(abs, 'utf8'));
    return { error: null, doc, abs };
  } catch (err) {
    return { error: `Az EPICS.yaml nem parse-olható: ${err.message}`, doc: null };
  }
}

function checkEpicsMembership({ epicsDoc, epicsAbs, tasks, root }) {
  const errors = [];
  if (!epicsDoc || !Array.isArray(epicsDoc.epics)) {
    errors.push({ file: '(EPICS.yaml)', field: 'epics', message: 'Az EPICS.yaml nem tartalmaz epics[] tömböt.' });
    return errors;
  }

  const epicsDir = dirname(epicsAbs);
  const referenced = new Map(); // task-id → { epicId, file(relToRoot) }

  for (const epic of epicsDoc.epics) {
    for (const t of epic.tasks ?? []) {
      const absFile = resolve(epicsDir, t.file);
      const relToRoot = toPosix(relative(root, absFile));
      referenced.set(t.id, { epicId: epic.id, relToRoot, absFile });

      if (!existsSync(absFile)) {
        errors.push({
          file: '(EPICS.yaml)',
          field: `epics[${epic.id}].tasks[${t.id}].file`,
          message: `Az EPICS.yaml a(z) '${t.id}' taskhoz nemlétező fájlra hivatkozik: '${t.file}' (feloldva: ${relToRoot}).`,
        });
      }
    }
  }

  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));

  // 1) Minden felfedezett task-fájl szerepel-e valamelyik epicben, a helyes fájllal?
  for (const task of tasks) {
    if (!task.id) continue; // parse-hiba máshol jelezve
    const ref = referenced.get(task.id);
    if (!ref) {
      errors.push({
        file: task.relFile,
        field: 'epic-membership',
        message: `Árva task: '${task.id}' egyetlen EPICS.yaml epic 'tasks[]' listájában sem szerepel. Javítás: vedd fel a megfelelő epic tasks[] tömbjébe { id: ${task.id}, file: <relatív útvonal> } formában.`,
      });
    } else if (ref.relToRoot !== task.relFile) {
      errors.push({
        file: task.relFile,
        field: 'epic-membership',
        message: `Az EPICS.yaml '${ref.epicId}' epicje a(z) '${task.id}' taskhoz más fájlútvonalat rögzít ('${ref.relToRoot}'), mint a ténylegesen felfedezett fájl ('${task.relFile}'). Javítás: szinkronizáld az EPICS.yaml 'file:' mezőjét.`,
      });
    }
  }

  return errors;
}

// ─── program/milestone/epic frontmatter-ÉRTÉK kereszt-ellenőrzés ───────────
//
// A `checkEpicsMembership` fent kizárólag azt ellenőrzi, hogy a task-ID és a
// fájlútvonal kétirányban egyezik-e egy EPICS.yaml epic `tasks[]` listájával —
// magát a frontmatter `program`/`milestone`/`epic` mező ÉRTÉKÉT sosem veti
// össze az EPICS.yaml tényleges ID-halmazával, holott a
// `docs/tasks/task-schema.json` mezőleírásai ezt kifejezetten ígérik (pl.
// `program`: "Létező programazonosítónak kell lennie..."). Ezt a rést a
// TASK-DP-003 független reviewja (2026-07-18, 1. kör, REQUEST_CHANGES)
// saját, reprodukálható próbával tárta fel: egy task-fájl, amely az
// EPICS.yaml-ban a task-ID + fájlútvonal alapján helyesen szerepelt egy
// VALÓS epic alatt, de a frontmatterjében kitalált `program`/`milestone`/
// `epic` értékekkel — a validátor csendben "OK"-t adott rá. Ez a függvény
// zárja be ezt a rést.
function checkEpicsReferences({ epicsDoc, tasks }) {
  const errors = [];
  if (!epicsDoc || !Array.isArray(epicsDoc.programs) || !Array.isArray(epicsDoc.epics)) {
    // Hiányzó/érvénytelen EPICS.yaml-t a loadEpics/checkEpicsMembership már
    // jelzi — itt nem duplikáljuk a hibát, csak nem futtatjuk a
    // kereszt-ellenőrzést egy már ismerten használhatatlan dokumentumon.
    return errors;
  }

  const programsById = new Map(epicsDoc.programs.map((p) => [p.id, p]));
  const epicsById = new Map(epicsDoc.epics.map((e) => [e.id, e]));

  // task-id → az epic-id, amely alatt az EPICS.yaml TÉNYLEGESEN regisztrálja
  // (ugyanaz a bejárás, mint `checkEpicsMembership`-ben, de itt csak az
  // ID-egyezés kell, fájlútvonal-feloldás nélkül).
  const registeredEpicByTaskId = new Map();
  for (const epic of epicsDoc.epics) {
    for (const t of epic.tasks ?? []) {
      registeredEpicByTaskId.set(t.id, epic.id);
    }
  }

  for (const task of tasks) {
    if (!task.id || !task.data) continue; // parse-hiba/hiányzó mező máshol jelezve
    const { program, milestone, epic } = task.data;

    let programDoc;
    if (program !== undefined) {
      programDoc = programsById.get(program);
      if (!programDoc) {
        errors.push({
          file: task.relFile,
          field: 'program',
          message: `A(z) '${program}' program nem létezik a docs/projects/EPICS.yaml 'programs[]' listájában. Javítás: használj létező program-id-t, vagy vedd fel az új programot az EPICS.yaml-ba.`,
        });
      }
    }

    if (milestone !== undefined) {
      const milestoneExists = programDoc
        ? (programDoc.milestones ?? []).some((m) => m.id === milestone)
        : false;
      if (!milestoneExists) {
        errors.push({
          file: task.relFile,
          field: 'milestone',
          message: programDoc
            ? `A(z) '${milestone}' mérföldkő nem létezik a(z) '${program}' program 'milestones[]' listájában.`
            : `A(z) '${milestone}' mérföldkő nem ellenőrizhető, mert a hivatkozott '${program}' program nem létezik (ld. a 'program' mező hibáját fent).`,
        });
      }
    }

    if (epic !== undefined) {
      const epicDoc = epicsById.get(epic);
      if (!epicDoc) {
        errors.push({
          file: task.relFile,
          field: 'epic',
          message: `A(z) '${epic}' epic nem létezik a docs/projects/EPICS.yaml 'epics[]' listájában. Javítás: használj létező epic-id-t, vagy vedd fel az új epicet az EPICS.yaml-ba.`,
        });
      } else {
        const registeredEpic = registeredEpicByTaskId.get(task.id);
        // Csak akkor jelzünk eltérést, ha a task TÉNYLEGESEN regisztrálva van
        // valamelyik epic alatt (ha nincs, azt a checkEpicsMembership már
        // "árva task"-ként jelzi — itt nem duplikáljuk azt a hibát).
        if (registeredEpic !== undefined && registeredEpic !== epic) {
          errors.push({
            file: task.relFile,
            field: 'epic',
            message: `A taskfájl frontmatterje 'epic: ${epic}'-t állít, de az EPICS.yaml a(z) '${task.id}' taskot a(z) '${registeredEpic}' epic 'tasks[]' listájában regisztrálja — a kettőnek egyeznie kell. Javítás: igazítsd a frontmatter 'epic' mezőjét vagy az EPICS.yaml regisztrációját.`,
          });
        } else if (epicDoc.program !== undefined && program !== undefined && epicDoc.program !== program) {
          // program-egyezés: KÖTELEZŐ, nincs ismert kivétel (a független
          // review 2. köre, 2026-07-18, szándékosan felvetette ezt az esetet
          // és nem talált rá legitim ellenpéldát a valós repóban — 0
          // program-mismatch az 5 valós milestone-mismatch mellett).
          //
          // FONTOS, MIÉRT NINCS ITT `epicDoc.milestone !== milestone`
          // ellenőrzés is: a review SZÁNDÉKOSAN, dokumentáltan kihagyta ezt
          // — egy epic `milestone` mezője a ZÁRÓ mérföldkövet jelöli, nem azt,
          // hogy MINDEN hozzá tartozó task ugyanabban a mérföldkőben él. Élő,
          // legitim precedens: a `QC-VERIFICATION` epic `milestone: QC-M4`
          // alatt zárul, miközben a hozzá tartozó `TASK-QC-005/006/011/012/013`
          // korábbi mérföldkőben (`QC-M2`) készült/készül — ezt az epic saját
          // leírása is kimondja ("...ezért az epic csak a QC-M4 mérföldkőben
          // zárulhat"). Egy `epicDoc.milestone === milestone` egyenlőség-
          // kényszer ezen a MÁR HELYES mintán hamis pozitívot adna. A task
          // saját `milestone` mezőjének helyességét a fenti, ettől független
          // "milestoneExists" ág már ellenőrzi (a task ÖNMAGA program-jának
          // milestones[] listája ellen) — ld. docs/tasks/task-schema.json
          // `taskFrontmatter.fields.milestone` és `epicsMembership`
          // leírását a pontos szerződésért.
          errors.push({
            file: task.relFile,
            field: 'program',
            message: `A taskfájl 'program: ${program}'-t állít, de a hivatkozott epic ('epic: ${epic}') az EPICS.yaml-ban a(z) '${epicDoc.program}' programhoz tartozik — a kettőnek egyeznie kell (a mérföldkőnek NEM kell egyeznie — egy epic több mérföldkövet is átívelhet, ld. task-schema.json 'epic' mezőleírása).`,
          });
        }
      }
    }
  }

  return errors;
}

// ─── Program-README taskindex (laza ellenőrzés) ─────────────────────────────

function checkProgramReadme({ root, tasksDir, taskIds }) {
  const errors = [];
  const tasksRoot = resolve(root, tasksDir);
  const LINK_RE = /\[TASK-([A-Z0-9-]+)[^\]]*\]\(([^)]+)\)/g;

  for (const programDir of listDirs(tasksRoot)) {
    const readmePath = join(tasksRoot, programDir, 'README.md');
    if (!existsSync(readmePath)) continue;
    const raw = readFileSync(readmePath, 'utf8');
    const relReadme = toPosix(relative(root, readmePath));
    for (const m of raw.matchAll(LINK_RE)) {
      const linkedId = `TASK-${m[1]}`;
      const target = m[2];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // külső URL
      const absTarget = resolve(dirname(readmePath), target.split('#')[0]);
      if (!existsSync(absTarget)) {
        errors.push({
          file: relReadme,
          field: 'readme-link',
          message: `A(z) '${linkedId}' hivatkozás célfájlja nem létezik: '${target}'.`,
        });
      }
      // Csak a top-level task-id mintát (TASK-XXX-NNN, opcionális betűvel) fogadjuk el
      // az összevetéshez — a sorszám előtti/utáni szöveg (pl. "…E — cím") nem gond,
      // mert a linkId-t csak a fájl-létezés, nem a teljes cím ellen ellenőrizzük.
    }
  }
  return errors;
}

// ─── Archívum-invariánsok ───────────────────────────────────────────────────

const EVIDENCE_BLOCK_RE = /^execution_evidence:\s*$/m;

function extractEvidenceBlock(content, yaml) {
  const idx = content.search(EVIDENCE_BLOCK_RE);
  if (idx === -1) return null;
  // A blokk a "execution_evidence:" sortól a következő nem-indentált,
  // nem-üres sorig (vagy a szöveg végéig) tart — kódblokkban (```yaml) vagy
  // sima szövegben egyaránt előfordulhat, ezért a keresés a nyers tartalomban
  // (fenced code-jelölőket figyelmen kívül hagyva) történik.
  const lines = content.slice(idx).split('\n');
  const block = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { block.push(line); continue; }
    if (/^([ \t]|```)/.test(line) && !/^```/.test(line)) { block.push(line); continue; }
    if (/^```/.test(line)) break; // fenced code záró jelölő
    break;
  }
  try {
    const loaded = yaml.load(block.join('\n'));
    // A block az "execution_evidence:" kulcsot is tartalmazza (yaml.load ezért
    // { execution_evidence: {...} } alakot ad vissza) — a hívók a BELSŐ objektumot
    // várják, ezért itt egyszer kicsomagoljuk.
    return loaded && typeof loaded === 'object' ? loaded.execution_evidence ?? null : null;
  } catch {
    return null;
  }
}

function checkArchiveInvariants({ task, schema, yaml }) {
  const errors = [];
  const policy = schema.archivePolicy;
  const perProgram = policy.perProgram[task.programDir] ?? {
    requireExecutionEvidenceBlock: false,
    requireReviewerIndependent: false,
    requireReviewerDecisionPass: false,
  };

  if (task.data?.status !== policy.common.requiredStatus) {
    errors.push({
      file: task.relFile,
      field: 'status',
      message: `Archivált taskhoz '${policy.common.requiredStatus}' státusz kötelező, kapott: '${task.data?.status}'.`,
    });
  }

  const hasImplementationSection = task.content && new RegExp(policy.common.sectionRegex, 'm').test(task.content);
  if (!hasImplementationSection) {
    errors.push({
      file: task.relFile,
      field: 'body',
      message: `Hiányzik a kötelező '${policy.common.requiredSection}' szakasz.`,
    });
  }

  if (perProgram.requireExecutionEvidenceBlock) {
    const evidence = task.content ? extractEvidenceBlock(task.content, yaml) : null;
    if (!evidence) {
      errors.push({
        file: task.relFile,
        field: 'execution_evidence',
        message: `A(z) '${task.programDir}' program archívumában kötelező egy parse-olható 'execution_evidence:' YAML-blokk (docs/tasks/task-schema.json evidenceManifest.requiredFields).`,
      });
    } else {
      for (const field of schema.evidenceManifest.requiredFields) {
        if (evidence[field] === undefined) {
          errors.push({
            file: task.relFile,
            field: `execution_evidence.${field}`,
            message: `Az evidence manifest hiányzó mezője: '${field}'.`,
          });
        }
      }
      if (perProgram.requireReviewerIndependent && evidence.reviewer?.independent !== true) {
        errors.push({
          file: task.relFile,
          field: 'execution_evidence.reviewer.independent',
          message: "Az archivált taskhoz 'reviewer.independent: true' kötelező (készítő ≠ ellenőr elve, QUALITY.md 8. pont).",
        });
      }
      if (perProgram.requireReviewerDecisionPass && evidence.reviewer?.decision !== 'PASS') {
        errors.push({
          file: task.relFile,
          field: 'execution_evidence.reviewer.decision',
          message: `Az archivált taskhoz 'reviewer.decision: PASS' kötelező, kapott: '${evidence.reviewer?.decision}'.`,
        });
      }
    }
  }

  return errors;
}

// ─── Fő ellenőrzés-összeállítás ─────────────────────────────────────────────

function runChecks(opts) {
  const { root, tasksDir, epicsPath, schema, diffBase, matter, yaml } = opts;
  const allErrors = []; // { file, field, message }

  const tasks = discoverTasks({ root, tasksDir, matter });

  // 1) Parse-hibák (érvénytelen YAML frontmatter)
  for (const task of tasks) {
    if (task.parseError) {
      allErrors.push({
        file: task.relFile,
        field: '(frontmatter)',
        message: `A frontmatter nem parse-olható érvényes YAML-ként: ${task.parseError.message.split('\n')[0]}. Javítás: a probléma jellemzően idézőjel nélküli, kettőspontot tartalmazó szabad szöveg (pl. 'source: ... (allowlist: ...)') — tedd a teljes értéket idézőjelbe.`,
      });
    }
  }

  const validTasks = tasks.filter((t) => !t.parseError);

  // 2) Frontmatter séma-validáció taskonként
  for (const task of validTasks) {
    for (const e of validateFrontmatter(task.data, schema)) {
      allErrors.push({ file: task.relFile, field: e.field, message: e.message });
    }
  }

  // 3) ID-egyediség
  const byId = new Map();
  for (const task of validTasks) {
    if (!task.id) continue;
    if (!byId.has(task.id)) byId.set(task.id, []);
    byId.get(task.id).push(task);
  }
  for (const [id, list] of byId) {
    if (list.length > 1) {
      allErrors.push({
        file: list.map((t) => t.relFile).join(', '),
        field: 'id',
        message: `Duplikált task-id: '${id}' ${list.length} fájlban szerepel.`,
      });
    }
  }

  // 4) depends_on / parallel_with létezés + DAG
  const graph = new Map();
  for (const task of validTasks) {
    if (!task.id) continue;
    graph.set(task.id, Array.isArray(task.data.depends_on) ? task.data.depends_on : []);
  }
  for (const task of validTasks) {
    if (!task.id || !task.data) continue;
    for (const field of ['depends_on', 'parallel_with']) {
      const list = Array.isArray(task.data[field]) ? task.data[field] : [];
      for (const dep of list) {
        if (dep === task.id) {
          allErrors.push({
            file: task.relFile, field,
            message: `Önhivatkozás: '${task.id}' saját magára hivatkozik a(z) '${field}' listában.`,
          });
        } else if (!byId.has(dep)) {
          allErrors.push({
            file: task.relFile, field,
            message: `Hiányzó hivatkozott task: '${dep}' szerepel a(z) '${field}' listában, de nincs ilyen id-jű felfedezett task.`,
          });
        }
      }
    }
  }
  for (const cycle of detectCycles(graph)) {
    allErrors.push({
      file: byId.get(cycle[0])?.[0]?.relFile ?? cycle[0],
      field: 'depends_on',
      message: `Ciklikus függőség: ${cycle.join(' → ')}.`,
    });
  }

  // 5) Státuszátmenet (csak ha --diff-base meg van adva)
  if (diffBase) {
    for (const task of validTasks) {
      const prev = previousStatus({ root, relFile: task.relFile, diffBase, matter });
      if (prev === undefined) continue;
      const cur = task.data?.status;
      if (!isAllowedTransition(prev, cur, schema)) {
        allErrors.push({
          file: task.relFile,
          field: 'status',
          message: `Jogosulatlan státuszátmenet: '${prev}' → '${cur}' (bázis: ${diffBase}). Engedélyezett élek: ${schema.statusTransitions.allowedEdges.map(([f, t]) => `${f}→${t}`).join(', ')}.`,
        });
      }
    }
  }

  // 6) EPICS.yaml betöltés + tagság + program/milestone/epic ID-kereszthivatkozás
  const { error: epicsLoadError, doc: epicsDoc, abs: epicsAbs } = loadEpics({ root, epicsPath, yaml });
  if (epicsLoadError) {
    allErrors.push({ file: epicsPath, field: '(EPICS.yaml)', message: epicsLoadError });
  } else {
    for (const e of checkEpicsMembership({ epicsDoc, epicsAbs, tasks: validTasks, root })) {
      allErrors.push(e);
    }
    for (const e of checkEpicsReferences({ epicsDoc, tasks: validTasks })) {
      allErrors.push(e);
    }
  }

  // 7) Program-README laza linkellenőrzés
  for (const e of checkProgramReadme({ root, tasksDir, taskIds: new Set(byId.keys()) })) {
    allErrors.push(e);
  }

  // 8) Archívum-invariánsok
  for (const task of validTasks) {
    if (!task.archived) continue;
    for (const e of checkArchiveInvariants({ task, schema, yaml })) {
      allErrors.push(e);
    }
  }

  return { errors: allErrors, taskCount: tasks.length, validCount: validTasks.length };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    root: repoRootDefault,
    tasksDir: 'docs/tasks',
    epicsPath: 'docs/projects/EPICS.yaml',
    schemaPath: 'docs/tasks/task-schema.json',
    // undefined = "nincs explicit megadva" → main() megpróbálja auto-
    // detektálni (ld. resolveDefaultDiffBase); null = explicit letiltva
    // (--no-diff-base) vagy explicit ref (--diff-base <ref>) van megadva.
    diffBase: undefined,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--root': opts.root = resolve(argv[++i]); break;
      case '--tasks-dir': opts.tasksDir = argv[++i]; break;
      case '--epics': opts.epicsPath = argv[++i]; break;
      case '--schema': opts.schemaPath = argv[++i]; break;
      case '--diff-base': opts.diffBase = argv[++i]; break;
      case '--no-diff-base': opts.diffBase = null; break;
      case '--quiet': opts.quiet = true; break;
      case '--help':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/');
        process.exit(0);
        break;
      default:
        console.error(`Ismeretlen paraméter: ${argv[i]} (lásd --help)`);
        process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (...m) => { if (!opts.quiet) console.log(...m); };

  // Auto-detektált diff-base, ha a hívó nem adott meg explicit értéket és
  // nem is tiltotta le (ld. resolveDefaultDiffBase fejléce — ez zárja be a
  // független review 2. talált rését: a státuszátmenet-ellenőrzés eddig
  // SOHA nem futott le sem lokálisan, sem CI-ben, flag hiányában).
  if (opts.diffBase === undefined) {
    opts.diffBase = resolveDefaultDiffBase(opts.root);
    if (opts.diffBase) {
      log(`[check:tasks] --diff-base nincs explicit megadva — automatikusan 'HEAD~1'-et használom (root egy git-repó gyökere, van szülő-commit).`);
    }
  } else if (opts.diffBase) {
    // EXPLICIT --diff-base: fail-closed ref-validáció (TASK-DP-007 review).
    // Enélkül egy elgépelt/le nem fetchelt ref esetén a previousStatus()
    // minden git-show hibát "új task"-ként nyelne le, és a státuszátmenet-
    // ellenőrzés NÉMÁN kimaradna — a hívó pedig azt hinné, lefutott.
    try {
      execFileSync('git', ['rev-parse', '--verify', `${opts.diffBase}^{commit}`], {
        cwd: opts.root, stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      console.error(`HIBA: az explicit --diff-base '${opts.diffBase}' nem oldható fel commitra ` +
        '(nincs ilyen ref, vagy nincs lefetchelve). A státuszátmenet-kapu fail-closed: ' +
        'adj meg létező refet, vagy tiltsd le tudatosan a --no-diff-base kapcsolóval.');
      process.exit(2);
    }
  }

  // A séma a formátum-specifikáció, nem fixture-specifikus adat — mindig a
  // VALÓS repo-gyökérhez (nem a --root-hoz, ami fixture-futásnál eltérhet)
  // relatív útvonalon oldjuk fel, hacsak --schema explicit abszolút utat nem ad.
  const schemaAbs = resolve(repoRootDefault, opts.schemaPath);
  if (!existsSync(schemaAbs)) {
    console.error(`HIBA: séma-fájl nem található: ${schemaAbs}`);
    process.exit(2);
  }
  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaAbs, 'utf8'));
  } catch (err) {
    console.error(`HIBA: séma-fájl nem parse-olható JSON-ként: ${err.message}`);
    process.exit(2);
  }

  let matter, yaml;
  try {
    // A gray-matter/js-yaml mindig a VALÓS repo knowledge-service/node_modules-jából
    // töltendő, fixture-futásnál (--root a fixture-gyökérre mutat) is.
    ({ matter, yaml } = loadYamlLibs(repoRootDefault));
  } catch (err) {
    console.error(`HIBA: ${err.message}`);
    process.exit(2);
  }

  const started = process.hrtime.bigint();
  const { errors, taskCount, validCount } = runChecks({
    root: opts.root,
    tasksDir: opts.tasksDir,
    epicsPath: opts.epicsPath,
    schema,
    diffBase: opts.diffBase,
    matter,
    yaml,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  log(`[check:tasks] Felfedezve: ${taskCount} task (${validCount} parse-olható). Futásidő: ${elapsedMs.toFixed(1)} ms.`);

  if (errors.length > 0) {
    console.error(`\n[check:tasks] HIBÁK (${errors.length}):`);
    for (const e of errors) {
      console.error(`  ${e.file} [${e.field}] ${e.message}`);
    }
    process.exit(1);
  }

  log('[check:tasks] OK — a task-séma, DAG, EPICS-tagság és archívum-invariánsok konzisztensek.');
  process.exit(0);
}

if (isMain) {
  main();
}

// ─── Programozott API (unit tesztekhez) ─────────────────────────────────────

export {
  loadYamlLibs,
  discoverTasks,
  validateFrontmatter,
  detectCycles,
  isAllowedTransition,
  loadEpics,
  checkEpicsMembership,
  checkEpicsReferences,
  resolveDefaultDiffBase,
  checkProgramReadme,
  extractEvidenceBlock,
  checkArchiveInvariants,
  runChecks,
  ID_RE,
  DATE_RE,
};
