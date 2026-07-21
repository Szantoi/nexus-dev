---
id: TASK-DP-005
title: "Egységes task discovery és státusz API"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M2
epic: DP-TASK-API
status: blocked
blocked_reason: >
  Nem indítható, amíg TASK-DP-004 el nem készül (a program README
  végrehajtási hulláma szerinti sorrend).
priority: high
depends_on: [TASK-DP-003, TASK-DP-004]
parallel_with: []
owner_role: backend
created: 2026-07-18
source: "DEVPROC-05"
---

# Egységes task discovery és státusz API

## Cél

A CLI, MCP, HTTP, mailbox és CI ugyanabból a task repositoryból lássa a teljes
programalapú taskfát, beleértve az aktív és archivált feladatokat.

## Mikor jó?

Az ID-alapú státuszlekérdezés a `quality-compliance`, `island-runtime`,
`development-process` és későbbi programokat automatikusan megtalálja; ugyanazt
a státuszt és provenance-adatot adja minden interfészen.

## Scope

1. Váltsd ki a `new/active/archive` könyvtárakat feltételező legacy scannert.
2. Használd a DP-003 discovery/index és a DP-004 lifecycle repositoryját.
3. Adj ID-, program-, milestone-, epic-, status- és owner-szűrést.
4. Tedd láthatóvá a blokk okát, dependencyket, verziót és utolsó transitiont
   jogosultság szerint.
5. Tarts kompatibilitási választ a régi MCP/HTTP klienseknek, de adj deprecation
   metrikát és kivezetési dátumot.
6. Biztosíts rendezett, lapozható és determinisztikus kimenetet.

## Elfogadási feltételek

- [ ] Minden valós `TASK-*` ID pontosan egyszer található meg.
- [ ] Program- és archívumkönyvtár hozzáadása kódmódosítás nélkül felfedezhető.
- [ ] MCP, HTTP és CLI kontraktteszt azonos státuszt igazol.
- [ ] Az ismeretlen és duplikált ID egyértelmű, fail-closed hibát ad.
- [ ] Path traversal, jogosulatlan fájlolvasás és symlink escape negatív tesztje
  zöld.
- [ ] A legacy használat mérhető és dokumentált.

## Kötelező ellenőrzés

Valós repository-integráció, temp fixture új programmal, archive discovery,
duplikált ID, hibás frontmatter, path traversal, Windows elérési út és MCP/HTTP
contract teszt.

## Kilépési feltétel

`done`, ha minden támogatott interfész azonos repositoryt használ, és a régi
scanner már nem autoritatív. Biztonsági vagy státuszeltérés esetén ne kapjon
kompatibilitási PASS-t.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
