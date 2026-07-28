# src/bootstrap — app-factory, startup és leállítás

## Felelősség

A szolgáltatás életciklusa: az Express-alkalmazás összeszerelése (middleware-ek
+ route-mount), az inicializálás (tárak, watcher-ek), a háttérszolgáltatások
flag-vezérelt indítása és a graceful shutdown. A `src/server.ts` belépési pont
csak ezt a modult hívja.

## Publikus belépési pontok

| Fájl | Export | Szerep |
|---|---|---|
| [`app.ts`](app.ts) | `createApp()` | Express app-factory: rate-limit (500 kérés/perc/IP), auth-kapuk, az összes REST route + `/mcp` mount |
| [`startup.ts`](startup.ts) | `initialize()` | útvonal-konfig naplózása (`logPathConfig`), task-message-box + vektortár init, üres tárnál első indexelés, message-registry szinkron, inbox-watcher indítás |
| [`startup.ts`](startup.ts) | `startServices(port)` | háttérszolgáltatások indítása az `ENABLE_*` flagek szerint (nightwatch, heartbeat, message-router, Telegram-koordinátor, metrika, autonomous-dev, root-monitor, idea-scan, hourly-digest, phase-coordinator, multi-bot) |
| [`startup.ts`](startup.ts) | `createGracefulShutdown(server)`, `getReadyState()`, `getShuttingDownState()` | graceful shutdown + readiness a health-route-oknak |
| [`index.ts`](index.ts) | re-exportok | |

## Függőségi irány

A bootstrap a **legkülső** réteg: mindenre rálát (config, auth, interfaces,
pipeline, telegram, dispatch-control), de rá csak a `server.ts` hivatkozhat.
Feature-modul sosem importál bootstrapből.

## Konfiguráció (env-kulcsok)

`PORT`, `HOST`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, valamint az összes
`ENABLE_*` flag és `*_INTERVAL*` ütemező-kulcs — mind a
[`config/env.ts`](../config/env.ts) sémán át (közvetlen `process.env`-olvasás
itt nincs). Teljes lista: [.env.example](../../.env.example).

## Logok

- Startupkor: effektív útvonal-konfig (titok nélkül), majd szolgáltatásonként
  egy sor `ENABLED (…)` / `DISABLED (set X=true to enable)` formában — a futó
  konfiguráció a naplóból rekonstruálható.
- Inbox-wake események: `[InboxWatcher]` / `[SSE]` / `[SessionStarter]` prefix.

## Tesztek

`npx vitest run src/__tests__/unit/appSecurity.test.ts src/__tests__/integration/authGate.integration.test.ts src/__tests__/integration/api.test.ts`
— az app-factory a legtöbb integrációs tesztben (supertest) is ez az összeszerelési pont.

## Ismert korlátok

- Az inbox-fájl-watcher indítását az `ENABLE_INBOX_WATCHER` env-kulcs kapuzza
  (TASK-QC-013; opt-out: alapból BE, `false` érték kikapcsolja — a `.env.dev`
  `false`-a adja a DEV-elszigeteltséget). A kapu az indító-út függvénye: a
  `.env.dev`-et a `scripts/dev-start.mjs` tölti be; közvetlen `npm run dev`
  esetén a kulcs unset marad és a watcher elindul. A session-indítást ettől
  függetlenül a `shouldWakeUp()` kapuzza.
- A rate-limit memóriában él (nem osztott), több processzes futásnál
  processzenként számol.
