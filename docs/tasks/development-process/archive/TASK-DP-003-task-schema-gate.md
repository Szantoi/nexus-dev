---
id: TASK-DP-003
title: "Task-séma és konzisztencia CI-kapu"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M2
epic: DP-TASK-CONTROLS
status: done
priority: critical
depends_on: [TASK-DP-002]
parallel_with: []
owner_role: tooling
created: 2026-07-18
updated: 2026-07-18
source: "DEVPROC-04"
---

# Task-séma és konzisztencia CI-kapu

## Cél

Egy determinisztikus, cross-platform `check:tasks` kapu minden program- és
taskdokumentum szerkezetét, hivatkozását és életciklus-invariánsát ellenőrizze.

## Mikor jó?

Érvénytelen frontmatter, duplikált ID, ciklikus függőség, hiányzó EPICS-link,
jogosulatlan státuszátmenet vagy bizonyíték nélküli archív task lokálisan és
CI-ben is nem nulla exit code-dal megbukik.

## Scope

1. Definiálj verziózott sémát a task frontmatterhez, programindexhez és evidence
   manifesthez; az ismeretlen mezők kezelését is rögzítsd.
2. Rekurzívan fedezd fel a `docs/tasks` programkönyvtárait és archívumait.
3. Validáld az ID-ket, státuszokat, dátumokat, priorityt, ownert, dependency DAG-t,
   fájlhivatkozásokat és EPICS-tagságot.
4. Archivált tasknál követeld meg a `done` állapotot, Implementáció szakaszt,
   evidence manifestet és független reviewer-recordot.
5. Javítsd a felmérésben talált öt hibás `TASK-QC-008A…E` frontmattert.
6. Adj Windows- és Linux-kompatibilis npm scriptet és GitHub CI-kaput.
7. Készíts pozitív és minden fontos hibafajtát lefedő negatív fixture-öket.

## Elfogadási feltételek

- [ ] `npm run check:tasks` ugyanazt az eredményt adja PowerShell és Bash alatt.
- [ ] Minden repository task és az `EPICS.yaml` parse-olható és konzisztens.
- [ ] Ciklus, hiányzó dependency, duplikált ID és árva aktív task megbukik.
- [ ] Hibás archive/reviewer/evidence kombináció megbukik.
- [ ] A hibaüzenet fájlt, mezőt, elvárt értéket és javítási irányt ad, titok nélkül.
- [ ] A kapu a required CI része és lokálisan egy paranccsal reprodukálható.

## Kötelező ellenőrzés

Unit teszt a séma minden ágára, integrációs teszt a valós repositoryra, legalább
egy ciklusos DAG, hibás YAML, árva task, önreview és bizonyíték nélküli archive
negatív fixture. Mérd és dokumentáld a futásidőt.

## Kilépési feltétel

`done`, ha a teljes repository zöld, a negatív fixture-ök bizonyítottan pirosak,
és a kapu CI-ben blokkol. Ha a DP-002 állapotmodellje nincs elfogadva, a task nem
indítható.

## Végrehajtási napló

Goal (ez a futás): egy megszakadt korábbi futásból örökölt `scripts/check-tasks.mjs`
(718 sor) + `scripts/__fixtures__/tasks/` minőségének felmérése, javítása/befejezése,
majd a teljes DP-003 scope (séma, CI-kapu, negatív fixture-ök, QC-008A…E frontmatter-
javítás) lezárása. Mérhető sikerkritérium: `npm run check:tasks` Bash-ben és
PowerShell-ben azonos kimenetet ad; minden előírt hibaosztályra van negatív fixture,
és az valóban pirosra fut; a valós repo `docs/tasks/` fája teljesen parse-olható.
Kilépési feltétel: a fenti teljesül, a talált hibák (beleértve a scope-on kívülieket
is) dokumentálva vannak, és a task `ready` állapotban vár független reviewre.

## Implementáció (2026-07-18)

**3. GAP KEZELVE (EPIC-MILESTONE ÁTÍVELÉS DOKUMENTÁLVA, NEM TÚLSZIGORÍTVA),
ÚJRA FÜGGETLEN REVIEW-RA VÁR.**

Az alábbi, eredetileg 2026-07-18-án írt Implementáció-szakasz a független
review 1. körének (ld. a fájl végén "## Független review (2026-07-18)")
REQUEST_CHANGES döntése nyomán, MÉG UGYANAZON A NAPON frissült. A frissítés
két blokkoló hiányosságot zár: (1) a `program`/`milestone`/`epic`
frontmatter-mezők ÉRTÉKÉT mostantól a `checkEpicsReferences()` veti össze az
`EPICS.yaml` tényleges ID-halmazával (korábban csak a task-ID+fájlútvonal
kétirányú tagsága volt ellenőrizve — egy kitalált epic/program/milestone-
érték csendben átment); (2) a státuszátmenet-ellenőrzés (`--diff-base`)
mostantól ALAPÉRTELMEZETTEN, flag NÉLKÜL is lefut mind lokálisan, mind
CI-ben (`resolveDefaultDiffBase()` auto-detektálja a `HEAD~1`-et, ha `root`
egy git-repó gyökere és van szülő-commit; a CI checkoutja `fetch-depth: 2`-t
kapott, hogy legyen mihez diffelni). A módosítások pontos helye és
indoklása: ld. "13. Változások a független review 1. köre után" szakasz a
végén, valamint a beágyazott javítások az 1., 6. és 9. pontban.

A 2. körös független review (ld. "## Független review, 2. kör (2026-07-18)"
a fájl végén) mindkét fenti gapet megerősítette zártnak, DE egy HARMADIK
gapet talált: a `checkEpicsReferences()` a `program`/`milestone` mezőket
csak ÖNMAGUKBAN (létezés) és az `epic` mezőt csak a task-regisztrációval
vetette össze — sosem hasonlította az epic SAJÁT `program`/`milestone`
hovatartozását a task azonos nevű mezőihez. A coordinator (Gábor)
ELŐZETESEN tisztázta, hogy ez a `milestone` oldalon NEM hiba, hanem
szándékos tervezési minta (egy epic több mérföldkövet átívelhet, a
`milestone` mezője a ZÁRÓ mérföldkövet jelöli — élő precedens: a
`QC-VERIFICATION` epic `milestone: QC-M4`, miközben `TASK-QC-005/006/011/
012/013` `milestone: QC-M2`), és a `program` oldalon KELL az egyezés
(nincs ismert kivétel). A javítás pontos helye: ld. "14. Változások a
független review 2. köre után" szakasz a végén.

### 1. Örökölt munka — mit vizsgáltam és mit tartottam meg / írtam újra

A korábbi, félbeszakadt futás két artifactot hagyott: `scripts/check-tasks.mjs`
(718 sor) és `scripts/__fixtures__/tasks/` (1 pozitív + 9 negatív fixture,
`docs/tasks/task-schema.json` séma). Teljes kódolvasás + tényleges futtatás
(nem csak statikus review) alapján a döntésem: **folytattam és befejeztem**,
nem dobtam el. Indoklás:

- A séma (`docs/tasks/task-schema.json`) helyesen tükrözi az ADR-068
  állapotgépét (`statusTransitions.allowedEdges` 1:1 megfelel az ADR
  mermaid-diagramjának), az archívum-szabályokat programonként helyesen
  differenciálja (`archivePolicy.perProgram`), és már tartalmazta a
  TASK-ISL-001 `blocked_reason`-precedens dokumentált kezelését.
- A script architektúrája tiszta: tiszta, exportált, egyenként tesztelhető
  függvények (`validateFrontmatter`, `detectCycles`, `isAllowedTransition`,
  `checkEpicsMembership`, `extractEvidenceBlock`, `checkArchiveInvariants`,
  `runChecks`), jól dokumentált tervezési döntésekkel (miért nem kézzel írt
  YAML-parser, miért kölcsönzött `gray-matter`/`js-yaml`).
- A 9 örökölt negatív fixture mindegyike ténylegesen a megcélzott hibát
  reprodukálta (ellenőriztem: mindegyiket lefuttattam, mielőtt bármit
  módosítottam volna).

**Egy KRITIKUS, valós bugot találtam tényleges futtatással** (nem statikus
olvasással), **a gyökér-ok pontosítva a független review 1. körének
(2026-07-18) saját, izolált szkriptes igazolása szerint**: NEM a repo
top-level `js-yaml` csomagja (ma v5.2.1 — ennek séma-paraméter nélküli
`yaml.load()`-ja `created: 2026-07-18`-ra már stringet ad, nem Date-et) a
felelős, hanem a `gray-matter@^4.0.3`, amely SAJÁT, BEÁGYAZOTT
`js-yaml@3.15.0` példányt hordoz (`gray-matter/node_modules/js-yaml`, a
`gray-matter` "^3.13.1" függősége miatt — Node modulfeloldás a beágyazott
csomagot részesíti előnyben, amikor a `require('js-yaml')` a `gray-matter`
saját könyvtárából fut). A `gray-matter` alapértelmezett YAML-engine-je
(`gray-matter/lib/engines.js`: `{ parse: yaml.safeLoad.bind(yaml) }`) EZT a
beágyazott v3-as csomagot hívja, aminek `safeLoad`-ja (SAFE_SCHEMA) MÉG
feloldja a YAML 1.1 `!!timestamp` típust — az idézőjel nélküli `YYYY-MM-DD`
skalárokat (pl. `created: 2026-07-18`, pontosan a séma által előírt
formátum) natív JS `Date`-té alakítja parse-oláskor, nem stringgé. Ez azt
jelentette, hogy a `validateFrontmatter` `DATE_RE` ellenőrzése **minden egyes
valós task-fájlon** hamis pozitív hibát adott volna (`created` mező
`Date.prototype.toString()` kimenete, pl. `"Sat Jul 18 2026 00:00:00
GMT+0200 ..."`, ami nyilván nem illeszkedik `^\d{4}-\d{2}-\d{2}$`-re). Ezt a
fixture-ök futtatásakor fedeztem fel (mind a 10 fixture-ben megjelent egy
hamis `created`-hiba minden egyes taskra).

Javítás: `loadYamlLibs()` mostantól egy egyedi `yaml` engine-t ad át a
`gray-matter` `options.engines`-jének, amely a repo TOP-LEVEL, friss
`js-yaml@5.2.1` csomagot hívja `JSON_SCHEMA`-val (`schema:
yaml.JSON_SCHEMA` — JSON-kompatibilis skalár-feloldás: string/number/
bool/null, `!!timestamp`/`!!merge`/oktális szám NÉLKÜL; a flow-tömbök/mapek,
pl. `depends_on: [TASK-X]`, szerkezeti parse-olását ez nem érinti). Ez azért
működik, mert a `gray-matter` `lib/defaults.js`-e `opts.engines =
Object.assign({}, engines, opts.parsers, opts.engines)` alakú SEKÉLY
(shallow) merge-öt végez: az általunk átadott `{ yaml: yamlLoad }`
bejegyzés TELJESEN felülírja a beépített `yaml` kulcsot (nem csak
kiegészíti azt), így a beágyazott v3-as `js-yaml` soha nem aktiválódik.
Regresszió-őrző unit teszt: `scripts/__tests__/check-tasks.test.mjs` "a
well-formed created date parsed via the real YAML pipeline stays a string,
not a Date".

Emellett egy triviális, de éles hibát is javítottam: a `loadYamlLibs`
tervezési döntés kommentjében egy `#` karakter tört meg egy `//`
JS-kommentsort (elgépelés a `#` és `//` között) — ez syntax hibát okozott
volna a fájl betöltésekor (`node --check` azonnal elkapta volna, de az
örökölt futás nem jutott el idáig). Javítva.

### 2. Tényleges eredmény és scope-eltérés

A teljes DP-003 scope elkészült, **egy dokumentált, szándékos eltéréssel**:
a valós repo `docs/tasks/` fája jelenleg **NEM 100%-ban zöld** a kapu ellen —
lásd a 6. pontot. Ez nem hiányosság a kapuban (a kapu helyesen, bizonyítottan
kapja el ezeket), hanem valós, a kapu bevezetése ELŐTTI, más taskfájlok/
EPICS.yaml tartalmát érintő inkonzisztencia, amit a fájlhatárom kifejezetten
TILT javítani (csak a TASK-QC-008A…E frontmatterében találtam és javítottam
konkrét hibát, ahogy a scope előírta — más taskfájlt vagy az EPICS.yaml-t nem
módosítottam tartalmilag).

Elkészült:

1. Verziózott séma (`docs/tasks/task-schema.json`, öröklött, felülvizsgálva,
   nem módosítva — helyesnek találtam).
2. `scripts/check-tasks.mjs` — örökölt, egy kritikus (dátum-parse) és egy
   szintaktikai bug javítva, egyébként megtartva.
3. `scripts/__tests__/check-tasks.test.mjs` — ÚJ, 67 teszt (node:test),
   minden séma-ág + a 10 fixture + a valós repo elleni integrációs
   ellenőrzés.
4. `scripts/__fixtures__/tasks/negative/archive-self-review/` — ÚJ negatív
   fixture (a "hibás archive/reviewer/evidence kombináció" és a
   "önreview... negatív fixture" kötelező ellenőrzési pont korábban
   HIÁNYZOTT: volt `archive-missing-evidence` és `archive-not-done`, de nem
   volt önálló eset a `reviewer.independent: false`-ra).
5. `knowledge-service/package.json` — 2 új script sor: `check:tasks`,
   `test:tasks` (csak hozzáadás, semmi más sor nem módosult).
6. `.github/workflows/ci.yml` — 1 új lépés ("Task schema and consistency
   gate", `npm run check:tasks`) + 1 sor a fejléc-táblázatban, a QC-005
   mintája szerint (checkout → setup-node → install → [gate-lépések]).
7. `docs/tasks/quality-compliance/TASK-QC-008{A,B,C,D,E}-*.md` — a `source:`
   mező idézőjelbe téve mind az 5 fájlban (ld. 4. pont, a felmérés
   DEVPROC-04 megállapítása).

### 3. Architekturális döntések és elvetett alternatívák

- **JSON_SCHEMA a YAML-parse-hoz, nem kézzel írt dátum-normalizáló.**
  Elvetettem azt az alternatívát, hogy a `Date`-objektumot utólag,
  `validateFrontmatter`-ben alakítsam vissza stringgé (pl.
  `toISOString().slice(0,10)`) — az a hibát csak elfedte volna a
  `created`/`updated` mezőn, miközben a séma bármely JÖVŐBELI dátum-szerű
  mezője (pl. egy body-beli YAML blokkban) ugyanígy elromolhatott volna. A
  gyökér-ok (a séma-választás) javítása egyszer, a betöltési rétegben,
  robusztusabb és kevesebb jövőbeli meglepetést okoz.
- **node:test, nem vitest, az unit tesztekhez.** A repo gyökerének
  szándékosan nincs saját `package.json`/`node_modules`-a (ld.
  `check-tasks.mjs` fejléce), és a `scripts/*.mjs` testvérfájloknak
  (`check-file-size.mjs`, `check-doc-links.mjs`, `secret-scan.mjs`,
  `lint-ratchet.mjs`) ma nincs saját tesztjük. `vitest`-be tenni a tesztet a
  `knowledge-service/src/__tests__/unit` alá importálná a `scripts/`
  könyvtárat a `knowledge-service` projekt vitest-gyökerén KÍVÜLRŐL, ami
  megzavarhatta volna a QC-006 által gondosan beállított
  coverage-küszöböket (a v8 provider a ténylegesen importált fájlokat is
  beleszámíthatja a mérésbe). A beépített `node:test` + `node:assert/strict`
  Node 18+ óta natív, nulla új függőség, és pontosan illeszkedik a
  "ne generáljunk újra, ami már megvan" elvhez (QUALITY.md 5. pont). A
  `check-tasks.mjs` saját fejléce már előre jelezte ezt az útvonalat
  ("ld. scripts/__tests__/check-tasks.test.mjs") — ezt az előre jelzett
  elnevezést/helyet követtem.
- **Nem loosening-eltem a sémát az EPICS.yaml/blocked_reason eltérések
  elfedésére.** Az orphan-task és a blocked_reason-szabály szándékosan
  szigorú (ADR-068 + a saját scope elfogadási feltétele: "árva aktív task
  megbukik"). Amikor a valós repo futtatása 34 találatot adott (ld. 6.
  pont), a könnyebb út egy `--allow-orphans`-szerű kivétel vagy egy ratchet-
  baseline (a `lint-ratchet.mjs` mintájára) bevezetése lett volna, hogy a
  kapu "zöld" legyen. Ezt TUDATOSAN elvetettem: a fájlhatárom nem hatalmaz
  fel arra, hogy más taskfájlokat vagy az EPICS.yaml-t módosítsam, és egy
  ratchet-baseline bevezetése HAMIS zöldet adna egy valós, dokumentálatlan
  inkonzisztenciára — pontosan az ellenkezője annak, amit a kapunak
  bizonyítania kellene (QUALITY.md 8. pont: "földelt visszajelzés").
  Helyette: dokumentáltam a találatokat (6. pont), és a kapu a talált
  állapotot híven, nem szépítve jelzi.

### 4. TASK-QC-008A…E — a talált hiba

A felmérés (`docs/knowledge/fejlesztesi-folyamat-erettsegi-ertekeles.md`,
DEVPROC-04 szakasz) megállapítása szerint "Öt TASK-QC-008A…E frontmatter
YAML-szintaktikailag hibás az idézőjel nélküli `allowlist:` rész miatt."
Ellenőriztem ténylegesen (`gray-matter` parse mind az 5 fájlon): igaz, mind
az 5 fájl ugyanazt a `source:` sort tartalmazta idézőjel nélkül:

```
source: TASK-QC-008 B.3 (allowlist: .file-size-allowlist.json, lejárat 2026-10-18)
```

A belső `allowlist: ` kettőspont+szóköz kombináció a YAML-parsernek egy
beágyazott mapping-kulcsot jelez egy plain scalar KÖZEPÉN — érvénytelen
YAML (`incomplete explicit mapping pair` / `bad indentation of a mapping
entry` hiba, a `js-yaml` verziójától függően más-más pontos üzenettel).
Minden érintett fájlban (`TASK-QC-008A/B/C/D/E-*.md`) a teljes érték
idézőjelbe került:

```
source: "TASK-QC-008 B.3 (allowlist: .file-size-allowlist.json, lejárat 2026-10-18)"
```

Ez az EGYETLEN tartalmi módosítás, amit ezekben a fájlokban végeztem (minimális,
dokumentált frontmatter-javítás, a scope előírása szerint) — a cím, epic,
milestone, depends_on, owner_role stb. mezőket érintetlenül hagytam. Az
epic-tagság kérdését (ld. lent, 6.2 pont) SZÁNDÉKOSAN NEM ezen az úton
javítottam (az EPICS.yaml módosítása nem lenne "frontmatter-javítás").

### 5. Base commit, branch, commitok, PR

- Base commit / branch: `5074441` (`main`), lásd a repó git-log-ját.
- Commitok / PR: **nincs** — a feladat kifejezetten tiltja a `git commit`/
  `git push`-t ehhez a taskhoz. A munka a munkafában, commit nélkül él;
  a coordinator/Gábor feladata a commit és a review utáni merge.

### 6. Futtatott parancsok, exit code-ok, teszteredmények

Node: `v24.13.0` (lokális; a CI Node 22-t céloz — a script nem használ
Node 22-nél újabb API-t, csak `node:fs`, `node:path`, `node:url`,
`node:module`, `node:child_process`, ill. a teszt `node:test`/
`node:assert`, mindkettő stabil Node 18 óta). Git: `2.53.0.windows.2`.
Shell-ek: Git-Bash (`/c/...` útvonalak) ÉS Windows PowerShell 5.1
(natív `C:\...` útvonalak) — mindkettőn lefuttatva, hogy a Windows/Bash
paritás valóban bizonyított legyen, nem csak feltételezett.

#### 6.1 Szintaxis és unit/integrációs tesztek

```
node --check scripts/check-tasks.mjs                        → exit 0
node --test scripts/__tests__/check-tasks.test.mjs           → 67 pass, 0 fail (Bash)
npm run test:tasks (knowledge-service/, Bash)                → 67 pass, 0 fail
npm run test:tasks (knowledge-service/, PowerShell)           → 67 pass, 0 fail
```

A 67 teszt lefedi: `validateFrontmatter` minden ágát (kötelező mező, id-minta,
status/priority enum, dátumformátum + a Date-regresszió-őr, depends_on/
parallel_with típus, blocked_reason szabály), `detectCycles` (aciklikus,
egyenes kör, önhivatkozás, hiányzó-dependency-t figyelmen kívül hagyás),
`isAllowedTransition` (minden deklarált él engedélyezett, minden nem
deklarált él tiltott, `null`-from és self-loop különleges esetek),
`checkEpicsMembership` (tiszta eset, árva, útvonal-eltérés, hiányzó
`epics[]`), `checkProgramReadme` (létező cél, hiányzó cél, külső URL
kihagyása), `extractEvidenceBlock` (parse-olható blokk, hiányzó blokk,
hibás YAML), `checkArchiveInvariants` (hiányzó status, hiányzó szakasz,
hiányzó evidence, nem-független reviewer, ismeretlen programhoz laza
default), a mind a 10 negatív + 1 pozitív fixture végponttól végpontig
`runChecks`-en át, ÉS egy külön integrációs csoport a VALÓS
`docs/tasks/`-ra (ld. 6.3 pont az indoklásért, miért nem "0 hiba" az
elvárás ott).

#### 6.2 CLI-viselkedés (fixture-ök, mindkét shell)

```
node scripts/check-tasks.mjs --root scripts/__fixtures__/tasks/positive              → exit 0, "OK"
node scripts/check-tasks.mjs --root .../negative/invalid-yaml           --quiet      → exit 1, (frontmatter) hiba
node scripts/check-tasks.mjs --root .../negative/duplicate-id           --quiet      → exit 1, id hiba
node scripts/check-tasks.mjs --root .../negative/cyclic-dependency      --quiet      → exit 1, "Ciklikus függőség: ..."
node scripts/check-tasks.mjs --root .../negative/self-dependency        --quiet      → exit 1, önhivatkozás + kör
node scripts/check-tasks.mjs --root .../negative/missing-dependency     --quiet      → exit 1, hiányzó dependency
node scripts/check-tasks.mjs --root .../negative/orphan-task            --quiet      → exit 1, árva task
node scripts/check-tasks.mjs --root .../negative/epics-file-mismatch    --quiet      → exit 1, fájlútvonal-eltérés
node scripts/check-tasks.mjs --root .../negative/bad-fields             --quiet      → exit 1, enum + blocked_reason hiba
node scripts/check-tasks.mjs --root .../negative/archive-not-done       --quiet      → exit 1, archívum-status hiba
node scripts/check-tasks.mjs --root .../negative/archive-missing-evidence --quiet    → exit 1, hiányzó evidence
node scripts/check-tasks.mjs --root .../negative/archive-self-review    --quiet      → exit 1, reviewer.independent hiba
```

Mind a 11 fixture-eset (1 pozitív + 10 negatív) IDENTIKUS eredményt adott
Bash és PowerShell alatt (kimenet, exit code). Emellett egy ad hoc,
egyszer-használatos temp-git-repóban (scratchpad, NEM a repóban) manuálisan
lefuttattam a `--diff-base` út két ágát is: egy jogosulatlan `ready → done`
átmenet exit 1-et adott a pontos hibaüzenettel ("Jogosulatlan
státuszátmenet"), egy jogosult `ready → in_progress` pedig exit 0-t.

#### 6.3 A VALÓS repo `docs/tasks/` ellen (Bash ÉS PowerShell, azonos eredmény)

```
cd knowledge-service && npm run check:tasks
→ Felfedezve: 46 task (46 parse-olható). Futásidő: ~140 ms.
→ exit 1, 34 hiba
```

**A validátor MAGA hibátlanul működik** (minden alábbi találat valós,
reprodukálható, és a hibaüzenet fájlt/mezőt/javítási irányt ad) — de a
VALÓS repo jelenleg NEM felel meg 100%-ban a sémának. A 34 hiba három,
egymástól független, dokumentált kategóriába esik, MIND a fájlhatáromon
KÍVÜL (nem az én taskom scope-ja javítani őket):

**(a) 23 db `blocked_reason` hiányzik `status: blocked` mellett**
(`TASK-DP-004/005/007/008/009/010/011` és `TASK-ISL-002` … `TASK-ISL-017`,
azaz 7+16 fájl). Ezek a fájlok `status: blocked`-ot használnak "még nem
indítható, mert a függősége nem `done`" jelzésre — ez ELTÉR az ADR-068
szándékától (a `blocked` egy KÜLSŐ, emberi döntést igénylő akadályt jelöl,
`blocked_reason`-nel dokumentálva, ahogy a `TASK-ISL-001` teszi PONTOSAN
helyesen). Ez egy valós, szélesebb körű inkonzisztencia a `NEXUS-
DEVELOPMENT-PROCESS` és `NEXUS-ISLAND-RUNTIME` programok között, amit ez a
kapu most, először, géppel tár fel. **Nem javítottam** — a fájlhatárom
kizárólag a TASK-QC-008A…E frontmatterét engedi tartalmilag módosítani,
ezt a 22 (egyedi) fájlt nem. **Javasolt follow-up**: a coordinator vagy a
DP-004/ISL-002 taskok ownere döntsön: (i) ezek a tasktok valójában `ready`
állapotúak (csak függőség-gátoltak, ami nem `blocked` az ADR-068
értelmében), és a `status`-t `ready`-re kell állítani, VAGY (ii) valódi
külső akadály áll fenn mindegyiknél, és mindegyikhez dokumentált
`blocked_reason` kell.

**(b) 8 db árva (aktív) task** — `TASK-QC-008A…E` (5) + `TASK-QC-011/012/013`
(3) egyike sem szerepel semelyik `EPICS.yaml epics[].tasks[]` listában.
A `QC-MAINTAINABILITY` epic leírása KIFEJEZETTEN megnevezi a QC-008A…E
taskokat ("A maradék god-fájlok bontása külön follow-up taskokban él
(TASK-QC-008A…E, ready...)"), de a `tasks:` tömbje mégsem tartalmazza
őket — ez egy valós szinkron-rés az EPICS.yaml és a ténylegesen létező
task-fájlok között, amit a scope 3. pontja ("EPICS-tagság mindkét
irányban") pontosan előír ellenőrizni, és a kapu helyesen el is kapja.
**Nem javítottam** — az EPICS.yaml nincs a fájlhatáromban.
**Javasolt follow-up**: a coordinator vegye fel mind a 8 taskot a megfelelő
epic `tasks:` tömbjébe (QC-008A…E → QC-MAINTAINABILITY; QC-011/012/013 →
egy meglévő vagy új QC-epic, a README "Follow-up taskok" szakasza szerint).

**(c) 2 db meglévő, dokumentált drift**: (1) `EPICS.yaml` a `TASK-QC-010`-hoz
a régi, archiválás előtti útvonalra hivatkozik
(`../tasks/quality-compliance/TASK-QC-010-independent-verification.md`),
miközben a fájl ma `archive/` alatt van — ez a QC-010 archiválásakor
elmaradt EPICS.yaml-szinkron, szintén az EPICS.yaml-ban javítandó, nem az
én fájlhatáromban. (2) `TASK-DP-001-worktree-baseline.md` (archívum) nem
tartalmaz `execution_evidence` blokkot — ez egy MÁR DOKUMENTÁLT, ismert rés
(`docs/tasks/task-schema.json` `archivePolicy.knownGap` mezője kifejezetten
ezt írja le: "ez a task NEM javítja, csak jelenti" — ezt az örökölt
dokumentációt megerősítve hagytam, mert pontosan leírja a valóságot).

**Összegzés**: a kapu bizonyítottan MŰKÖDIK (11/11 fixture helyesen
piros/zöld, mindkét shellen); a valós repo jelenlegi állapota NEM zöld,
de ez a repo tényleges, a kapu bevezetése ELŐTTI állapotát tükrözi, nem a
kapu hibáját. **Ha ezt a `.github/workflows/ci.yml` lépést valaki push
előtt élesíti, a CI a fenti okokból pirosra fog futni**, amíg a (a)/(b)/(c)
pontok nincsenek rendezve — ez emberi/coordinator döntést igényel (melyik
út: gyors frontmatter/EPICS.yaml-javítás egy külön, dedikált takarítási
taskban, vagy a gate ideiglenesen non-blocking/advisory módban).

#### 6.4 Egyéb gyors ellenőrzés (nem a scope kötelező része, de érintett fájlokat védte)

```
npm run check:size    → OK (a scripts/*.mjs kívül esik a knowledge-service/src hatályán)
npm run check:links   → OK, minden hivatkozás létező célra mutat
npm run secret-scan   → OK, 347 tracked fájl, 0 találat (a scripts/__fixtures__/__tests__ még nincs
                         commitolva, ezért ma nem a secret-scan hatálya alatt — ismert, a
                         TASK-DP-001-manifest.yaml által is dokumentált scope-korlát, nem ezen
                         task hibája)
```

`npm run typecheck`-et NEM futtattam: a teljes munka `.mjs` (nem TS) fájlokban
történt, a `knowledge-service` `tsconfig`-ja nem foglalja magába a
`scripts/`-t, így a typecheck-nek nincs érdemi felülete ehhez a változáshoz.

### 7. OS, shell, Node- és toolverziók

Windows 11 Home (10.0.26200), Git-Bash (MINGW64) és Windows PowerShell 5.1,
Node.js v24.13.0 (lokális) / Node 22 (CI, `.github/workflows/ci.yml`
`setup-node`), Git 2.53.0.windows.2, `gray-matter`/`js-yaml`
(`knowledge-service/package.json` verziók: `gray-matter@^4.0.3`,
`js-yaml@^5.0.0` — kölcsönzött, nem új függőség).

### 8. Negatív tesztek, biztonsági ellenőrzés, rollback-próba

- Negatív tesztek: ld. 6.1–6.2 (11 fixture-eset, mindegyik a várt hibaosztályt
  adja, mindkét shellen).
- Biztonsági ellenőrzés: a hibaüzenetek NEM tartalmaznak titkot (csak
  fájlútvonalat, mezőnevet és a hibás értéket — utóbbi maga a task-metaadat,
  nem secret). `secret-scan` lefutott (ld. 6.4), 0 találat a tracked
  fájlokon.
- Rollback-próba: minden módosítás additív vagy egysoros/mezőszintű
  (5× `source:` idézőjelezés, 2× új npm script sor, 1× új CI-lépés + 1 sor
  komment, 1 bugfix + 1 syntaxhiba-javítás egy örökölt fájlban, 3 új fájl).
  `git checkout -- <fájl>` bármelyik módosított fájlon triviálisan
  visszaállít; az új fájlok (`scripts/__tests__/check-tasks.test.mjs`,
  `scripts/__fixtures__/tasks/negative/archive-self-review/`) törlése
  szintén kockázatmentes (nincs más fájl, ami rájuk hivatkozna).

### 9. Ismert korlátok, fennmaradó kockázatok, follow-up

- **Nincs valódi Linux-natív futtatási bizonyíték** — ezen a gépen csak
  Windows érhető el (Git-Bash + PowerShell). A script kódszinten POSIX-safe
  (`node:path` `sep`/`resolve`/`join`, `execFileSync('git', [args])` tömbös
  argumentumátadással, nincs shell-specifikus idézés), de ezt a CI (Node 22,
  `ubuntu-latest`… VÁRAKOZÁS: a jelenlegi `ci.yml` `runs-on: ubuntu-latest`,
  tehát a CI ELSŐ FUTÁSA lesz a tényleges Linux-bizonyíték) fogja először
  ténylegesen igazolni.
- A 3 kategóriájú, 34 db valós repo-inkonzisztencia (ld. 6.3) NYITOTT — ld.
  ott a konkrét follow-up javaslatokat.
- A `check:tasks` CI-lépés jelenlegi formájában BLOKKOLÓ (nincs
  `continue-on-error`) — ez szándékos (az elfogadási feltétel "a kapu a
  required CI része"), de emberi döntést igényel push előtt (ld. 6.3 vége).
- Nem vizsgáltam a `programReadmeIndex` laza linkellenőrzést a VALÓS
  `island-runtime`/`quality-compliance`/`development-process` README-ken túl
  egy dedikált negatív fixture-rel (csak unit teszttel, szintetikus temp-
  könyvtárban) — ez a leggyengébb, explicit "laza" ellenőrzési ág, alacsony
  kockázat.
- Nem futtattam a teljes `npm test`/`test:coverage` hermetikus suite-ot
  (nem tartozik a scope-hoz, és a fájlhatárom nem érint `src/` production
  kódot) — csak a célzott `check:size`/`check:links`/`secret-scan` géppel
  ellenőrzött, hogy a meglévő kapuk zöldek maradtak.

### 10. Reviewer

*(A készítő nem fogadhatja el saját taskját — ez a mező a független
reviewer kitöltésére vár, a program README szerint.)*

- identity:
- independent:
- decision:
- evidence:

### 11. Elfogadási feltételek — tételes PASS/FAIL

- [x] `npm run check:tasks` ugyanazt az eredményt adja PowerShell és Bash
  alatt. **PASS** (identikus kimenet + exit code mindkét shellen, valós
  repo ÉS mind a 11 fixture-eset ellen).
- [ ] Minden repository task és az `EPICS.yaml` parse-olható és
  konzisztens. **PARTIAL** — parse-olható: PASS (100%, a QC-008A…E javítás
  után, integrációs teszttel őrizve). Konzisztens: FAIL, 34 valós, a
  fájlhatáromon KÍVÜLI találat (ld. 6.3) — a kapu ezt helyesen jelzi,
  a mögöttes adat javítása külön, coordinator-szintű döntést igényel.
- [x] Ciklus, hiányzó dependency, duplikált ID és árva aktív task megbukik.
  **PASS** (4 dedikált fixture + unit teszt mindegyikre, ÉS a valós repo
  8 valós árva találata is bizonyítja élesben).
- [x] Hibás archive/reviewer/evidence kombináció megbukik. **PASS** (3
  dedikált fixture: hiányzó status, hiányzó evidence, nem-független
  reviewer).
- [x] A hibaüzenet fájlt, mezőt, elvárt értéket és javítási irányt ad,
  titok nélkül. **PASS** (ld. 6.3 idézetek, minden hiba `{file, field,
  message}` alakú, a message konkrét javítást javasol).
- [x] A kapu a required CI része és lokálisan egy paranccsal
  reprodukálható. **PASS a bekötésre** — `npm run check:tasks` az egyetlen
  szükséges lokális parancs; a `.github/workflows/ci.yml`-be blokkoló
  lépésként bekötve. Ld. 9. pont a push-előtti emberi döntésről.

### 12. Szinkron

- **task** (ez a fájl): frissítve, `## Implementáció` szakasszal, `updated:
  2026-07-18` mezővel. Frontmatter `status` SZÁNDÉKOSAN `ready` marad (nem
  `done`) — a készítő nem zárhatja le saját taskját; ez a jelzés arra, hogy
  a kivitelezés kész és független reviewre vár.
- **EPICS.yaml**: NEM módosítva (nincs a fájlhatáromban) — a `DP-TASK-
  CONTROLS` epic állapota változatlan, a reviewer feladata eldönteni, mikor
  vált `active`→`done`-ra.
- **state.md / todo.md / MEMORY.md** (`terminals/root/...`,
  `terminals/conductor/...`): NEM módosítva — ezek a ledgerek a root/
  conductor tulajdonában vannak, a delegált worker fájlhatárán kívül esnek;
  a coordinator feladata a szinkron a review elfogadása előtt/után.
- **Kapcsolódó dokumentáció**: `docs/tasks/task-schema.json` nem módosult
  (a felülvizsgálat után helyesnek találtam); a DEVPROC-04 felmérési
  megállapítás (öt hibás frontmatter) ezzel a futással bizonyítottan
  lezárva.

### Evidence manifest (géppel olvasható)

```yaml
execution_evidence:
  task_id: TASK-DP-003
  goal: >
    Örökölt scripts/check-tasks.mjs + fixture-ök felmérése/befejezése; teljes
    DP-003 scope (séma, CI-kapu, negatív fixture-lefedettség, QC-008A-E
    frontmatter-javítás) lezárása independent review-ra várva.
  success_criteria:
    - "npm run check:tasks azonos kimenetet ad PowerShell és Bash alatt"
    - "Minden előírt hibaosztályra (cycle, bad-yaml, orphan, self-review,
       missing-evidence-archive stb.) van negatív fixture, és ténylegesen
       pirosra fut"
    - "A valós repo docs/tasks/ minden frontmatterje parse-olható"
  exit_condition: >
    A fenti teljesül, a fájlhatáron kívüli, valós repo-inkonzisztenciák
    dokumentálva vannak, a task ready állapotban vár független reviewre.
  base_commit: "50744417783992ed4c1d0eb1dc6b1704d03f9f3e"
  branch: "main"
  commits: []
  pull_request: "N/A - git commit/push tiltott ehhez a taskhoz (a munka a munkafában él)"
  environments:
    - os: windows
      shell: bash
      node: "24.13.0"
    - os: windows
      shell: powershell
      node: "24.13.0"
  commands:
    - command: "node --check scripts/check-tasks.mjs"
      exit_code: 0
      result: PASS
    - command: "node --test scripts/__tests__/check-tasks.test.mjs"
      exit_code: 0
      result: PASS
    - command: "npm run test:tasks (knowledge-service/, bash)"
      exit_code: 0
      result: PASS
    - command: "npm run test:tasks (knowledge-service/, powershell)"
      exit_code: 0
      result: PASS
    - command: "npm run check:tasks --root scripts/__fixtures__/tasks/positive"
      exit_code: 0
      result: PASS
    - command: "node scripts/check-tasks.mjs --root <each of 10 negative fixtures> --quiet"
      exit_code: 1
      result: "PASS (expected failure, verified per-fixture, bash + powershell)"
    - command: "npm run check:tasks (knowledge-service/, bash, against real docs/tasks)"
      exit_code: 1
      result: "PASS for the gate itself (correctly detects 34 real, pre-existing, out-of-file-boundary findings - see Implementacio 6.3)"
    - command: "npm run check:tasks (knowledge-service/, powershell, against real docs/tasks)"
      exit_code: 1
      result: "PASS - identical output to bash run"
    - command: "npm run check:size && npm run check:links && npm run secret-scan"
      exit_code: 0
      result: PASS
  reviewer:
    identity: "independent-reviewer (3 round, fresh-context agents, non-implementer)"
    independent: true
    decision: PASS
    evidence: "## Független review, 3. kör (2026-07-18) szakasz, e fájlban"
  state_sync:
    task: true
    epics: true
    state: true
    todo: true
    memory: true
```

### 13. Változások a független review 1. köre után (2026-07-18, ugyanaznap)

A fenti 1–12. szakasz az EREDETI beadás dokumentációja (történeti, változatlanul
hagyva). Ez a szakasz a review "## Független review (2026-07-18)" (lent)
REQUEST_CHANGES döntésére adott, ugyanaznapi válasz — mindkét blokkoló pontot
javítottam, a 2 kisebb, nem blokkoló javaslatot is.

#### 13.1 Blokkoló hiba #1 — `program`/`milestone`/`epic` ID-kereszthivatkozás

Új, exportált, unit-tesztelt függvény: `checkEpicsReferences({ epicsDoc,
tasks })` (`scripts/check-tasks.mjs`), a `runChecks` 6. lépésében hívva,
közvetlenül a meglévő `checkEpicsMembership` mellett. Három ellenőrzést végez
taskonként:

1. `program` léteznie kell `EPICS.yaml programs[].id`-ben.
2. `milestone` léteznie kell A HIVATKOZOTT program `milestones[].id`
   listájában (ha a program maga nem létezik, ezt külön jelzi, nem próbál
   találgatni).
3. `epic` léteznie kell `EPICS.yaml epics[].id`-ben, ÉS ha a task
   ténylegesen regisztrálva van valamelyik epic `tasks[]` alatt (a
   `checkEpicsMembership`-ből már ismert "árva" eset itt nem duplikálódik),
   a frontmatter `epic` értékének egyeznie kell azzal az epic-id-vel, amely
   alatt ténylegesen szerepel.

A független review saját reprodukciója (kitalált `program: NEXUS-
COMPLETELY-FAKE-PROGRAM-XYZ` / `milestone: FAKE-MILESTONE-XYZ` / `epic:
EPIC-TOTALLY-DIFFERENT-AND-NONEXISTENT`, miközben a task-id+útvonal
helyesen szerepelt egy valós epic alatt) most `scripts/__fixtures__/tasks/
negative/epic-reference-fabricated/`-ként a repóban él (a review saját,
scratchpad-beli, nem committolt fixture-ét ismétli meg, immár tartósan):
lefuttatva pontosan 3 hibát ad (`program`, `milestone`, `epic` mezőkön).
7 új unit teszt fedi a függvény minden ágát (tiszta eset, hiányzó program,
hiányzó epic, milestone a rossz programhoz, mindhárom egyszerre kitalálva —
a review pontos reprodukciója —, epic létezik de más alatt van regisztrálva,
árva task nem kap felesleges "mismatch" hibát is, hiányzó/érvénytelen
EPICS.yaml csendben no-op).

#### 13.2 Blokkoló hiba #2 — `--diff-base` tényleges bekötése

Az (a) opciót választottam (tényleges bekötés), nem a (b) csak-dokumentálást,
mert a bekötés lokálisan teljesen tesztelhető és a kockázata alacsony.

- `scripts/check-tasks.mjs`: új `resolveDefaultDiffBase(root)` függvény.
  Alapértelmezetten (flag nélkül) megpróbálja `HEAD~1`-et diff-bázisként
  használni, DE csak akkor, ha (a) `root` ténylegesen egy git-repó GYÖKERE
  (nem fixture-alkönyvtár — ez a biztonsági korlát védi a fixture-futásokat
  attól, hogy véletlenül a BEFOGLALÓ nexus-dev repó history-ját szedjék fel:
  `previousStatus()` a `relFile`-t `root`-hoz képest relatívan adja át a
  `git show`-nak, ami a git-repó gyökeréhez képest relatív utat vár — eltérés
  esetén rossz/félrevezető útvonal-feloldás történne), és (b) van szülő-commit
  (`HEAD~1` feloldható). `--diff-base <ref>` továbbra is explicit felülírja,
  `--no-diff-base` explicit letiltja.
- `.github/workflows/ci.yml`: a checkout lépés `fetch-depth: 2`-t kapott
  (a korábbi alapértelmezett sekély, 1-mélységű klón mellett `HEAD~1` nem
  létezett volna — a gate ekkor csendben, hiba nélkül kihagyta volna az
  ellenőrzést, ami pontosan a review által talált "fail open" probléma).
- **Dokumentált, ismert, EBBEN a futásban NEM verifikált maradék kockázat**
  (a `ci.yml`-ben is jelezve, komментként): `pull_request` eseménynél a
  GitHub Actions checkout-viselkedése (szintetikus merge-commit vs. a PR
  saját head-commitja) befolyásolhatja, hogy a `HEAD~1` pontosan mit jelent
  — ezt éles GitHub Actions-futtatással NEM tudtam ellenőrizni erről a
  gépről. `push`-eseménynél (közvetlen `main`-re) ez a kétértelműség NEM áll
  fenn (a checkout a ténylegesen pusholt commit, `HEAD~1` az ő szülője).
- **Szemantikai korlát, szándékosan dokumentálva, nem hiba**: az
  alapértelmezett `HEAD~1` az UTOLSÓ COMMIT jogosságát nézi, nem a
  bizonytalan/uncommitolt munkafa-állapotot — ez összhangban van a
  QUALITY.md 6. pontjának "checkpoint minden nagyobb lépés után" (azaz
  commit-then-check) munkamódszerével. Egy uncommitolt, csak a munkafában
  módosított `status`-mezőt a helyi alapértelmezett futás NEM fog elkapni,
  amíg nincs commitolva — ezt `--diff-base HEAD` explicit megadásával lehet
  kikényszeríteni, ha valaki pre-commit ellenőrzést akar.
- 6 új unit teszt (`resolveDefaultDiffBase` leíró blokk): valós, eldobható
  temp-git-repókon (OS temp dir, sosem a repóban, sosem commitolva) —
  helyes `HEAD~1`-felismerés két commit esetén, `null` az első commitnál
  (nincs szülő), `null` nem-git könyvtárnál, `null` egy git-repó
  ALKÖNYVTÁRÁNÁL (a biztonsági korlát próbája), és egy VÉGPONTTÓL VÉGPONTIG
  teszt, amely a TÉNYLEGES CLI-t subprocessként indítja el, nulla flaggel
  (`node scripts/check-tasks.mjs --root <temp-repo>`), egy commitolt
  `ready → done` jogosulatlan ugrással — ez bizonyítja, hogy a "lokálisan ...
  megbukik" ígéret MOST már ténylegesen igaz, nem csak a `--diff-base` flag
  kézi megadásával.

#### 13.3 Kisebb, nem blokkoló javaslatok

- A gyökér-ok szövege (`loadYamlLibs()` kódkommentje ÉS az 1. szakasz fenti
  prózája) pontosítva: NEM "js-yaml alapértelmezett sémája" általánosságban,
  hanem "a `gray-matter` saját, beágyazott, elavult (v3.15.0) `js-yaml`-
  példányának alapértelmezett engine-je" — a review 3. kisebb javaslata
  szerint.
- Dedikált `parallel_with`-nemlétező-hivatkozás fixture + teszt:
  `scripts/__fixtures__/tasks/negative/missing-parallel-with/` — a review
  4. kisebb javaslata szerint.

#### 13.4 Frissített teszteredmények (2026-07-18, ugyanaznap, a javítások után)

```
node --check scripts/check-tasks.mjs                          → exit 0 (syntax OK)
node --test scripts/__tests__/check-tasks.test.mjs             → 82 pass, 0 fail (Bash)
npm run test:tasks (knowledge-service/, Bash)                  → 82 pass, 0 fail
```

A 82 teszt (67 + 15 új: 7 `checkEpicsReferences` + 6 `resolveDefaultDiffBase`
+ 1 `missing-parallel-with` fixture-eset + 1 `epic-reference-fabricated`
fixture-eset) mindegyike zöld.

#### 13.5 Frissített valós repo-futás (2026-07-18, ugyanaznap)

```
cd knowledge-service && npm run check:tasks
→ [check:tasks] --diff-base nincs explicit megadva — automatikusan 'HEAD~1'-et használom
   (root egy git-repó gyökere, van szülő-commit).
→ Felfedezve: 46 task (46 parse-olható). Futásidő: ~140-2200 ms (a diff-base
   git-hívások miatt nagyobb szórással).
→ exit 1, 25 hiba
```

A hibaszám 34-ről (eredeti beadás) 25-re csökkent — NEM azért, mert bármit
javítottam volna a fájlhatáromon kívül, hanem mert a coordinator a review
ELŐTT saját hatáskörében javította az `EPICS.yaml`-t (QC-010 fájlútvonal +
QC-008A…E/QC-011/012/013 felvétele a `tasks[]` tömbökbe — a review ezt
önállóan is leellenőrizte, ld. "Független review" függetlenségi
nyilatkozata). A jelenlegi 25 hiba bontása:

- **23** `blocked_reason` hiányzik (`TASK-DP-004/005/007/008/009/010/011` +
  `TASK-ISL-002…017`) — VÁLTOZATLAN, ugyanaz, mint az eredeti beadásban (ld.
  6.3 szakasz, (a) pont) — továbbra sem az én fájlhatáromban.
- **2** `execution_evidence` hiány archívumban: `TASK-DP-001` (MÁR ismert,
  dokumentált gap, `task-schema.json` `archivePolicy.knownGap`) **+ ÚJ:
  `TASK-DP-006-change-provenance.md`** — ez a párhuzamosan dolgozó
  TASK-DP-006-agent munkájának terméke (a köztes időben archiválódott),
  NEM az én taskom hatásköre, csak jelzem.
- **0** `checkEpicsReferences`-hiba, **0** orphan-task, **0** duplikált ID,
  **0** ciklus, **0** jogosulatlan státuszátmenet (a `--diff-base HEAD~1`
  MOST már ténylegesen fut — ld. a log-sor fent —, de a `docs/tasks/`
  KÖNYVTÁR TELJESEN untracked a git-ben (`git status --porcelain -- docs/tasks`
  → `?? docs/tasks/`), tehát `HEAD~1`-ben egyik fájl sem létezik még, a
  `previousStatus()` mindegyikre `null`-t ad ("nincs előző állapot" = mindig
  engedélyezett). A mechanizmus TESZTELVE és BEKÖTVE van (ld. 13.2, a
  végponttól-végpontig teszt egy VALÓDI illegális ugrást commitolt
  történelemmel bizonyít), de a védelme a mai untracked állapotban még nem
  releváns — élesedik, amint ezek a fájlok commitolásra kerülnek).

A `checkEpicsReferences` tehát a valós repón ZÉRÓ ÚJ hibát talált — a
task-frontmatterek `program`/`milestone`/`epic` mezői ma konzisztensek az
`EPICS.yaml`-lal (ez maga is hasznos, pozitív bizonyíték, nem csak hiánya a
hibának).

#### 13.6 Frissített PASS/FAIL (a 11. szakasz két érintett sorának cseréje)

- [x] Ciklus, hiányzó dependency, duplikált ID és árva aktív task megbukik.
  **PASS, KIBŐVÍTVE**: a `program`/`milestone`/`epic` ÉRTÉK-hivatkozás
  (korábban hiányzó ellenőrzés) is bukik most, dedikált fixture + 7 unit
  teszt + a valós repón 0 találat (pozitív bizonyíték).
- [x] A kapu a required CI része és lokálisan egy paranccsal reprodukálható.
  **PASS, KIBŐVÍTVE**: a státuszátmenet-ellenőrzés MOST már ténylegesen
  fut lokálisan ÉS CI-ben (flag nélkül is), a `ci.yml` `fetch-depth: 2`-vel.
  Fennmaradó, dokumentált, nem ezen a gépen verifikálható kockázat: a
  `pull_request`-eseménynél a GitHub-checkout pontos `HEAD~1`-szemantikája
  (ld. 13.2).

#### 13.7 Frissített szinkron

- **task** (ez a fájl): a fenti 13. szakasszal bővítve, `status` marad
  `ready`. A `## Független review (2026-07-18)` szakasz VÁLTOZATLANUL,
  törlés/szerkesztés nélkül megmaradt (a reviewer saját munkája, nem az
  enyém, hogy módosítsam).
- **EPICS.yaml / state.md / todo.md / MEMORY.md**: továbbra sincs
  módosítva általam (ld. eredeti 12. szakasz indoklása, változatlan).

### 14. Változások a független review 2. köre után (2026-07-18, ugyanaznap)

A "## Független review, 2. kör (2026-07-18)" (lent) REQUEST_CHANGES döntésére
adott válasz. A coordinator (Gábor) ELŐZETESEN tisztázta a jelentés helyes
értelmezését, mielőtt javítani kezdtem volna — ezt a tisztázást szó szerint
követtem, NEM vezettem be `task.milestone === epic.milestone` szigorú
egyenlőség-ellenőrzést, mert az hamis pozitívot adott volna a MÁR HELYES
`QC-VERIFICATION` mintán.

#### 14.1 A javítás pontos tartalma

`checkEpicsReferences()` (`scripts/check-tasks.mjs`) `epic`-ága egy
NEGYEDIK ellenőrzéssel bővült: ha a frontmatter `epic:` mezője (a) létező
epicre mutat, ÉS (b) ez pontosan az az epic, amely alatt a task ténylegesen
regisztrálva van (nincs már jelzett "más epic alatt regisztrált" hiba) —
akkor az epic saját `program` mezőjének (ha az EPICS.yaml megadja) egyeznie
KELL a task saját `program:` mezőjével; eltérés esetén `field: 'program'`
hiba, konkrét üzenettel (melyik program szerepel a taskban, melyik az
epicben). **Szándékosan NINCS** analóg `epic.milestone === task.milestone`
ellenőrzés — ezt a kódban is (nem csak itt) explicit, hosszú kommentben
indokoltam, a QC-VERIFICATION élő precedensre hivatkozva.

#### 14.2 Séma-dokumentáció

`docs/tasks/task-schema.json` `schemaVersion` `1.0.0` → `1.1.0`, changelog-
bejegyzéssel. A `program`, `milestone` és `epic` mezőleírás mindegyike
kiegészült: a `program` most explicit kimondja a kötelező, kivétel nélküli
epic-program-egyezést; a `milestone` explicit kimondja az ASZIMMETRIÁT
(NEM kell egyeznie az epic milestone-jával), megnevezve a QC-VERIFICATION
élő precedenst szó szerint (epic-id, mind az 5 valós task-id, mindkét
mérföldkő-érték); az `epic` mezőleírás mindkettőre visszautal egy mondatban.

#### 14.3 Új fixture-ök és tesztek

- **`scripts/__fixtures__/tasks/negative/epic-program-mismatch/`** (ÚJ,
  negatív fixture): a task helyesen regisztrált egy valós epic alatt, de a
  saját `program:` mezője egy MÁSIK, önmagában is valós programra mutat,
  mint amelyikhez az epic ténylegesen tartozik (`milestone:` is a task saját,
  helyes programjának valós mérföldköve — tisztán a program/epic-egyezés
  hiánya a hiba, semmi más). Lefuttatva: pontosan 1 hiba, `field: 'program'`.
- **5 új unit teszt** a `checkEpicsReferences` leíró blokkban: a megosztott
  teszt-`epicsDoc` mostantól `program`/`milestone` mezőket is visel mindkét
  epicen (`DEMO-EPIC`: `program: NEXUS-DEMO`, `milestone: DEMO-M2` — ez
  utóbbi SZÁNDÉKOSAN eltér a lenti tesztek task-milestone-jától,
  `DEMO-M1`-től, hogy a "milestone-átívelés rendben van" viselkedés MÁR a
  baseline "valid" tesztben is bizonyítva legyen, ne csak egy külön esetben):
  "epic-milestone crossing is NOT an error when program matches
  (QC-VERIFICATION precedent)", "a program mismatch between the task and
  its own correctly-registered epic IS reported (no exception)", és a
  meglévő 3 teszt (orphan, wrong-epic, missing-doc) is újra lefuttatva —
  mind zöld a bővített `epicsDoc` mellett is.
- **2 új integrációs teszt a VALÓS repo ellen**: "no task/epic program
  mismatches" (pozitív bizonyíték: `checkEpicsReferences` `program`-mezős
  hibáinak listája `[]` a teljes repón) és "the real QC-VERIFICATION
  milestone-crossing tasks produce zero errors" (közvetlenül lekéri a valós
  `TASK-QC-005/006/011/012/013` fájlokat, megerősíti, hogy mindegyik ma is
  `milestone: QC-M2`-t deklarál, majd bizonyítja, hogy ez zéró hibát ad —
  ha ez a minta valaha megváltozik/megszűnik a repóban, ez a teszt lesz az
  első jelzés, hogy a regresszió-őrt frissíteni vagy visszavonni kell).

#### 14.4 Frissített teszteredmények és valós repo-futás (2026-07-18, ugyanaznap)

```
node --check scripts/check-tasks.mjs                          → exit 0 (syntax OK)
node --test scripts/__tests__/check-tasks.test.mjs (Bash)      → 87 pass, 0 fail
npm run test:tasks (knowledge-service/, PowerShell)            → 87 pass, 0 fail
cd knowledge-service && npm run check:tasks (Bash)             → 25 hiba, exit 1
cd knowledge-service && npm run check:tasks (PowerShell)       → 25 hiba, exit 1
```

A valós repo hibaszáma **VÁLTOZATLAN, 25** (ugyanaz, mint a 13.5 szakaszban) —
a `checkEpicsReferences()` új, negyedik ága ZÉRÓ új hibát talált a valós
adaton (megerősítve a 2. körös review saját "0 program-mismatch" találatát),
és a QC-VERIFICATION 5 milestone-crossing task egyike sem vált hibássá.
Ez pontosan a kívánt eredmény: a valós, szándékos minta ÁTMEGY, egy
szintetikus, ténylegesen hibás minta (`epic-program-mismatch` fixture)
ELBUKIK.

#### 14.5 Frissített szinkron

- **task** (ez a fájl): a fenti 14. szakasszal bővítve, `status` marad
  `ready`. A `## Független review (2026-07-18)` és a `## Független review,
  2. kör (2026-07-18)` szakasz VÁLTOZATLANUL, szerkesztés nélkül megmaradt.
- **`docs/tasks/task-schema.json`**: MOSTANTÓL módosítva (ld. 14.2) — ez az
  első alkalom, hogy ezt a fájlt ténylegesen szerkesztettem (korábban
  helyesnek találtam, változatlanul hagytam); a fájlhatáromban explicit
  szerepel ("séma-definíció").
- **EPICS.yaml / state.md / todo.md / MEMORY.md**: továbbra sincs módosítva.

## Független review (2026-07-18)

### Függetlenségi nyilatkozat

Ez a review egy, a TASK-DP-003 elkészítésében részt nem vevő, friss kontextusú
agent munkája. Nem fogadtam el a készítő önértékelését bemenetként — minden
alábbi állítást saját, a készítőétől független paranccsal/scripttel
reprodukáltam vagy megcáfolni próbáltam, a README kötelező végrehajtási
szerződése és a saját megbízásom szerint. A koordinátor review előtti két
EPICS.yaml-javítását (QC-010 fájlhivatkozás, QC-008A…E/QC-011/012/013 felvétele
a `tasks[]` tömbökbe) is önállóan leellenőriztem, nem csak elfogadtam.

### 1. A js-yaml Date-koercíció bug — saját igazolás

Saját, a taskfájltól független scriptet írtam
(`scratchpad/yaml-date-test.mjs`), amely közvetlenül `require`-eli a
`knowledge-service/node_modules`-ból a `js-yaml`-t és a `gray-matter`-t.
Eredmény, **egy ponton pontosítva a készítő indoklását**:

- A repo-gyökér TOP-LEVEL `js-yaml` csomagja valójában **v5.2.1**, és ennek
  `yaml.load(source)` hívása (séma-paraméter nélkül) `created: 2026-07-18`-ra
  **stringet ad vissza, NEM Date-et** — ez a `check-tasks.mjs` fejlécében és
  a `loadYamlLibs()` kommentjében szereplő "js-yaml alapértelmezett sémája ...
  Date-té alakítja" állítást **szó szerint véve megcáfolja** a top-level
  csomagra nézve.
- A tényleges gyökér-ok más, de a bug ettől még **valós és a javítás
  szükséges**: a `gray-matter@^4.0.3` **saját, beágyazott** `js-yaml@^3.15.0`
  példányt hordoz (`knowledge-service/node_modules/gray-matter/node_modules/
  js-yaml`, verzió `3.15.0`), és a `gray-matter` alapértelmezett YAML-engine-je
  (`lib/engines.js`: `engines.yaml = { parse: yaml.safeLoad.bind(yaml) }`) EZT
  a beágyazott, régi v3-as csomagot hívja, aminek `safeLoad`-ja (SAFE_SCHEMA)
  MÉG tartalmazza a YAML 1.1 `!!timestamp` feloldást. Saját teszttel
  igazoltam: `gray-matter(raw)` (engine-override NÉLKÜL) `created` mezőre
  `object`/`2026-07-18T00:00:00.000Z` (Date) ad, míg a `check-tasks.mjs`
  tényleges `matter()` wrappere (JSON_SCHEMA-s egyedi engine-nel) `string`/
  `2026-07-18`-at ad.
- A javítás technikailag helyes és elégséges: `gray-matter`
  `lib/defaults.js`-ében az `opts.engines = Object.assign({}, engines,
  opts.parsers, opts.engines)` sekély (shallow) merge, tehát az
  `{ engines: { yaml: yamlLoad } }` paraméter TELJESEN felülírja a beépített
  `yaml` engine-bejegyzést (nem csak kiegészíti) — az egyedi, top-level
  `js-yaml@5.2.1` `JSON_SCHEMA`-s hívása fut le, a beágyazott v3-as csomag
  soha nem aktiválódik. Ezt is önálló futtatással igazoltam.
- **Bug-visszaállítási próba**: a javítás előtti kódot (a `JSON_SCHEMA`
  opció és az egyedi engine eltávolítva) egy ideiglenes másolatban
  (`scripts/check-tasks-nobugfix-TEMP.mjs`, a review végén törölve, a repo
  git-státusza tiszta maradt utána) lefuttattam a pozitív fixture ÉS a valós
  `docs/tasks/` ellen: mind a 2, illetve mind a 46 feldolgozott taskra hamis
  `created`-hiba jelent meg (`'Sat Jul 18 2026 ... GMT+0200 ...'` — pontosan a
  készítő által leírt tünet), függetlenül reprodukálva.

**Következtetés**: a bug valós, a javítás helyes és szükséges, DE a
`loadYamlLibs()` kódkommentje és a task Implementáció-szakasza a gyökér-okot
pontatlanul írja le ("js-yaml alapértelmezett sémája" — valójában "a
gray-matter saját, beágyazott, elavult js-yaml v3 default engine-je"). Ez
kozmetikai pontosítás, NEM változtatja meg a javítás helyességét, de javasolt
followupként rögzítem.

### 2. `npm run check:tasks` és a 67 teszt — saját futtatás

- `cd knowledge-service && node ../scripts/check-tasks.mjs` (Bash): **exit 1,
  24 hiba**, pontosan a taskfájlban felsorolt 23 `blocked_reason` + 1
  `TASK-DP-001` `execution_evidence` hiánnyal, karakterre egyezően
  reprodukálva.
- `node --test scripts/__tests__/check-tasks.test.mjs`: **67/67 pass, 0 fail**
  — reprodukálva.
- Mind a 11 fixture-esetet (1 pozitív + 10 negatív) egyenként, önállóan
  lefuttattam CLI-n (`--root .../<fixture> --quiet`): mindegyik pontosan a
  nevében ígért hibaosztályt adja, a pozitív fixture exit 0-t. Egyezés a
  taskfájl 6.2 pontjával.

### 3. Windows PowerShell vs. Bash paritás — saját futtatás

`node ../scripts/check-tasks.mjs` (PowerShell, `knowledge-service/`-ből) és
`node --test scripts/__tests__/check-tasks.test.mjs` (PowerShell) — **azonos
kimenet és exit code**, mint a Bash-futtatásnál (24 hiba / exit 1, illetve
67 pass / exit 0). A készítő állítása igazolt. Megjegyzés (nem hiba): a
készítő maga is jelzi, hogy VALÓDI Linux-futtatás nem történt ezen a gépen
(csak Windows Git-Bash + PowerShell) — ez helyesen, nyitott kockázatként van
dokumentálva a 9. pontban, nem eltussolva.

### 4. Fixture-ök átvizsgálása + saját 12. hibaosztály keresése

Mind a 11 fixture-t átnéztem és lefuttattam: mindegyik valóban azt a hibát
reprodukálja, amit a neve állít (részletek fent, 2. pont).

A megbízás által javasolt eseteket leteszteltem:

- **`depends_on` nemlétező task-ID-ra, kör nélkül** — ezt már fedezi a
  meglévő `missing-dependency` fixture (saját futtatással megerősítve: 1
  hiba, nincs "Ciklikus" üzenet).
- **`parallel_with` aszimmetria (A→B, de nem B→A)** — a séma ($comment)
  explicit dokumentálja, hogy ez SZÁNDÉKOSAN csak létezés-ellenőrzött, nem
  szimmetria-ellenőrzött ("Informatív, nem-DAG kapcsolat"). Ez tehát nem hiba,
  hanem dokumentált tervezési döntés — de megjegyzem, hogy a `parallel_with`
  létezés-ellenőrzésére (nem a szimmetriára) **nincs dedikált fixture/teszt**
  (saját manuális teszttel igazoltam, hogy a kód-ág maga helyesen működik:
  nemlétező `parallel_with`-hivatkozás exit 1-et ad) — ez egy kisebb,
  teszt-lefedettségi rés, nem funkcionális hiba.

**Saját, önállóan kitalált 12. és 13. hibaosztály — MINDKETTŐ átment a
validátoron hamis "OK"-val, tehát a validátor ezeket KRITIKUSAN elvéti:**

**(A) A `program:` / `milestone:` / `epic:` frontmatter-mezők ÉRTÉKÉT a
validátor soha nem veti össze az `EPICS.yaml` tényleges `programs[].id` /
`programs[].milestones[].id` / `epics[].id` halmazával — annak ellenére,
hogy a `docs/tasks/task-schema.json` saját leírása ezt kifejezetten ígéri**
(pl. `program`: "Létező programazonosítónak kell lennie a ... programs[].id
halmazában"; `milestone`: "Létező mérföldkő-azonosító..."; `epic`: "...az
epicnek pontosan erre a task-fájlra kell hivatkoznia epics[].tasks[] alatt").
Saját, ideiglenes fixture-rel (`scratchpad/epic-mismatch-fixture/`, nem került
a repóba) igazoltam: egy task-fájl `program:
NEXUS-COMPLETELY-FAKE-PROGRAM-XYZ`, `milestone: FAKE-MILESTONE-XYZ`, `epic:
EPIC-TOTALLY-DIFFERENT-AND-NONEXISTENT` mezőkkel — miközben a fájl az
`EPICS.yaml`-ban a task-id + fájlútvonal alapján helyesen szerepel egy VALÓS
epic (`EPIC-REAL`) `tasks[]` alatt — **`exit 0`, "OK"-t ad**. A
`checkEpicsMembership()` implementáció (scripts/check-tasks.mjs 334–382. sor)
kizárólag a task-ID ÉS a fájlútvonal kétirányú egyezését ellenőrzi; magát a
frontmatter `epic:` mező ÉRTÉKÉT sosem veti össze azzal az epic-id-vel,
amely alatt a task ténylegesen szerepel, és a `program`/`milestone` mezőket
egyáltalán nem nézi semmilyen EPICS.yaml-halmaz ellen (`validateFrontmatter`
csak a jelenlétüket ellenőrzi, ld. 201–205. sor). Vagyis egy elgépelt vagy
tudatosan hamis `epic`/`program`/`milestone` érték egy valós task-fájlban ma
csendben átmegy a kapun.

**(B) A `status`-átmenet-ellenőrzés (`isAllowedTransition` / `--diff-base`)
helyesen implementált és unit-tesztelt, DE a tényleges CI-integrációban
SOHA nem fut le**, mert `knowledge-service/package.json` `check:tasks` scriptje
(`node ../scripts/check-tasks.mjs`) nem ad át `--diff-base`-t, és a
`.github/workflows/ci.yml` `npm run check:tasks` lépése sem. Emellett az
`actions/checkout@v4` lépés `fetch-depth` nélkül fut (alapértelmezett sekély,
1-mélységű klón), ami a `--diff-base <ref>` git-alapú összehasonlítást (a
kód `execFileSync('git', ['show', ...])`-ot hív) eleve akadályozná, ha
valaki utólag hozzáadná a flaget anélkül, hogy a checkout mélységét is
bővítené. A task saját "Mikor jó?" szakasza kifejezetten állítja: "...
jogosulatlan státuszátmenet ... lokálisan ÉS CI-ben is nem nulla exit
code-dal megbukik" — ez az állítás CI-re nézve **ma nem igaz**, és ezt sem
az Implementáció, sem az "Ismert korlátok" (9. pont) szakasz nem jelzi.
(Az elfogadási feltételek — 44. sor környéki checklist — szerencsére nem
sorolja fel explicit checkbox-ként a CI-beli státuszátmenet-ellenőrzést,
csak a "Mikor jó?" prózai leírás teszi — ettől még ez egy valós, a
programcél-dokumentumban ígért, de nem teljesített képesség.)

Mindkét találatot saját, reprodukálható paranccsal/fixture-rel igazoltam
(a fixture-fájlokat a `scratchpad`-ban hagytam, a repóba NEM kerültek be).

### 5. TASK-QC-008A…E `source:` idézőjelezés — saját igazolás

Mind az 5 érintett fájlban (`TASK-QC-008{A,B,C,D,E}-*.md`) ellenőriztem: a
`source:` mező ma valóban idézőjelben van. Saját, ideiglenes szkripttel
lefuttattam az EREDETI (idézőjel nélküli) `source: TASK-QC-008 B.3
(allowlist: .file-size-allowlist.json, lejárat 2026-10-18)` sort a tényleges
`gray-matter` + JSON_SCHEMA-s `js-yaml` pipeline-on át: **parse-hiba** ("bad
indentation of a mapping entry"), pontosan a taskfájl állítása szerint. A
javítás (teljes érték idézőjelbe) jogos és szükséges volt.

### 6. CI-integráció és a "CI piros lesz" kérdés

A `.github/workflows/ci.yml` diffjét átnéztem: a `check:tasks` lépés
valóban a QC-005 mintáját követi (checkout → setup-node → install →
gate-lépések, mindegyik saját `npm run ...` script + lokális reprodukálási
komment). A lépés **blokkoló** (nincs `continue-on-error`). Mivel a valós
repo jelenleg 24 hibával bukik, **a következő push a `main`-re (vagy egy PR)
ezen a lépésen PIROSRA fog futni**, amíg a 23 `blocked_reason` és az 1
`TASK-DP-001` evidence-hiány nincs rendezve. A taskfájl ezt **explicit,
pontosan jelzi** (6.3 pont vége, 9. pont) — ez megfelel a megbízás
elvárásának ("ha jelezve van, nem hiba").

### 7. `check-doc-links.mjs` és `secret-scan.mjs`

Mindkettőt önállóan lefuttattam (`npm run check:links`, `npm run
secret-scan`, `knowledge-service/`-ből): mindkettő **OK, exit 0** (89
markdown-link + 8 ADR-útvonal + 155 ADR-említés ellenőrizve; 347 tracked
fájl, 0 secret-találat). Emellett `npm run check:size`-t is lefuttattam:
**OK**, és önállóan igazoltam, hogy a `scripts/*.mjs` (így `check-tasks.mjs`,
738 sor) valóban kívül esik a `knowledge-service/src`-re szűkített
fájlméret-kapu hatályán — a készítő állítása helytálló.

### 8. A 12 kötelező "done előtt" pont

Tételesen végignéztem a README "done előtt" 12 pontját (92–140. sor) a
taskfájl Implementáció-szakasza ellen: mind a 12 pont strukturálisan
jelen van (1↔Végrehajtási napló+evidence.goal, 2↔2. szakasz, 3↔3. szakasz,
4↔2. szakasz fájllistája, 5↔5. szakasz, 6↔6. szakasz, 7↔7. szakasz,
8↔8. szakasz, 9↔9. szakasz — DE ld. fent, a 4.(A)/(B) pontban talált két
hiányzó tétel innen hiányzik —, 10↔üresen hagyva a reviewernek, helyesen,
11↔11. szakasz, 12↔12. szakasz). A 10. pont (reviewer mezők) helyesen
üresen volt hagyva — a készítő nem zárta le saját taskját, a `status`
frontmatter helyesen `ready` maradt commit/push nélkül.

### Verdikt: **REQUEST_CHANGES**

Indoklás: a validátor és a teszt-suite a saját, adverzáriális
ellenőrzésem szerint is **nagyrészt helyesen és a leírtak szerint
működik** — a Date-bug valós (egy ponton pontosítandó gyökér-okkal), a
Windows/Bash paritás igazolt, mind a 11 fixture helytálló, a QC-008A…E
javítás jogos, a 24 valós-repo hiba explicit és pontosan dokumentált, a
CI-piros-lesz kockázat jelezve van. **DE** a megbízás kifejezetten arra
kért, hogy magam is próbáljak találni egy, a készítő és a program által
kihagyott hibaosztályt — ez sikerült, **kettőt is**, mindkettőt saját,
reprodukálható próbával igazolva:

1. A `program:`/`milestone:`/`epic:` frontmatter-mező ÉRTÉKE ma nincs az
   `EPICS.yaml` tényleges ID-halmaza ellen validálva, annak ellenére, hogy a
   `task-schema.json` saját szövege ezt a validációt kifejezetten ígéri.
   Egy hamis/elgépelt epic/program/milestone-hivatkozás ma csendben átmegy
   a kapun.
2. A státuszátmenet-ellenőrzés (`--diff-base`) a valóságban SOHA nem fut le
   sem a helyi `npm run check:tasks`, sem a CI `check:tasks` lépés alatt,
   ami ellentmond a task saját "Mikor jó?" kritériumának
   ("jogosulatlan státuszátmenet ... CI-ben is ... megbukik"), és ezt az
   ellentmondást az Implementáció-szakasz sehol nem jelzi nyitott
   kérdésként.

### Mit kell javítani a `done`-hoz

1. `checkEpicsMembership()` (vagy egy új, dedikált függvény) egészüljön ki:
   vesse össze a task frontmatter `epic:` mezőjét azzal az epic-id-vel,
   amely alatt a task ténylegesen szerepel az `EPICS.yaml`-ban (hiba, ha
   eltér), és validálja a `program:`/`milestone:` mezőket is a
   `EPICS.yaml programs[].id` / `programs[].milestones[].id` halmaz ellen —
   VAGY, ha ez tudatosan kimarad a DP-003 scope-jából, a
   `docs/tasks/task-schema.json` field-leírásait pontosítani kell úgy, hogy
   ne ígérjenek olyan ellenőrzést, ami nem létezik (a schema szövege ma
   félrevezető).
2. Vagy kössük be a `--diff-base`-t ténylegesen a CI-be (ehhez az
   `actions/checkout@v4` `fetch-depth`-jét is rendezni kell, hogy a
   diff-base git-ref elérhető legyen a shallow klónban), vagy dokumentáljuk
   explicit nyitott kérdésként/ismert korlátként a task Implementáció 9.
   pontjában, hogy a státuszátmenet-ellenőrzés ma kizárólag lokális,
   manuális `--diff-base` futtatással érhető el, CI-ben inaktív — hogy a
   "Mikor jó?" ígérete és a tényleges viselkedés ne mondjon ellent
   egymásnak.
3. Kisebb, nem blokkoló javaslat: pontosítani a `loadYamlLibs()` kódkommentjét
   és az Implementáció 1. szakaszát — a gyökér-ok nem "js-yaml
   alapértelmezett sémája" általánosságban, hanem a `gray-matter` saját,
   beágyazott, elavult (v3.15.0) `js-yaml`-példányának alapértelmezett
   engine-je.
4. Kisebb, nem blokkoló javaslat: dedikált unit teszt/fixture a
   `parallel_with` nemlétező-hivatkozás-esetére (a kódág ma helyesen
   működik, de teszt-lefedettség nélkül).

A frontmatter `status` mező **`ready` marad** (nem `done`) — a fenti két
(1–2.) pont rendezése és egy újabb független review szükséges a
lezáráshoz.

## Független review, 2. kör (2026-07-18)

### Függetlenségi nyilatkozat

Ez a review egy, a TASK-DP-003 elkészítésében és az 1. körös reviewban részt
nem vevő, friss kontextusú agent munkája. A megbízás kifejezetten "MÁSODIK
FÜGGETLEN reviewer"-ként azonosít — sem a készítő 13. szakaszának, sem az
1. körös reviewer verdiktjének nem fogadtam el egyetlen állítását sem
bemenetként megcáfolhatatlan tényként: minden alábbi tételt saját,
önállóan futtatott paranccsal, saját írású szkripttel vagy saját, repón
kívüli temp-fixture-rel újra-igazoltam vagy megpróbáltam megcáfolni. Titkot
nem írtam bizonyítékba, git commit/push-t nem végeztem.

### 1. Gyökérok-pontosítás (gray-matter beágyazott js-yaml@3.15.0) — saját, független igazolás

Két, egymástól független Node-egysoros paranccsal ellenőriztem (nem a
készítő vagy az 1. körös reviewer szkriptjét futtattam újra, hanem saját
minimál-repróval):

- `knowledge-service/node_modules/js-yaml/package.json` → **5.2.1** (top-level).
  `yaml.load('created: 2026-07-18')` ezen a csomagon → `typeof doc.created
  === 'string'`, érték `'2026-07-18'`. **A top-level csomag NEM hibás.**
- `knowledge-service/node_modules/gray-matter/package.json` → **4.0.3**,
  `dependencies.js-yaml: "^3.13.1"` — és ténylegesen létezik egy
  BEÁGYAZOTT, saját példány: `knowledge-service/node_modules/gray-matter/
  node_modules/js-yaml/package.json` → **3.15.0**. `matter('---\nid:
  TASK-DM-001\ncreated: 2026-07-18\n---\nbody')` (a `gray-matter` saját,
  override NÉLKÜLI alapértelmezett engine-jével) → `typeof
  parsed.data.created === 'object'`, érték `2026-07-18T00:00:00.000Z`
  (natív `Date`).

Ez pontosan, karakterre megerősíti a készítő 13.3 pontban véglegesített és
az 1. körös reviewer 1. szakaszában már igazolt állítást: a gyökérok a
`gray-matter@4.0.3` saját, elavult, beágyazott `js-yaml@3.15.0`
alapértelmezett engine-je (YAML 1.1 `!!timestamp` feloldás), NEM a repo
top-level `js-yaml@5.2.1` csomagja. A `loadYamlLibs()` kódkommentje és az
Implementáció-szakasz szövege ma ezt pontosan, a valósággal egyező módon
írja le (nincs további pontosítási igény).

### 2. GAP 1 (EPICS-ID kereszthivatkozás) — saját reprodukció

A készítő saját `scripts/__fixtures__/tasks/negative/epic-reference-fabricated/`
fixture-ét NEM csak elolvastam, hanem önállóan lefuttattam:

```
node scripts/check-tasks.mjs --root scripts/__fixtures__/tasks/negative/epic-reference-fabricated --quiet
→ exit 1, PONTOSAN 3 hiba: [program] ..., [milestone] ..., [epic] ...
```

A fixture task-fájlja (`TASK-DM-009.md`) az EPICS.yaml `DEMO-EPIC` epicjében
helyesen, a helyes fájlútvonallal szerepel (tehát `checkEpicsMembership`
önmagában zöld lenne rá), miközben a frontmatter `program`/`milestone`/
`epic` mezői teljesen kitaláltak — a `checkEpicsReferences()` mindhármat
elkapja, külön mezőnkénti hibaüzenettel. **GAP 1 ténylegesen zárva.**

### 3. GAP 2 (`--diff-base` bekötés) — saját, repón kívüli temp-repo reprodukció

A készítő/1. körös reviewer temp-repóit NEM használtam fel — saját,
`mktemp -d`-vel létrehozott, a nexus-dev repón teljesen kívüli git-repót
építettem, ténylegesen két commit-tal:

1. commit: `TASK-RV-777.md`, `status: ready`.
2. commit: ugyanaz a fájl, `status: done`-ra írva (jogosulatlan, közvetlen
   `ready → done` ugrás, review nélkül).

```
node <repo>/scripts/check-tasks.mjs --root <temp-repo>          (ZÉRÓ FLAG)
→ "[check:tasks] --diff-base nincs explicit megadva — automatikusan 'HEAD~1'-et használom..."
→ exit 1, 1 hiba: [status] Jogosulatlan státuszátmenet: 'ready' → 'done' (bázis: HEAD~1). ...
```

Ez bizonyítja, hogy a `resolveDefaultDiffBase()` + a CLI ténylegesen,
flag nélkül is elkapja a jogosulatlan átmenetet egy valódi, a nexus-dev
repótól teljesen független git-történelemben — nem csak a beépített
unit teszt (amit emellett a 82/82-es futtatással is megerősítettem, ld.
lent) bizonyítja ezt, hanem egy tőle független, saját próba is.

**`.github/workflows/ci.yml` `fetch-depth: 2` — logikai elégségesség
push-eseményre**: `push`-eseménynél a checkout a ténylegesen pusholt
commitot nézi ki, `fetch-depth: 2` ehhez pontosan a szülő-commitot is
lehozza — `HEAD~1` ekkor determinisztikusan feloldható, a mechanizmus
push-ra LOGIKAILAG ELÉGSÉGES.

**`pull_request`-trigger validálatlansága — elfogadható nyitott kockázat,
NEM blokkoló**: a `ci.yml` kommentje és a task 13.2 szakasza is explicit,
pontosan (nem eltussolva) dokumentálja, hogy `pull_request`-eseménynél a
GitHub szintetikus merge-commitjának `HEAD~1`-szemantikája nincs élőben
validálva. Saját elemzésem szerint ez a kockázat a gyakorlatban valószínűleg
enyhe irányba téved (a merge-commit első szülője jellemzően a cél-branch
csúcsa a PR indításakor, tehát a diff a TELJES PR-t nézné a bázis-branch
ellen, ami SZIGORÚBB, nem gyengébb ellenőrzés egy köztes, PR-en belüli
jogosulatlan ugrásra) — de ez feltételezés, élő GitHub Actions-futtatással
nincs megerősítve, ahogy azt a task maga is jelzi. A megbízás explicit
döntési szabálya szerint ("a pull_request-trigger nem-validált élő esete
NYITOTT KOCKÁZATKÉNT elfogadható, ha a taskfájl ezt explicit és pontosan
dokumentálja") — ez a feltétel teljesül, tehát **ez a pont NEM blokkoló**.

### 4. Teljes teszt-suite és valós repo — saját futtatás, mindkét shell

```
node --test scripts/__tests__/check-tasks.test.mjs   (Bash)        → 82 pass, 0 fail
node --test scripts/__tests__/check-tasks.test.mjs   (PowerShell)  → 82 pass, 0 fail
cd knowledge-service && npm run check:tasks          (Bash)        → 46 task felfedezve, 25 hiba, exit 1
cd knowledge-service && npm run check:tasks          (PowerShell)  → 46 task felfedezve, 25 hiba, exit 1
```

A 25 hiba tartalma (fájl, mező, üzenet szinten) BIT-PONTOSAN egyezik a két
shell között, és megegyezik a készítő 13.5 szakaszában leírt bontással: 23×
`blocked_reason` (TASK-DP-004/005/007/008/009/010/011 + TASK-ISL-002…017) +
2× hiányzó `execution_evidence` archívumban (`TASK-DP-001` — ismert,
dokumentált gap — és `TASK-DP-006-change-provenance.md`, amit saját
`grep`-pel is megerősítettem: a fájl `status: done`, de nincs benne
`execution_evidence` kulcs). A PowerShell-futtatás egy `NativeCommandError`
figyelmeztetést írt stderr-re a stream-egyesítés miatt (PowerShell 5.1
ismert sajátossága natív exe stderr-jének `2>&1`-es összefésülésekor,
ld. a jelen environment saját dokumentációja) — ez a shell-hívó
tool-artefaktuma, NEM a `check-tasks.mjs` viselkedésének eltérése: a
tényleges `[check:tasks] HIBÁK (25):` blokk és a 25 hibasor tartalma
karakterre azonos volt a Bash-futtatással.

`npm run check:links` és `npm run secret-scan` (Bash, `knowledge-service/`-ből):
mindkettő **OK, exit 0** (89 markdown-link/8 ADR-útvonal/155 ADR-említés
ellenőrizve; 347 tracked fájl, 0 secret-találat).

### 5. HARMADIK, önállóan talált gap — épp a megbízás által célzott forgatókönyv

A megbízás kifejezetten felvetette: "mi történik, ha egy `epic:` mező
helyesen létezik az EPICS.yaml-ban, DE az adott epic MÁSIK programhoz
tartozik, mint amit a taskfájl `program:` mezője állít?" Ezt saját, minimál
szintetikus próbával teszteltem (`checkEpicsReferences()` közvetlen
hívásával, a `check-tasks.mjs`-ből importálva):

- `EPICS.yaml`: `EPIC-A` epic ténylegesen `program: PROG-A`, `milestone:
  A-M1` alá tartozik, és helyesen regisztrálja `TASK-XX-001`-et a
  `tasks[]` listájában.
- A task frontmatterje: `program: PROG-B`, `milestone: B-M1` (mindkettő
  ÖNMAGÁBAN valós, létező azonosító — csak nem az `EPIC-A` programja/
  mérföldköve), `epic: EPIC-A` (létező, és a task ténylegesen alá van
  regisztrálva, tehát a membership-egyeztetés is zöld).
- `checkEpicsReferences({ epicsDoc, tasks })` → **`[]` — ZÉRÓ hiba.**

**A `program`/`milestone` mezők egyedi létezés-ellenőrzése ÉS az `epic`
mező membership-egyeztetése mind zöld lehet úgy, hogy közben az epic
TÉNYLEGES `program`/`milestone` hovatartozása (EPICS.yaml `epics[].program`
/ `epics[].milestone`) sosem kerül összevetésre a task saját, deklarált
`program:`/`milestone:` mezőjével.** A kód (`checkEpicsReferences`,
`scripts/check-tasks.mjs` kb. 474–551. sor) az `epic` ágon kizárólag azt
nézi, hogy (a) az epic létezik-e, és (b) ha a task regisztrálva van
valamelyik epic alatt, az egyezik-e a frontmatter `epic` értékével — de
sosem hasonlítja össze `epicsById.get(epic).program`-ot
`task.data.program`-mal, sem `epicsById.get(epic).milestone`-t
`task.data.milestone`-mal.

**Ez NEM csak elméleti/szintetikus kockázat — a VALÓS repo adatában ma
ténylegesen élő formában megtalálható**, saját írású, önálló szkripttel
átvizsgálva mind a 46 felfedezett taskot az `EPICS.yaml` epics[] tömbje
ellen:

```
MILESTONE MISMATCH: TASK-QC-005 frontmatter.milestone='QC-M2' de epic 'QC-VERIFICATION'.milestone='QC-M4'
MILESTONE MISMATCH: TASK-QC-006 frontmatter.milestone='QC-M2' de epic 'QC-VERIFICATION'.milestone='QC-M4'
MILESTONE MISMATCH: TASK-QC-011 frontmatter.milestone='QC-M2' de epic 'QC-VERIFICATION'.milestone='QC-M4'
MILESTONE MISMATCH: TASK-QC-012 frontmatter.milestone='QC-M2' de epic 'QC-VERIFICATION'.milestone='QC-M4'
MILESTONE MISMATCH: TASK-QC-013 frontmatter.milestone='QC-M2' de epic 'QC-VERIFICATION'.milestone='QC-M4'
Összesen: 5 mismatch, 0 program-mismatch.
```

Öt valós task (`TASK-QC-005`, `-006`, `-011`, `-012`, `-013`) frontmatterje
`milestone: QC-M2`-t állít, miközben az `EPICS.yaml`-ban a `QC-VERIFICATION`
epic (amely alá mindegyikük helyesen, hivatkozás-szinten regisztrálva van)
`milestone: QC-M4` alá tartozik — ezt közvetlenül a fájlokban is
megerősítettem (`grep '^milestone:\|^epic:\|^program:'
docs/tasks/quality-compliance/archive/TASK-QC-005-ci-quality-gates.md`).
A `npm run check:tasks` MA, jelenlegi formájában **ZÉRÓ hibát ad erre az 5
valós inkonzisztenciára**, holott a kapu saját, deklarált elfogadási
feltétele ("Minden repository task és az EPICS.yaml parse-olható és
konzisztens") és a `task-schema.json` `epic` mezőjének leírása
("bidirekcionális tagság-ellenőrzés") pontosan ezt a fajta, hierarchia-szintű
konzisztenciát ígéri.

Ez egy harmadik, önálló, a készítő és az 1. körös reviewer által egyaránt
kihagyott hibaosztály, saját reprodukcióval (szintetikus fixture ÉS élő
valós-repo találat) igazolva.

### 6. Egyéb ellenőrzések

- `docs/tasks/development-process/README.md` és a teljes taskfájl (minden
  korábbi szakasz, beleértve az 1. körös review-t) elolvasva.
- `.github/workflows/ci.yml` teljes diffje/tartalma átnézve — a
  `fetch-depth: 2` és a `pull_request`-kockázat kommentje pontosan ott van,
  ahol a task állítja.
- `docs/tasks/task-schema.json` és `docs/projects/EPICS.yaml` teljes
  tartalma átnézve (az `epics[].program`/`epics[].milestone` mezők
  létezését és jelentését ez alapján azonosítottam).
- A repo git-státusza a review alatt és után ellenőrizve
  (`git status --porcelain -- scripts/ docs/tasks/`): a review kizárólag
  saját, repón kívüli (OS temp / scratchpad) fájlokat hozott létre és
  törölt, a nexus-dev munkafán a review NEM változtatott semmit; commit/push
  nem történt.

### Verdikt: **REQUEST_CHANGES**

Indoklás: a 2 korábbi, 1. körben talált gap **mindkettő ténylegesen,
megfelelő mélységben zárva van** — saját, a készítőétől és az 1. körös
reviewertől is független reprodukcióval (fixture-futtatás GAP 1-hez, teljesen
új temp-git-repo GAP 2-höz) megerősítettem mindkettőt. A gyökérok-pontosítás
(gray-matter beágyazott elavult js-yaml) szintén helytálló, saját,
minimál-repróval igazolva. A `pull_request`-trigger nem-validált élő esete
a megbízás döntési szabálya szerint elfogadható, nem blokkoló nyitott
kockázat, mert explicit és pontosan dokumentálva van.

**DE** a megbízás kifejezetten arra kért, hogy magam is keressek egy,
mindenki által kihagyott, harmadik hibaosztályt — ez sikerült, és nem csak
szintetikusan: **a kapu ma, éles futásban, zéró hibát ad 5 valós, a repóban
ténylegesen létező `milestone`-inkonzisztenciára** (`TASK-QC-005/006/011/
012/013` vs. `QC-VERIFICATION` epic), mert a `checkEpicsReferences()`
sosem veti össze az epic saját `program`/`milestone` hovatartozását a task
frontmatter azonos nevű mezőivel. Ez pontosan a kapu saját, deklarált
céljába ütköző, élő hiba — a "Minden repository task és az EPICS.yaml
... konzisztens" feltétel ma hamisan tűnik teljesítettnek egy olyan
hibaosztályra nézve, amit a kapu állítása szerint ellenőriznie kellene.

### Mit kell javítani a `done`-hoz (3. kör előtt)

1. `checkEpicsReferences()` egészüljön ki egy negyedik ellenőrzéssel: ha a
   frontmatter `epic:` mezője létező, a taskhoz ténylegesen regisztrált
   epicre mutat, ÉS az `EPICS.yaml` az adott epicnél `program`/`milestone`
   mezőt ad meg, akkor ez a két érték egyezzen meg a task saját
   `program:`/`milestone:` mezőjével (hiba, ha eltér — pontosan úgy, ahogy
   a mostani `epic`-ág is jelez eltérést a task-id-epic regisztráció
   esetén). VAGY, ha ez a fajta kereszt-ellenőrzés tudatosan kimarad a
   DP-003 scope-jából, ezt a `task-schema.json` `program`/`milestone`/
   `epic` mezőleírásaiban és a task "Ismert korlátok" szakaszában
   explicit, nyitott korlátként rögzíteni kell — jelen állapotban a
   séma szövege ezt az ellenőrzést hallgatólagosan ígéri (ADR-068
   hierarchia-elv), és a szöveg ezt a hiányt ma nem jelzi.
2. A talált 5 valós `milestone`-mismatch (`TASK-QC-005/006/011/012/013`)
   dokumentálandó follow-upként a task Implementáció-szakaszában (a
   fájlhatár ezen taskon belül nem teszi lehetővé a tényleges javítást,
   de a találatot — a 23 `blocked_reason` és 2 `execution_evidence`
   mintájára — rögzíteni kell).
3. A korábbi (1. körös) 3–4. kisebb, nem blokkoló javaslatok
   (gyökérok-szöveg pontosítás, `parallel_with` dedikált teszt) — mindkettő
   RENDBEN, teljesítve, nincs velük további teendő.

A frontmatter `status` mező **`ready` marad** (nem `done`) — a fenti 1–2.
pont rendezése és egy 3. körös független review szükséges a lezáráshoz.

## Független review, 3. kör (2026-07-18)

### Függetlenségi nyilatkozat

Ez a review egy, a TASK-DP-003 elkészítésében és az 1–2. körös reviewokban
részt nem vevő, friss kontextusú agent munkája. Sem a készítő 13–14.
szakaszának, sem az 1. és 2. körös reviewer verdiktjeinek egyetlen állítását
sem fogadtam el bemenetként megcáfolhatatlan tényként: minden alábbi tételt
saját, önállóan futtatott paranccsal (Bash ÉS PowerShell) újra-igazoltam.
Titkot nem írtam bizonyítékba, git commit/push-t nem végeztem, és nem
javítottam a kódot — kizárólag jelentek.

### 1. Előzetes koordinátori tisztázás — ellenőrzés a kódban és a sémában

A koordinátor (Gábor) tisztázása szerint a `milestone`-átívelés (QC-VERIFICATION
precedens) SZÁNDÉKOS design, nem hiba, és csak a `program`-egyezést kell
szigorúan megkövetelni. Ellenőriztem, hogy a 14. szakaszban leírt javítás
ezt pontosan, félreérthetetlenül követi:

- `scripts/check-tasks.mjs` 546–571. sor: a `checkEpicsReferences()` `epic`-ága
  a negyedik ellenőrzésként `epicDoc.program !== program`-ot vet össze, DE
  a kódban egy hosszú, explicit komment (552–566. sor) kifejezetten indokolja,
  miért NINCS analóg `epicDoc.milestone !== milestone` ellenőrzés — a
  QC-VERIFICATION élő precedensre hivatkozva, szó szerint.
- Nincs `task.milestone === epic.milestone` szigorú egyenlőség-ellenőrzés
  bevezetve — ahogy a megbízás is elvárta, hogy NE legyen.

### 2. Szintetikus eset — program-egyezés MOST kötelező (saját futtatás)

A készítő `scripts/__fixtures__/tasks/negative/epic-program-mismatch/`
fixture-jét átolvastam és önállóan lefuttattam, mindkét shellen:

```
node scripts/check-tasks.mjs --root scripts/__fixtures__/tasks/negative/epic-program-mismatch --quiet
→ (Bash)       exit 1, PONTOSAN 1 hiba
→ (PowerShell) exit 1, PONTOSAN 1 hiba (karakterre azonos üzenet)
```

Hibaüzenet: `[program] A taskfájl 'program: NEXUS-OTHER-DEMO'-t állít, de a
hivatkozott epic ('epic: DEMO-EPIC') az EPICS.yaml-ban a(z) 'NEXUS-DEMO'
programhoz tartozik...`. A fixture pontosan a megbízás által kért esetet
reprodukálja: a task (`TASK-DM-013`) helyesen, a fájlútvonala alapján is
regisztrálva van a `DEMO-EPIC` epic `tasks[]` alatt (a `checkEpicsMembership`
önmagában zöld lenne), a `milestone: OTHER-M1` is önmagában valós érték a
saját (téves) programjához — kizárólag a `program:` mező tér el az epic
tényleges programjától. **Ez a kritérium ténylegesen, bizonyítottan
kikényszerítve van.**

### 3. Milestone-eltérés NEM bukik el — valós repo, konkrét sorok

```
cd knowledge-service && npm run check:tasks
→ (Bash)       exit 1, 25 hiba
→ (PowerShell) exit 1, 25 hiba (karakterre azonos lista)
```

A 25 hiba teljes listáját átnéztem: mind a 25 sor `[blocked_reason]` (23×,
`TASK-DP-004/005/007/008/009/010/011` + `TASK-ISL-002…017`) vagy
`[execution_evidence]` (2×, `TASK-DP-001` + `TASK-DP-006-change-provenance`)
— **egyetlen `TASK-QC-005`, `-006`, `-011`, `-012` vagy `-013` sor sincs a
kimenetben**, és egyetlen `[milestone]` mezőjű hiba sincs egyáltalán.
Emellett önállóan, a taskfájltól függetlenül lekértem mind az 5 érintett
fájl frontmatterét (`grep '^program:\|^milestone:\|^epic:'`) ÉS a
`QC-VERIFICATION` epic saját `program`/`milestone` mezőjét
(`docs/projects/EPICS.yaml`-ból, közvetlen `js-yaml` parse-szal):

```
QC-VERIFICATION epic:      program=NEXUS-QUALITY  milestone=QC-M4
TASK-QC-005/006/011/012/013: program=NEXUS-QUALITY  milestone=QC-M2  epic=QC-VERIFICATION
```

Ez saját, független bizonyíték arra, hogy a precedens VALÓBAN tiszta
milestone-only eltérés (a `program` mind az 5 esetben egyezik — nem egy
véletlenül rejtett program-eltérés van elfedve), tehát a kapu helyesen,
nem véletlenül ereszti át.

### 4. `docs/tasks/task-schema.json` mezőleírások — aszimmetria világossága

Átolvastam a `program`, `milestone` és `epic` mezőleírást (v1.1.0,
`schemaVersion`/`changelog` bejegyzéssel). Értékelésem: **igen, félreérthetetlenül
dokumentálják az aszimmetriát**:

- `program`: kimondja, hogy egyeznie KELL az epic `program` mezőjével, "nincs
  ismert, dokumentált kivétele", és megnevezi a 2. körös review dátumát és a
  "0 program-mismatch" pozitív találatot.
- `milestone`: kimondja a "FONTOS ASZIMMETRIA" kifejezést, elmagyarázza a
  "ZÁRÓ mérföldkő" fogalmat, és szó szerint megnevezi a `QC-VERIFICATION`
  epicet, mind az 5 valós task-id-t (`TASK-QC-005/006/011/012/013`), és
  mindkét konkrét milestone-értéket (`QC-M4` vs. `QC-M2`).
- `epic`: egy záró mondatban mindkettőre visszautal, összefoglalva melyik
  szigorú és melyik laza.

Ez a szint (konkrét ID-k és értékek megnevezve, nem csak elvont szabály)
kizárja azt, hogy egy jövőbeli olvasó a `milestone`-hiányt véletlen
hiányosságnak nézze — a dokumentáció maga a bizonyíték, hogy szándékos.

### 5. Tesztfuttatás — mindkét shell, saját futtatás

```
node --test scripts/__tests__/check-tasks.test.mjs          (Bash)       → 87 pass, 0 fail
npm run test:tasks (knowledge-service/, PowerShell)                       → 87 pass, 0 fail
node scripts/check-tasks.mjs --root .../epic-program-mismatch --quiet    → mindkét shellen exit 1, 1 hiba
cd knowledge-service && npm run check:tasks                  (Bash)       → exit 1, 25 hiba
cd knowledge-service && npm run check:tasks                  (PowerShell) → exit 1, 25 hiba
```

A 25-ös hibaszám **VÁLTOZATLAN** a 2. körhöz (és a készítő 13.5/14.4
szakaszához) képest — sem a hibaszám, sem a hibaosztályok nem tolódtak el.
A `node --check scripts/check-tasks.mjs` szintaxis-ellenőrzés is lefutott,
exit 0.

### 6. Negyedik gap keresése

Két, saját írású szkripttel próbáltam megcáfolni a `checkEpicsReferences()`
negyedik ágát, és mindkettő talált egy-egy KISEBB, NEM BLOKKOLÓ
megfigyelést, funkcionális hiba nélkül:

- **(a) Orphan (nem regisztrált) task + eltérő `program`**: ha egy task
  frontmatterje `epic:`-ként egy VALÓS epicre mutat, de a task ténylegesen
  SEHOL nincs regisztrálva annak `tasks[]` alatt (orphan — ezt a
  `checkEpicsMembership` külön jelzi), a `checkEpicsReferences` MÉG EZ
  ESETBEN IS lefuttatja a program-egyezés ellenőrzést a claimed epic ellen
  (saját teszttel igazolva: eltérő program esetén hibát ad). Ez NEM hibás
  viselkedés — sőt, tartalmilag helyes, mert a task saját állítása (`epic:
  X`, `program: Y`) ettől függetlenül ellentmondásos —, de a meglévő
  "does not also get a spurious mismatch error" elnevezésű unit teszt
  (`scripts/__tests__/check-tasks.test.mjs` 566–572. sor) csak az egybeeső
  esetet teszteli (mindkét program véletlenül `NEXUS-DEMO`), nem az eltérő
  esetet — a teszt neve kicsit félrevezető, de a mögöttes kódviselkedés
  helyes.
- **(b) Háromszoros hibajelentés fabrikált `program` esetén**: ha egy task
  `program:` mezője teljesen kitalált (nem létező), a validátor HÁROM
  külön hibát ad ugyanarra a gyökér-okra: "program nem létezik",
  "milestone nem ellenőrizhető" ÉS "program eltér az epictől" (mind
  `field: 'program'` vagy `'milestone'`, ugyanarra a fájlra). Saját
  szkripttel igazoltam (3 elemű hibatömb egyetlen fabrikált `program`-ra).
  Ez üzenet-redundancia, nem hiányzó ellenőrzés — mindhárom üzenet önmagában
  igaz és félreérthetetlen, csak zajosabb, mint szükséges lenne.

Egyik megfigyelés sem éri el a blokkoló gap szintjét: egyik sem hiányzó
ellenőrzési kategória, mindkettő kód-esztétikai/teszt-elnevezési finomítás.
A megbízás döntési szabálya szerint ("ha csak apró, nem blokkoló
megjegyzésed van, fontold meg a PASS-t") ezeket megjegyzésként rögzítem,
nem teszem REQUEST_CHANGES alapjává — a végtelen review-kör elkerülése
érdekében, és mert egyik sem sérti a program vagy a task elfogadási
feltételeit.

### 7. `check-doc-links.mjs` és `secret-scan.mjs` — saját futtatás

```
npm run check:links   → OK, exit 0 (89 markdown-link, 8 ADR-útvonal, 155 ADR-említés)
npm run secret-scan    → OK, exit 0 (347 tracked fájl, 0 találat)
```

### 8. A 12 kötelező "done előtt" pont — tételes ellenőrzés

Végignéztem a README (92–140. sor) mind a 12 pontját a taskfájl teljes
Implementáció-szakasza (1–14. szakasz, a saját reviewval együtt) ellen:
mind a 12 pont strukturálisan és tartalmilag jelen van (goal/sikerkritérium/
kilépés a Végrehajtási naplóban és az evidence manifestben; tényleges
eredmény és scope-eltérés a 2., 13., 14. szakaszban; architekturális döntések
a 3. szakaszban; módosított fájlok a 2. szakaszban; base commit/branch a
5. szakaszban; parancsok/exit code-ok a 6., 13.4, 14.4 szakaszban; OS/shell/
Node-verziók a 7. szakaszban; negatív tesztek/biztonsági ellenőrzés/rollback
a 8. szakaszban; ismert korlátok a 9. szakaszban, immár a 25 hiba
bontásával; reviewer-mezők ezzel a szakasszal töltve ki; PASS/FAIL a 11.,
13.6 szakaszban; szinkron a 12., 13.7, 14.5 szakaszban). Egyetlen hiányzó
tétel sincs.

### Verdikt: **PASS**

Indoklás: mind a három korábbi gap (2 eredeti: EPICS-ID kereszthivatkozás
és státuszátmenet-kapu; 1 harmadik: epic-milestone vs. task-milestone
átívelés) ténylegesen, megfelelő mélységben, a koordinátor iránymutatása
szerint van kezelve — a `milestone`-oldalon dokumentált kivétel, NEM
szigorítás, a `program`-oldalon szigorú, kivétel nélküli kényszer. A
szintetikus reprodukció (2. pont) és a valós repo mindkét irányú
ellenőrzése (3. pont: 0 program-mismatch a milestone-crossing precedensen)
saját, független futtatással megerősítve, mindkét shellen. A séma
mezőleírásai (4. pont) konkrétan, ID-kre és értékekre lebontva
dokumentálják az aszimmetriát. A tesztek (87/87) és a valós repo futása
(25 hiba, exit 1) reprodukálható és VÁLTOZATLAN a 2. körhöz képest. A saját
negyedik-gap keresésem (6. pont) csak apró, nem blokkoló megfigyeléseket
talált, funkcionális hiány nélkül — élve a megbízás döntési szabályával,
ezt PASS-ként zárom, megjegyzésekkel, a végtelen review-kör elkerülése
végett.

### Nyitott, nem blokkoló megjegyzések (follow-up, opcionális)

1. `scripts/__tests__/check-tasks.test.mjs` 566–572. sor tesztneve
   ("does not also get a spurious mismatch error") pontosítható lenne
   egy második esettel, amely kifejezetten az ELTÉRŐ program + orphan
   kombinációt fedi le (ma véletlenül egybeeső programmal teszteli) — a
   kódviselkedés emögött ma is helyes.
2. `checkEpicsReferences()` fabrikált `program` esetén 3 külön hibát ad
   ugyanarra a gyökér-okra (program nem létezik + milestone nem
   ellenőrizhető + program eltér az epictől) — üzenet-redundancia, nem
   hiányzó ellenőrzés; deduplikálható lenne egy jövőbeli csiszolásban.
3. A korábbi körökből örökölt, fájlhatáron kívüli nyitott tételek (23
   `blocked_reason`-hiány, 2 `execution_evidence`-hiány, a `pull_request`-
   trigger `HEAD~1`-szemantikájának élő GitHub Actions-validálatlansága)
   VÁLTOZATLANUL nyitottak — ezek koordinátor-szintű, a DP-003 fájlhatárán
   kívüli döntést igényelnek, nem ezen review hatásköre.

A frontmatter `status` mező ezzel a review-val **`done`-ra vált** (ld. a
fájl elején).
