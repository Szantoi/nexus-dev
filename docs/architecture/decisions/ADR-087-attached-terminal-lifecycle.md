# ADR-087: Attached terminál életciklus és completion-szerződés

- **Státusz:** proposed
- **Dátum:** 2026-07-22
- **Döntéshozó(k):** Gábor + root/architect review szükséges
- **Rekonstruált:** nem

## Kontextus

A `1ac43f6` commit bevezette a `TerminalSink` végrehajtási határt és a
terminálonkénti `headless | attached` konfigurációt. Az `attached` mód még
szándékosan fail-closed. A következő lépés hosszú életű, látható és vezérelhető
CLI-sessiont igényel Windowson és Linuxon úgy, hogy a poll maradjon az egyetlen
launch authority, és a headless VPS-üzem ne változzon.

A PTY nyers kimenetéből nem bizonyítható megbízhatóan az MCP `complete_task`.
Emellett a runner outbound-only kliens, a PTY a runner processzében él, a
knowledge-service jelenleg SSE-t ad, de PTY WebSocket gatewayt nem.

## Döntés

1. Egy `TerminalSinkRouter` terminálnév alapján delegál a közös headless vagy a
   terminálhoz tartozó attached sinknek; ezzel egy runner vegyes módot kezel.
2. Az attached sessiont a runner birtokolja, terminálonként egy hosszú életű
   `node-pty` processzel. A session runner-crasht nem él túl; restart után új PTY
   indul, és tartós szerverállapotból reconciliál.
3. Task-completion kizárólag a `complete_task` szerveroldali feldolgozásakor
   létrejövő, terminal/message-id kötött durable receipt. SSE csak ébresztés; a
   runner cursoros API-ból pótolja a kihagyott nyugtákat.
4. A terminál csak matching completion receipt és stabil, provider-specifikus
   PTY-idle együttese után lesz ismét `ready`. Idle önmagában nem completion.
5. A PTY dashboard gateway a runner mellett fut, alapból tiltva és localhostra
   kötve. Egy controller lease írhat, több kliens nézhet; a hozzáférés rövid
   életű tickethez, limithez és audithoz kötött.
6. A nyers PTY transcript alapból nem perzisztálható. A replay korlátozott
   memóriapuffer, a lassú dashboard-klienst bontani kell.
7. A legacy tmux/pipeline watcherekből csak tiszta osztályozási szabály vehető
   át; automatikus Enter/kill/értesítési mellékhatás nem.

## Design intent

A completion és az interaktív képernyőállapot két külön tény. Az első üzleti,
szerveroldali és tartós; a második lokális végrehajtási állapot. Külön kezelésük
akadályozza meg, hogy egy promptnak látszó karakterlánc vagy SSE-kiesés dupla
taskot indítson. A runner-oldali PTY-tulajdon megtartja az outbound-only
topológiát és elkerüli a központi szerver távoli processzfelügyeleti jogkörének
bővítését.

## Alternatívák

- **PTY-outputból completion:** elvetve; provider-/verziófüggő, spoofolható és
  alternate-screen mellett hiányos.
- **SSE mint egyetlen completion-forrás:** elvetve; reconnect és processzleállás
  alatt esemény veszhet.
- **Központi szerver birtokolja/relézi a PTY-t:** elvetve az MVP-ből; ellentétes
  az outbound-only runnerrel, nagyobb támadási felület és hibadomén.
- **tmux mint hordozó:** elvetve; nem ad Windows-native támogatást.
- **Csendes attached → headless fallback:** elvetve; eltérő izolációs és
  lifecycle-szemantikát rejtene el.
- **PTY túlélő külön daemon:** későbbi opció; az MVP-hez aránytalan új service,
  auth-, upgrade- és recovery-felület.

## Következmények

Pozitív: determinisztikus mixed-mode routing, crash után visszaállítható
completion, megfigyelhető és kontrollálható session, Windows/Linux közös
architektúra. Negatív: új durable receipt store/API, natív dependency, provider-
specifikus readiness classifier, lokális WebSocket támadási felület és összetett
race-condition tesztmátrix szükséges.

## Biztonsági hatás

A `node-pty` child a runner jogaival fut, a dashboard pedig távoli
billentyűinjektálási felület. Kötelező a localhost-default, terminál-szkópolt
auth, rövid életű ticket, egyíró-lease, input/resize/rate limit, bounded replay,
secret-redaction és a transcript-perzisztencia tiltása. A sink nem kerülheti meg
a lokális provider/model/sandbox allowlistet vagy a szerveroldali autorizációt.

## Kapcsolódó kód

- `knowledge-service/src/runner/terminalSink.ts`
- `knowledge-service/src/runner/sinkFactory.ts`
- `knowledge-service/src/runner/main.ts`
- `knowledge-service/src/runner/serverClient.ts`
- `knowledge-service/src/runner/sseListener.ts`
- `knowledge-service/src/interfaces/mcp/tools/mailbox.tools.ts`
- `knowledge-service/src/pipeline/epicRouter.ts`

## Bizonyíték

- `1ac43f6` — TerminalSink + headless/attached konfiguráció, headless default.
- `docs/plans/ATTACHED-SINK-STEP-3.md` — lifecycle, protokoll, teszt és rollout.
- `src/runner/sseListener.ts` — az SSE jelenleg wake-only.
- `src/runner/sessionLauncher.ts` — headless siker: processz + durable
  `complete_task` esemény együtt.
- `src/pipeline/completionReceiptStore.ts` — append-only, scope-olt receipt store.
- `src/pipeline/epicRouter.ts` — task-completion + receipt közös tranzakciója.
- `src/interfaces/http/routes/mailbox.routes.ts` — auth-derived island és saját
  terminálra szűkített cursoros feed; a claim tartós island-kötése.
- `src/__tests__/integration/completionAuth.integration.test.ts` — valódi
  token→terminal/island mapping, root-override és island-rotáció negatív teszt.
- `src/runner/serverClient.ts` — expected-island ellenőrzés és endpoint/island/
  terminal/credential-fingerprint alapú cursor namespace.
- Élő DEV evidence (2026-07-22): `island-live-a/conductor`, sequence 1; root
  cross-terminal completion DENY, cursoros replay, üres `after=1` oldal és
  azonos sequence-et adó idempotens retry PASS. A DEV szerver a 3466-os porton
  futott, majd le lett állítva; production deploy nem történt.

## Nyitott kérdések

- Az első két független review findingjainak javítását elfogadja-e a re-review
  (claim island-kötés, legacy bypass tiltás, credential-scoped és íráshiba-álló
  cursor, literális checkpoint-illesztés)?
- A három CLI mely verzióján és mely screen-markerrel igazolható stabil
  interaktív readiness Windowson és Linuxon?
- A dashboard későbbi központi relay-je szükséges-e, vagy a localhost +
  tunnel/tailnet operációs modell elegendő?
