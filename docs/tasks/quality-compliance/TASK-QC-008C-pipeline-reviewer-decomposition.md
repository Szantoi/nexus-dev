---
id: TASK-QC-008C
title: pipeline/reviewer.ts felbontása felelősség szerint
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

# pipeline/reviewer.ts felbontása felelősség szerint

## Cél

A `knowledge-service/src/pipeline/reviewer.ts` (1053 sor) a 800 soros méretkapu
allowlistjén él lejárattal. A dual-review folyamat konfigurációbetöltést,
DONE-metaadat parszolást, promptépítést, review-futtatást és eszkalációs
üzenetírást kever; ezeket külön modulokba kell bontani.

## Indoklás (miért külön task)

A reviewer a minőségkapu-pipeline része (készítő ≠ ellenőr elv, QUALITY.md §8);
bontása a review-folyamat viselkedés-pinjeit igényli (unit/reviewer.test.ts
bővítése), ami önálló munkamenetet érdemel.

## Javasolt vágási felületek (a jelenlegi szerkezet alapján)

1. `review/config.ts` — `loadConfig`, `loadPromptTemplate`, `loadTaskTypeConfig`.
2. `review/doneMetadata.ts` — DONE-fájl parszolás (`extractTerminal`,
   `extractRef`, `extractModel`, `extractTaskType`, `extractReviewType`,
   `findInboxFile`) — a terminalReviewer.ts-szel KÖZÖS helper-réteg
   (duplikáció-megszüntetés, lásd TASK-QC-008D).
3. `review/promptBuilder.ts` + `review/responseParser.ts`.
4. `review/dualReview.ts` — futtatás + eszkaláció/reject üzenetek.

## Elfogadási feltételek

- [ ] Egyik kivont modul sem nagyobb 800 sornál, és nem okoz körkörös importot.
- [ ] A reviewer.test.ts zöld marad; a közös helper-réteg a terminalReviewer
      számára is használható (QC-008D-vel egyeztetve).
- [ ] `npm run typecheck && npm test && npm run check:size` zöld; a
      `src/pipeline/reviewer.ts` allowlist-tétel törölve.
