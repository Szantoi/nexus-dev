---
id: TASK-DP-010
title: "Fejlesztői és operátori folyamatdokumentáció"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M4
epic: DP-PROCESS-DOCUMENTATION
status: blocked
blocked_reason: >
  Nem indítható, amíg TASK-DP-004, TASK-DP-005, TASK-DP-007, TASK-DP-008, TASK-DP-009 el nem készül (a program README
  végrehajtási hulláma szerinti sorrend).
priority: high
depends_on: [TASK-DP-004, TASK-DP-005, TASK-DP-007, TASK-DP-008, TASK-DP-009]
parallel_with: []
owner_role: technical-writer
created: 2026-07-18
source: "DEVPROC-03, DEVPROC-05 and DEVPROC-10"
---

# Fejlesztői és operátori folyamatdokumentáció

## Cél

Egy új ember vagy CLI-agent clean-room környezetből, rejtett chatkontekstus és
szóbeli tudás nélkül végig tudja vinni a támogatott fejlesztési folyamatot és a
hibahelyreállítást Windows és Linux környezetben.

## Mikor jó?

A dokumentációból reprodukálható a setup, taskindítás, checkpoint, teszt, PR,
review, archive, release és recovery; minden parancs, felelősség, emberi kapu és
hibaút aktuális.

## Scope

1. Dokumentáld a célhierarchiát, kanonikus állapotmodellt és projekciókat.
2. Adj fejlesztői quickstartot PowerShellhez és Bashhez rögzített előfeltételekkel.
3. Írd le a teljes task-lifecycle parancsait, evidence manifestet, review- és
   archiválási folyamatot.
4. Dokumentáld a branch/PR policyt, helyi CI-paritást és a required checkeket.
5. Adj release, smoke/canary, rollback és incidens runbookot.
6. Dokumentáld a state/todo/memória helyes célját és a reconciliationt.
7. Adj troubleshootingot stale lock, split-brain, sérült projekció, CI-platform
   eltérés és félbeszakadt release esetére.
8. Távolítsd el vagy jelöld történetinek az ellentmondó leírásokat.

## Elfogadási feltételek

- [ ] Windows és Linux clean-room quickstart egyaránt reprodukált.
- [ ] A dokumentációban nincs implicit, csak chatben ismert lépés.
- [ ] Minden parancs létezik, `--help`-je és hibamódja dokumentált.
- [ ] A forrás-of-truth és projekció fogalmak minden dokumentumban egyeznek.
- [ ] A review, archive és release emberi/jogosultsági kapui egyértelműek.
- [ ] A docs linkcheck és taskcheck zöld.
- [ ] A dokumentáció verzió- és utolsó ellenőrzési dátumot tartalmaz.

## Kötelező ellenőrzés

Két clean-room walkthrough: egy Windows PowerShell és egy Linux Bash. A
végrehajtó nem lehet a dokumentáció fő szerzője, és minden eltérést issue/task
formájában rögzít. Titok vagy éles deploy nem szükséges a walkthrough-hoz.

## Kilépési feltétel

`done`, ha mindkét walkthrough PASS, minden dokumentumlink zöld és nincs
kritikus, csak implicit tudásra épülő lépés. Hiányzó platformhozzáférés esetén
`blocked`, nem „feltételezett PASS”.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
