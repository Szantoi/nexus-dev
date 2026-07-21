# src/interfaces/http — REST route-modulok

## Felelősség

A szolgáltatás HTTP (REST + SSE) felülete: minden `/api/...` és `/health`
végpont itt él, témánként külön route-fájlban. A route-ok vékonyak: kérés-
validálás + a megfelelő feature-modul hívása; üzleti logika nem ide való.

## Publikus belépési pontok

A [`routes/index.ts`](routes/index.ts) exportálja a routereket; a
`bootstrap/app.ts` mountolja őket. Fő csoportok:

| Route-fájl | Prefix / téma |
|---|---|
| `health.routes.ts` | `/health`, `/ready`, `/live` |
| `knowledge.routes.ts` | `/api/knowledge/*` — RAG-keresés, újraindexelés |
| `mailbox.routes.ts` | `/api/mailbox/:terminal/*` — inbox/outbox, SSE subscribe, broadcast |
| `task.routes.ts`, `kanban.routes.ts` | taskállapot, kanban |
| `registry.routes.ts`, `agent-messages.routes.ts` | message-registry, agent-üzenetek |
| `session.routes.ts`, `terminal.routes.ts` | session-kezelés, terminál-állapot |
| `control.routes.ts` | dispatch-vezérlés |
| `epic-router.routes.ts` | `/api/epic-router/*` — epic-tudatos task-routing, EPICS-szinkron |
| `federation.routes.ts` | sziget-közi federáció (ADR-066) |
| `eval.routes.ts`, `costMonitoringRoutes.ts`, `digest.routes.ts`, `dashboard.routes.ts`, `channels.routes.ts`, `pipeline.routes.ts`, `projects.routes.ts`, `memory.routes.ts`, `auth.routes.ts` | eval-futások, költségfigyelés, digest, dashboard, csatornák, pipeline-vezérlés, projektek, memória, auth |

Történeti maradvány: néhány router még a `src/api/` és `src/routes/` alatt él
(graph, planning, subscription, escalation) — új route ide, az
`interfaces/http/routes/` alá kerüljön.

## Függőségi irány

route → feature-modul (pipeline, task-message-box, vectorStore stb.) → config.
Route-fájl másik route-fájltól nem függ; az auth-middleware-eket
(`auth/tokenAuth.ts`) az app-factory fűzi be, a route-ok már hitelesített
kérést kapnak (`req.mcpTerminal`, `req.mcpIsland`).

## Konfiguráció

Közvetlen env-olvasás nincs; minden a [`config`](../../config/README.md)
rétegen át. A védettséget az `AUTH_MODE` határozza meg (lásd
[auth-README](../../auth/README.md)).

## Logok

Kérés-szintű hibák és az SSE-életciklus a `core/logger`-en; a mailbox-SSE
`[SSE]` prefixszel naplóz.

## Tesztek

Supertest-alapú integrációs tesztek: `npm run test:integration` —
route-onként pl. `mailboxRoutes.integration.test.ts`,
`controlRoutes.integration.test.ts`, `kanbanRoutes.integration.test.ts`,
`epicRouterRoutes.integration.test.ts`, `graphRoutes.test.ts`,
valamint a gyökér-szintű `federationRoutes.test.ts`, `projectsApi.test.ts`.

## Ismert korlátok

- `epic-router.routes.ts` 800 sor feletti (méretkapu-allowlist, bontása:
  TASK-QC-008E).
- A `src/api/` + `src/routes/` maradványrouterek migrálása nyitott
  backlog-tétel (EPIC-KS-ARCH-REFACTOR).
