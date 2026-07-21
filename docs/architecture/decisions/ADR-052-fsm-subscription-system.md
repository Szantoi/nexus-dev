# ADR-052: FSM feliratkozási rendszer (push-értesítések + eszkaláció)

- **Státusz:** accepted
- **Dátum:** Phase 1: 2026-06-30, Phase 2: 2026-07-02; rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (eredeti ADR az előd-repóban)
- **Rekonstruált:** igen — kód és datált kódkommentek alapján

## Kontextus

A terminálok egymás állapotát pollozással figyelték (inbox-fájl olvasgatás), ami
token-pazarló és lassú. Kellett egy push-alapú értesítési mechanizmus a pipeline-
eseményekre (task done/blocked, inbox-új-üzenet, session-életciklus), és egy
automatikus kezelés a beragadt taskokra.

## Döntés

- **Phase 1 (2026-06-30) — Feliratkozási mag:** terminálok feliratkozhatnak task-
  vagy terminál-eseményekre (`done | blocked | progress | inbox_new | outbox_done |
  session_started | session_ended`), lejárattal (default 1h). Kézbesítés három
  csatornán: SSE, Telegram, Inbox (vagy `auto`). A forrás az egységes pipeline
  eseménybusz (`eventBus`).
- **Phase 2 (2026-07-02) — Task-eszkaláció:** feliratkozás-timeout után automatikus
  lépcső: Retry #1 = nudge (tmux send-keys) → Retry #2 = session-újraindítás +
  inbox-újrainjektálás → eszkaláció a root inboxába teljes kontextussal.
- ADR-053-kiegészítés: checkpoint-trigger feliratkozás terminál-WORK-sessiont indít
  (nem csak értesít).

## Design intent

Esemény-vezérelt flotta pollozás helyett: az agent akkor kap kontextust, amikor
történik valami — ez tokent spórol és csökkenti a reakcióidőt. Az eszkalációs
lépcső a QUALITY.md 8. "erőforrás-keret + eszkaláció" elve: nincs végtelen
javítgatási spirál, a beragadt munka determinisztikus úton jut el a koordinátorig.

## Alternatívák

Az eredeti ADR elveszett. A kontextusból valószínűsíthető (nem bizonyított) elvetett
irány: gyakoribb pollozás / cron-alapú státuszellenőrzés — a "push-based event
notifications" kifejezés a kódfejlécben erre a szembeállításra utal.

## Következmények

- Az eseménybusz központi függőség lett; az epicRouter DONE-detektálása
  (ADR-053) eseményt emittál, amire a feliratkozások épülnek.
- A subscription-ök memóriában + fájlban élnek, lejárat-kezeléssel.
- A taskEscalation tmux-műveleteket végez — a session-kezeléssel közös felület.

## Biztonsági hatás

A Telegram-kézbesítés kifelé irányuló csatorna; az eszkaláció tmux send-keys
injektálást használ (input-sanitizálás szükséges). Titkot az értesítések nem
hordozhatnak.

## Kapcsolódó kód

- `knowledge-service/src/pipeline/subscriptionManager.ts` — Phase 1 mag
- `knowledge-service/src/pipeline/subscriptionTools.ts`, `src/routes/subscriptionRoutes.ts` — MCP + SSE/HTTP
- `knowledge-service/src/pipeline/taskEscalation.ts` — Phase 2 retry/eszkaláció
- `knowledge-service/src/bootstrap/app.ts:242,245` — bekötés

## Bizonyíték

- Kódkommentek: `subscriptionManager.ts:4-7` ("2026-06-30: Phase 1 Core Implementation"),
  `taskEscalation.ts:4-12` ("2026-07-02: Phase 2 Implementation")
- git: 823db70 (Initial commit, 2026-07-14)
