# ADR-041: Gráf-alapú workflow-architektúra (SpaceOS)

- **Státusz:** accepted
- **Dátum:** eredeti dátum ismeretlen (a nexus-dev repóba importálva: 2026-07-14); rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (az eredeti ADR a repó-import előtti előd-repóban élt)
- **Rekonstruált:** igen — kizárólag kód, tesztek és kódkommentek alapján

## Kontextus

A flotta (8 terminál: root, conductor, architect, librarian, explorer, backend,
frontend, designer + monitor) munkáját epicek, taskok, mérföldkövek és workflow-lépések
alkotják, köztük függőségekkel. Fájl-alapú, lineáris listákkal a függőségek, a kritikus
út és a párhuzamosítható munka nem volt levezethető.

## Döntés

A workflow- és projektmenedzsment egységes, gráf-alapú modellre épül:

- Univerzális `GraphNode` (epic | task | workflow_step | milestone), státusszal
  (`pending | active | done | blocked`), prioritással, terminál- és modell-hozzárendeléssel.
- A gráf forrása az `EPICS.yaml` (validátor + loader), a gráfon műveletek
  (függőségfeloldás, topológiai rendezés) futnak, a kimenet Mermaid-diagramként és
  HTTP API-n (`/api/graph`) is elérhető.
- Fázisolt bevezetés: Phase 1 = TASK-001 (validátor), TASK-002 (loader/builder),
  TASK-003 (API route-ok), TASK-004 (státusz-riport a Codebase_Status.md-be),
  TASK-006 (E2E smoke teszt).

## Design intent

Egyetlen, gépileg feldolgozható igazságforrás a munka állapotáról: a gráfból
levezethető a "mi futhat párhuzamosan", "mi blokkolt és miért", és a haladás
vizualizálható (Mermaid) ember számára is. A QUALITY.md goal-fókusz elvének
infrastruktúrája: a cél nem a beszélgetés-kontextusban él, hanem az EPICS.yaml-ben.

## Alternatívák

Az eredeti ADR elveszett; az elvetett alternatívák nem rekonstruálhatók bizonyítottan.
A kódszerkezetből valószínűsíthető (nem bizonyított) alternatíva: sima task-lista
függőség-mező nélkül, illetve külső projektmenedzsment-eszköz.

## Következmények

- Az EPICS.yaml séma-validált; hibás gráf (kör, hiányzó hivatkozás) korán kiderül.
- Minden pipeline-komponens (epicRouter, statusUpdater, conductor-modulok) erre a
  modellre épül — az ADR-053 (Mode #4) ennek a folytatása.
- A gráf-modell a gyártási (manufacturing) workflow-lépéseket is hordozza, ami a
  knowledge-service-t a SpaceOS tágabb doménjéhez köti.

## Biztonsági hatás

Nincs közvetlen; a graph API a szolgáltatás meglévő auth-rétege mögött él.

## Kapcsolódó kód

- `knowledge-service/src/graph/` — types, operations, epicsLoader, mermaidGenerator, index
- `knowledge-service/src/api/graphRoutes.ts` — Phase 1 / TASK-003
- `knowledge-service/src/pipeline/epicsValidator.ts` — Phase 1 / TASK-001
- `knowledge-service/src/pipeline/statusUpdater.ts` — Phase 1 / TASK-004
- `knowledge-service/src/__tests__/epicsValidator.test.ts`, `__tests__/epicsLoader.test.ts`,
  `__tests__/e2e/graph.test.ts`

## Bizonyíték

- Kódkommentek: `graph/types.ts:2`, `graph/operations.ts:2`, `pipeline/epicsValidator.ts:2`
  (mind `@see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md`)
- git: 823db70 (Initial commit, 2026-07-14) — a teljes graph-modul már készen érkezett
- Teszt: `__tests__/unit/terminalReviewer.test.ts:393` ("Pattern inconsistent with ADR-041")
