---
id: TASK-DP-004
title: "Tranzakciós task-lifecycle és állapotprojekciók"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M2
epic: DP-TASK-LIFECYCLE
status: ready
priority: critical
depends_on: [TASK-DP-002, TASK-DP-003]
parallel_with: []
owner_role: backend
created: 2026-07-18
source: "DEVPROC-03 and DEVPROC-10"
---

# Tranzakciós task-lifecycle és állapotprojekciók

## Cél

A `start`, `checkpoint`, `finish`, `review` és `archive` művelet egyetlen
validált életciklust használjon, amely részleges hiba után idempotensen
helyreállítható és nem hagy ellentmondó task-, EPICS-, state- vagy todo-állapotot.

## Mikor jó?

Minden transition atomikus, vagy tartós journalból determinisztikusan
befejezhető/visszagörgethető; párhuzamos agent nem írhatja felül a frissebb
állapotot; a projekciók újraépíthetők.

## Scope

1. Implementáld a DP-002 transition- és repository-szerződését CLI/API
   belépési pontokkal.
2. Követeld meg induláskor a goalt, sikerkritériumot, kilépési feltételt,
   ownert, base commitot és erőforráskeretet.
3. Használj verziót/CAS-t és lockot vagy tranzakciót a párhuzamos írás ellen.
4. Generáld vagy reconciliáld az `EPICS.yaml`, `state.md` és `todo.md`
   projekciókat; a `MEMORY.md` csak explicit tartós tanulságot kapjon.
5. Tarts append-only transition- és review-auditot érzékeny adat nélkül.
6. Biztosíts dry-run, diff, crash-recovery és projekció-újraépítés parancsot.
7. Tarts kompatibilitási adaptert a kézi taskfájlokhoz dokumentált kivezetéssel.

## Elfogadási feltételek

- [ ] Tiltott státuszátmenet és stale version írás fail-closed.
- [ ] Két párhuzamos owner közül legfeljebb egy indíthatja ugyanazt a taskot.
- [ ] Félbeszakított transition után nincs tartós split-brain.
- [ ] A projekció törlés után a kanonikus store-ból újraépíthető.
- [ ] A state/todo eltérés géppel észlelhető és számlálható.
- [ ] Minden transition tartalmaz actor-, idő-, előző/új állapot- és taskazonosítót.
- [ ] A régi kézi folyamat migrációs és rollback útja dokumentált.

## Kötelező ellenőrzés

Konkurencia-, crash-injection-, restart-, stale-write-, idempotens retry- és
projection rebuild integrációs teszt Windows-kompatibilis ideiglenes
könyvtárakkal. A teszt nem írhat repository `data/` vagy terminálállapotba.

## Kilépési feltétel

`done`, ha minden támogatott transition az új lifecycle-on halad, vagy az
átmeneti adapterhez mérhető kivezetési dátum tartozik. Adatvesztés, néma
overwrite vagy nem javítható reconciliation esetén állj meg.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
