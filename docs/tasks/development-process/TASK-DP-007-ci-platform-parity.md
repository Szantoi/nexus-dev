---
id: TASK-DP-007
title: "CI-paritás és Windows/Linux mátrix"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M3
epic: DP-CI-CONTROLS
status: ready
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
