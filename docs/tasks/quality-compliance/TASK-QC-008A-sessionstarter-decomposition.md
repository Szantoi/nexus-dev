---
id: TASK-QC-008A
title: sessionStarter.ts felbontása felelősség szerint
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M3
epic: QC-MAINTAINABILITY
status: ready
priority: medium
depends_on: [TASK-QC-008]
owner_role: backend
created: 2026-07-18
source: "TASK-QC-008 B.3 (allowlist: .file-size-allowlist.json, lejárat 2026-10-18)"
---

# sessionStarter.ts felbontása felelősség szerint

## Cél

A `knowledge-service/src/sessionStarter.ts` (1431 sor) a 800 soros méretkapu
allowlistjén él lejárattal. A fájl legalább négy, jól elváló felelősséget kever;
ezeket külön modulokba kell bontani úgy, hogy a publikus API (a jelenlegi
exportok) változatlan maradjon.

## Indoklás (miért külön task)

A TASK-QC-008 fő kockázata az MCP publikus szerződés volt; a sessionStarter
tmux-vezérlést és élő terminál-folyamatokat érint, amit friss kontextusú,
dedikált munkamenetben biztonságosabb bontani, mint az MCP-refaktorral egy
PR-ben (lásd TASK-QC-008 "Kockázat és rollback").

## Javasolt vágási felületek (a jelenlegi szerkezet alapján)

1. `session/tmuxDriver.ts` — tmux exec/send-keys/capture-pane, buffer- és
   placeholder-kezelés (`tmuxExec`, `sendChunks`, `injectMessageToSession`, ...).
2. `session/sessionContextBuilder.ts` — prompt/kontextus építés
   (`buildEscalatedPrompt`, `buildModeAwarenessContext`, `extractInboxContent`).
3. `session/terminalSession.ts` — session életciklus (`startTerminalSession`,
   `terminateColdSession`, running-ellenőrzések).
4. `session/workSessionSpawner.ts` — ADR-049 work session / raw worker spawning
   (`startParallelWorkSession`, `spawnRawWorkers`, `collectRawResults`).

## Elfogadási feltételek

- [ ] Egyik kivont modul sem nagyobb 800 sornál, és nem okoz körkörös importot.
- [ ] A meglévő importálók (mcp registry worker.tools, watchInbox, stb.) változatlan
      API-t látnak (re-export a régi útvonalról vagy import-frissítés).
- [ ] `npm run typecheck && npm test && npm run check:size` zöld; a
      `src/sessionStarter.ts` allowlist-tétel törölve.
