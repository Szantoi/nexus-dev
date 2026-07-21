---
id: TASK-ISL-016
title: Migrációs, fejlesztői és üzemeltetési dokumentáció lezárása
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M5
epic: ISL-DOCUMENTATION
status: blocked
blocked_reason: >
  A közvetlen TASK-ISL-002…015 függőségek nem mind done állapotúak. Elkészült
  az aktuális Codex/Linux rollout runbook, de a teljes Windows/Linux, három-CLI,
  federation, migration és clean-room dokumentáció csak a feature-taskok után
  zárható. Feloldás: minden függőség done és friss dokumentáció-review PASS.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-002, TASK-ISL-003, TASK-ISL-004, TASK-ISL-005, TASK-ISL-006, TASK-ISL-007, TASK-ISL-008, TASK-ISL-009, TASK-ISL-010, TASK-ISL-011, TASK-ISL-012, TASK-ISL-013, TASK-ISL-014, TASK-ISL-015]
parallel_with: []
owner_role: technical-writer
created: 2026-07-18
source: QUALITY.md sections 2, 3, 4 and 5
---

# Migrációs, fejlesztői és üzemeltetési dokumentáció lezárása

## Cél

A végleges rendszer telepítése, fejlesztése, migrálása, ellenőrzése és
helyreállítása chatkontextus nélkül, dokumentációból reprodukálható legyen.

## Mikor jó?

Egy új fejlesztő vagy operátor a README-k és runbookok alapján fel tud állítani
egy Windows és Linux runnert, mindhárom CLI-t, két izolált szigetet és a teljes
teszt/rollback folyamatot.

## Scope

1. Fő és modul-README-k frissítése a tényleges architektúrához.
2. CLI-adapter fejlesztői guide és capability/version compatibility táblázat.
3. Codex, Claude, Antigravity telepítés/auth/troubleshooting titkok nélkül.
4. Windows service és Linux systemd install/upgrade/uninstall runbook.
5. Legacy adat/config/mailbox migráció dry-run, végrehajtás és rollback.
6. Federation, backup/restore, DLQ és incident runbook.
7. ADR-index, OpenAPI/MCP tool szerződés és diagramszinkron.
8. Minden task Implementáció szakaszának teljességi auditja.

## Elfogadási feltételek

- [ ] Dokumentációs linkellenőrzés és parancs-smoke zöld.
- [ ] Egy tiszta Windows és Linux környezet setupja a dokumentációból reprodukált.
- [ ] Minden env/config mező egy helyen dokumentált, secretérték nélkül.
- [ ] CLI-verziómátrix valós platformbizonyítékra mutat.
- [ ] Migráció és rollback próbafuttatása dokumentált.
- [ ] A knowledge-értékelés „jelenlegi állapot” része eredménydokumentummal frissült.
- [ ] Task, EPICS, state, todo és memória állapotok konzisztenciája igazolt.

## Kötelező ellenőrzés

Link checker, minden dokumentált config/parser validáció, clean-room setup review,
parancsok shellcheck/PowerShell syntax checkje és task evidence audit.

## Kilépési feltétel

`done`, ha friss kontextusú dokumentáció-reviewer nem talál reprodukciót blokkoló
hiányt. Kézzel nem igazolt, csak leírt runbook nem fogadható el.

## Végrehajtási napló

### 2026-07-21 — részleges Codex/Linux runbook

Létrejött a
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md` dokumentum: cél,
architektúra, trust boundary, autonomous-management kapuk, Linux/Windows
platformevidence, service- és logútvonalak, pause/restart/rollback, GitHub-
publikálási higiénia és fennmaradó kockázatok. A deploy bundle saját README-je
is rögzíti a blocked-state és erőforrásvédelmet.

Ez részleges checkpoint; a TASK-ISL-016 a teljes program és clean-room review
előtt `blocked` marad.
