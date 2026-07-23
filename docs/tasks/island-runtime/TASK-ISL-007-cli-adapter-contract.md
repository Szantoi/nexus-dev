---
id: TASK-ISL-007
title: Platformfüggetlen CLI-adapter és process supervisor szerződés
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M3
epic: ISL-CLI-ADAPTERS
status: in_progress
updated: 2026-07-22
priority: critical
depends_on: [TASK-ISL-001]
parallel_with: [TASK-ISL-002, TASK-ISL-004]
owner_role: platform
created: 2026-07-18
source: cross-platform CLI requirement and SZIGET-07
---

# Platformfüggetlen CLI-adapter és process supervisor szerződés

## Cél

A runner ne Claude-specifikus folyamatot indítson, hanem egységes, tesztelhető
adapteren keresztül kezeljen headless és PTY-alapú CLI agenteket Windows és Linux alatt.

## Mikor jó?

Új CLI támogatása a core poll/lease logika módosítása nélkül, egy adapterrel
megoldható; a process lifecycle és a strukturált események minden platformon azonosak.

## Scope

1. `detect`, `version`, `capabilities`, `launch`, `send`, `events`, `cancel`,
   `resume`, `terminate`, `health` adapter contract.
2. Headless stdio és interaktív PTY capability külön kezelése.
3. Strukturált normalizált eventek: started, progress, tool, output, blocked,
   completed, failed, cancelled.
4. Cross-platform spawn argumentlistával, shell-injection nélkül.
5. Process-tree leállítás, timeout, output limit, backpressure és secret redaction.
6. Adapterverziózás, capability negotiation és fake adapter tesztharness.
7. Explicit sandbox/permission policy; veszélyes auto-approve ne legyen default.

## Elfogadási feltételek

- [ ] Core runner nem tartalmaz Codex/Claude/Antigravity-specifikus elágazást.
- [ ] Headless és PTY adapter ugyanarra a lifecycle-re normalizálható.
- [ ] Args/prompt nem kerül shell string interpolációba.
- [ ] Cancel/timeout a teljes processzfát lezárja Windowson és Linuxon.
- [ ] Kimeneti limit és hibás JSON/stream nem dönti le a runnert.
- [ ] Fake adapterrel minden lifecycle-ág determinisztikusan tesztelt.

## Kötelező ellenőrzés

Windows és Linux CI-fixture, unicode/space path, nagy stdout/stderr, child tree,
timeout, cancellation, malformed event és secret-redaction teszt.

## Kilépési feltétel

`done`, ha a három valós adapter csak a contractot implementálja, és a platform-
specifikus rész a process supervisor absztrakció mögött marad.

## Végrehajtási napló

### 2026-07-21 — Codex-elsődleges operatív checkpoint

- **Goal:** providerfüggetlen, shell-interpoláció nélküli headless CLI-varrat
  létrehozása, amelyből a Codex Linuxon tartós mailbox-taskot tud végrehajtani.
- **Sikerkritérium:** zárt adapterregistry; validált provider/terminal/model
  konfiguráció; normalizált JSONL lifecycle; timeout/output/process-tree guard;
  unit teszt; valós Linux Codex canary.
- **Kilépési feltétel:** ez a checkpoint akkor zárható, ha a fenti Linux Codex
  út PASS és a hiányzó teljes contractsűrűség külön maradó tételként rögzített.
  A TASK-ISL-007 `done` feltétele továbbra is a teljes headless + PTY, cancel,
  resume, backpressure és mindhárom adapterre alkalmazott contract.
- **Erőforráskeret:** egy implementációs kör; célzott teszt + teljes suite;
  legfeljebb három javítási retry; secret nem kerülhet logba.

Megvalósult:

- `cliAdapter.ts`, `adapterRegistry.ts`, `cliDiscovery.ts` és a három provider-
  adapter elkészült;
- az argv tömbként jut a `spawn` hívásba, `shell` használata nélkül;
- timeout, maximális output, process-tree termination és normalizált eseménylog
  működik;
- a hálózati task csak lokálisan engedélyezett terminált/modellt választhat; a
  binary, provider, sandbox, credential-env és extra argumentum lokális config;
- célzott runner/mailbox/launch-authority tesztek: 6 fájl, 69 teszt PASS;
  typecheck, teljes Vitest suite
  és build PASS.

Valós Linux evidence: Debian 13, x86_64, Node v22.22.1, Codex 0.144.6;
`MSG-EXPLORER-025` read-only és `MSG-EXPLORER-026` workspace-write canary PASS.
Részletes napló és rollback:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.

**Maradó FAIL/nyitott feltétel:** PTY/send/resume nincs teljesen implementálva;
Claude és Antigravity valós adapterbizonyítéka hiányzik; a natív Windows Codex
smoke sandbox-helper jogosultsági hibán blokkolt. Emiatt a task `in_progress`,
nem `done`, és független review még szükséges.

### 2026-07-22 — TerminalSink 1–2 kész, AttachedSink 3. lépés tervezési checkpoint

- **Goal:** a már merge-elt végrehajtási varrat után az attached módot olyan
  részletességgel specifikálni, hogy a natív dependency, completion, PTY-
  életciklus és dashboard implementációja külön szeletekben, fail-closed módon
  végrehajtható és review-zható legyen.
- **Sikerkritérium:** pontos mixed-mode routing; szerverautoritatív durable
  completion; egzakt session/idle/heartbeat szabály; dashboard auth/control;
  Windows/Linux dependency- és tesztkapu; rollout/rollback rögzítve.
- **Kilépési feltétel:** az al-terv és az ADR review-képes, a nyitott
  architekturális kérdések explicitek, és egyetlen pont sem kezeli a PTY-
  szöveget vagy az SSE-t completion source of truthként.
- **Erőforráskeret:** dokumentációs/tervezési kör; production kód, dependency,
  deploy és külső állapot módosítása nélkül.

Eredmény:

- az 1–2. lépés `1ac43f6` commitban a `main` ágon, CI PASS: `TerminalSink`, a
  viselkedésazonos `HeadlessSink`, terminálmód config és fail-closed preflight;
- létrejött a végrehajtható
  `docs/plans/ATTACHED-SINK-STEP-3.md` A–F megvalósítási szeletekkel;
- létrejött a proposed `ADR-087`: mixed-mode router, runner-owned PTY/gateway,
  durable completion receipt, completion+idle kettős kapu, egyíró/többnéző;
- igazolt korrekció: a szerver ma SSE-t biztosít, PTY WebSocket gatewayt nem;
  a régi pipeline watcherekből csak tiszta classifier-logika vihető tovább;
- a `node-pty` session csak a runner élettartamán belül perzisztens. Runner-
  crash után új PTY és durable receipt/claim reconciliáció szükséges.

**Maradó kapu:** ADR-087 architecture/security review; A szelet (durable receipt)
után Linuxon regenerált lock és Windows/Linux `npm ci`; majd router/lifecycle,
Codex PoC, dashboard, végül a teljes valós 3×2 CLI-mátrix. Emiatt a task továbbra
is `in_progress`.

### 2026-07-22 — AttachedSink 3A durable completion-receipt implementáció

- **Goal:** a PTY-outputtól és SSE-kapcsolattól független, szerverautoritatív
  completion-nyugta és cursoros runner-replay út létrehozása.
- **Sikerkritérium:** a `complete_task` állapotváltás és a nyugta egyetlen
  SQLite-tranzakció; az ismételt hívás idempotens; az island/terminal scope nem
  kérésparaméterből, hanem hitelesített kontextusból származik; a runner csak
  monoton cursort ment; hibás vagy más terminálhoz tartozó válasz fail-closed.
- **Kilépési feltétel:** az implementáció és a regressziós/élő bizonyíték kész,
  majd a készítőtől független reviewer PASS-t ad a tranzakció, autorizáció,
  idempotencia és cursor-invariánsokra. A jelen checkpoint az első részt
  teljesíti; a review miatt a task továbbra is `in_progress`.
- **Erőforráskeret:** natív dependency nélküli A-szelet; célzott és teljes CI-
  kapuk; DEV-only élő ellenőrzés a 3466-os porton; production deploy nélkül.

Megvalósult:

- `completionReceiptStore.ts`: append-only, egyedi
  `(island_id, terminal_id, message_id)` nyugta, növekvő sequence és cursoros
  lekérdezés;
- `epicRouter.ts`: a mailbox task completion és a nyugta ugyanabban a
  `better-sqlite3` tranzakcióban íródik, ezért nyugtahiba esetén az üzleti
  állapot is rollbackel;
- MCP `complete_task`: ismétléskor ugyanazt a nyugtát adja vissza
  `idempotent: true` jelzéssel;
- `GET /api/mailbox/:terminal/completions`: szerveroldali island-scope,
  saját-terminál/root autorizáció, validált `after`/`limit`, lapozható replay;
- `serverClient.ts` és `completionCursorStore.ts`: szigorúan validált receipt-
  feed, más terminál/hibás sequence elutasítása, atomi és monoton helyi cursor;
- a runner főciklusa még szándékosan nem fogyasztja a feedet: ezt a C–D szelet
  köti össze a PTY lifecycle-lal és a `completion + stabil idle` kapuval.

Ellenőrzési bizonyíték:

- `npm run typecheck` — PASS;
- `npm run lint:ratchet` — PASS, 784 figyelmeztetés ≤ 786 baseline;
- négy célzott suite — 110 teszt PASS;
- teljes `npm run test:coverage` — PASS, coverage floorok teljesültek;
- `npm run audit:prod` — 0 vulnerability;
- `npm run secret-scan:all`, `npm run check:links`, `npm run check:tasks` és
  `npm run check:size` — PASS;
- élő DEV-lánc — PASS: `claim → complete_task → sequence=1 receipt → after=1`
  üres replay → idempotens retry ugyanazzal a sequence-szel.

Koordináció: az `AGENT-CHANNEL.md` szerint @codex az implementáló, @root a
független reviewer. A B-szelet előzetes natív bizonyítéka rendelkezésre áll:
`node-pty` 1.1.0 Windows/ConPTY és Linux/forkpty install+spawn PASS; a dependency
és a Linuxon regenerált lock azonban csak az A-review után kerül a repóba.

### 2026-07-22 — AttachedSink 3A első review és korrekció

Az első két, egymástól független review **FAIL / changes required** eredményt
adott. A read-oldali island-szűrés önmagában nem volt elég: a claim nem kötötte
az aktív taskot tartósan a hitelesített islandhez, a legacy REST/file-DONE út
pedig nyugta nélkül is lezárhatott volna ilyen taskot. Emellett a runner cursor
kulcsa nem választotta szét az island- és credential-rotációkat, a cursor
memóriában a tartós fájlírás előtt lépett előre, a checkpoint-illesztés pedig
escape nélkül épített reguláris kifejezést.

Korrekció:

- a `terminal_context.current_island_id` a claimben rögzíti a hitelesített
  erőforrás-tulajdont; claim, release és completion csak pontos
  terminal+island egyezéssel engedélyezett, root cross-terminal felülírás nincs;
- az MCP completion ugyanabban a SQLite-tranzakcióban ellenőrzi a tárolt
  task+island kötést, amelyben az állapotot és a receiptet commitolja;
- a legacy REST és a ProjectDispatcher file-DONE út fail-closed megtagadja az
  island-scoped task lezárását, ezért nincs receipt nélküli kerülőút;
- a replay válasz minden receiptjén ellenőrzi az elvárt islandet, streamkulcsa
  server+terminal+island+credential-fingerprint; rotáció új cursort kap;
- a cursor csak sikeres temp-write+rename után lép előre memóriában;
- a checkpoint message ID regex-metakarakterei escape-elve, literálisan
  illeszkednek;
- valós `authenticateMcp`/`authenticateRest` integrációs teszt bizonyítja, hogy
  ugyanazon token island-mappingjének rotációja után a régi claim nem írható és
  nem olvasható kereszt-szigetből.

Ellenőrzési bizonyíték a korrekció után:

- typecheck, build és lint-ratchet PASS (`784 ≤ 786`);
- 7 célzott suite / 142 teszt PASS;
- teljes coverage PASS: statements 41,76%, branches 36,29%, functions 41,25%,
  lines 42,20%;
- production audit 0 vulnerability; secret, link, task és méretkapu PASS;
- a méretkapu miatt a checkpoint-projekció külön
  `checkpointStatusUpdater.ts` modulba került, új allowlist nélkül;
- élő DEV/3466 PASS: saját conductor tokennel claim, root cross-terminal
  completion DENY, `island-live-a` sequence=1 receipt, `after=1` üres replay,
  idempotens retry ugyanazzal a sequence-szel; a DEV szerver leállítva,
  production deploy nem történt.

**Állapot:** a teljes kapu- és élő DEV-kör kész; a készítőtől független re-review
még kötelező. A runner főciklusba kötött receipt+idle döntés szándékosan a C–D
szelet scope-ja, ezért a 3A infrastruktúra és a teljes AttachedSink továbbra is
`in_progress`.

### 2026-07-22 — AttachedSink 3A második review és P1 CAS-korrekció

A második re-review **FAIL / P1** eredményt adott. A claim route a contextet egy
aszinkron inbox-read előtt vizsgálta, majd feltétel nélküli upsertet végzett.
Két eltérő párhuzamos claim egyaránt sikeres lehetett, és a publikus legacy
`setTerminalContext`/dispatch hívók egy aktív scoped claim islandjét NULL-ra
írhatták; ezután a legacy completion guard sem ismerte volna fel a tulajdont.

Javítás:

- `TerminalContextStore` külön felelősségként fogja össze a context és ownership
  SQL-primitíveket;
- claim: SQLite-tranzakciós CAS, amely csak üres contextet, azonos unscoped task
  biztonságos scope-olását vagy pontos idempotens terminal+task+island tuple-t
  fogad el;
- release: pontos terminal+task+island `WHERE` feltételes CAS;
- a generikus compatibility setter aktív scoped claimet nem módosíthat, és új
  scoped claimet sem létesíthet;
- legacy dispatch ugyanabban a tranzakcióban ellenőrzi a guardot, frissíti a
  queue-t és a contextet, így elutasításkor egyik sem változik;
- negatív teszt: két párhuzamos eltérő REST claimből pontosan egy 200 és egy 409;
  generic setter/legacy dispatch clobber-kísérlet után a tuple és a queue
  változatlan; matching release/completion továbbra is PASS.

**Friss evidence:** typecheck/build/lint PASS; 7 célzott suite / 144 teszt és a
teljes suite 1342 PASS + 1 skipped; coverage statements 41,82%, branches 36,29%,
functions 41,55%, lines 42,26%; audit 0, secret/link/task/size PASS. Élő
DEV/3466: két párhuzamos eltérő claim `200+409`, root cross-terminal completion
DENY, a nyerteshez `island-live-cas` sequence=1 receipt és idempotens retry
PASS; DEV leállítva, production deploy nem történt.

**Független review 3:** PASS, P0/P1/P2 finding nélkül a `d607aaa` commiton.
A reviewer 7 releváns suite / 130 tesztet futtatott, és közvetlenül igazolta az
üres claimet, azonos unscoped task atomikus scope-olását, idempotens exact
retry-t, `1×200 + 1×409` párhuzamos claimet, minden generic/legacy clobber
tiltását, rossz release/completion utáni változatlan tuple+queue állapotot,
majd a matching release és matching completion sikerét receipt létrejöttével.
Az A-szelet lezárt; a teljes TASK-ISL-007 a B–F szeletek miatt `in_progress`.

### 2026-07-22 — AttachedSink 3B natív dependency és platformkapu

- **Goal:** reprodukálható, stabil és fail-closed natív PTY-alapot létrehozni
  ugyanazzal a lockfile-lal Windows ConPTY és Linux forkpty környezethez.
- **Sikerkritérium:** pontos stabil production dependency; tiszta Linux
  checkoutban generált lock; ugyanazzal Windows/Linux `npm ci`; spawn,
  Unicode/szóköz cwd, resize, write és teljes process-tree cleanup smoke;
  build-fallback dokumentáció; támogatott Node-vonalak CI-mátrixa.
- **Kilépési feltétel:** mindkét valós platform smoke PASS, teljes quality-kör
  PASS, nincs maradt processz, és a készítőtől független reviewer P0/P1/P2
  finding nélkül elfogadja a watchdog-, stderr- és tree-kill invariánsokat.
- **Erőforráskeret:** legfeljebb három elsődleges Linux cleanup-kísérlet után
  diagnózis/escalation; production deploy és `/opt/nexus-dev` módosítás nélkül;
  minden lockművelet külön `/tmp` clean checkoutban.

Megvalósult a `162f7e7` commitban:

- `node-pty@1.1.0` pontos production dependency; beta és lebegő tartomány
  tiltott. A service minimum runtime-ja az EOL Node 20 kivezetése után Node 22;
- `package-lock.json` tiszta VPS Linux checkoutban, npm 10.9.4-gyel regenerálva;
- `smoke-node-pty.mjs` külső watchdog és bounded output; külön natív worker,
  30 másodperces hard timeout és teljes worker-tree takarítás;
- Linux forkpty cleanup: a session ID TERM előtt rögzül, descendant-first
  `SIGTERM`, grace, majd `SIGKILL`. A fixture child ignorálja a TERM-et, ezért a
  fallback ténylegesen tesztelt;
- Windows cleanup: ConPTY close rendezi a natív workert, az előre snapshotolt
  descendant PID-fa `taskkill /T /F` fallbackje eltávolítja a túlélő childot;
- az ismert upstream `conpty_console_list_agent` / `AttachConsole failed` blokk
  csak pontos sorstruktúra-egyezéssel lesz strukturált INFO. Bármely residual
  stderr 1-es exit; injektált stderr negatív tesztje PASS;
- CI: Node 22 és 24 × `ubuntu-latest` és `windows-latest`, jobonként 10 perces
  hard timeout. A Linux source-build fallbackhez Python 3 + make + g++ explicit;
- runner README: prebuild/source-build prerequisites, reprodukció és fail-closed
  platform-szemantika dokumentálva. Konfigurációs mező nem változott.

Platform- és minőségi evidence:

- Linux VPS: Debian 13 x64, Node 22.22.1, npm 10.9.4; `npm ci
  --prefer-offline` + `npm run smoke:pty` PASS, `node-pty` 1.1.0, Unicode/space,
  `32x100`, process-tree cleanup PASS;
- Windows x64: Node 24.13.0, npm 11.6.2; ugyanazzal a Linux lockkal `npm ci
  --prefer-offline` + `npm run smoke:pty` PASS, ConPTY contract és PID fallback
  PASS; smoke/helper leak nem maradt;
- negatív Windows stderr-injekció: a contract-output PASS mellett is exit 1,
  tehát váratlan natív diagnosztika nem lehet hamis zöld;
- typecheck, build, lint-ratchet (`784 ≤ 786`), file-size, teljes coverage-suite,
  production audit (0 vulnerability), secret-scan, link- és task-séma kapu PASS;
- független review: az első kör két P1-et talált (spawn watchdog hiánya; Linux
  SID elvesztése TERM után) és P2 Node-runtime rést. A javítások után a végső
  verdict **PASS**, P0/P1/P2 finding nélkül; syntax/Biome, YAML parse, lock/
  engine, Windows/Linux cleanup, hard timeout, residual stderr és leak-check
  közvetlenül reprodukálva.

Rollback: a `162f7e7` commit visszavonása eltávolítja a dependencyt, lock-
bejegyzést, smoke- és CI-jobot; az `attached` mód továbbra is a meglévő
fail-closed preflightnál áll meg, a default `headless` VPS-üzem változatlan.
Production deploy nem történt. A B-szelet lezárt; a TASK-ISL-007 a C–F
szeletek és a teljes Codex/Claude/Antigravity × Windows/Linux evidence miatt
továbbra is `in_progress`.

### 2026-07-23 — AttachedSink 3C leállítási és átadási checkpoint

- **Goal:** a mixed-mode router, mockolható PTY host, tartós attached session
  lifecycle, restart/reconciliation és koordinált shutdown C-szeletének
  biztonságos, bizonyítható megvalósítása.
- **Sikerkritérium:** headless regresszió nélkül kevert routing; durable
  accepted/written/completed marker; teljes scope-olt completion receipt +
  provider-stabil idle; PID-identity alapú teljes process-tree cleanup;
  bounded restart és shutdown; minden kötelező kapu és független P0/P1/P2-mentes
  review PASS.
- **Kilépési feltétel:** a fenti invariánsok regressziós teszttel és teljes
  QUALITY-körrel bizonyítottak, a független re-review PASS, az implementáció és
  a dokumentáció lokális commitban van. Push és production deploy nincs ebben a
  szeletben.
- **Leállítás oka:** Gábor kifejezett stop kérése. A két javító agent
  megszakítva, a reviewer befejezte a vizsgálatot, futó Nexus/Vitest/PTY
  folyamat nincs.

Az implementációs jelölt a lokális munkafában megmaradt. Tartalmazza többek
között a `TerminalSinkRouter`, `PtyHost`, `AttachedSessionManager`, tartós marker,
stable-idle, restart policy, poll drain és runner lifecycle kódját és célzott
tesztjeit. A korábbi ellenőrzési körben 9 releváns suite / 186 teszt,
typecheck, Biome, méretkapu és `git diff --check` PASS volt; a teljes
coverage/audit/secret/link/task kapuk és a Windows PTY smoke is PASS voltak.
Ezek **nem záró bizonyítékok**, mert a legutolsó review után három P1 maradt:

1. **Cleanup-verseny:** root-exit elő-dispose esetén a shutdown elveszítheti a
   subscription-cleanup hibát. Egy session/generation szintű közös
   cleanup-tranzakció kell, amelynek hibáját minden hívó látja és a runner exit
   1-re fordítja.
2. **Restart-folytonosság:** automatikus restart pending-spawn startup-timeoutja
   után, sikeres late cleanup esetén sem indul következő próbálkozás. Csak
   explicit cancel/shutdown tilthatja a folytatást; külön regressziós teszt kell.
3. **Shutdown-budget:** a jelentett minimum csak cleanup+margin, de a shutdown
   előbb a pending spawn settlementjét várja. A `PtyHost` kikényszerített hard
   spawn deadline-ja és
   `minimum >= spawn settlement + cleanup deadline + margin` szükséges.

**Kanonikus folytatási sorrend:**

1. a három P1-hez red regressziós teszt;
2. diszjunkt manager- és PTY-host javítás, fájlméretkapu megtartásával;
3. célzott suite + typecheck/build/lint;
4. teljes coverage, audit, secret, link, task és méretkapu;
5. valós Windows PTY smoke/leak-check;
6. új, készítőtől független review; bármely P0/P1/P2 esetén vissza az 1. pontra;
7. csak PASS után lokális implementációs és dokumentációs commit, majd D.

**Állapot a leállításkor:** az utolsó publikált és implementációs baseline
`origin/main@e627495`; a C-diff commitolatlan és szándékosan megőrzött, C-re nem
volt stage, commit, push vagy deploy. A stop-dokumentáció külön lokális
checkpoint commitja nem jelent C-elfogadást. A task és az `ISL-CLI-ADAPTERS`
epic továbbra is `in_progress`/`active`.
