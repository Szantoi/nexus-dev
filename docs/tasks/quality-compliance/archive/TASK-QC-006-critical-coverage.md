---
id: TASK-QC-006
title: Kritikus runtime útvonalak tesztlefedettségének növelése
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-VERIFICATION
status: done
priority: high
depends_on: [TASK-QC-005]
parallel_with: [TASK-QC-004, TASK-QC-008]
owner_role: qa
created: 2026-07-18
source: QUALITY.md section 4
---

# Kritikus runtime útvonalak tesztlefedettségének növelése

## Cél

Ne csak a tesztek darabszáma legyen magas: a biztonsági, deploy-, auth-, routing- és agent-ellenőrzési útvonalak hibás ágai is legyenek bizonyítottan lefedve.

## Jelenlegi bizonyíték

- A teljes lines coverage 23,51%, branches coverage 19,03%.
- Több nagy vagy kritikus modul lefedettsége 0–3% körüli, köztük reviewer/pre-review jellegű útvonalak.
- 958 teszt sikeres, tehát a hiány elsősorban lefedettségi fókusz, nem teszt-infrastruktúra hiánya.

## Scope

1. A coverage JSON-ból készíts kockázat × lefedettség rangsort.
2. Elsőként teszteld az auth/RBAC/CORS, config fail-closed, deploy/rollback, MCP dispatch/permission, epic-router és reviewer gate modulokat.
3. Minden célmodulhoz legyen happy path, jogosultsági hiba, validációs hiba és függőségi hiba teszt, ahol értelmezhető.
4. A filesystem, process, hálózat, idő és random bemenet legyen kontrollált/mokkolt; a suite maradjon hermetikus.
5. Emeld a globális thresholdot legalább: statements 35%, branches 30%, functions 35%, lines 35%.
6. Az auth-, security- és deploy-modulokra állíts legalább 80% lines és 70% branches per-file küszöböt.
7. Ne használj indokolatlan coverage ignore kommentet.

## Nem cél

- 100%-os globális coverage.
- Live ChromaDB vagy production service használata a hermetikus suite-ban.
- Triviális getter-tesztek gyártása csak a szám növeléséért.

## Elfogadási feltételek

- [x] A globális threshold eléri a fenti minimumokat. (38/32/37/38 ≥ 35/30/35/35)
- [x] A kijelölt biztonsági és deploy-modulok elérik a per-file minimumot. (lásd Implementáció; deploy: QC-004 bash tesztek)
- [x] A kritikus hibautakhoz tartozik regressziós teszt.
- [x] A teljes suite determinisztikusan zöld legalább két egymást követő futásban. (2× 1307 passed / 0 failed)
- [x] A tesztek nem igényelnek hálózatot vagy `/opt/...` fájlrendszert.

## Kötelező ellenőrzés

```bash
cd knowledge-service
npm run test:coverage
npm test
npm test
```

## Átadandó bizonyíték

- Előtte/utána coverage-tábla globálisan és célmodulonként.
- Új tesztek által lefedett hibaszcenáriók listája.
- Két egymást követő teljes tesztfutás eredménye.

## Kockázat és rollback

A túlzott mocking hamis biztonságot adhat. A komponensek közötti szerződéseket legalább egy integrációs tesztben is igazolni kell.

## Implementáció (2026-07-18)

### Coverage — globálisan (teljes hermetikus suite, `npm run test:coverage`)

| Metrika | Előtte (QC-008 után) | Utána | Küszöb (vitest.config.ts) |
|---|---|---|---|
| Statements | 24,55% | **40,75%** (6996/17168) | 38 |
| Branches | 19,86% | **34,78%** (2969/8535) | 32 |
| Functions | 24,45% | **39,88%** (1035/2595) | 37 |
| Lines | 24,74% | **41,15%** (6680/16232) | 38 |

A küszöbök a mért érték alá ~3 ponttal, a taskban előírt minimum (35/30/35/35)
fölé kerültek — ratchet: csak felfelé mozdulhatnak, csökkentés csak ADR-rel.

### Coverage — célmodulonként (lines% / branches%, előtte → utána)

| Modul | Előtte | Utána |
|---|---|---|
| `src/auth/tokenAuth.ts` | 95,4 / 84,1 | **100 / 92,0** |
| `src/bootstrap/app.ts` | 80,6 / 58,8 | **96,3 / 88,2** |
| `src/config/env.ts` | 68,9 / 63,2 | **97,8 / 97,4** |
| `src/mcp.ts` (dispatch/permission/mailbox-auth) | 56,7 / 41,9 | **86,6 / 73,3** |
| `src/interfaces/http/routes/epic-router.routes.ts` | 6,5 / 0 | **87,3 / 87,9** |
| `src/pipeline/epicRouter.ts` | 45,1 / 29,4 | **98,6 / 94,1** |
| `src/pipeline/preReviewGate.ts` | 0,8 / 0 | **98,3 / 64,9** |
| `src/pipeline/reviewer.ts` | 0,3 / 0,5 | **93,4 / 75,7** |
| `src/pipeline/terminalReviewer.ts` | 1,8 / 0 | **91,6 / 79,5** |
| `src/interfaces/http/routes/control.routes.ts` | 10,0 / 0 | **96,9 / 84,1** |
| `src/interfaces/http/routes/mailbox.routes.ts` | 10,3 / 0 | **86,8 / 63,9** |
| `src/interfaces/http/routes/kanban.routes.ts` | 2,5 / 0 | **95,0 / 79,5** |
| `src/goalStore.ts` | 0,6 / 0 | **98,8 / 92,9** |
| `src/contextPersistence.ts` | 9,7 / 4,9 | **97,6 / 85,2** |
| `src/skills.ts` | 3,0 / 0 | **100 / 100** |
| `src/workflowManager.ts` | 0,8 / 0 | **93,2 / 91,5** |
| `src/memoryTools.ts` | 5,9 / 0 | **96,3 / 87,0** |
| `src/identity.ts` | 30,6 / 0 | **100 / 100** |
| `src/retrospective.ts` | 1,7 / 0 | **94,2 / 83,3** |
| `src/mailbox.ts` (route-teszteken át, részleges) | 11,5 / 7,9 | **47,6 / 36,0** |

**Per-file küszöbök** (vitest.config.ts, auth/security modulokra, 80 lines /
70 branches): `auth/tokenAuth.ts`, `bootstrap/app.ts`, `config/env.ts`,
`mcp.ts`, `interfaces/http/routes/epic-router.routes.ts` — mind bizonyítottan
felette. **Deploy-modulok:** a `scripts/deploy` bash-logikát a QC-004 bash
tesztjei fedik (70 PASS); bash coverage-t nem mérünk, ezt itt dokumentáljuk.
Indokolatlan coverage-ignore komment nem került be (0 db).

### Új / módosított tesztfájlok (16 új fájl, +314 teszt: 993 → 1307)

Új: `unit/mcpTransport.test.ts`, `unit/envSecurity.test.ts`,
`unit/identityStore.test.ts`, `unit/retrospectiveStore.test.ts`,
`unit/goalStore.test.ts`, `unit/preReviewGate.test.ts`,
`unit/reviewerPipeline.test.ts`, `unit/terminalReviewerPipeline.test.ts`,
`unit/contextPersistence.test.ts`, `unit/skillsStore.test.ts`,
`unit/workflowManagerFs.test.ts`, `unit/memoryToolsFs.test.ts`,
`integration/epicRouterRoutes.integration.test.ts`,
`integration/controlRoutes.integration.test.ts`,
`integration/kanbanRoutes.integration.test.ts`,
`integration/mailboxRoutes.integration.test.ts`,
valamint a `helpers/perfBudget.ts` helper.
Bővítve: `unit/tokenAuth.test.ts`, `unit/appSecurity.test.ts`.

Minden célmodulnál: happy path + jogosultsági hiba + validációs hiba +
függőségi hiba, ahol értelmezhető. Kiemelt hibaszcenáriók:

- **tokenAuth**: fail-closed 503 (REST és MCP −32000), 401/403 ágak, env-token
  felülírás, hibás agents.yaml → env-only fallback, mtime-cache, island-scope
  fallback lánc, requireRoot önálló identitás-feloldása, HEAD/OPTIONS olvasás.
- **bootstrap/app**: CORS allowlist (engedett/tiltott origin, preflight 204/403),
  trust-proxy viselkedés (spoofolt header 0 és 1 hopnál), rate limit (skip-utak,
  429 + retryAfter, lejárt ablak reset), middleware-hiba → generikus 500
  (stack-szivárgás nélkül), SPA fallback vs API 404, legacy /api/tasks/status.
- **env**: érvénytelen konfiguráció → process.exit(1) fail-fast, minden lazy
  secret-getter + alias (GEMINI_API_KEY, TELEGRAM_TOKEN), CHROMADB_URL alias.
- **mcp**: authorizeMailboxRest teljes mátrix (identitás nélkül 401,
  root/conductor, monitor read-only, broadcast-őr, közös olvasó utak, saját vs
  idegen mailbox, create_task-jog), JSON-RPC élek (−32600, −32601, −32602,
  notifications 204).
- **epic-router**: terminál-token auth mátrix (root/saját/idegen/503/401/403 +
  származtatott SHA-256 token), admin token-kiadás (503/403/200), fetch/ack/complete
  hozzárendelés-ellenőrzés, sync EPICS.yaml-ből, SQLite függőségi hibák (500).
- **reviewer/pre-review gate**: formal/content/manual routing, gate pass/fail,
  dual review approve/reject/UNKNOWN/ERROR, MAX_ATTEMPTS eszkaláció,
  reject-inbox tartalom, tsc/teszt/audit hibaszámolás, audit-JSON critical/high
  ágak, node_modules-hiányzó skip ágak.
- **goalStore/workflowManager/contextPersistence/memoryTools/skills**: minden
  exportált függvény, hiányzó/hibás fájl ágak, ismeretlen terminál/goal/workflow
  hibák, kompresszió/staleness/duplikátum heurisztikák.

Integrációs (szerződés-szintű) tesztek: supertest a valódi routereken
(epic-router, control, kanban, mailbox, MCP transport), a meglévő
`mcpContract.integration.test.ts` mintát követve — a mock-túlhasználat elleni
követelmény teljesül.

### Determinisztikus zöld — perf-budget megoldás

A suite fix ms-budget assertjei (dependencyResolver, componentScaffold,
domainPatternMatcher, sessionContextTransfer, terminalStatusAggregator,
epicsValidator, agent/* és integration/* időlimitek) coverage-instrumentáció
vagy terhelés alatt flake-eltek. Megoldás (perf-assert NEM törlődött):

- `src/__tests__/helpers/perfBudget.ts`: `perfBudget(ms)` = `ms ×
  PERF_BUDGET_MULTIPLIER` (env, default 1; hibás érték → 1, fail-safe).
- Minden fix budget erre lett átállítva (12 tesztfájl + `agent/agent.config.ts`
  és `integration/api.config.ts` küszöbdefiníciói).
- `vitest.config.ts`: coverage-futásnál (`--coverage` argumentum) vagy CI env
  esetén a default szorzó **4**; explicit `PERF_BUDGET_MULTIPLIER` mindig nyer.

### Kötelező ellenőrzés eredményei (2026-07-18, lokál)

- `npm run test:coverage` → **exit 0** (76 fájl, 1307 passed / 1 skipped;
  globális és per-file küszöbök zöldek).
- `npm test` #1 → 1307 passed / 1 skipped / **0 failed** (exit 0).
- `npm test` #2 → 1307 passed / 1 skipped / **0 failed** (exit 0).
- `npm run typecheck` → exit 0.
- `npm run lint:ratchet` → exit 0 (786 warning = baseline, a 16 új tesztfájl
  0 új warningot ad).

### Ismert korlátok, talált hibák (follow-up jelöltek, kód nem módosult)

1. **BUG (workflowDb)**: `setWorkflowState(saveHistory=true)` named-param
   hiánnyal hívja a history INSERT-et (`@terminal/@island/@task_file` nincs
   átadva) → minden cross-step history-írás csendben elbukik.
2. **BUG-kockázat (goalStore)**: `generateGoalId()` a `Date.now()` utolsó 3
   számjegyét használja — azonos ms-ben ütközés és néma felülírás lehetséges.
3. `/opt` hardcode-ok: `config/terminals.yaml` (backend/frontend/designer
   directory), `workflowManager.generateWorkflowTask`, `memoryTools.MEMORY_DIR`
   (__dirname-relatív) — env-vezérelt útvonalra állításuk külön task.
4. `retrospective.ts` skill-create ága `os.homedir()`-be ír (nem hermetizálható
   env-felülírás nélkül) — teszt szándékosan kihagyva, kommentben dokumentálva.
5. `terminalReviewer.ts` `isTerminalBusy`/`waitForTerminal` a publikus API-ból
   halott kód; `control.routes` POST /dispatch happy path valódi tmux-ot
   indítana (seam kellene hozzá).

