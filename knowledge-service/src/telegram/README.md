# src/telegram — Telegram-kommunikáció (user ↔ agent ↔ agent)

## Felelősség

Szabad szöveges Telegram-üzenetváltás: felhasználó → agent (feladatkiosztás,
kérdés), agent → felhasználó (válaszok MCP toolokon át), agent → agent
broadcast. A beszélgetések és a kimenő válasz-sor SQLite-ban perzisztens.

## Publikus belépési pontok

Az [`index.ts`](index.ts) exportálja:

| Fájl | Szerep |
|---|---|
| [`telegramService.ts`](telegramService.ts) | `sendTelegramMessage`, `sendNotification`, üzenet-injektálás terminálba, kimenő válasz-worker (`startResponseWorker`/`stopResponseWorker`) |
| [`conversationManager.ts`](conversationManager.ts) | beszélgetés-életciklus, üzenet- és válaszsor-kezelés, lejáratás |
| [`intentParser.ts`](intentParser.ts) | bejövő üzenet szándék- és cél-terminál felismerése |
| [`multiBotManager.ts`](multiBotManager.ts) | több bot (terminálonkénti botok) indítása/leállítása |
| [`contextBuilder.ts`](contextBuilder.ts) | beszélgetés-kontextus összeállítása |

A bejövő webhook/polling koordinációt a
[`pipeline/channelCoordinator.ts`](../pipeline/channelCoordinator.ts) és a
[`pipeline/telegramBot.ts`](../pipeline/telegramBot.ts) végzi; a Telegram MCP
toolok az [`interfaces/mcp/tools/telegram.tools.ts`](../interfaces/mcp/tools/telegram.tools.ts)-ban élnek.

## Függőségi irány

telegram → `config` (secrets, útvonalak) + `core/logger` + saját SQLite tár
(`TELEGRAM_DB_PATH`, default `<DATA_DIR>/telegram.db`). A modult a
`bootstrap/startup.ts` (worker, multi-bot) és a pipeline-koordinátor hívja.

## Konfiguráció (env-kulcsok)

`TELEGRAM_BOT_TOKEN` (preferált; `TELEGRAM_TOKEN` legacy alias),
`TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_URL` (üres = polling),
`TELEGRAM_WEBHOOK_SECRET`, `ENABLE_TELEGRAM_COORDINATOR`, `ENABLE_MULTI_BOT`,
`TELEGRAM_BOTS_CONFIG` (multi-bot YAML, default
`<SPACEOS_ROOT>/config/telegram-bots.yaml`), `TELEGRAM_DB_PATH` — mind a
[`config`](../config/README.md) rétegen át. **DEV-ben a Telegram kötelezően
KI** (a `.env.dev.example` kapcsolja ki) — DEV nem küldhet üzenetet.

## Logok

Küldés/fogadás, worker-ciklusok és hibák a `core/logger`-en, `[Telegram]` /
bot-név prefixszel; token naplóba nem kerül.

## Tesztek

A csatorna-szintű viselkedést a pipeline-tesztek fedik (pl.
`src/__tests__/agent/communication.test.ts`, `unit/conductorModules.test.ts`);
a hermetikus suite nem hív valódi Telegram API-t.

## Ismert korlátok

- A `pipeline/telegramBot.ts` 800 sor feletti (allowlist, bontása:
  TASK-QC-008E).
- Közvetlen dedikált unit-teszt-lefedettsége alacsony — a TASK-QC-006
  coverage-programjának jelöltje.
