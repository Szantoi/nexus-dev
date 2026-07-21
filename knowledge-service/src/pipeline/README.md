# src/pipeline — ütemezők, watcherek és folyamat-automatizmusok

## Felelősség

A flotta „idegrendszere”: időzített és eseményvezérelt háttérfolyamatok —
inbox/queue/response watcherek, nightwatch, heartbeat, message-router,
review-folyamat, epic-tudatos task-routing, digest, költségfigyelés,
Telegram-koordináció. Minden folyamat **flag-vezérelt** (default: KI), a
[`bootstrap/startup.ts`](../bootstrap/startup.ts) indítja őket.

## Publikus belépési pontok

Az [`index.ts`](index.ts) re-exportálja a start/stop/status API-kat és a
router-factory-kat. Fő csoportok:

| Terület | Fájlok (példák) |
|---|---|
| Watcherek (esemény/poll) | `watchInbox`, `watchQueue`, `watchDone`, `watchResponse`, `watchIdle`, `watchStuck`, `watchPriority`, `watchGoals`, `watchMonitor`, `watchMcpHeartbeat`, `watchConductorProgress` |
| Ütemezők | `nightwatch`, `heartbeat`, `autoRestart`, `hourlyDigest`, `systemMetrics`, `rootMonitor`, `ideaScan`, `phaseCoordinator`, `autonomousDev` |
| Review-folyamat | `reviewer` (formal/content/manual review a DONE-üzenetekre), `terminalReviewer`, `preReviewGate`, `reviewLog`, `bestOfN` |
| Task-routing | `epicRouter` (epic-kontextusú kiosztás, queue, SQLite), `projectDispatcher`, `projectMatcher`, `dependencyResolver`, `taskEscalation` |
| EPICS-gráf | `epicsValidator`, `dagValidator`, `epicProgressTracker`, `epicNotifications` |
| Kommunikáció | `messageRouter`, `channelCoordinator`, `channelProvider`, `telegramBot`, `subscriptionManager` |
| Közös | `eventBus`, `pipelineConfig`, `processLock`, `hashUtils`, `costLimiter` |

## Függőségi irány

pipeline → feature-tárak (mailbox, messageRegistry, task-message-box,
terminalStatus) + `config` + `core/logger`. A pipeline nem importál a
`bootstrap`/`interfaces` rétegből; a szolgáltatás SAJÁT API-ját típusos
`fetch`-csel, a `SELF_BASE_URL`-en hívja (nem fix porttal, nem shell-curllel
— TASK-QC-007).

## Konfiguráció (env-kulcsok)

`ENABLE_NIGHTWATCH`, `ENABLE_HEARTBEAT`, `ENABLE_AUTO_RESTART`,
`ENABLE_MESSAGE_ROUTER`, `ENABLE_TELEGRAM_COORDINATOR`, `ENABLE_AUTONOMOUS_DEV`,
`ENABLE_ROOT_MONITOR`, `ENABLE_IDEA_SCAN`, `ENABLE_PHASE_COORDINATOR`,
`ENABLE_HOURLY_DIGEST` (opt-out), `PRE_REVIEW_ENABLED` (opt-out), a hozzájuk
tartozó `*_INTERVAL*` kulcsok, `REVIEW_MODE` (`terminal`/`api`),
`AUTONOMOUS_DEV_*`, `DAILY_COST_BUDGET` — mind a
[`config/env.ts`](../config/env.ts) sémán át. DEV-ben a sablon mindet
kikapcsolja (`.env.dev.example`).

## Logok

Minden folyamat prefixelt sorokkal naplóz (`[Nightwatch]`, `[MessageRouter]`,
`[Reviewer]`, `[EpicRouter]` stb.); az indítás/leállítás és minden döntés
(dispatch, skip, eszkaláció) naplózott — a futás a logból követhető
(QUALITY.md 3. pont).

## Tesztek

`npm run test:unit` + `npm run test:integration` — pl.
`unit/epicRouter.test.ts`, `unit/reviewer.test.ts`,
`unit/terminalReviewer.test.ts`, `unit/preReviewGate.test.ts`,
`unit/autonomousDev.test.ts`, `integration/watchInbox.integration.test.ts`,
gyökér-szintű `projectDispatcher.test.ts`, `epicsValidator.test.ts`,
`hourlyDigest.test.ts`, `costLimiter.test.ts`, `alertRules.test.ts`.

## Ismert korlátok

- 800 sor feletti fájlok (méretkapu-allowlist, lejárat 2026-10-18):
  `reviewer.ts` (TASK-QC-008C), `terminalReviewer.ts` (QC-008D),
  `telegramBot.ts` (QC-008E) — bontásuk ütemezett follow-up.
- Több watcher a régi `messageRegistry`-re épül; a kanonikus
  [task-message-box](../task-message-box/README.md)-ra migrálás folyamatban.
- A `tmux`-alapú session-vezérlés Linux/VPS-környezetet feltételez; Windowson
  a [runner](../runner/README.md) a helyettesítő út.
