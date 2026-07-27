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
