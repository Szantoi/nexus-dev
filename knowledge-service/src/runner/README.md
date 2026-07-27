# src/runner — lokális session-runner (tmux-mentes terminál-futtatás)

## Felelősség

Önálló kliens-processz, amely a knowledge-service mailboxát figyeli, és a
kiosztott terminálokhoz **lokálisan indít Codex, Claude Code vagy Antigravity
CLI-sessionöket** Windows és Linux alatt. A poll-hurok az egyetlen indítási
autoritás; az SSE csak másodperc-szintű ébresztés (nudge), nem indít önállóan.

## Publikus belépési pontok

- Indítás a repo gyökeréből: **`node scripts/runner-start.mjs`** →
  [`main.ts`](main.ts).
- Belső modulok: [`runnerConfig.ts`](runnerConfig.ts) (zod-validált
  YAML-konfig betöltés), [`pollLoop.ts`](pollLoop.ts),
  [`sseListener.ts`](sseListener.ts) (terminálonként egy stream, backoffal),
  [`serverClient.ts`](serverClient.ts) (HTTP-hívások Bearer-tokennel),
  [`sessionLauncher.ts`](sessionLauncher.ts) (a **headless** TerminalSink:
  process supervisor, busy-követés), [`terminalSink.ts`](terminalSink.ts)
  (a `TerminalSink` absztrakció),
  [`terminalSinkRouter.ts`](terminalSinkRouter.ts) (immutable mixed-mode routing),
  [`runnerLifecycle.ts`](runnerLifecycle.ts) (shutdown-koordinátor és
  grace-budget kapu — lásd lent),
  [`ptyHost.ts`](ptyHost.ts) (node-pty és identity-védett processzfa),
  [`ptyProcessCommand.ts`](ptyProcessCommand.ts) (idő- és bufferkorlátos
  OS-processztábla-parancsok), [`attachedSessionManager.ts`](attachedSessionManager.ts)
  (perzisztens PTY-lifecycle), [`attachedTaskMarkerStore.ts`](attachedTaskMarkerStore.ts)
  (durable task-marker), [`sinkFactory.ts`](sinkFactory.ts) (mode → sink
  feloldás), [`processedStore.ts`](processedStore.ts)
  (feldolgozott üzenetek perzisztens nyilvántartása — duplaindítás ellen),
  [`completionCursorStore.ts`](completionCursorStore.ts) (monoton, atomikusan
  mentett durable-completion cursor az attached managerhez),
  [`taskPrompt.ts`](taskPrompt.ts), valamint a provider-adapterek:
  [`cliAdapter.ts`](cliAdapter.ts), [`codexAdapter.ts`](codexAdapter.ts),
  [`claudeAdapter.ts`](claudeAdapter.ts),
  [`antigravityAdapter.ts`](antigravityAdapter.ts).

## TerminalSink absztrakció

A poll-hurok az egyetlen indítási autoritás; a **`TerminalSink`**
([`terminalSink.ts`](terminalSink.ts)) csak *végrehajt*, nem dönt. A kontraktus:
`dispatch(req)` (a launch belépési pont), `isBusy`, `cancel`, `cancelAll`,
`activeCount`, opcionális `minimumShutdownGraceMs()` (a legkisebb biztonságos
runner-grace, ha a sink natív cleanupot birtokol — induláskor a
`shutdown_grace_ms` konfigot ez ellen validálja az
`assertRunnerShutdownBudget`), opcionális `ensureReady()` (attached warm-up),
valamint opcionális, awaitelhető `shutdown()`; a headless sink az utóbbi
hármat nem implementálja.

- **`headless`** (default): a mai [`SessionLauncher`](sessionLauncher.ts) — egy
  leválasztott, egyszeri CLI-processz taskonként, prompt stdinen, élő terminál
  nélkül. A `dispatch` a `launch` aliasa → **nulla viselkedésváltozás**.
- **`attached`** (node-pty): a C-szelet lifecycle-magja + a D-szelet provider-
  bekötése. A [`buildAttachedAssembly`](sinkFactory.ts) minden `mode: attached`
  terminálhoz közös PTY-hostot, durable marker-store-t és session-managert
  épít; **egyelőre csak Codex** provider támogatott (más provider fail-closed
  indulási hiba). A [`attachedProvider.ts`](attachedProvider.ts) adja az
  interaktív spawn-specet (`--no-alt-screen`, sandbox, model, cwd; credential
  env-leképezés), a [`terminalScreen.ts`](terminalScreen.ts)-re épülő
  fail-closed readiness/idle-osztályozást és a **safe nudge**-ot (szigorúan
  validált message-id, session-modell-pin; task-TARTALOM soha nem megy a
  PTY-be). A [`attachedCompletionPump.ts`](attachedCompletionPump.ts) a poll
  ütemén fogyasztja a durable completion-receipteket és a stable-idle
  bizonyítékokat (a cursor csak sikeres kézbesítés után lép), és auditálja a
  stall/completion-idle határidőket ([`attachedDeadlines.ts`](attachedDeadlines.ts)).
  Futó task alatti restart után a stale-marker terminál **parkolva** indul
  (attention_required, busy-gatelt) — a runner NEM bukik el, a pump a szerver
  receiptjéből reconcile-ol és indítja újra.

A [`sinkFactory.ts`](sinkFactory.ts) a terminál `mode` mezője alapján old fel
sinket: `headless` → a megosztott headless sink; `attached` → a terminálhoz
explicit regisztrált sink. Hiányzó regisztráció **világos hibát dob**
(`AttachedSink unavailable for configured terminal '<name>'`). A [`main.ts`](main.ts)
a backlog és poll indítása előtt `await sink.ensureReady?.()` preflightot futtat,
így egy még be nem kötött `attached` terminál fail-closed leállítja a runnert —
nem esik csendben headlessre.

### Üzemi fallback Codex TUI-indítási hiba esetén

Ha a `mode: attached` Codex TUI a PTY-n nem jut el igazolható promptig, a
terminált **kifejezetten** `mode: headless` értékre kell állítani és újra kell
indítani a runnert. Ez nem automatikus degradáció: a konfigurációs módosítás
auditálható, a `codex exec --json` pedig strukturált `complete_task` esemény
alapján zárja le a feladatot. A headless fallback megtartja a provider, modell,
sandbox és MCP-konfigurációt; csak a perzisztens interaktív PTY-t váltja ki.

## Attached lifecycle alap (3C)

Az `AttachedSessionManager` állapotgépe terminálonként legfeljebb egy PTY-t
birtokol. Dispatch előtt `accepted`, sikeres írás után `written`, matching
szervernyugta után `completed` marker kerül a helyi logkönyvtárba. Új task csak
akkor indulhat, ha nincs előző tulajdon: PTY-write bizonytalan eredménye,
receipt előtti processzhalál, markerhiba és cleanup-hiba `attention_required`
vagy más fail-closed állapot.

A terminál csak matching completion **és** a D-szelet által bizonyított stabil
idle után lesz újra `ready`. Task nélküli, illetve már completed task melletti
PTY-exit bounded exponential backoff + jitter + restart-budget szerint
helyreállhat; completion előtti taskot soha nem futtat újra. Runner-crash után
az exact, scope-validált `RunnerCompletionReceipt` az `accepted/written` markert
előbb durable `completed` fázisra emeli, majd a marker csak az új PTY readiness
után törlődik.

A marker saját fájlja fsyncelt, létrehozás/törlés után POSIX-on a teljes új
directory-entry lánc is flusholódik; bizonytalan durability ragadósan blokkolja
az adott store-példányt. A processzfa-leállítás puszta PID helyett Linuxon
`/proc/<pid>/stat` starttime+SID, Windowson PID+CreationDate identityt ellenőriz,
így PID-újrahasznosításkor nem jelez idegen folyamatot. Enumerációs hiba mellett
a natív root-close továbbra is megkísérlődik, és minden cleanup-hiba látható.

**Spawn hard deadline.** A `PtyHost.spawn()` a `spawnDeadlineMs` korláton belül
kötelezően lezárul (default 30 000 ms, max 60 000). A deadline után befutó
„késői nyertes" sessiont a host háttérben teljes processzfa-killel bontja;
a bontási hibák korlátosan megőrződnek, és a manager `shutdown()`-ja a
`drainPendingSpawnUnwinds()`-szel bevárja + jelenti őket.

**Pending-spawn startup-timeout.** Ha a startup-timeout úgy jár le, hogy natív
session még nincs, a terminál `stopping`-ba kerül (a generation megmarad). A
késői spawn sikeres lezárása után egy *automatikus* kísérlet folytatja a
korlátos restart-láncot; explicit `cancel` (generation-bump) vagy shutdown után
soha. A session nélküli `stopping`-ablakban érkező `cancel` bumpolja a
generationt, `true`-t ad, és megelőzi a restartot.

**Cleanup-hiba-ledger.** Minden subscription-/session-cleanup-hiba a keletkezés
pillanatában terminálonkénti ledgerbe kerül (korlátos: 20 bejegyzés +
drop-számláló; kill-hibák sessiononként egyszer, WeakSet-deduppal), így a
root-exit/cancel/shutdown continuation-versenyek egyik sorrendje sem
veszíthet hibát. A ledger új spawn-generáció induláskor ürül (a már
kézbesített — restart-reasonként vagy readiness-rejectionként átadott — hibák
nem buktatják el egy helyreállt terminál későbbi tiszta shutdownját); a
`shutdown()` végül sweepeli az összes ledgert, és bármely hibánál
`AttachedLifecycleError`-t dob.

## Durable completion replay (AttachedSink 3A)

A PTY-output és az SSE nem üzleti completion. A sikeres MCP `complete_task` az
`epic_router.db` append-only `runner_completion_receipts` táblájába ír az
üzleti taskállapottal **azonos SQLite-tranzakcióban**. Az ismételt
`complete_task` ugyanazt a `completionSequence` értéket adja vissza.

A runner a Bearer-tokenből származtatott island/terminal scope-ban kérdezi:

```text
GET /api/mailbox/:terminal/completions?after=<cursor>&limit=<1..500>
```

A [`ServerClient.fetchCompletionReceipts(terminal, expectedIslandId, after)`](serverClient.ts)
elutasítja a hibás, nem monoton, más terminálhoz vagy más islandhez tartozó
választ. A `completionStreamKey()` az endpointot, a várt islandet, a terminált
és a token nem visszafejthető fingerprintjét köti össze, ezért credential- vagy
island-rotáció nem örökölhet régi magas cursort. A `CompletionCursorStore`
cursor-regressziót nem enged és temp-file + rename írást használ. A lifecycle
exact receiptet fogadni képes; a feed folyamatos fogyasztása, provider-readiness
és stabil-idle bizonyítása a D-szeletben kerül a main loopba.

## Függőségi irány

A runner a szolgáltatás **kliense**: csak a `core/logger`-t és a saját
moduljait használja, a szerver-oldali feature-modulokból nem importál —
minden adat a HTTP API-n át jön.

## Natív PTY-függőség és platformkapu

Az attached mód natív végrehajtási rétege a production dependencyként pontosan
rögzített `node-pty@1.1.0`. Windowson ConPTY-t, Linuxon forkpty-t használ; a
child folyamat a runner operációs rendszerbeli jogosultságaival fut. A verziót
nem szabad lebegő tartományra vagy beta kiadásra cserélni. Dependency-frissítés
csak külön upstream-ellenőrzés, tiszta Linux checkoutban regenerált lockfile,
production audit és kétplatformos smoke után fogadható el.

A kiadás tartalmazhat natív prebuildet. Ha az adott Node/OS/architektúrához nincs
használható prebuild, az install `node-gyp` source-buildre esik vissza:

- Linux (Debian/Ubuntu): Python 3, `make`, `g++` és a szokásos libc fejlécek;
- Windows: Python 3, Visual Studio 2022 „Desktop development with C++” workload
  és megfelelő Windows SDK.

A natív CI-kapu a támogatott LTS-vonalakat (Node 22 és 24) ugyanazzal a
Linuxon generált `package-lock.json`-nal telepíti `ubuntu-latest` és
`windows-latest` alatt. Helyi reprodukció mindkét rendszeren:

```text
cd knowledge-service
npm ci --prefer-offline
npm run smoke:pty
```

A `smoke:pty` ellenőrzi a pontos telepített verziót, a natív spawn működését,
Unicode- és szóközt tartalmazó munkakönyvtárat, a resize és input útvonalat,
valamint azt, hogy a supervisor platformfüggő process-tree leállítása a
létrehozott gyermekfolyamatot sem hagyja életben. A nyers `node-pty.kill()` erre
Linuxon önmagában nem elég, és az interaktív háttér-jobok külön process groupba
is kerülhetnek. Ezért a teljes forkpty session folyamatait, gyermek-először,
kontrollált `SIGTERM` → rövid grace → `SIGKILL` fallbackkel kell lezárni;
Windowson a ConPTY saját lezárása rendezi a natív output-workert; a lezárás
előtt rögzített leszármazottakat PID+CreationDate identityvel, gyermek-először,
egyenként ellenőrzi és takarítja. A külön platform-smoke a saját snapshot +
`taskkill` fallback szerződését is ellenőrzi. A smoke belső
workerét ezen felül egy 30 másodperces külső
supervisor és a CI-jobot egy 10 perces felső korlát védi, ezért a natív spawn
beragadása sem teheti végtelenné a kaput. Bármely eltérés fail-closed, nem
tekinthető támogatott platformnak.

## Shutdown és exit-kód szemantika

A [`runnerLifecycle.ts`](runnerLifecycle.ts) `RunnerShutdownCoordinator`-a
birtokolja a processz-kilépési tranzakciót (SIGINT/SIGTERM a `main.ts`-ből):
előbb az ingress áll le (poll-abort + SSE-stop + drain), csak utána az
állapotmentés, majd a sink `shutdown()` (vagy `cancelAll` fallback). **Exit 0
kizárólag akkor lehetséges, ha nulla hiba gyűlt és `sink.activeCount() === 0`**;
minden más út exit 1. Egy referenced safety-deadline a grace lejártakor
kényszerítetten 1-gyel lép ki, így beragadt cleanup sem hagyhat élő sessiont
csendben.

## Konfiguráció

- **`config/runner.yaml`** (sablon: [`runner.yaml.example`](../../config/runner.yaml.example)):
  `server_url`, kiszolgált `terminals` térkép, `poll_interval_ms`,
  `sse_enabled`, `max_backoff_ms`, `log_dir`, `quarantine_existing_on_first_start`,
  provider/model allowlistek, terminálonkénti `mode`
  (`headless` default / `attached` step 3),
  opcionális terminálonkénti `allowed_message_ids` dispatch-gate (a `[]`
  explicit, biztonságos pause: a runner nem claimeli a postaláda többi
  feladatát),
  sandbox, timeout és kimeneti limit. Codexnél az automatizálási út
  `codex exec --json --ephemeral`; a prompt stdinre kerül.
- **Egyszeri canary-grant:** `npm run runner:gate -- grant explorer MSG-...`
  egy helyi, titokmentes `dispatch-gates.json` bejegyzést készít. A runner
  csak a megadott üzenetet indíthatja, és a grant a sikeres launch után
  automatikusan elfogy. `npm run runner:gate -- status` a grantokat, aktív
  sessiont és az utolsó strukturált esemény típusát mutatja; `pause explorer`
  minden dinamikus grantot töröl az adott terminálhoz. A `grant`/`pause` és a
  runner-fogyasztás közös, kizárólagos `.lock` könyvtárat használ: ütközéskor
  a művelet fail-closed hibával leáll (ismételd meg), a `status.locked` pedig
  jelzi, hogy éppen folyamatban van-e módosítás.
- **`shutdown_grace_ms`** (default 20 000, max 120 000): a shutdown-koordinátor
  teljes kerete. Induláskor az `assertRunnerShutdownBudget` a sink
  `minimumShutdownGraceMs()` igénye ellen validálja és **fail-closed elutasítja**
  az alulméretezett konfigot. Attached terminálnál az igény
  `spawnDeadlineMs + cleanupDeadlineMs + cleanupMarginMs` (defaultokkal
  30 000 + 15 000 + 2 000 = **47 000 ms**) — attached módhoz tehát a
  `shutdown_grace_ms`-t legalább erre kell emelni; 120 000 fölötti igényt a
  kapu túlméretezett konfigurációként jelent.
- Env: `RUNNER_TOKEN` (a runner Bearer-tokenje — kötelező), `RUNNER_CONFIG_PATH`
  (default: `<knowledge-service>/config/runner.yaml`). A `runnerConfig.ts`
  saját zod-loader — dokumentált kivétel a config-rétegszabály alól
  (TASK-QC-007).
- Indító script: `scripts/runner-start.mjs` — `.env.runner`, ennek híján
  `.env.dev` betöltése; ha egyik sincs, figyelmeztetéssel tisztán
  process-env-ből fut.

## Logok

`[Runner]` prefixű sorok (CLI preflight, poll-döntések, launch, SSE-állapot);
állapotfájl: `<log_dir>/runner-state.json`, normalizált session-események:
`<log_dir>/<terminal>/<message-id>.jsonl`. Titok nem kerülhet a logba.
Hiányzó vagy sérült állapotfájlnál az első indulás az összes már meglévő
UNREAD taskot tartós karanténba veszi. Ha bármelyik inbox nem olvasható, a
runner fail-closed leáll, és egyetlen sessiont sem indít.

## Tesztek

`npx vitest run src/__tests__/unit/runner.test.ts src/__tests__/unit/runnerSse.test.ts src/__tests__/unit/terminalSinkRouter.test.ts src/__tests__/unit/sinkFactory.test.ts src/__tests__/unit/runnerLifecycle.test.ts src/__tests__/unit/ptyHost.test.ts src/__tests__/unit/attachedTaskMarkerStore.test.ts src/__tests__/unit/attachedSessionManager.test.ts src/__tests__/unit/attachedSessionCleanup.test.ts src/__tests__/unit/attachedRestartPolicy.test.ts src/__tests__/unit/attachedDeadlines.test.ts src/__tests__/unit/attachedCompletionPump.test.ts src/__tests__/unit/attachedProvider.test.ts src/__tests__/unit/terminalScreen.test.ts src/__tests__/integration/runnerPoll.integration.test.ts src/__tests__/integration/runnerSse.integration.test.ts`

## Ismert korlátok

- Terminálonként egyszerre egy session (busy-gate); a poll-intervallum a
  reakcióidő alsó korlátja, ha az SSE nem elérhető.
- A runner nem ellenőrzi a task tartalmát — a kiosztás helyessége a
  szerver-oldali routing felelőssége.
- Antigravity strukturált event-streamet nem dokumentál; az adapter plain-text
  normalizálást használ, és csak sikeres valós `agy --version` preflight után
  indulhat.
- Windowson natív `.exe` CLI ajánlott. `.cmd` shim miatt a runner nem kapcsol
  `shell:true` módra; ez szándékos shell-injection elleni fail-closed viselkedés.
- Attached: a késői spawn *kill-lezárása alatti* rövid al-ablakban (a session már
  trackelt, a bontás fut, felső korlát `cleanupDeadlineMs`) a `cancel` őszintén
  `false`-t ad és nem előzi meg az automatikus restart-folytatást; a restart
  utáni `failed`/backoff állapot viszont már cancellálható. Ugyanez a szemantika
  minden automatikus `cleanupFailedStart` stopping-ablakra is áll (review 2,
  P3 — elfogadott, dokumentált korlát).
- Attached: egy **explicit** más modellt kérő task végleges policy-elutasítás.
  A poll a claim release után tartósan karanténba helyezi, ezért nem indul újra
  minden tickben. Átmeneti refusal (például még nem ready PTY) továbbra is
  újrapróbálható marad.
- A screen-parser a duplázott ESC-et (`ESC ESC [...]`) nem kezeli
  sequence-restartként — terminfo-vezérelt program ilyet nem ad ki, és a
  release-t a receipt + outputEpoch + csend-kapu úgyis dominálja (D-review P3).
