---
id: TASK-QC-001
title: Projektállapot, célhierarchia és leállási feltételek rendezése
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M1
epic: QC-GOVERNANCE
status: done
priority: high
depends_on: []
parallel_with: [TASK-QC-002, TASK-QC-003, TASK-QC-005, TASK-QC-007]
owner_role: coordinator
created: 2026-07-18
source: QUALITY.md sections 1 and 4
---

# Projektállapot, célhierarchia és leállási feltételek rendezése

## Cél

Egyetlen, géppel feldolgozható állapotforrásban jelenjen meg a program → projekt → mérföldkő → epic → task hierarchia, a mérhető cél és a leállási feltétel.

## Jelenlegi bizonyíték

- `docs/projects/EPICS.yaml` 2026-07-15-i állapotot mutat.
- Az `EPIC-KS-MCP-SPLIT` még `active`, az `EPIC-KS-ARCH-DECISION` még `pending`.
- A `terminals/root/todo.md` ugyanezeket 2026-07-15-én lezártnak jelöli.
- Az EPICS-séma csak epic-listát ír le; program-, mérföldkő- és stopping-condition mező nincs dokumentálva.

## Scope

1. Határozd meg és dokumentáld az `EPICS.yaml` kompatibilis séma-bővítését a program-, projekt-, mérföldkő-, cél- és leállási mezőkre.
2. Szinkronizáld a már lezárt MCP- és DDD-fázis állapotát a task-ledgerrel.
3. Vedd fel a QUALITY megfelelőségi programot és az ebben a könyvtárban lévő taskokat.
4. Adj minden mérföldkőhöz mérhető elfogadási feltételt.
5. Frissítsd a TypeScript típusokat és a YAML-parszolási teszteket, ha a séma runtime kódban is használt.
6. Dokumentáld, melyik fájl a kanonikus állapotforrás, és hogyan történik a szinkronizálás.

## Nem cél

- A taskokban leírt technikai javítások végrehajtása.
- Új projektmenedzsment UI készítése.

## Elfogadási feltételek

- [x] Az EPICS állapota nem mond ellent a task-ledgernek.
- [x] A teljes ötszintű hierarchia visszakövethető.
- [x] Van explicit, mérhető programcél és leállási feltétel.
- [x] Minden aktív epic egy létező taskfájlra mutat.
- [x] A YAML érvényes, és a kapcsolódó parser/graph tesztek zöldek.
- [x] Az állapotfrissítési eljárás dokumentált.

## Kötelező ellenőrzés

```bash
cd knowledge-service
npm run typecheck
npx vitest run src/__tests__/workflowModel.test.ts src/__tests__/graph*.test.ts
```

Emellett kézzel hasonlítsd össze az `EPICS.yaml`, a `docs/tasks/quality-compliance/README.md` és a `terminals/root/todo.md` állapotait.

## Átadandó bizonyíték

- Módosított állapotfájlok listája.
- Tesztkimenet.
- Rövid táblázat minden epic régi és új állapotáról.

## Kockázat és rollback

A séma bővítése eltörheti a régi parsereket. Visszaállításkor a séma- és kódmódosítást együtt kell revertálni; részleges rollback nem elfogadható.

## Implementáció (2026-07-18)

### Mi készült

1. **`docs/projects/EPICS.yaml` — additív séma-bővítés (version 1.0 → 1.1).**
   - Új top-level `programs[]` szekció: `id`, `name`, `project`, `goal` (mérhető cél),
     `stopping_condition` (explicit leállási feltétel), `status`, `milestones[]`
     (`id`, `name`, `status`, `acceptance` — mérföldkövenként mérhető elfogadási feltétel).
   - Két program felvéve: `NEXUS-KS-MODERNIZATION` (KS-M1 done, KS-M2 done, KS-M3 active)
     és `NEXUS-QUALITY` (QC-M1..M3 active, QC-M4 pending) — a README programcélja és
     leállási feltétele géppel olvasható formában.
   - Epic-szinten új, opcionális mezők: `program` (melyik programé), `milestone`
     (melyik mérföldkőben zárul), `tasks[]` (`id` + `file` — állapot NÉLKÜL, mert a
     task-állapot kanonikus forrása a task-frontmatter).
   - A bővítés ADDITÍV: az `epicsValidator.ts` az ismeretlen mezőket nem hibáztatja,
     régi parser nem törik (futó tesztekkel igazolva).

2. **Állapot-szinkron a `terminals/root/todo.md` ledgerrel.**
   - `EPIC-KS-MCP-SPLIT`: active → done (ledger 2026-07-15: 103 tool / 14 modul, 889 teszt zöld).
   - `EPIC-KS-ARCH-DECISION`: pending → done (ledger 2026-07-15: „A opció", scaffolding törölve, `046b8bb`).
   - A 4. fázis maradék refaktor-scope-ja (routes/, pipeline/, memoryStore, DomainError)
     új, `pending` backlog-epicbe került: `EPIC-KS-ARCH-REFACTOR` — így a done-státusz
     nem állít többet a bizonyítottnál, a backlog-tételek pedig nem vesznek el.

3. **NEXUS-QUALITY program + 7 QC-epic felvéve** a task-frontmatterek `epic` mezőivel
   1:1 azonos azonosítókkal: `QC-GOVERNANCE`, `QC-ARCHITECTURE`, `QC-SECURITY`,
   `QC-STABILITY`, `QC-VERIFICATION`, `QC-MAINTAINABILITY`, `QC-DOCUMENTATION`.
   Mind a 10 QC-task hozzá van rendelve (`tasks[]`), minden hivatkozott fájl létezik.
   Az 1. hullám epicjei `active`, a függő hullámok `pending` (QC-STABILITY ← QC-SECURITY;
   QC-DOCUMENTATION ← 5 epic). Kör-veszélyes task-függések (QC-010 ← minden;
   QC-009 ← QC-005) task-szinten dokumentálva, epic-szinten szándékosan nem élként.

4. **TypeScript-típusok** (`knowledge-service/src/graph/types.ts`, additív):
   új `ProgramMilestone`, `ProgramDefinition`, `EpicTaskRef` interfészek;
   `EpicDependency` + `program?`/`milestone?`/`tasks?`; `EpicsYaml` + `programs?`.
   Runtime-kód (loader, validátor, workflowManager) NEM változott — nem is kellett,
   mert minden új mező opcionális.

5. **Kanonikus állapotforrás + szinkron-eljárás dokumentálva** (EPICS.yaml fejléc-komment,
   todo.md fejléc, `EpicsYaml` JSDoc):
   - program/mérföldkő/epic szint: `docs/projects/EPICS.yaml` (kanonikus);
   - task szint: a task-fájl frontmattere (kanonikus);
   - emberi ledger: `terminals/root/todo.md`.
   Szinkron minden task-zárásnál: frontmatter → EPICS.yaml → todo.md Kész-sor →
   `updated` mező; eltérésnél a frissebb, bizonyítékos forráshoz igazítunk.

### Futtatott parancsok és eredmény

```
cd knowledge-service && npm run typecheck
→ zöld (tsc --noEmit, 0 hiba)

npx vitest run src/__tests__/workflowModel.test.ts src/__tests__/epicsLoader.test.ts \
  src/__tests__/epicsValidator.test.ts src/__tests__/e2e/graph.test.ts \
  src/__tests__/integration/graphRoutes.test.ts
→ Test Files 5 passed (5), Tests 85 passed (85)
```

Megjegyzés: a taskban hivatkozott `src/__tests__/graph*.test.ts` glob nem létezik;
a graph-lefedettséget az `epicsLoader` + `epicsValidator` + `e2e/graph` +
`integration/graphRoutes` suite-ok adják. Az `e2e/graph.test.ts` a VALÓDI
`docs/projects/EPICS.yaml`-t tölti be a validátoron keresztül (DAG-ellenőrzéssel),
tehát az új séma élesben igazoltan érvényes.

### Epic-állapotok: régi → új

| Epic | Régi | Új | Bizonyíték |
|---|---|---|---|
| EPIC-KS-CLEANUP | done | done | változatlan |
| EPIC-KS-TOOLING | done | done | változatlan |
| EPIC-KS-MCP-SPLIT | active | **done** | ledger 2026-07-15: 103 tool / 14 modul, 889 teszt |
| EPIC-KS-ARCH-DECISION | pending | **done** | ledger 2026-07-15: „A opció", `046b8bb` |
| EPIC-KS-ARCH-REFACTOR | — | **pending** (új) | todo.md „4. fázis — Architektúra" backlog |
| EPIC-KS-TEST-HARDENING | done | done | változatlan |
| QC-GOVERNANCE | — | **active** (új) | TASK-QC-001 (ez a task) |
| QC-ARCHITECTURE | — | **active** (új) | TASK-QC-002, 1. hullám |
| QC-SECURITY | — | **active** (új) | TASK-QC-003, 1. hullám |
| QC-STABILITY | — | **pending** (új) | TASK-QC-004 ← QC-003 |
| QC-VERIFICATION | — | **active** (új) | TASK-QC-005/006/010; QC-005 1. hullám |
| QC-MAINTAINABILITY | — | **active** (új) | TASK-QC-007/008; QC-007 1. hullám |
| QC-DOCUMENTATION | — | **pending** (új) | TASK-QC-009, 3. hullám |

### Módosított fájlok

- `docs/projects/EPICS.yaml` (séma-bővítés + szinkron + programok)
- `knowledge-service/src/graph/types.ts` (additív típusok)
- `terminals/root/todo.md` (fejléc-szinkronszabály, NEXUS-QUALITY aktív sor, QC-kereszthivatkozások, Kész-sor)
- `docs/tasks/quality-compliance/TASK-QC-001-project-state.md` (status: done + ez a szekció)

Nem érintett: `workflowManager.ts`, `package.json`, `.github/`, a folyamatban lévő
biztonsági módosítások (tokenAuth/app/env/routes/tesztek) — érintetlenül hagyva.

