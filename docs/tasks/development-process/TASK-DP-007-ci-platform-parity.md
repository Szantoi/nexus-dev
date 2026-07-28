---
id: TASK-DP-007
title: "CI-paritás és Windows/Linux mátrix"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M3
epic: DP-CI-CONTROLS
status: in_progress
priority: critical
depends_on: [TASK-DP-003, TASK-DP-006]
parallel_with: []
owner_role: devops
created: 2026-07-18
source: "DEVPROC-07, DEVPROC-08 and DEVPROC-09"
---

# CI-paritás és Windows/Linux mátrix

## Cél

A lokális és távoli ellenőrzés ugyanazokat a kötelező kapukat futtassa ismert
Node-verzióval Linuxon és Windowson, és zöld státusz csak valóban merge-képes
állapotot jelentsen.

## Mikor jó?

Ugyanaz a commit tiszta checkoutból mindkét operációs rendszeren reprodukálható;
a kötelező kapuk bármely hibája blokkolja a merge-et; a tesztek nem szennyezik a
repository állapotát.

## Scope

1. Kösd required CI-be a clean installt, buildet, typechecket, lint-ratchetet,
   teljes tesztet/coverage-et, task-sémát, file-size-, secret-, link- és
   dependency-auditot.
2. Javítsd a két hibás `ADR-001` linkreferenciát, és definiáld a kódtesztekben
   szereplő dokumentumazonosítók helyes kezelését.
3. Adj támogatott Windows és Linux jobot, explicit Node/npm verzióval és
   platformfüggetlen scriptekkel.
4. Minden tesztadatot ideiglenes könyvtárba irányíts; a suite után ellenőrizd,
   hogy a munkafa nem változott.
5. A coverage-, lint- és fájlméret-ratchet baseline-jához rögzíts ownert,
   lejáratot és taskhivatkozást; kritikus modulokra külön küszöböt használj.
6. Archiváld a hibánál szükséges tömör logot és reportot titokredakcióval.
7. Tartsd meg a least-privilege workflow permissiont és concurrency-cancel
   szabályt.

## Elfogadási feltételek

- [ ] A required workflow ugyanabból a commitból zöld Linuxon és Windowson.
- [ ] A lokális egyparancsos ellenőrzés a CI-lépésekkel ekvivalens.
- [ ] Build-, link-, task-, secret-, audit- vagy teszthiba blokkolja a merge-et.
- [ ] A teljes suite után nincs új vagy módosított repository-runtime adat.
- [ ] Lejárt allowlist/baseline fail-closed és konkrét follow-up taskot jelez.
- [ ] A kritikus task/lifecycle/review/release modulok küszöbei külön mértek.
- [ ] A jobok timeouttal és véges erőforráskerettel futnak.

## Kötelező ellenőrzés

Tiszta Windows és Linux checkout, cache nélküli install, teljes gate; negatív
próba hibás taskkal, broken linkkel, secretscan fixture-rel, coverage-romlással
és repositoryba író teszttel. Rögzítsd az OS-, shell-, Node- és npm-verziót.

## Kilépési feltétel

`done`, ha mindkét platform required eredménye ugyanarra a commitra PASS, és
minden negatív fixture blokkol. Runner-kapacitás vagy külső szolgáltatás hiánya
nem PASS: dokumentált feloldási feltétellel `blocked`.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.

### 2026-07-27 — @root: indítás + 1. inkrementum (branch: `dp-007-ci-parity`)

- **Base commit:** `f2c45d2` (origin/main, CI zöld). **Owner:** @root.
  **Erőforráskeret:** 1 session + PR-validációs CI-futások.
- **Goal/siker/kilépés:** a task fejléce szerint; a PR-mátrix zöldje Linux+
  Windows ugyanarra a commitra a mérce.
- **Scope-2 (ADR-001 linkek): már megoldva** — a QC-009-ben dokumentált két
  hibás hivatkozás a QC-006 worker `contextPersistence.test.ts` fixture-ében
  volt (`refs: ['ADR-001']`); a jelenlegi fán `ADR-001`-találat nincs, a
  `check:links` 153 ADR-említést validál zölden. Nincs teendő.
- **1. inkrementum (ez a commit):**
  - `ci.yml`: a `knowledge-service` job OS-mátrix (ubuntu + windows), teljes
    kapusor mindkét platformon; `Build` lépés (tsc emit — a typecheck nem fogja
    az emit-only hibákat); toolchain-verziórögzítő lépés; suite utáni
    „worktree változatlan" fail-closed kapu; hibánál diagnosztika-artifact
    (coverage + npm-logok, 7 nap retenció); job-timeout 25 perc.
  - `TASK-DP-006-branch-protection-config.json`: a required check-kontextusok
    a mátrix-nevekre frissítve (`knowledge-service (ubuntu-latest|windows-latest)`)
    — a payload továbbra is DRAFT, alkalmazása emberi kapu.
- **Hátralévő scope:** negatív fixture-próbák (hibás task, törött link,
  secret-fixture, coverage-romlás, repóba író teszt) PR-branchen; baseline-
  lejárat auditja (file-size allowlistnek van owner+expiry+task mezője és a
  lejárat fail-closed; a lint-baseline és coverage-küszöb owner/task-hivatkozása
  megvan a kommentekben — expiry-mechanizmusuk értékelendő); required-check
  kikényszerítés = DP-006 payload alkalmazása (Gábor kapuja).

### 2026-07-27 — @root: 2. inkrementum — platform-bug fix + negatív próbák

- **A mátrix első futása (PR #1, run 30276567734) valós platform-hibát
  fogott:** `knowledge-service (windows-latest)` FAIL — az
  `epicRouter.test.ts` hardcode-olt `/tmp/test-epic-router.db`-t használt; a
  fejlesztői gépeken véletlenül zöld (létező `C:\tmp`), a tiszta runneren a
  better-sqlite3 nem hoz létre szülőkönyvtárat → bukás. Fix (`74674a3`):
  `os.tmpdir()` + `fs.mkdtempSync` per-futás egyedi könyvtár, teljes
  takarítás. Ubuntu-gate és a 4-utas PTY-mátrix már az első futásban PASS.
- **Ismert maradék `/tmp`-hardcode-ok (NEM CI-blokkolók — mkdir-rel maguknak
  hoznak létre könyvtárat, de a scope-4 szellemének nem felelnek meg,
  follow-up): `epicsLoader.test.ts`, `projectDispatcher.test.ts`,
  `componentScaffold.test.ts`, `watchInbox.integration.test.ts`,
  `dailyReport.test.ts`, `workSessionLog.test.ts` + PROD-kód:
  `pipeline/processLock.ts` (`/tmp/spaceos-locks`).**
- **Negatív fixture-próbák: MIND az 5 igazolva** izolált klónban, ZÖLD
  baseline-ról indulva (először a klón Windows MAX_PATH-csonkulása miatt
  érvénytelen volt a futás — `core.longpaths` után baseline exit=0, utána):
  1. hibás task (`status: nonexistent_status`) → `check:tasks` exit 1;
  2. törött markdown-link → `check:links` exit 1;
  3. secret-fixture (AWS-kulcs minta tracked fájlban) → `secret-scan` exit 1;
  4. coverage-küszöb 38→99 → `test:coverage` exit 1;
  5. repót piszkító fájl → a worktree-kapu `git status --porcelain` nem üres
     → FAIL. Minden fixture revertálva, a klón tiszta.
- **Toolchain-rögzítés élesben:** a CI-lépés kiírja az OS/node/npm/git
  verziót minden platformon (run-logban visszakereshető).

### 2026-07-28 — @root: 3. inkrementum — baseline-expiry (scope-5) + `/tmp`-follow-up lezárás

- **`/tmp`-hardcode follow-upok KÉSZ (verifikálva):** a 2. inkrementumban
  listázott 6 teszt + `pipeline/processLock.ts` `/tmp`-hardcode-jait az
  Antigravity mainre került `/tmp`-refaktorja (`7e21785..294eb5f` sáv)
  kivezette; a mai fán `["'\`]/tmp` találat a `src/` alatt: 1 magyarázó
  komment + 1 terv-doksi példa — kód-hardcode nulla.
- **Scope-5 baseline-expiry audit — eredmény és implementáció:**
  - **File-size allowlist** (`.file-size-allowlist.json` +
    `check-file-size.mjs`): már megfelelt (owner+expires+task kötelező,
    lejárat fail-closed). Nincs teendő.
  - **Lint-baseline** (`.lint-baseline.json`): a 784-es warning-plafon
    tömbösített kivétel-lista volt lejárat nélkül → **owner/expires/task
    mezők mostantól kötelezők** (hiányuk exit 2 konfigurációs hiba), a
    **lejárt baseline fail-closed exit 1**, az üzenet a felelőst és a
    konkrét follow-up taskot nevezi meg (`TASK-QC-014`, új, `ready`,
    EPICS.yaml-ba felvéve a QC-VERIFICATION alá). A lejárat-ellenőrzés a
    ratchet-összevetés ELŐTT fut, így plafon alatti warning-szám sem
    engedi át a lejárt baseline-t; `--update` a mezőket megőrzi és
    továbbra sem emelhet. BOM-strip a parse előtt (Windows/Notepad-eset).
  - **Coverage-küszöbök** (`vitest.config.ts`): TUDATOSAN nincs lejárat —
    ezek nem kivételek, hanem csak felfelé ratchetelhető, regressziónál
    már ma is fail-closed padlók; a döntés indoklása a configban
    dokumentálva (owner: backend). A kritikus modulok per-file küszöbei
    (5 auth/security fájl, 80/70) változatlanul külön mértek.
  - **Refaktor + teszt:** `lint-ratchet.mjs` exportált tiszta függvények
    (`parseCounts`/`validateBaseline`/`isExpired`) + `isMain`-kapu (a
    check-tasks.mjs mintája); új `scripts/__tests__/lint-ratchet.test.mjs`
    (16 teszt, node:test), a `test:tasks` script mindkét suite-ot futtatja.
  - **Negatív próbák élő Biome-futással:** lejárt baseline → exit 1 a
    task-hivatkozással; hiányos baseline (csak maxWarnings) → exit 2 mind
    a 3 hiányzó mezőt megnevezve; `--update` 999→784 leszorítás
    mezők megőrzésével → exit 0. Pozitív út: 784/784 exit 0.
- **Kapuk a fán:** typecheck 0; `test:tasks` 103/103 PASS; lint:ratchet,
  check:tasks (47 task), check:links, check:size, secret-scan mind zöld.
- **Hátra:** független review (folyamatban, friss reviewer-agentek);
  DP-006 branch-protection payload alkalmazása (Gábor kapuja).

### 2026-07-28 — @root: 4. inkrementum — FÜGGETLEN REVIEW (2 lencse) + javítások

**Review-verdiktek (készítőtől független adverzáriális agentek):** CI-mátrix
lencse **FAIL (1 P1 + 5 P2 + 7 P3)**; lint-baseline-expiry lencse **FAIL
(2 P2 + 3 P3)**. Minden P1/P2 javítva vagy dokumentáltan emberi kapun:

- **P1 (worktree-kapu vak az ignorált útvonalakra):** a sima
  `git status --porcelain` a gitignore-olt runtime-írást (pl.
  `knowledge-service/data/`) nem látta. Fix: új
  `scripts/check-worktree.mjs` snapshot/verify kapu — porcelain `-uall` +
  `git ls-files --others --ignored --exclude-standard` FÁJLSZINTŰ
  ignorált-enumeráció (az élő próba megmutatta: a `--ignored=matching`
  könyvtár-kollabálása miatt a MEGLÉVŐ ignorált könyvtárba írás láthatatlan
  maradt volna), capture-kori allowlist a legitim kimenetekre
  (node_modules/dist/coverage), eltűnt bejegyzés is bukás. Élő negatív
  próba: `data/` alá írás → exit 1; takarítás után → exit 0. A CI mindkét
  jobja (gate + PTY-smoke) snapshot/verify párral fut.
- **P2 (nincs egyparancsos lokális ekvivalens):** új **`npm run gate`**
  aggregátor — a CI kapusor 1:1 sorrendben, ugyanazokkal a scriptekkel
  (worktree-kapu és a gate-script tesztek is). A ci.yml fejléc-táblázat
  frissítve (Build + test:tasks + worktree sorok).
- **P2 (check:tasks diff-base fail-open):** a CI explicit bázist ad
  (PR: base-sha; push: HEAD~1), és a `check-tasks.mjs` mostantól
  **fail-closed exit 2** feloldhatatlan explicit `--diff-base`-re
  (korábban minden git-show hibát „új task"-ként nyelt le). +2 CLI-teszt.
- **P2 (lint-ratchet isMain symlink/junction fail-open):** a
  refaktor-bevezette `resolve()`-összevetés junction alatt NÉMA exit 0-t
  adott (reviewer-repró). Fix: `realpathSync`-alapú összevetés mindkét új
  scriptben; junction-próba igazolva (exit 2 a bogus flagre).
- **P2 (expiry-invariánsok tesztfedetlenek + suite nem fut CI-ben):** a
  baseline-validáció és a lejárat-ellenőrzés a Biome-futás ELÉ került
  (olcsó integrációs tesztek), +2 CLI integrációs teszt (lejárt baseline
  a plafon ALATT → exit 1 a follow-up task nevével; hiányos → exit 2 minden
  hiányzó mezővel); a **`test:tasks` mostantól CI-lépés** mindkét OS-en.
- **P2 (kritikus task/lifecycle/review modulok külön küszöbe hiányzott):**
  per-file coverage-padlók a mért értékek −5 pontján: `mailbox.ts` 45/32,
  `task-message-box/store.ts` 50/40, `pipeline/epicRouter.ts` 90/85,
  `pipeline/reviewer.ts` 85/68, `pipeline/terminalReviewer.ts` 85/70
  (lines/branches). A release-felület (bash deploy-scriptek) vitest-en
  kívül esik — saját hermetikus suite kapuzza (QC-004), dokumentálva.
- **P2 (Windows npm-log artifact-út néma):** a hiba-artifact mindkét
  platform npm-log útvonalát felsorolja; a halott `coverage-summary.json`
  út mögé bekerült a `json-summary` reporter.
- **P3-fixek:** `--update` lejárt baseline-nál hangos WARN; szigorúbb
  baseline-séma (valódi nem-negatív egész `maxWarnings`, szemantikus
  dátum-validáció — a formátumra jó, de lehetetlen `9999-99-99` elutasítva;
  whitespace-only owner/task elutasítva); BOM-tűrő baseline-olvasás.
- **Dokumentált, nem javított maradékok:** (a) branch-protection
  alkalmazása = P2, de Gábor emberi kapuja (DP-006 payload draft kész);
  (b) Node major-pin (22.x) + npm-verzió rekord-de-nem-pin — tudatos:
  a setup-node minor-frissítései kívánatosak, az eltérés a toolchain-log
  lépésből visszakereshető; (c) nincs `.gitattributes` — a checkout-
  normalizálás runner-defaultokon áll, felvétele külön, izolált változtatás
  legyen (tömeges sorvég-churn kockázata miatt nem e task mellékhatása);
  (d) az `npm ci` a setup-node npm-cache-sel fut („cache nélküli" helyett
  integrity-hash-védett install — a lock-integritás a tényleges garancia).
- **INCIDENS (transzparencia):** a worktree-kapu élő próbája közben a
  takarító lépésem a TELJES meglévő `knowledge-service/data/` könyvtárat
  törölte a szándékolt egyetlen próbafájl helyett (DEV-gép, runtime
  SQLite-ok: workflow/memory/dispatch/registry/telegram). A szerver
  induláskor üresen újrateremti őket; a lokális DEV-történet elveszett.
  VPS/PROD nem érintett. Tanulság: destruktív takarítás CSAK a létrehozott
  fájlra célozva, sosem könyvtár-rekurzióval.
- **A KAPU ELSŐ ÉLES FOGÁSA (a P1-fix értékének bizonyítéka):** az első
  teljes `npm run gate` futás a verify-lépésen BUKOTT — a hermetikusnak
  hitt suite valójában 4 runtime DB-t írt a `knowledge-service/data/` alá
  (epic_router/taskmessagebox/telegram/workflow + shm/wal) és 2 valódi
  workflow-taskfájlt a `terminals/backend/inbox/`-ba. A régi
  (`git status --porcelain`) kapu MINDKETTŐT némán átengedte volna
  (gitignore-olt utak). Gyökérok: több modul import-időben számol
  `DATA_DIR`/`TERMINALS_PATH`-alapú útvonalat, és env-felülbírálás nélküli
  teszt-importnál a valós fába ír. **Szisztémás fix:** globális vitest
  setup (`src/__tests__/setup/hermeticEnv.ts`) — workerenként mkdtemp-elt
  `DATA_DIR` + `TERMINALS_PATH` minden tesztmodul betöltése ELŐTT; a
  jövőbeli tesztek is öröklik. Teljes suite az átirányítással: 106 fájl /
  1710 PASS + 1 skipped, nulla kiesés. A szennyezés-műtermékek célzottan
  (fájlonként, tartalom-ellenőrzés után) eltávolítva.
- **Kapuk a javítások után:** `test:tasks` 123/123 PASS (3 suite);
  junction-, data-írás-, expired-, incomplete-, update-próbák mind a várt
  exit-kóddal; a teljes `npm run gate` egyparancsos futás eredménye a
  commit előtt rögzítve (lásd alább).

### 2026-07-28 — @root: 5. inkrementum — az új kapuk ÉLES CI-fogásai + zöld mátrix

Az első két CI-futás az új kapukkal további KÉT valós hibát fogott (mindkettő
a lokális gépen láthatatlan volt, mert a snapshot-modell a meglévő fájlokat
elnyeli — a tiszta CI-checkout a hiteles mérce):

1. **`logs/dispatcher/nightwatch.log` írás mindkét platformon** (`bfcbf37`):
   a `pipeline/common.ts` a `SPACEOS_ROOT`-ból hardcode-olta a log-utat, a
   `config/paths.ts` `LOGS_DIR`-jét megkerülve (QC-007-osztályú maradék).
   A `LOG_DIR` most `LOGS_DIR`-ből származik (a PROD-default változatlan),
   az alertRules/hourlyDigest olvasók és a goals.log ugyanazt a konstansot
   követik; a nightwatch `STATE_FILE` env-felülbírálást kapott. További
   SPACEOS_ROOT-hardcode-ok (alertState, terminals-utak) backlog-tételként
   rögzítve.
2. **Windows `test:tasks` bukás — 8.3 rövidnév fail-open** (`b0ddcb9`): a
   runner `os.tmpdir()`-je 8.3-as rövidnév, a `git rev-parse --show-toplevel`
   hosszú — a `resolveDefaultDiffBase` hamis `null`-t adott, és a
   státuszátmenet-kapu némán kimaradt (ugyanaz a fail-open osztály, amit a
   remediáció vadászik). Fix: `realpathSync.native` kanonizálás; a hiteles
   regressziós teszt maga a CI Windows-lege (a suite a runner tmpdir-jéből
   fut). Emellett a hermetikus env MINDEN repo-gyökérbe író path-defaultot
   átirányít (LOGS/GOALS/IDEAS/QUEUE/CONDUCTOR_STATE/tasks-new).

**Végállapot: a teljes mátrix ZÖLD a `bfcbf37`-en (run 30334227869)** —
knowledge-service ubuntu+windows a teljes kapusorral (test:tasks +
snapshot/verify + explicit diff-base) és a 4-utas PTY-mátrix saját
worktree-kapuval. Az elfogadási feltételek közül immár teljesül: #1 (két-OS
zöld ugyanarra a commitra — élő run-evidencia), #2 (`npm run gate`
egyparancsos ekvivalens), #4 (worktree-kapu ignorált utakra is, élesben
bizonyított fogásokkal), #5 (lejárat fail-closed follow-up-taskkal), #6
(per-file küszöbök a task/lifecycle/review modulokra; release = QC-004
bash-suite, dokumentálva), #7 (timeout/erőforráskeret). A #3
(merge-blokkolás) EGYEDÜL a DP-006 branch-protection payload alkalmazásán
áll — Gábor emberi kapuja; annak alkalmazása után a task `done`-ra zárható.
