# ADR-049: Dual-session chat/work architektúra és párhuzamos workerek

- **Státusz:** accepted
- **Dátum:** eredeti dátum ismeretlen (Phase 1 legkésőbb 2026-06-29 előtt; import: 2026-07-14); rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (eredeti ADR az előd-repóban)
- **Rekonstruált:** igen — kód, tesztek, kódkommentek alapján

## Kontextus

Egyetlen terminál-session egyszerre volt "beszélgetőpartner" (Telegram-válaszok,
gyors koordináció) és "dolgozó" (hosszú munkafolyamatok). A két szerep ütötte egymást:
a chat megszakította a munkát, a munka miatt a chat nem válaszolt, és a drága modell
futott olcsó feladatokon is.

## Döntés

Terminálonként KÉT session-típus, három fázisban bevezetve:

- **Phase 1 — Dual-session + multi-bot:** külön chat session
  (`spaceos-{terminal}-chat`, olcsó modell) és work session; terminálonként saját
  Telegram-bot; közös SQLite WAL-alapú `MemoryStore` (chat/work/shared szekciók),
  hogy a két session konkurensen írhasson-olvashasson. A root is kap chat sessiont.
- **Phase 2 — Work session kérés + audit:** a chat session MCP-n át kérhet work
  sessiont (`request_work_session`); minden kérés és spawn immutable append-only
  logba kerül (`workSessionLog`).
- **Phase 3 — Párhuzamos workerek + domain-tudás:** több konkurens work session
  terminálonként (workerRegistry), minimál-kontextusú raw workerek N-az-1-hez
  szelekcióval (bestOfN, a chat session értékel), DAG-validált worker-függőségek
  (dagValidator), költségkeret (costLimiter), és task-tartalom-alapú domain-memória
  betöltés (knowledgeLoader + ADR-046 hookok bővítése).

## Design intent

Szerep-szeparáció költségtudatosan: az olcsó (Haiku) chat session mindig elérhető és
ő dönt a drága munka indításáról; a work session fókuszált kontextust kap (csak a
releváns domain-tudást). A Phase 3 a QUALITY.md 6. és 8. pontjának megvalósítása:
specializált agentek, orchestrator–worker minta, erőforrás-keret (costLimiter).

## Alternatívák

Az eredeti ADR elveszett. A kódszerkezetből valószínűsíthető (nem bizonyított)
elvetett irány: egyetlen session prioritás-alapú megszakításokkal — a WAL-alapú
közös memória és a session-név-konvenció arra utal, hogy a szeparációt választották
a megszakítás-kezelés komplexitása helyett.

## Következmények

- A tmux-session-térkép megduplázódott; a session-detektálásnak két socketet kell
  próbálnia (chatSessionStarter).
- Az ADR-060 (CLI-agnosztikus Telegram) erre a fundamentumra épült rá.
- A worker-menedzsment (spawn, collect, cost) MCP toolokként is elérhető.

## Biztonsági hatás

A work session spawn tmux send-keys útján történik — a bemenet sanitizálása kritikus
(shell-injection felület). A workSessionLog audit trailt ad minden spawnról.

## Kapcsolódó kód

- Phase 1: `knowledge-service/src/memoryStore.ts`, `src/telegram/telegramService.ts`,
  `src/pipeline/telegramBot.ts:106`
- Phase 2: `knowledge-service/src/pipeline/workSessionLog.ts`, `src/sessionStarter.ts:1105`
- Phase 3: `knowledge-service/src/pipeline/workerRegistry.ts`, `bestOfN.ts`,
  `dagValidator.ts`, `costLimiter.ts`, `knowledgeLoader.ts`, `src/sessionStarter.ts:1235`
- Tesztek: `__tests__/workerRegistry.test.ts`, `__tests__/costLimiter.test.ts`,
  `__tests__/dagValidator.test.ts`, `__tests__/unit/memoryStore.test.ts`,
  `__tests__/unit/workSessionLog.test.ts`

## Bizonyíték

- Kódkommentek: `memoryStore.ts:4` (Phase 1), `workSessionLog.ts:4` (Phase 2),
  `sessionStarter.ts:1235,1324,1366` (Phase 3, MSG-BACKEND-080)
- `mcp.ts:4098`: "updated 2026-06-29 for multi-bot" — Phase 1 multi-bot dátum-felső korlát
- git: 823db70 (Initial commit, 2026-07-14) — mindhárom fázis készen érkezett
