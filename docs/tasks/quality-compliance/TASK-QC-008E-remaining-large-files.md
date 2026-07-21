---
id: TASK-QC-008E
title: További 800+ soros fájlok felbontása (mailbox, task-message-box store, telegramBot, epic-router)
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M3
epic: QC-MAINTAINABILITY
status: ready
priority: low
depends_on: [TASK-QC-008]
owner_role: backend
created: 2026-07-18
source: "TASK-QC-008 B.3 (allowlist: .file-size-allowlist.json, lejárat 2026-10-18)"
---

# További 800+ soros fájlok felbontása

## Cél

A méretkapu (scripts/check-file-size.mjs) bevezetésekor a négy kiemelt fájlon
(QC-008A–D) túl négy további production fájl volt 800 sor felett. Ezek is
lejáratos allowlist-tételen élnek; a lejáratig (2026-10-18) fel kell bontani
őket, vagy dokumentált indokkal hosszabbítani.

## Érintett fájlok (2026-07-18-i sorszámok)

| Fájl | Sor | Megjegyzés |
|---|---|---|
| `src/mailbox.ts` | 943 | tárolás + task-életciklus + integritás keveredik |
| `src/task-message-box/store.ts` | 866 | TMB store |
| `src/pipeline/telegramBot.ts` | 835 | bot-transport + parancskezelés |
| `src/interfaces/http/routes/epic-router.routes.ts` | 821 | route + tokenlogika; folyamatban lévő biztonsági keményítés érinti — azzal egyeztetve bontandó |

## Indoklás (miért külön task)

Ezek a fájlok épphogy a limit felett vannak, és nem voltak a TASK-QC-008
scope-jában (ott az mcp.ts volt a kritikus). Bontásuk alacsonyabb kockázatú,
de mindegyik élő felületet érint (mailbox-fájlok, Telegram, epic-router REST),
ezért önálló, fájlonként külön commitolható munkamenetet érdemelnek.

## Elfogadási feltételek

- [ ] Minden érintett fájl 800 sor alatt, vagy dokumentáltan hosszabbított
      allowlist-tétellel él (indok + új lejárat + felelős).
- [ ] Egyik kivont modul sem okoz körkörös importot.
- [ ] `npm run typecheck && npm test && npm run check:size` zöld; a felbontott
      fájlok allowlist-tételei törölve.
