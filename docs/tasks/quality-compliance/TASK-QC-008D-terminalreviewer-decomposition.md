---
id: TASK-QC-008D
title: pipeline/terminalReviewer.ts felbontása felelősség szerint
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M3
epic: QC-MAINTAINABILITY
status: ready
priority: medium
depends_on: [TASK-QC-008]
parallel_with: [TASK-QC-008C]
owner_role: backend
created: 2026-07-18
source: "TASK-QC-008 B.3 (allowlist: .file-size-allowlist.json, lejárat 2026-10-18)"
---

# pipeline/terminalReviewer.ts felbontása felelősség szerint

## Cél

A `knowledge-service/src/pipeline/terminalReviewer.ts` (1017 sor) a 800 soros
méretkapu allowlistjén él lejárattal. A terminál-alapú review folyamat
szint-kiválasztást, DONE-parszolást, terminál-foglaltság kezelést,
promptépítést (Architect/Librarian) és kimenet-parszolást kever.

## Indoklás (miért külön task)

A terminalReviewer a reviewer.ts-szel átfedő helper-készletet tartalmaz
(`extractTerminal`, `extractRef`, `findInboxFile` duplikálva); a helyes bontás
a két fájl KÖZÖS rétegének kialakítása, ami a TASK-QC-008C-vel összehangolt,
önálló munkamenetet igényel.

## Javasolt vágási felületek (a jelenlegi szerkezet alapján)

1. Közös `review/doneMetadata.ts` használata (TASK-QC-008C-ben jön létre) —
   a duplikált extract/find helperek törlése innen.
2. `review/terminalAvailability.ts` — `isTerminalBusy`, `waitForTerminal`,
   `waitForReviewResponse`.
3. `review/terminalPrompts.ts` — Architect/Librarian promptépítők.
4. `review/terminalReview.ts` — futtatás + verdict-parszolás + orchestráció.

## Elfogadási feltételek

- [ ] Egyik kivont modul sem nagyobb 800 sornál, és nem okoz körkörös importot.
- [ ] A terminalReviewer.test.ts zöld marad; a reviewer.ts-szel közös helperek
      egyetlen példányban élnek.
- [ ] `npm run typecheck && npm test && npm run check:size` zöld; a
      `src/pipeline/terminalReviewer.ts` allowlist-tétel törölve.
