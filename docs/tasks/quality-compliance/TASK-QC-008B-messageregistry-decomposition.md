---
id: TASK-QC-008B
title: messageRegistry.ts felbontása felelősség szerint
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

# messageRegistry.ts felbontása felelősség szerint

## Cél

A `knowledge-service/src/messageRegistry.ts` (1118 sor) a 800 soros méretkapu
allowlistjén él lejárattal. A fájl SQLite-sémát, cache-t, hash-integritást és
üzenet-életciklust kever; ezeket külön modulokba kell bontani a publikus
exportok megtartásával.

## Indoklás (miért külön task)

A message registry az üzenetintegritás (body-hash) és a mailbox-státuszkezelés
magja; hibás bontás csendes adatvesztést okozhat. Dedikált, tesztfókuszú
munkamenetet igényel, nem fért volna kockázat nélkül a TASK-QC-008 MCP-refaktor
mellé.

## Javasolt vágási felületek (a jelenlegi szerkezet alapján)

1. `messageRegistry/db.ts` — adatbázis-setup, séma, `getDb`/`initSchema`.
2. `messageRegistry/cache.ts` — TTL-es model-cache (`getCachedModel`, invalidálás).
3. `messageRegistry/integrity.ts` — body-hash számítás/pecsételés/ellenőrzés
   (`calculateBodyHash`, `stampFileWithHash`, `verifyMessageHash`, `verifyAllMessages`).
4. `messageRegistry/registry.ts` — core + query műveletek (`registerMessage`,
   `updateStatus`, `markAsRead`, ...), és a régi útvonalról re-export.

## Elfogadási feltételek

- [ ] Egyik kivont modul sem nagyobb 800 sornál, és nem okoz körkörös importot.
- [ ] A meglévő tesztek (messageModel, messageStatusHistory, mailbox) zölden maradnak.
- [ ] `npm run typecheck && npm test && npm run check:size` zöld; a
      `src/messageRegistry.ts` allowlist-tétel törölve.
