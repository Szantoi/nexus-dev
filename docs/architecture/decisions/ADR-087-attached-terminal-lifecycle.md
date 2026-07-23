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
8. *(kiegészítés, 2026-07-23, C-szelet)* A runner élete alatt kihaló vagy
   spawn-hibás PTY-t a manager **korlátos automatikus restarttal** állítja
   helyre, de kizárólag task nélküli vagy már completed-task melletti exitnél:
   exponenciális backoff + jitter, restart-budget (default 3 kísérlet), a
   budget folyamatos READY-stabilitás után áll vissza; a budget kimerülése a
   terminált tartósan `failed`-re parkolja. Completion előtti taskot restart
   sosem futtat újra (`attention_required`). A spawn-fázis hard deadline-t kap
   (`spawnDeadlineMs`); a runner minimális shutdown grace-e
   `spawnDeadline + cleanupDeadline + margin`. Minden cleanup-hiba
   terminálonkénti ledgerben gyűlik és a shutdown felé propagál; explicit
   cancel vagy shutdown automatikus restartot soha nem enged tovább.

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
- CAS-korrekció utáni élő DEV evidence: két eltérő, párhuzamos conductor claim
  pontosan `200+409`; a nyertes `island-live-cas` scoped completionje sequence 1,
  azonos sequence-es retry PASS; root cross-terminal DENY. DEV leállítva.
- A-szelet független review 3 (`d607aaa`): PASS, P0/P1/P2 finding nélkül;
  130/130 releváns teszt és közvetlen claim/release/completion/legacy-clobber
  mátrix PASS. Ez az A-szeletet zárja, a teljes ADR elfogadását még nem.
- `162f7e7` — pontos `node-pty@1.1.0` production dependency, tiszta Linux
  checkoutban generált lock, Node 22/24 × Ubuntu/Windows CI-mátrix és natív
  PTY supervisor/worker smoke kemény határidőkkel.
- Linux VPS evidence: Debian 13, Node 22.22.1, forkpty, Unicode/szóköz cwd,
  resize/write és `SIGTERM`-et ignoráló child session-szintű `SIGKILL` cleanup
  PASS. Windows evidence: Node 24.13.0, ConPTY, ugyanaz a lock és contract PASS;
  az upstream `AttachConsole` helperhiba mellett az előre snapshotolt PID-fa
  fallback bizonyított, minden más stderr fail-closed.
- B-szelet független review: PASS, P0/P1/P2 finding nélkül; külön watchdog,
  residual-stderr negatív teszt, lock/engine egyezés és process-leak ellenőrzés
  PASS. A B-szelet lezárt; az ADR a C–F szeletek miatt továbbra is `proposed`.
- C-szelet leállítási checkpoint (2026-07-23): a router, PTY-host,
  AttachedSessionManager, durable marker, poll-drain és lifecycle implementációs
  jelöltje commitolatlan WIP. A független re-review `FAIL / 3×P1`: közös
  cleanup-tranzakció nélkül elveszhet dispose-hiba; pending-spawn timeout után
  megszakadhat az automatikus restart; a minimum shutdown grace nem tartalmazza
  a kikényszerített spawn-settlement budgetet. A folyamatok leálltak; az utolsó
  publikált/implementációs baseline `origin/main@e627495`, C implementációs
  commit, push vagy deploy nem történt. Az ADR státusza változatlanul
  `proposed`; C csak javítás + teljes QUALITY + új független PASS után tekinthető
  bizonyítottnak.

- C-szelet P1/P2-javítási kör (2026-07-23 este, @root): mindhárom P1 javítva —
  cleanup-hiba-ledger (gyűjtéskori rögzítés, WeakSet-dedup, shutdown-sweep +
  `drainPendingSpawnUnwinds`); pending-spawn timeout utáni bounded
  restart-folytatás (csak automatikus kísérletnél; cancel generation-bumppal,
  shutdown flaggel kizárva); `minimumShutdownGraceMs = spawnDeadline +
  cleanupDeadline + margin` az új `PtyHost.spawnDeadlineMs` hard deadline-nal.
  Az 1. friss független review (futtatható reprókkal) 2 P2-t talált (ledger
  generáció-szivárgás; cancel no-op a timeout utáni stopping-ablakban) —
  javítva; a 2. review **PASS, P0/P1/P2 finding nélkül**, mindkét P2-fix
  mutáció-verifikált, a méret-kapu miatti kiszervezések
  (`ptyProcessCommand.ts`, `assertAttachedPreflightState`,
  `clearCompletedMarkerForRestart`) viselkedés-azonosak. Kapuk: 88 fájl /
  1500+1 teszt, coverage 45,2%, size/audit/secret/tasks/links PASS, valós
  Windows `smoke:pty` PASS. Ismert, elfogadott P3-korlát: a késői spawn
  kill-lezárása alatti al-ablakban a cancel `false`-t ad és nem előzi meg a
  restart-folytatást. Az ADR a D–F szeletek miatt továbbra is `proposed`.

## Nyitott kérdések

- A három CLI mely verzióján és mely screen-markerrel igazolható stabil
  interaktív readiness Windowson és Linuxon?
- A dashboard későbbi központi relay-je szükséges-e, vagy a localhost +
  tunnel/tailnet operációs modell elegendő?
