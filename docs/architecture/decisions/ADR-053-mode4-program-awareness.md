# ADR-053: Mode #4 Program-Awareness (program-tudatos üzemmód)

- **Státusz:** accepted
- **Dátum:** 2026-07-02; rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (eredeti ADR az előd-repóban)
- **Rekonstruált:** igen — kód, datált kódkommentek és integrációs teszt alapján

## Kontextus

A flotta üzemmódjai (manual, planning_pipeline) nem "látták" a futó programot: a
Conductor minden session-indulásnál cold starttal indult, a checkpoint-teljesülést
kézzel kellett követni, és a monitor health-checkjei üzemmód-függetlenek voltak.

## Döntés

Új üzemmód: `structured_program` (Mode #4), amelyben a rendszer az EPICS.yaml-ben
definiált aktív epic + checkpointok körül szerveződik:

- **Mode-detektálás:** `SPACEOS_MODE` env override → aktív epic az EPICS.yaml-ben →
  planning-queue könyvtár → manual (ebben a sorrendben).
- **Conductor-briefing:** session-indulásnál generált, kontextus-tudatos briefing
  (epic-státusz, checkpoint-haladás, 2 órás aktivitás-ablak, prioritások, blokkolók)
  — a cold start probléma megszüntetése.
- **Autoritatív task-lezárás:** az epicRouter outbox-DONE detektálása az egyetlen
  hiteles forrása a task-teljesülésnek; ez frissíti a checkpoint-státuszt az
  EPICS.yaml-ben és `outbox:done` eseményt emittál (→ ADR-052 feliratkozások).
- **Mode-aware health check:** a watchMonitor üzemmód-függő prompttal ellenőriz.
- **Terminal review MCP toolok** (MSG-122-vel közösen): terminálok munkájának
  review-ja MCP-n át.
- **Felhasználói értesítések:** epic-eseményekről (epicNotifications).

## Design intent

A "program" (QUALITY.md 1.: program → projekt → mérföldkő → epic → task) legyen a
rendszer első osztályú fogalma: a cél a configban él (EPICS.yaml), nem a
beszélgetés-kontextusban, és minden komponens (briefing, health check, lezárás)
ebből az egy forrásból dolgozik. A "kész" földelt bizonyítékhoz kötött: a DONE az
outbox-ból detektált tény, nem önbevallás.

## Alternatívák

Az eredeti ADR elveszett. A kódból kiolvasható szembeállítás: a korábbi üzemmódok
(manual, planning_pipeline) megtartása mellett ADDITÍV új mód került be — a meglévő
módok lecserélése helyett.

## Következmények

- A Conductor-terminál szerepe felértékelődött (conductor/ modul-négyes:
  modeDetection, epicManager, checkpointTracker, conductorBriefing).
- Az EPICS.yaml írás-olvasás több komponensben történik — konkurencia-érzékeny.
- Az ADR-059 (goal progression) ennek költséghatékonysági folytatása
  ("Mode #4 cost-efficient operation" a watchGoals fejlécében).

## Biztonsági hatás

Nincs közvetlen; a review- és briefing-útvonalak a meglévő auth mögött élnek.

## Kapcsolódó kód

- `knowledge-service/src/conductor/` — modeDetection, epicManager, checkpointTracker, conductorBriefing
- `knowledge-service/src/pipeline/epicRouter.ts:482-530` — autoritatív lezárás + checkpoint-frissítés
- `knowledge-service/src/pipeline/watchMonitor.ts:206` — mode-aware health check
- `knowledge-service/src/pipeline/terminalReviewer.ts:779` — review MCP API
- `knowledge-service/src/sessionStarter.ts:105` — Mode #4 kontextus-injektálás
- Tesztek: `__tests__/unit/conductorModules.test.ts`, `__tests__/integration/mode4.test.ts`

## Bizonyíték

- Kódkommentek: `conductor/*.ts:2` ("ADR-053: Mode #4 Program-Awareness (2026-07-02)"),
  `epicRouter.ts:482` ("AUTHORITATIVE source of task completion")
- git: 823db70 (Initial commit, 2026-07-14)
