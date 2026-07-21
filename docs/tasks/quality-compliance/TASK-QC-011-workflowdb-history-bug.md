---
id: TASK-QC-011
title: workflowDb.addHistory named-param hiba javítása
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-VERIFICATION
status: done
priority: medium
depends_on: []
owner_role: backend
created: 2026-07-18
source: TASK-QC-010 független review, 4. szakasz "1" pont
---

# workflowDb.addHistory named-param hiba javítása

## Cél

A workflow step-váltásainak history-bejegyzése ne veszjen el csendben; a DB és a
fájl-alapú workflow-állapot ne váljon szét.

## Jelenlegi bizonyíték

- `knowledge-service/src/workflowDb.ts:180-183` — a prepared INSERT mind a 6
  named paramot megköveteli (`@workflow_id, @step_id, @terminal, @island,
  @task_file, @notes`).
- `knowledge-service/src/workflowManager.ts:217-221` csak hármat ad át
  (`workflow_id, step_id, notes`) → better-sqlite3 `RangeError: Missing named
  parameter`-t dob.
- A hívó `setWorkflowState` (uo. 209-251) generikus `catch`-csel elnyeli a
  hibát, `logger.error`-t ír és `false`-t ad vissza — a hívó kód ezt nem
  kezeli különbözőképp egy valódi I/O-hibától.
- Tesztben pinnelve, de NEM javítva:
  `src/__tests__/unit/workflowManagerFs.test.ts:225-244` (teszt neve is
  "workflowDb named-param BUG, pinned") — a teszt explicit asszertálja, hogy a
  state-fájl is változatlan marad a sikertelen hívás után, miközben a
  `saveStateToDb` előtte lefutott. Vagyis a DB `workflow_states` tábla és a
  fájl/API-n visszaadott állapot szétválhat minden `saveHistory=true` hívásnál
  (pl. `advanceWorkflow` egy már létező állapotú workflow-n).

## Scope

1. Igazítsd a `workflowManager.ts` hívási helyét a `workflowDb.ts` prepared
   statement paramétereihez (mind a 6 named param átadása), VAGY módosítsd a
   statementet, ha a hiányzó mezők (terminal/island/task_file) szándékosan
   opcionálisak — ez esetben adj nekik explicit defaultot a séma szintjén.
2. A jelenlegi pinned tesztet (`workflowManagerFs.test.ts:225-244`) alakítsd át:
   a bugot igazoló asszerciók helyett a helyes viselkedést rögzítse (history
   sikeresen beszúrva, state-fájl és DB szinkronban).
3. Ha a hiba mégis előfordulhat (pl. DB lock), a hívó kód különböztesse meg a
   logikai hibát az I/O-hibától, és ne nyelje el csendben — legalább egy
   `logger.error` + a hívó felé továbbadott hibaérték szükséges (ne csak
   `false`).

## Nem cél

- A workflow-modell egyéb részeinek refaktorálása.
- Migrációs script a már elveszett történeti bejegyzésekhez (nincs ismert
  production-incidens, csak a hermetikus tesztben feltárt hiba).

## Elfogadási feltételek

- [x] `advanceWorkflow` sikeres history-írás után a DB és a state-fájl
      ugyanazt az állapotot mutatja.
- [x] A `workflowManagerFs.test.ts` már a helyes viselkedést rögzíti, nem a
      hibát.
- [x] `npm run typecheck && npm test` zöld.

## Kötelező ellenőrzés

```bash
cd knowledge-service
npm run typecheck
npx vitest run src/__tests__/unit/workflowManagerFs.test.ts src/__tests__/unit/workflowModel.test.ts
npm test
```

## Átadandó bizonyíték

- Diff a `workflowDb.ts`/`workflowManager.ts` hívási helyén.
- Tesztkimenet előtte/utána.

## Kockázat és rollback

Alacsony — a hívási hely önmagában javítható, nem publikus API. Ha a
statement-mezők opcionálissá tétele mellett döntesz, dokumentáld az ADR-index
alatt, mert ez séma-szintű döntés.

## Végrehajtási napló

### 2026-07-21 — kezdés (backend)

- **Goal:** a workflow step-váltás history-bejegyzése ne vesszen el csendben;
  DB (`workflow_states` + `workflow_history`) és a state-fájl maradjon szinkronban.
- **Mérhető sikerkritérium:**
  1. `setWorkflowState(id, step, true)` cross-step váltásnál sikeres, a
     `workflow_history`-ba bekerül a sor, a state-fájl és a DB `current_step`
     megegyezik (teszt asszertálja).
  2. A korábbi pinned bug-teszt (`workflowManagerFs.test.ts`) a helyes
     viselkedést rögzíti.
  3. Hibaágon a hívó nem csak `false`-t kap: `{ success: false, error }`
     megy tovább, logic vs. I/O hiba megkülönböztetve a logban.
- **Kilépési feltétel:** `npm run typecheck` exit 0, az érintett tesztfájlok +
  a teljes hermetikus `npm test` zöld, `npm run check:tasks` exit 0; utána
  status → `ready` (a `done` a független review joga).
- **Terv (red → green):** először a tesztet írom át a helyes viselkedésre
  (buknia kell a mai kódon), utána a fix: `workflowDb.addHistory` az opcionális
  mezőket explicit `null`-lal köti be (a séma oszlopai eleve NULL-képesek,
  séma-változás nincs → ADR nem kell), a `workflowManager.setWorkflowState`
  pedig `{ success, error? }`-t ad vissza.

## Implementáció (2026-07-21, backend)

**Környezet:** Windows 11 Home 10.0.26200, Node v24.13.0, npm 11.6.2.

### Mi és miért

1. **Gyökérok-fix — `knowledge-service/src/workflowDb.ts` (`addHistory`, ~383. sor):**
   a better-sqlite3 a prepared INSERT MINDEN named paramját megköveteli, a
   `terminal`/`island`/`task_file`/`notes` viszont a függvény-szignatúra és a
   séma szerint is opcionális (NULL-képes oszlopok). A fix a hiányzó opcionális
   mezőket explicit `null`-lal köti be (`entry.x ?? null`). A Scope 1. pont
   „B” ága; **séma-változás nincs**, ezért ADR nem szükséges (a nullable
   oszlopok eddig is így voltak definiálva).
2. **Hibapropagálás — `knowledge-service/src/workflowManager.ts`:**
   - `setWorkflowState` visszatérése `boolean` → `SetWorkflowStateResult`
     (`{ success, error? }`); a `catch` megkülönbözteti a logikai hibát
     (`RangeError`/`TypeError` → `logic`) az I/O-hibától (`io`), `logger.error`
     szintre logol és a hibaüzenetet továbbadja (Scope 3).
   - `advanceWorkflow` a write-eredmény `error`-ját beleteszi a saját
     válaszába (a visszatérési típusa eddig is tartalmazott opcionális
     `error`-t).
   - `set_workflow_step` MCP-handler most a teljes `{ success, error? }`
     payloadot adja vissza (eddig csak `{ success }`-t; a `success` mező
     kontraktusa változatlan).
3. **Teszt — `knowledge-service/src/__tests__/unit/workflowManagerFs.test.ts`:**
   a két pinned bug-teszt a helyes viselkedést rögzíti (Scope 2): cross-step
   `setWorkflowState(..., true)` sikeres; a state-fájl JSON-ja ÉS a DB
   (`getStateFromDb` + `getHistoryFromDb`) szinkronban van; same-step írás nem
   szúr be plusz history-sort; a `set_workflow_step` → `advance_workflow` út
   meglévő state-tel (history-írási ág) végigmegy a záró lépésig.

### Red → green bizonyíték

- Fix ELŐTT (átírt teszt, javítatlan kód): `npx vitest run
  src/__tests__/unit/workflowManagerFs.test.ts` → **3 failed | 21 passed**
  (a cross-step írás `success:false`-t adott — bug reprodukálva).
- Fix UTÁN: ugyanez + `workflowModel.test.ts` → **31 passed**, exit 0.

### Módosított fájlok

- `knowledge-service/src/workflowDb.ts` — `addHistory` null-defaultok
- `knowledge-service/src/workflowManager.ts` — `SetWorkflowStateResult`,
  hibamegkülönböztetés + propagálás, `advanceWorkflow`/handler igazítás
- `knowledge-service/src/__tests__/unit/workflowManagerFs.test.ts` — pinned
  bug-tesztek → helyes viselkedés + DB-szinkron asszerciók
- `docs/tasks/quality-compliance/TASK-QC-011-workflowdb-history-bug.md` —
  napló + implementáció

### Futtatott parancsok (knowledge-service/)

| Parancs | Exit |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npx vitest run src/__tests__/unit/workflowManagerFs.test.ts src/__tests__/workflowModel.test.ts` | 0 (31 passed) |
| `npm test` (teljes hermetikus suite) | 0 (76 fájl, 1308 passed, 1 skipped) |
| `npm run check:tasks` | 0 |

Status: `in_progress` → `ready` — a `done` zárás a független review joga.

## Független adverzáriális review (2026-07-21)

**Verdikt: PASS** — a megcáfolási kísérletek nem találtak érdemi hibát.

### Mit próbáltam megcáfolni, és miért nem sikerült

1. **„Maradt frissítetlen hívó a `boolean` → `{success, error?}` váltás után"**
   (egy kimaradt hívónál az objektum mindig truthy, így a hiba megint némán
   átcsúszna). Repo-szerte kerestem (`setWorkflowState|advanceWorkflow|
   handleWorkflowTool`): az egyetlen két hívó a `workflowManager.ts:294`
   (`advanceWorkflow`) és a `:640` (`set_workflow_step` MCP-ág) — mindkettő
   frissült, az `error` mindkét szinten továbbmegy. A `workflow.tools.ts`
   csak a handlert delegálja, payload-alakot nem szűr. Az MCP-kontraktus
   (`mcpContract.integration.test.ts`) csak tool-neveket pinnel, az additív
   `error` mező nem töri.
2. **„A `?? null` kötés jövőbeli kötelező mezőt fedne el."** Nem: az
   `addHistory` explicit mező-felsorolással köt; ha a prepared statement új
   named paramot kap, a better-sqlite3 újra `RangeError`-t dob, ami most már
   `{success:false, error}`-ként hangosan propagál — nem maszkolódik.
3. **Gyökérok-hitelesítés futtatással** (scratchpad, better-sqlite3
   in-memory): a HEAD-viselkedés (3 param a 6-ból) determinisztikusan
   `RangeError: Missing named parameter "terminal"`-t dob; a null-kötéses
   insert `changes=1`-gyel átmegy. A bug-állítás és a fix mechanizmusa igaz.
4. **Red-fázis hitelesség:** a `toEqual({success:true})` asszerció önmagában
   a típusváltás miatt is bukna régi kódon, DE a teszt a DB-oldalt is pinneli
   (`getHistoryFromDb` tartalmazza a transition-sort, `getStateFromDb` =
   state-fájl), amit a javítatlan kód nem tudott produkálni — a teszt tehát
   valóban a bugot rögzíti, nem triviálisan zöld.

### Rögzített maradék-kockázatok (nem blokkolók, scope-on kívül)

- A `saveStateToDb` a history- és fájlírás ELŐTT fut; valódi I/O-hibánál
  (pl. DB-lock az `addHistory`-ban) a DB `workflow_states` már az új lépést
  mutatja, a state-fájl a régit — a szétválás hibaágon továbbra is lehetséges,
  de most hangos (`{success:false, error}`), az elfogadási feltétel pedig csak
  sikeres írásra követeli a szinkront.
- `advanceWorkflow` hibaágon is `current_step: nextStepId`-t jelent a
  válaszban (a `success:false` + `error` mellett) — kozmetikai.
- A diffben a `workflowDb.ts`/`workflowManager.ts` path-centralizálása
  (`config/paths` import) a párhuzamos config-vezérelt-útvonal munkafolyam
  része, nem e task scope-ja; a hermetikus tesztek env-felülírása erre épül.

### Kapuk (független újrafuttatás, knowledge-service/, 2026-07-21)

| Parancs | Exit |
|---|---|
| `npx tsc --noEmit` | **2** — 1 hiba, `src/runner/runnerConfig.ts:66` (párhuzamos runner-munkaterület módosított fájlja; e task fájljaira nulla típushiba) |
| `npx vitest run src/__tests__/unit/workflowManagerFs.test.ts src/__tests__/unit/goalStore.test.ts` | 0 (58 passed) |
| `npm test` (teljes hermetikus suite) | 0 (77 fájl, 1314 passed, 1 skipped) |
| `npm run check:tasks` | 0 |

A typecheck-hiba nem e task következménye (a `runner/` aktív párhuzamos
munkaterület), a task saját futásakor dokumentáltan exit 0 volt.

Status: `ready` → `done` (független review lezárva).
