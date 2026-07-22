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
