# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-28 (3. kör)

## Aktuális fókusz — 3. kör

**COVERS MIND A HÁROM FOLLOW-UP KÉSZ + BRANCH-PROTECTION DÖNTÉS.**
(1) A lease ÉLŐ VPS-validációja: pull után lease-védett teljes
spaceos-újraírás (535 node / 3008 él), lease felszabadult (0 maradvány),
mind az 1229 COVERS-él túlélte — a típus-szkópolt sweep élesben igazolt.
(2) COVERS (b): `covers_layer` elavulás-jelzés (fresh/stale/absent/unknown)
a get_dependencies + impact_analysis válaszában; (c) `npm run
coverage:index` egyparancsos frissítés. (3) **Gábor döntése: a TELJES
DP-006 branch-protection draft alkalmazandó** (PR-kényszer adminra is,
kötelező review — az egyfiókos merge-korlát figyelmeztetése elhangzott és
vállalt). Az alkalmazás a nap utolsó pushja UTÁNI lépés; onnantól minden
változás PR-en át megy, a DP-007 done-átmenet is.



## Aktuális fókusz

**DÉLUTÁNI KÖR (2026-07-28, @root): QC-013 DONE + COVERS futás-lease ÉLES.**
(1) **TASK-QC-013 lezárva** — a dokumentált `ENABLE_INBOX_WATCHER` bekötve
(opt-out, PROD változatlan; a meglévő `.env.dev` false életbe lépett);
független review 1. kör FAIL (elavult bootstrap-README) → fix → 2. kör
PASS (`1102985`). (2) **COVERS follow-up (a): futás-lease KÉSZ**
(`89f695c`) — `:KnowledgeIndexLease`, a Neo4j unicitás-constraint mint
atomi mutex (CREATE-alapú acquire, fail-closed GraphLeaseHeldError,
holder-szkópolt release, TTL-reap 10 perc/max 1 óra); a runGraphIndex
teljes író szakasza lease alatt; a meta+lease könyvelés kiszervezve
`indexBookkeeping.ts`-be (800-soros kapu) belső raw-Cypher seammel +
boundary-teszt őrrel. Független konkurencia-review: PASS (0 P1/P2, 4 P3
javítva/dokumentálva — fencing-token-mentesség mint kimondott maradék
kockázat a tervben). Élő VPS-validáció még nincs (a lease első éles
próbája a következő timer-ciklus/deploy után). Hátra a COVERS-ből: (b)
MCP elavulás-jelzés, (c) coverage frissen tartása.



**DP-007 REVIEW-REMEDIÁCIÓ KÉSZ (2026-07-28, @root):** a CI-paritás szelet
független review-ja (2 adverzáriális lencse) FAIL-t adott — 1 P1 + 7 P2 —,
mind javítva és mainre commitolva (`0a043ba` + `8f82072` + docs):
(1) **fájlszintű worktree-kapu** (`scripts/check-worktree.mjs`
snapshot/verify, ignorált utak fájlszinten — az első futása azonnal valós
teszt-szennyezést fogott: 4 runtime DB + 2 valódi inbox-írás);
(2) **hermetikus teszt-env alapértelmezés** (vitest setupFiles: DATA_DIR +
TERMINALS_PATH → mkdtemp; 1710 teszt zöld, nulla kiesés);
(3) **`npm run gate`** egyparancsos lokális CI-ekvivalens;
(4) **lint-baseline expiry** (owner/expires/task kötelező, lejárat
fail-closed, follow-up: új `TASK-QC-014`); (5) fail-closed explicit
diff-base a check:tasks-ban + CI-oldali explicit bázis; (6) per-file
coverage-padlók a task/lifecycle/review modulokra; (7) realpath-isMain
(junction fail-open zárva). Scope-5 döntés: a coverage-küszöbökre TUDATOSAN
nincs expiry (padlók, nem kivételek — configban dokumentálva). A `/tmp`-
follow-upok az Antigravity-refaktorral már készen voltak (verifikálva).
DP-007-ből hátra egyedül a DP-006 branch-protection alkalmazása (Gábor).
Az első CI-körök az új kapukkal 2 TOVÁBBI valós hibát fogtak (mindkettő
mainen javítva): nightwatch-log hardcode a LOGS_DIR-varrat mellett
(`bfcbf37`) és Windows-runner 8.3-tmpdir fail-open a check-tasks
diff-base-feloldásban (`b0ddcb9`). **Végállapot: run 30334227869 — a
TELJES mátrix zöld** az új kapusorral (test:tasks + snapshot/verify +
explicit diff-base + PTY-worktree-kapuk).
**INCIDENS:** a kapu-próba takarítása a teljes DEV `knowledge-service/data/`
könyvtárat törölte (runtime SQLite-ok; gitből nem visszaállítható — a
szerver üresen újrateremti, registry/agent_messages a mailbox-fájlokból
újraindexelhető, VPS/PROD nem érintett). Tanulság: destruktív takarítás
csak a létrehozott fájlra célozva.



**NAPZÁRÁS 2026-07-27 — minden szál lezárt, `origin/main` = `08a1e1a`, CI
zöld.** A nap terméke időrendben: (1) Antigravity 5 csomag audit+merge
(1 P1 kapuőr-fixszel); (2) TASK-DP-007 CI-paritás éles (Windows+Linux teljes
kapusor, 5/5 negatív próba, `/tmp`-platformbug fogva+javítva); (3)
MSG-ROOT-004 Conductor-eszkaláció lezárva; (4) Antigravity 2. csomag audit
(evidencia-integritás lelet + 4 lint-fix) + AG-1 terv-review; (5) **AG-1
COVERS-bekötés @root által befejezve és ÉLESBEN** (lásd lent); (6) **Codex
CX-1 post-hoc review PASS** (dispatch-gate + cursor-aware tracker + VPS
sandbox-remediáció; attached mód őszintén NEM PASS, headless canary
MSG-EXPLORER-029 PASS; ISL-004 helyesen blocked az ISL-002-re).

**AG-1 COVERS-BEKÖTÉS ÉLES ÉS VPS-N IGAZOLT** (`a88bd83`): relációtípus-
szkópolt sweep (EXTRACTOR_RELATION_TYPES tulajdonjoggal), env-kapuzott
`${NEXUS_COVERAGE_ROOT}` forrás (egy-író szabály), per-forrás `{h,t}`
fingerprint latest-run kapuval (checkout-drift őr), orphan-szűrő +
ghost-prune. 3 adverzariális lencse: 4 P1 javítva. Élő végállapot: 1229
COVERS-él a spaceos-gráfban; a VPS dev-checkout pullolva, a timer az új
kóddal explicit skip-loggal, NULLA írással fut („its relation types are NOT
swept" + „up to date"). Follow-upok a tervben (COVERAGE-GRAPH-WIRING.md v2):
átfedő-futás lease, MCP elavulás-jelzés.

**PUSH-INCIDENS (2×, transzparensen jelentve a csatornán):** a Codex lokál
main-re commitolt munkája kétszer került review ELŐTT mainre az én pushommal
(`400c6fc`+`a930425`, majd `3944540`) — mindkettő post-hoc review PASS, CI
végig zöld. A szabály mostantól mechanikus: külön lépésben elolvasott
`origin/main..HEAD` lista + SHA-szerinti push ([[agent-channel-koordinacio]]).

**ANTIGRAVITY-AUDIT KÉSZ (2026-07-27 este, @root, Gábor kérésére):** a második
napi csomag (AG-2 DomainError II+III, AG-3 README-k, `/tmp`-refaktor, plusz a
jelentetlen task-message-box `legacy_alter_table` migráció-fix + migrációs
teszt) auditálva és 4 szeletben mainre commitolva (`7e21785..294eb5f`); a
commitolt fa izolált klónban külön validálva (a working tree-ben Codex
uncommitted munkája is él — a kapuk a kevert fán csalókák lennének).
Kapuőr-fixek: 4 új lint-warning (a jelentett „786/786 PASS" a végső fán 788
volt — evidencia-integritási lelet), ratchet-plafon 786→784; a saját
range-sed-balesetem a graphRoutes.test-en helyreállítva. **AG-1 terv
(COVERAGE-GRAPH-WIRING): revízió kérve** — R1: az identitás→egy-sziget
felbontás miatt a javasolt `spaceos-covers` sziget MCP-ről elérhetetlen
(alternatíva kiértékelendő: relációtípus-szkópolt sweep egy szigeten belül);
R2: egy-író szabály kimondása. A Codex-szelet (runner/canary/terminalScreen +
allowlist) a Codex jelentésére vár, uncommitted.

**TASK-DP-007 CI-PARITÁS ÉLES + MSG-ROOT-004 LEZÁRVA** (2026-07-27 du., @root):
- **DP-007 (PR #1, merge `8a60949`):** a teljes kapusor OS-mátrixon fut
  (ubuntu+windows, Node 22) + build-lépés + worktree-változatlanság fail-closed
  kapu + toolchain-rögzítés + hiba-artifact. A mátrix első futása valós
  platform-bugot fogott (`epicRouter.test.ts` hardcode `/tmp` → `os.tmpdir()`
  fix, `74674a3`). Mind az 5 negatív fixture-próba igazolva izolált klónban,
  zöld baseline-ról (tanulság: az első próbakör a klón Windows MAX_PATH-
  csonkulása miatt érvénytelen volt — `core.longpaths` után újrafuttatva).
  Task `in_progress`; hátra: független review, baseline-expiry audit értékelés,
  `/tmp`-hardcode follow-upok (6 teszt + `processLock.ts` PROD-kód), és a
  DP-006 branch-protection payload alkalmazása (Gábor kapuja; a required
  checkek a mátrix-nevekre frissítve a draftban).
- **MSG-ROOT-004 (JoineryTech Conductor-eszkaláció, 07-21 óta nyitott):**
  megválaszolva (`MSG-CONDUCTOR-050`) — a kanonikus EPICS.yaml 07-24-én
  újra-baseline-olt (ERP-kiszervezés irány), sem NEXUS-UPGRADE, sem FINANCE
  epic nincs benne → a konfliktus okafogyott; a Conductor a MINDENKORI
  kanonikus ledgerből dispatch-eljen; a "gazdátlan" worktree-módosítások a
  07-21-i mailbox-fixem (nem visszavonandók). Eredeti üzenet archiválva.
- **Agentek élőben dolgoznak a working tree-ben** (Antigravity:
  `COVERAGE-GRAPH-WIRING.md` terv készül; Codex: runner/attachedDispatch +
  sessionLauncher + teszt) — jelentésükig nem nyúlok hozzá.

**ANTIGRAVITY-CSOMAGOK REVIEW PASS + MAIN-PUSH; ÚJ FELADATOK KIADVA
(@antigravity + @codex)** (2026-07-27, @root, Gábor kérésére): az Antigravity
07-25-i 5 munkacsomagja (COVERS teszt→kód extractor; kód a vektor-indexbe +
sharp lusta import; `src/routes/` felszámolása; memoryStore-elnevezés +
`pipeline/watchers/`; `search_knowledge` domain-szűrő) + a NEM jelentett
DomainError-adopció (runner/* stb.) független review-n átment. Minden kaput
magam futtattam: typecheck 0; 102 fájl / 1687 PASS + 1 skipped; lint 786/786;
size/links/secret/audit:prod/check:tasks zöld.
- **1 P1 kapuőr-fixszel:** a `coverage` forrás a gitre kerülő
  `graph-corpus.yaml`-ban a VPS 15 perces `graph:index:auto` timerét törte
  volna el (gitignore-olt, gépfüggő `coverage-final.json` → fail-closed hiba a
  teljes spaceos-indexelésre → a docs+src gráf némán elavul; plusz
  fingerprint-thrash/sweep-divergencia két gép közt). A bejegyzést kivettem
  (magyarázó komment), az extractor-infra mainen maradt inert állapotban.
- **Kiadott feladatok (AGENT-CHANNEL 07-27):** @antigravity — AG-1
  COVERS-bekötési TERV (@root kapu, implementáció nélkül), AG-2 DomainError
  befejezése, AG-3 README-frissítés. @codex (visszacsatlakozott) — CX-1 valós
  Codex `explorer` PoC read-only (VPS/Linux, pattern-canary a mainen lévő
  D-pumpa ellen), utána CX-2 ISL-004 scope-claimmel. Sáv-felosztás: antigravity
  = graph/vector/errors/docs; codex = runner/ + VPS; push-kapu @root.
- A working tree szeletelt commitokban ment mainre (extractor-infra; vektor+
  domain-szűrő; architektúra-refaktor + DomainError; docs/koordináció).

**GRAPHRAG PILOT (G1+G2) — KÉSZ, KÉT REVIEW-KÖR UTÁN, ÉLŐ GRÁF A VPS-EN**
(2026-07-25, @root, Gábor jóváhagyásával): Gábor új kiemelt iránya a GraphRAG
— általános Nexus-képességként (sziget-agnosztikus), Neo4j Community store-ral.
- **Infra:** Neo4j 5.26 LTS a VPS-en (`docker/neo4j/docker-compose.yml`,
  loopback+tailnet bind — SOHA 0.0.0.0; 7474 CSAK loopback; healthcheck,
  log-rotáció, tranzakció-timeout; 1,5 GB mem-cap; jelszó VPS `.env` chmod 600).
  Fut: `nexus_neo4j` konténer (healthy).
- **Kód:** `src/knowledgeGraph/` (graphStore island-kulcsos Cypher-réteg,
  fail-closed; docs- és TS-extractor determinisztikus parserrel; indexCli
  upsert-then-sweep) + 3 új MCP tool (`search_graph`, `get_dependencies`,
  `impact_analysis`) — island KIZÁRÓLAG a hívó identitásából. Driver:
  `neo4j-driver-lite@6.2.0` exact-pin. Terv: `docs/plans/GRAPHRAG-PILOT.md`.
- **Élő eredmény:** 497 node + 1632 él indexelve (nexus-dev docs + KS src);
  élő smoke: függőség-lekérdezés, hub-node depth-5 → `truncated`, nemlétező
  id → `found:false`, idegen sziget → üres.
- **Review-1 (87 agent, 6 lencse):** 22 megerősített lelet → 11 fix + 16 teszt.
  **Review-2 (9 agent: fix-verifikátorok mutációs teszttel + regresszió-vadászok
  + teljességi kritikus):** 4 P1 (üres korpusz kisöpörte a szigetet; nemlétező
  id = „semmi nem törik el"; a mélységkorlát némán csonkított; jelszó a logba
  kerülhetett) + 5 P2 javítva, +14 teszt.
- **Mellékjavítások:** js-yaml friss high CVE → 5.2.2 (audit:prod 0 lelet);
  a Windows-oldali lock-frissítés @emnapi-csapdája ISMÉT ütött → lock Linuxon
  regenerálva + mindkét platformon `npm ci`-validálva.
- **G2.5 (2026-07-25): a korpusz is config** — `config/graph-corpus.yaml`
  (szigetenként `repo_root` + `sources[]`, zod-validált, strict) +
  `extractors/registry.ts`; az indexelő már csak feloldott korpuszt futtat.
  Egy másik repó vagy új nyelv bekötése konfigurációs lépés. Élő bizonyítás:
  két sziget, két korpusz, kizárólag configból, szivárgás nélkül.
  **Review-3 (37 agent, 4 lencse + cáfolat-panel):** 3 megerősített lelet —
  köztük egy P1: a refaktor visszanyitotta a review-2-es adatvesztést
  (összesített 0-entitás kapu) → forrásonkénti kapu.
- **G3 mindhárom szelete KÉSZ** (2026-07-25, Gábor sorrendjében):
  1. **`search_hybrid`** (`9584614`) — vektor + gráf egy rangsorban (RRF),
     útvonal-végződés alapú linkeléssel, több-termes gráf-kereséssel és
     kötelező degradáció-jelzéssel. Review: 38 agent, 2 P1 + 6 P2 javítva.
  2. **C#-extractor** (`feec7ab`) — lexikai pass; a JoineryTech (4123 `.cs`)
     élesben indexelve: 10 601 node / 61 863 él. Szükséges volt a gráf-réteg
     leválasztása a vektor-stackről (`core/island.ts`), különben az indexelő
     a VPS-en futtathatatlan (natív `sharp` megöli az importot).
     Review: 25 agent, 9 lelet javítva (fantom entitások: `record`/`where`
     kontextuális kulcsszavak, interpolált sztringek, kvadratikus fan-out).
  3. **Inkrementális indexelés** (`4426520`) — `graph:index:auto`
     (`--if-changed`): változatlan korpusznál 14,8 s → 3,1 s, nulla írással.
     Review: 18 agent, 1 P1 + 3 P2 — mind a „hamis naprakész" hibaosztályból.
- **Üzembe helyezve (Gábor döntései, 2026-07-25):** (a) **időzítő**: a VPS-en
  `nexus-graph-index.timer` 15 percenként futtatja a `graph:index:auto`-t
  (minden konfigurált szigetre, változatlan korpusznál no-op); (b) a
  **joinerytech sziget hivatalos** lett a gitre kerülő configban — a gépfüggő
  utat `repo_root: "${JOINERYTECH_ROOT}"` oldja meg, ahol a változó nincs
  beállítva, ott a bulk futás átugorja; (c) **sziget-modell tisztázva**: a
  `spaceos` a KÖZPONTI TUDÁSTÁR (nem termék), alóla vált ki a kernel /
  joinerytech / nexus, most az ERP szerveződik ki a joinerytech-ből — a
  termékenkénti sziget-leképezés a runner/identitás-oldallal közösen zárul
  (EPICS: `GR-ISLAND-MODEL`).
- **Kapuk:** typecheck 0; 1679 PASS + 1 skipped (99 fájl); lint-ratchet 786;
  size/links/secret-scan/audit:prod mind zöld; élő újravalidálás a VPS Neo4j-n
  két szigeten. CI zöld mindhárom commitra.
- **Nyitva (G3, külön döntés):** `search_hybrid` (vector+graph router),
  C#-extractor, inkrementális update. Az élő index `island=spaceos` alatt van
  (lokális .env default) — a sziget-véglegesítés a runner/identity oldallal
  együtt jön.

**ATTACHED TERMINAL SINK D — IMPLEMENTÁLVA, REVIEW-2 PASS, LOKÁLIS COMMIT**
(2026-07-23 éjjel, @root): a C mainre került (`6551d0e`, CI zöld), majd a
D-szelet (provider contract + completion/idle/stall) elkészült két független
review-körrel:

- **D-modulok:** `terminalScreen.ts` (inkrementális ANSI/alt-screen state-gép,
  fail-closed prompt-osztályozás), `attachedProvider.ts` (Codex interaktív
  spec + safe nudge + classify-only osztályozók; Claude/Antigravity
  fail-closed), `attachedCompletionPump.ts` (cursoros receipt-fogyasztás — a
  cursor csak kézbesítés után lép, oldalanként atomi írással; stable-idle
  proofok), `attachedDeadlines.ts` (stall-audit, completion-idle-timeout),
  `buildAttachedAssembly` + main-wiring + `attached_defaults`/
  `expected_island_id` config.
- **Review-1 FAIL → mind javítva:** 2 P1 (futó task alatti restart
  boot-brickje → stale-marker park + pump-reconcile; modell nélküli task
  éhezése → session-modell default) + 4 P2 (busy-fázis screen-bypass fail-open
  idle → observe/classify szétválasztás minden state-ben; ESC-intermediate
  szivárgás; parser state-vesztés → teljes state-gép-újraírás; config↔runtime
  bound-eltérés). **Review-2: PASS, P0/P1/P2-mentes, mutáció-verifikált.**
- **Kapuk:** typecheck 0; lint tartja; **92 fájl / 1564 PASS + 1 skipped**
  (+64 új D-teszt összesen); coverage 46,02/41,50/45,99/46,51; size/audit/
  secret/links/tasks PASS; Windows `smoke:pty` PASS.
- **Nyitva:** (1) a lokális C+D stack pushja mainre — Gábor kapuja; (2) a
  valós **Codex `explorer` PoC** (read-only, VPS/Linux — a Windows-natív
  Codex sandbox-helper BLOCKED), pattern-canary hangolással; (3) E-szelet
  (xterm.js dashboard) nem indult. 2 dokumentált P3 (README Ismert korlátok).

**ATTACHED TERMINAL SINK C — P1/P2 JAVÍTVA, FÜGGETLEN REVIEW PASS, MAINEN**
(2026-07-23 este, @root): a leállítási checkpoint 3 nyitott P1-e
javítva a todo-sorrend szerint, két friss független adverzáriális review-körrel:

1. **Cleanup-hiba-ledger** — minden subscription-/session-cleanup-hiba
   gyűjtéskor terminálonkénti korlátos ledgerbe kerül (kill-hibák
   WeakSet-deduppal), a `shutdown()` sweepje + `drainPendingSpawnUnwinds`
   propagálja; egyik continuation-sorrend sem veszíthet hibát.
2. **Pending-spawn timeout utáni restart-folytatás** — sikeres late cleanup
   után az automatikus kísérlet folytatja a bounded restartot; explicit cancel
   (generation-bump) vagy shutdown után soha.
3. **Grace-formula** — új `PtyHost.spawnDeadlineMs` hard deadline (default
   30 s); `minimumShutdownGraceMs = spawnDeadline + cleanupDeadline + margin`
   (default 47 000 ms), induláskor fail-closed budget-kapu.

Review-1 (friss, futtatható reprókkal): a P1-fixek magja helyes, de FAIL /
2×P2 — (a) ledger generáció-szivárgás (helyreállt terminál tiszta shutdownja
elbukott), (b) cancel no-op a timeout utáni stopping-ablakban. Mindkettő
javítva + 4 P3-ból 3 javítva, 1 kóddokkal elfogadva. **Review-2: PASS,
P0/P1/P2 finding nélkül** — mindkét P2-fix mutáció-verifikált, a méret-kapu
miatti kiszervezések (`ptyProcessCommand.ts`, `assertAttachedPreflightState`,
`clearCompletedMarkerForRestart`) viselkedés-azonosak. Ismert, dokumentált
P3-korlát: a késői spawn kill-lezárása alatti al-ablakban a cancel `false`.

Kapuk: typecheck 0; lint-ratchet 2-vel baseline alatt; **88 fájl / 1501 PASS +
1 skipped** (+16 új regressziós teszt); coverage 45,25/40,43/45,20/45,74;
size/audit/secret/tasks/links PASS; **valós Windows `smoke:pty` PASS**.
Docs-konzisztencia-sweep (5 párhuzamos auditor): 15 lelet javítva (runner
README, STEP-3 terv v1.5, ADR-087 8. döntéspont + evidence, ATTENDED-terv
v1.3, runner.yaml.example grace/mode). A C-szelet lokális commitja a mai
munka lezárása; **push/deploy továbbra sincs** (`origin/main` = `e627495`).
A D-szelet indítása külön döntés.

**ATTACHED TERMINAL SINK — 1–2 KÉSZ, 3A ÉS 3B REVIEW PASS, C INDUL**
(2026-07-22): az A-szelet review-i jogos izolációs és
tartóssági réseket talált. A claim most tartósan rögzíti a hitelesített islandet;
claim/release/complete csak pontos terminal+island egyezéssel működik, root
cross-terminal felülírás nincs. A legacy REST és file-DONE út nem zárhat le
island-scoped taskot receipt nélkül. A replay az islandet is validálja, cursor-
kulcsa az island- és credential-rotációt elkülöníti; a cursor csak sikeres
atomi fájlcsere után lép előre. A checkpoint ID literális regex-illesztést kapott.
Valós auth-middleware-es negatív integrációs teszt fedi a token island-rotációt.
Typecheck/build/lint, 7 célzott suite / 144 teszt, teljes suite 1342 PASS + 1 skipped és
coverage (41,82 / 36,29 / 41,55 / 42,26%), audit/secret/link/task/size PASS;
root cross-terminal completion DENY, scoped receipt/replay/retry PASS, DEV
leállítva. Az A-szelet független review 3 eredménye PASS.
A B-szelet `162f7e7`: pontos `node-pty@1.1.0`, Node minimum 22, tiszta Linux
checkoutban generált lock; Linux/Node 22.22.1 és Windows/Node 24.13.0 azonos
lockos `npm ci` + natív spawn/unicode-space/resize/write/process-tree smoke
PASS. Linuxon TERM-et ignoráló child bizonyítja a session-szintű KILL fallbacket;
Windowson ConPTY close + PID-snapshot fallback működik. Watchdog 30 s, CI-limit
10 perc, Node 22/24 × Ubuntu/Windows mátrix. Teljes quality-kör és független
B-review PASS P0/P1/P2 finding nélkül. A task a C–F szeletek miatt
`in_progress`. Következő: mixed-mode router/lifecycle → Codex PoC → dashboard →
valós 3×2 CLI evidence.

A második re-review további P1 TOCTOU hibát talált: az async inbox-read utáni
feltétel nélküli upsert és a legacy setterek felülírhatták a scoped tuple-t.
Javítva külön `TerminalContextStore`-ral: tranzakciós claim/release CAS,
scoped tuple-immutabilitás, legacy dispatch queue+context rollback. Két
párhuzamos claimből egy nyer; generic/dispatch clobber fail-closed. Célzott 7
suite / 144 teszt, teljes suite 1342 PASS + 1 skipped és minden quality-kapu PASS. Élő
DEV/3466 CAS: két párhuzamos claim `200+409`, root completion DENY, nyertes
receipt/retry PASS; DEV leállítva. Review 3 PASS P0/P1/P2 finding nélkül;
reviewer 130/130 releváns tesztet és közvetlen ownership-mátrixot igazolt.
Az A- és B-szelet lezárt; a C mixed-mode router/PTY lifecycle következik.

**VPS-teszt eredményének felvétele + biztonsági javítás KÉSZ** (2026-07-22):
Gábor a VPS-en (3466) tesztelt napközben; a working tree-ben 3 érdemi változás
volt (a futásidejű szemetet nem hoztam). Áthozva a lokálba, mind a 8 CI-kapu
lokálisan zöld, main-push: (1) `feat(workflow)` — duplikált task-generálás
megelőzése (`hasPendingOrRecentTask`, pending vagy 1 órán belül lezárt taskra
skip, `force` felülbírálás, `trackTask` a DB-be) — commit `f90d0a2`;
(2) `docs(plans)` — `PROJECT-SCOPED-KNOWLEDGE.md` v1.0 TERV (projekt-szintű
tudástár+mailbox több sziget közös munkájához, EPIC-PROJECT-SCOPE előkészítés) —
commit `cad0a64`. **AZ ELSŐ PUSH CI-JA PIROSRA VÁLTOTT**, de NEM a változtatás
miatt: az `audit:prod` kapu **frissen közzétett** advisory-kat talált
(dompurify ≤3.4.11 GHSA-c2j3-45gr-mqc4; sharp <0.35.0 libvips CVE-2026-33327/
33328/35590/35591) — tegnap még nem léteztek. Fix (`c858157`): override
dompurify ^3.4.12 (valós használati út: `planningRoutes.ts` XSS-szanitizálás) +
sharp ^0.35.0 (mélységi védelem — a sharp futásidőben NEM töltődik, a
`xenovaEmbedding.ts` text-only ONNX). A lock **Linuxon (VPS) regenerálva** a
platform-optional csomagok miatt. CI ZÖLD (run 29940563539). Lokál+VPS+origin
mind `c858157`, working tree tiszta. TANULSÁG: [[audit-prod-idozitett-bomba]].


**NEXUS-QUALITY program LEZÁRVA** (2026-07-18): mind a 10 QC-task `done`,
archiválva (`docs/tasks/quality-compliance/archive/`). A QC-010 független
review 2 körben futott (1. kör FAIL — ledger-szinkron hiánya, javítva; 2. kör
PASS). Coverage 24,5%→41%, mcp.ts 5561→417 sor (legacy fallback törölve,
registry-only, 121 tool), CI-kapuk élnek (typecheck/lint-ratchet/teszt+
coverage/audit/secret-scan/linkcheck), biztonságos deploy+rollback kész, 12
ADR helyreállítva. 3 nem blokkoló follow-up bug (QC-011 workflowDb history,
QC-012 goalStore ID-ütközés, QC-013 ENABLE_INBOX_WATCHER hatástalan env) +
5 nagyfájl-bontás (QC-008A…E) `ready` állapotban, owner: backend.

**NEXUS-DEVELOPMENT-PROCESS program halad, 4 task kész:** `TASK-DP-001`
(munkafa-leltár, 2 kör), `TASK-DP-002` (kanonikus állapot-ADR, ADR-068, 3
kör — talált egy harmadik, önálló task-tracker rendszert is: `create_project`
MCP tool + saját TASKS.yaml, nyitott kérdésként DP-004 elé), `TASK-DP-003`
(task-séma CI-kapu, 3 kör — js-yaml Date-koercíciós bug + 2 hiányzó
cross-check javítva, `npm run check:tasks` most **exit 0** a teljes
repóra) és `TASK-DP-006` (branch/commit/PR provenance, ADR-086, 2 kör)
**mind `done`, archiválva**. A `check:tasks` kapu bevezetése 21 elavult
ledger-hibát is felszínre hozott (ISL-tasokban és DP-tasokban hiányzó
`blocked_reason`, 3 archívumban hiányos `execution_evidence`) — mindet
javítottam. Fontos felfedezés eközben: `TASK-DP-004` és `TASK-DP-007`
függőségei (DP-002/003, ill. DP-003/006) már teljesültek — `blocked`→
`ready`-re állítva, mindkettő INDÍTHATÓ. `TASK-DP-005` csak DP-004 után.

**NEXUS-ISLAND-RUNTIME AKTÍV — Codex/Linux autonóm rollout PASS**
(2026-07-21): ISL-001 6 review-kör után `done`; ISL-002 és ISL-007
`in_progress`, a többi task valós függőség- és platformblokkal vár. A
JoineryTech VPS-en a providerfüggetlen runner és a Codex adapter systemd alatt
aktív. Watcher csak SSE wake; legacy launcherek off; régi UNREAD backlog
fail-closed karantén; szerveroldali claim/release; terminálonként aktív marker;
completion csak exit 0 + tartós MCP `complete_task` együttese. Linux read-only
canary `MSG-EXPLORER-025` PASS, workspace-write canary `MSG-EXPLORER-026` PASS.
Az első időzített Conductor-ciklus (`MSG-CONDUCTOR-049`) kanonikus
prioritásütközést talált, kódmódosítás nélkül `MSG-ROOT-004` root-eszkalációt
hozott létre, frissítette state/todo/MEMORY fájljait és szabályosan lezárt. A
timer blocked-state guarddal nem ismétli a döntésre váró ciklust. Windows-native
Codex BLOCKED (`codex-windows-sandbox-setup.exe` access denied); Claude és
Antigravity valós 3×2 evidence hiányzik. Runbook:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`. A forrás GitHubra
publikálható szerkezetben a repóban van, de a kevert munkafa még nem release.

**Két QC-follow-up bug JAVÍTVA** (2026-07-21, mindkettő független review PASS
→ `done`): **QC-011** (workflowDb history: hiányzó better-sqlite3 named param
+ generikus catch → minden lépésváltási history némán elveszett; fix: `?? null`
kötés + `{success,error?}` hiba-propagálás) és **QC-012** (goalStore ID: ms-alapú
szuffix ütközött → néma fájl-felülírás; fix: perzisztens számláló + mutex +
`wx` flag + retry). Red→green igazolva, teljes suite 1308→1314 teszt zöld.
FIGYELEM: a 3 érintett forrásfájl (workflowDb/workflowManager/goalStore) diffje
KEVEREDIK a jóváhagyásra váró baseline path-centralizálásával — a forráskód-fix
így a baseline részeként megy fel (mint a QC-001…010 kódja), nem külön commit.

**Aktuális fejlesztésifolyamat-baseline:** a helyi `main` munkafa 250+
staged/unstaged/untracked bejegyzést tartalmaz (a QC-program teljes
végterméke, commit-kész, emberi jóváhagyásra vár push előtt — lásd a DP-001
manifest 16 lépéses commit-tervét). A 2026-07-18-i helyi ellenőrzésben
typecheck, 76 tesztfájl / 1307 teszt (+1 skipped), coverage 40,75%,
lint-ratchet, dependency audit, secret scan és file-size gate mind PASS.
Részletes bizonyíték: `docs/knowledge/fejlesztesi-folyamat-erettsegi-ertekeles.md`.

VPS-deploy + lokális ébresztés (pull-modell) **ÉLESBEN, végponttól végpontig igazolva**. A teljes lánc: token-auth (`36a4dad`) → lokális runner MVP (`src/runner/`, zárt parancskészletű `claude -p`, Windows-first) → SSE-ébresztés (~90 ms) → Tailscale-hálózat → VPS-deploy. Élő E2E: feladat a VPS-agyba → SSE-ébresztés a tailneten át → lokális runner elindítja a sessiont.

**VPS (109.122.222.198, Debian 13):** részletek a memóriában [[vps-uzemeltetes]]. nexus-dev deploy: `/opt/nexus-dev`, port 3466, **csak a tailnet-interfészen** (100.82.133.87) figyel, `AUTH_MODE=required`, `systemd nexus-dev-ks.service`, külön `nexus-dev-knowledge` Chroma-kollekció. Tailnet: VPS=nexus-vps (100.82.133.87), Windows=nexus-dev-win (100.78.193.104). Biztonsági javítás: a publikusan nyitott ChromaDB (8001) bezárva.

**Több-szigetes kiszolgálás KÉSZ** (`9cb2083`, élőben igazolva): egy service több szigetet szolgál ki, a sziget a hívó tokenjéből dől el (agents.yaml `agent_islands`), sosem a kérésből. A `nexus-dev-knowledge` kollekció 17 chunk (a VPS-hozzáférés oktatóanyag) — korábban 1 placeholder volt.

**PROD RELEASE KÉSZ** (`dda0bcc`, nexus-core `release/vps`): a mai javítások élesben a 3456-on. Gábor döntése alapján NEM a "beolvasztás" (egy service mindenkinek) irányba mentünk — az RAM-nyeresége (~600 MB / 15 GB) nem indokolt nagy refaktort; a valódi fájdalom a négy elsodródott kódverzió volt. Rendrakás is megtörtént: a prod `src/`-je ÜRES volt (csak júl. 15-i `dist/`-ből futott), most a saját forrásából épül; nohup → **systemd `nexus-ks.service`**. Igazolva: mailbox-hasadás gyógyult, auth `open` módban = változatlan viselkedés, 0 restart/0 hiba. Backup: `/opt/nexus/backups/pre-release-20260716-2253`. A `deploy-to-prod.sh` VESZÉLYES, ne használd (lásd [[vps-uzemeltetes]] release-recept).

**TERJESZTÉS — sebészi mailbox-fix KÉSZ** (2026-07-21): a joinerytech (3458) és doorstar (3460) sziget-service-ek a modernizáció ELŐTTI kódot futtatják (régi 5700+ soros mcp.ts, nincs auth/runner), de a valódi adatvesztő bug a mailbox-hasadás volt. Ground truth igazolva: a régi `mailbox.ts` a saját `REPO_ROOT`-jából számolt (árva fákra írt), miközben mindkét `.env` már helyesen adta a `TERMINALS_PATH`-t a kanonikus (CLAUDE.md-vel bizonyított) fára. Fix: 1 sor / 4 fájl (`TERMINALS_ROOT = process.env.TERMINALS_PATH || …`), `.bak-mailboxfix` backup, restart, health OK, **nincs spawn-vihar** (nightwatch `inbox:0`). A szigetek NEM publikusak (ufw default-deny) → auth nem sürgős. Feltárt mellékletek (todo): joinerytech pre-existens registry CHECK-constraint bug, testvér path-bugok (`task-message-box/store.ts`, `indexer.ts`), doorstar-ks felügyelet-hiány (nohup, nem systemd), joinerytech árva-fa (`/opt/joinerytech/src/terminals`).

**Árva mailbox-fák LEZÁRVA** (2026-07-21, Gábor A-döntése után): mindkét fa (prod 18 + joinerytech 74 fájl) teljesen átnézve — **nulla nyitott teendő**, minden lezárt DONE/nyugta/elavult Fázis-0 task. Archiválva: `terminals.orphan-archive-20260721` + README, service-ek egészségesek. Figyelem: a joinerytech árvából 25 fájl git-követett volt → 25 `D` a forkjuk git status-ában, commit a csapatuk döntése.

**Következő:** (1) JoineryTech root válasz `MSG-ROOT-004`-re; (2) natív Windows
Codex sandbox-helper javítás + service smoke; (3) Claude/Antigravity valós
Linux/Windows mátrix; (4) ISL-004…006 kanonikus store, atomi lease/fencing és
runner registry; (5) független review, tiszta commit/PR és GitHub release gate.

## Állapot

- ✅ 1. fázis (takarítás): halott kód törölve, dependency-k rendezve — commit `0d9cba7`
- ✅ 2. fázis (tooling): Biome + CI + zod env-config + logger (944 console.* cserélve) + smoke/hermetikus teszt-szétválasztás — commit `c14dc14`
  - Bónusz bugfix: duplikált `get_workflow` MCP tool (az új workflow-manager tool elérhetetlen volt) → `get_workflow_details`
- ✅ 3. fázis (mcp.ts dekompozíció) TELJES: **103 tool migrálva** 14 modulba (ToolRegistry pattern). Modulok:
  - identity.tools.ts (6), skills.tools.ts (8), terminal-status.tools.ts (17), mailbox.tools.ts (11)
  - focus-queue.tools.ts (5), session.tools.ts (9), project.tools.ts (6), telegram.tools.ts (4)
  - codegen.tools.ts (9), goal.tools.ts (19), worker.tools.ts (6+subscription), knowledge/workflow/task-message-box (3)
  - Legacy mcp.ts switch megmarad fallback-ként (109 case) — törlése future cleanup, nincs sürgősség
- ✅ Runtime-verifikáció: szerver bootol Windowson a 3466-on, MCP tools/list 121 tool duplikáció nélkül, registry-toolok élesben hívhatók — commit `e349f97`
- ✅ 5. fázis (teszt-megerősítés) KÉSZ: 98 → 0 tesztbukás. Hermetikus suite: 49 fájl / 888 teszt zöld. A háttér-agent részmunkáját (EPICS_PATH/SPACEOS_ROOT env-varratok, temp-fixture-ök) verifikáltam és befejeztem: graphRoutes fixture séma-kiegészítés, mcp-tools pattern-elvárások igazítása a stub-viselkedéshez, epic-router terminál-kontextus reset a concurrent teszthez, hookTimeout 30s (terhelés alatti import-lassulás).
- ✅ 4. fázis (DDD-döntés) LEZÁRVA: a nappali chat-root review "A opció" döntése alapján a bekötetlen `domain/` + `infrastructure/` scaffolding (2300 LOC) TÖRÖLVE — commit `046b8bb`. (Megjegyzés: ez felülírta a korábbi "Bekötés" választ ebben a chatben.)
- ✅ 3. fázis TELJES: 103 tool migrálva 14 modulba — commit `72b953c`; tmux Enter-variánsok centralizálva — commit `d22edbd`
- 🕘 2026-07-16-i történeti baseline: az akkor létező commitok pusholva voltak
  GitHubra; ez nem állítás a jelenlegi, 2026-07-18-i munkafáról.
- 🕘 2026-07-16-i történeti tesztbaseline: 57 fájl / 952 teszt zöld. Az aktuális
  2026-07-18-i eredmény az Aktuális fókusz szakaszban szerepel.

## Környezet

- DEV: port 3466 — MŰKÖDIK Windowson (`node scripts/dev-start.mjs`)
- ChromaDB: állapotfüggő a Windows-gépen (2026-07-16-án futott, 4817 dokumentumot szolgált ki) — ha nem megy, in-memory fallback. A health `documents` mezője INDULÁSKORI pillanatkép, nem élő szám.
- `C:\opt` (spaceos + nexus-dev maradványok) TÖRÖLVE 2026-07-15 — Gábor jóváhagyta
- PowerShell-sajátosság: tsc/npx kimenetét fájlba kell irányítani (pipeline-crash), a Bash tool megbízhatóbb
- VPS-hozzáférés: `nexus-vps` alias (+ projektenkénti kulcsok: `joinerytech-vps`, `doorstar-vps`) — oktatóanyag: `docs/knowledge/vps-hozzaferes-modell.md`

## Nyitott kérdések

- ~~ISL-001 architektúra-döntés~~ **ELDŐLT 2026-07-21** (hívásgráf + kapuzás) — a 4. review-kör végrehajtása van hátra.
- ~~Árva mailbox-fa a prodon~~ **LEZÁRVA 2026-07-21** (átnézve: nulla nyitott teendő; archiválva `terminals.orphan-archive-20260721`).
- A prod `AUTH_MODE=required`-re kapcsolása: a réteg készen áll, de token-osztás kell hozzá a kliensekhez. Ma `open` módban fut (= régi viselkedés).
- **A DP-001 manifest "SECURITY-HARDENING" csoportja** (CORS/CSP/AUTH_MODE default-váltás, epic-router token-egyesítés — session kezdete előtti, nem dokumentált eredetű): Gábor jóváhagyására vár push előtt.
- Megjegyzés: a Claude havi költségkeret ismétlődően elfogyott a háttér-agenteknél ezen a napon — a keret rendszeresen újraindul, a megszakadt agenteket a taskfájl állapotának ellenőrzése után folytatni kell (van rá eset, hogy a munka ténylegesen elkészült a megszakadás előtt).
