# MEMORY.md — ROOT terminál

> Tartós munkamemória a root terminálhoz. Nagyobb lépések végén frissítjük (QUALITY.md 5. pont).

---

## 2026-07-14 — Knowledge-service modernizációs audit

Teljes átvizsgálás (3 párhuzamos felderítő agent: architektúra, tooling, tesztek). ~67 500 sor TS, CommonJS, Express 5.

### Fő megállapítások

- **God-fájl:** `src/mcp.ts` 5801 sor — MCP-szerver + auth + ~102 tool regisztráció ÉS implementáció egy 121 ágú switch-ben. Teszteletlen. A tiszta absztrakció (`interfaces/mcp/tools/base-tool.ts`) létezik, de használatlan.
- **Halott kód (~4000+ sor):** `server.legacy.ts` (3160 sor, 0 importer), `embeddings-old.ts`, `coldStart.prototype.ts`, `test-embedding.ts`, `pipeline/phaseCoordinator.ts.broken.bak`.
- **Két félbemaradt refaktor:** route-kiszervezés (`interfaces/http/routes/`) ~80% kész, ÉL; DDD-réteg (`domain/`, `infrastructure/`) ~2300 sor scaffolding, 0 importer — halott párhuzamos mailbox/terminal implementáció a futó flat `mailbox.ts` mellett.
- **`pipeline/`:** 72 flat fájl, 25k sor (a kód 37%-a), alfolderezés nélkül.
- **Tooling nulla:** nincs linter/formatter/CI/vitest.config; 944 `console.*` 120 fájlban; `process.env` 100 fájlban nyersen (zod van, de env-re nem használt); ~30 fájlban `/opt/spaceos` hardcode, néhol env-override nélkül (`handoff.ts:96`, `goalStore.ts:278`, `dispatch-control/tokenBudget.ts:21`) — Windows dev gépen törik; minden script bash-only.
- **Dependency-gubancok:** js-yaml v5 vs @types/js-yaml v4; ts-node ÉS tsx (tsx használatlan); `@xenova/transformers` deprecated + `sharp` valszeg felesleges (embedding már ChromaDB-oldali); nincs `engines` mező.
- **Tesztek:** 56 tesztfájl, de a 3 legnagyobb fájl fedetlen; 8 teszt élő szervert igényel (localhost:3456), vákuum-pass kockázattal; 159 `any`; 72 nyers `throw new Error`; `DomainError`-hierarchiát csak 5 fájl használja.

### Elfogadásra váró modernizálási terv (fázisok)

1. **Takarítás** — halott kód törlése + dependency-rendezés (~1 nap, kockázatmentes)
2. **Tooling-alap** — Biome + minimál CI (tsc --noEmit + vitest) + zod-validált config-modul + pino logger + cross-platform Node scriptek
3. **mcp.ts dekompozíció** — toolok kiszervezése a meglévő base-tool absztrakcióra, inkrementálisan, unit-tesztekkel
4. **Architektúra-döntés** — DDD-scaffolding: bekötni VAGY törölni (a kettősség a rossz); `routes/` maradék 2 fájl átmozgatása; `pipeline/` alfolderezés
5. **Teszt-megerősítés** — vitest.config, élő-szerveres tesztek külön smoke-suite-ba

**Nem javasolt most:** ESM-migráció (drága, kevés haszon), Express-csere.

**Státusz:** Gábor jóváhagyta ("Csináld meg a rendszer fejlesztését"), végrehajtás 2026-07-14-én elindult.

---

## 2026-07-14 (este) — Modernizáció végrehajtás, 1–3. fázis

### Elkészült (commitok: 0d9cba7, c14dc14, 1c4e8e6, 7730c93, e349f97)

- **1. fázis:** ~4000 sor halott kód törölve; sharp/@types/js-yaml/ts-node ki, engines be.
- **2. fázis:** Biome (lint-gate, 0 error), CI workflow, `config/env.ts` (zod, fail-fast), `core/logger.ts` (LOG_LEVEL/LOG_FORMAT, console-kompatibilis), 944 console.* → logger codemoddal (104 fájl; kódgeneráló template-ekben szándékosan console maradt), hermetikus/smoke teszt-szétválasztás, cross-platform `scripts/dev-start.mjs`.
- **3. fázis (elindítva):** ToolRegistry-varrat az mcp.ts-ben (registry először, legacy switch fallback), 3 csoport kiszervezve (knowledge, tmb_*, workflow), 6 unit teszt, migrációs recept a `src/interfaces/mcp/tools/README.md`-ben. Maradék ~85 tool.
- **Runtime-verifikáció:** Windowson bootol a 3466-on; MCP tools/list 121 tool, duplikátum nincs; registry-toolok élesben hívva.

### Talált és javított bugok

1. **Duplikált `get_workflow` MCP tool** (Biome noDuplicateCase találat): a 2026-07-14-én hozzáadott workflow-manager tool elérhetetlen volt a legacy mögött → átnevezve `get_workflow_details`-re.
2. **CHROMA_URL-t a kód sosem olvasta** (ChromaClient host/port beégetve; .env-ben ráadásul CHROMA_HOST néven szerepelt) → env.ts + vectorStore javítva.
3. **workflowDb.ts beégetett `/opt/nexus/...` útja** import-időben `C:\opt\...` szemetet írt Windowson → config/paths + WORKFLOW_DB env.
4. **indexer.ts saját KNOWLEDGE_BASE_PATH duplikátuma** más defaulttal, mint a config/paths → egyesítve.
5. **paths.ts defaultok** a prod (`/opt/spaceos/spaceos-nexus`) beágyazást feltételezték, nem a repo-layoutot → `../` javítás.

### Tanulságok (Windows dev gép)

- PowerShellben a tsc/npx kimenetét fájlba kell irányítani (pipeline OOM-crash / npx.ps1 NullReference); a Git Bash tool megbízhatóbb.
- PowerShell `Set-Content -Encoding utf8` BOM-ot ír — fájlmódosításhoz Node-szkript kell.
- `C:\opt\spaceos` (5 MB) régi teszt-runtime-adat — még törlendő, ha Gábor jóváhagyja.

### Nyitott

- 4. fázis DDD-döntés: Gábor.

---

## 2026-07-15 — 5. fázis: teszt-megerősítés KÉSZ (98 → 0 bukás)

A háttér-agent a havi költségkeret-limitbe futott és félbehagyta; a részmunkáját verifikáltam, befejeztem, minden zöld (49 fájl / 888 teszt).

### Az agent jó munkája (megtartva)
- `EPICS_PATH` / `SPACEOS_ROOT` / `PLANNING_FOCUS_PATH` env-varratok a forráskódban (4 fájl, minimál-diff)
- Közös `__tests__/helpers/epicsFixture.ts` (temp EPICS.yaml + env-beállítás)
- `/tmp` hardcode-ok → `os.tmpdir()` a tesztekben; `vi.hoisted` az import-idejű env-beállításhoz
- epic-router FK-regisztráció a projectAutomation tesztekben

### Amit én fejeztem be
1. **graphRoutes fixture** nem felelt meg az EPICS-sémának (hiányzó `version`/`updated`/`project`/`tasks_yaml` → PUT 500) — kiegészítve; 14 bukás megszűnt.
2. **mcp-tools pattern-tesztek** olyan sikert vártak, amit a kulcsszó-alapú `matchDomainPattern` stub sosem adott — bemenetek/elvárások igazítva a tényleges viselkedéshez (4 teszt).
3. **Concurrent Dispatch teszt**: a megosztott epic-router SQLite-ban a korábbi tesztek `working`-ben hagyták a terminálokat → queue dispatch helyett — teszt elején `setTerminalContext(..., 'idle')` reset.
4. **4 suite hook-timeout** (agentEval, federationRoutes, projectsApi, workflowModel): izoláltan zöldek, csak teljes-suite terhelés alatt lassú az import (>50s össz) — `hookTimeout: 30s`, `testTimeout: 15s` a vitest.configban.

### Tanulság
- Tesztbukás-triázs: külön kell választani a "izoláltan is bukik" (valódi hiba) és a "csak teljes suite alatt bukik" (terhelés/megosztott állapot) eseteket — a 98-ból 29 az utóbbi volt.
- A megosztott module-szintű SQLite (epicRouter) tesztek közti állapot-szivárgást okoz — tesztenkénti kontextus-reset kell.

---

## 2026-07-15 — 3. fázis (mcp.ts dekompozíció) TELJES

**103 tool migrálva** a ToolRegistry architektúrára, 14 doménspecifikus modulba szervezve:

| Modul | Tool-szám | Fő funkciók |
|-------|-----------|-------------|
| identity.tools.ts | 6 | get_identity, list_terminals, read/write/append_memory, get_capabilities |
| skills.tools.ts | 8 | list_skills, get_skill, get_workflow, get_terminal_setup, get_project_context, terminal_docs |
| terminal-status.tools.ts | 17 | register_working/idle, session_state, context_saturation, checkpoints, domain_memories |
| mailbox.tools.ts | 11 | list_inbox, create_task, send_message, submit_done, complete_inbox_message |
| focus-queue.tools.ts | 5 | get/set_focus_queue, add_focus_item, set_active_task, set_task_status |
| session.tools.ts | 9 | request/spawn_work_session, tiered_memory, retrospective, handoff, daily_digest |
| project.tools.ts | 6 | create_project, get_project_status, dispatch_next, list_blocked, skeleton/endpoint gen |
| telegram.tools.ts | 4 | telegram_reply/broadcast, get_telegram_history, request_review |
| codegen.tools.ts | 9 | generate_api_client/component/module/hook, verify_frontend_build, analyze_bundle_size |
| goal.tools.ts | 19 | create/list/check/complete_goal, memory_health, compress_memory, epic_progress, create_skill |
| worker.tools.ts | 6+sub | spawn_parallel/raw_workers, get_worker/service_status, subscription tools |
| knowledge/workflow/tmb | 3 | search_knowledge, list_workflows, tmb_create_task |

### Implementációs részletek
- Migráció a `src/interfaces/mcp/tools/README.md` recept alapján
- Minden tool `success()`/`error()` helper-ekkel, JSON-text result shape
- ToolContext.terminal a caller-azonosításhoz (auth, broadcast)
- TypeScript típusok javítva: CreateSkillParams (template/trigger_patterns), CreateResult.id
- Unit tesztek frissítve a registry-megfelelés ellenőrzéséhez

### Státusz
- **Tesztek:** 49 fájl / 889 teszt ZÖLD (frissített mcpToolRegistry.test.ts)
- **TypeScript:** 0 hiba (`npm run typecheck`)
- **Build:** sikeres
- Legacy mcp.ts switch (109 case) fallback-ként megmarad — törlése future cleanup, nincs sürgősség

---

## 2026-07-18 — Garantált szigetüzem és többplatformos CLI runner program

### Tartós architekturális tanulság

A jelenlegi rendszer egy sziget, egy szerver és terminálonként egy runner mellett
használható, de több izolált szigetet még nem garantál. A fő okok:

- nincs első osztályú `island_id / terminal_id / runner_id` összetett identitás;
- a mailbox és több állapotmodell globális terminálnevet használ;
- nincs szerveroldali atomi claim/lease/fencing;
- a legacy mailbox, TMB, registry és Epic Router párhuzamos igazságforrás;
- a service watcher és a külső runner külön launch authority lehet;
- a federation jelenleg tároló/API, nem teljes outbox/relay/ACK/DLQ transport;
- a review, budget és dependency nem minden útvonalon kikényszerített.

Részletes bizonyíték:
`docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md`.

### Elfogadott fejlesztési program

Létrejött a `NEXUS-ISLAND-RUNTIME` program 5 mérföldkővel és 17 taskkal:
`docs/tasks/island-runtime/`. Első kapu a `TASK-ISL-001` célarchitektúra és ADR;
feature implementáció csak ennek elfogadása után indulhat.

A végső platformkapu valós 3×2 mátrix:

- Codex CLI: Windows + Linux;
- Claude Code CLI: Windows támogatott út + Linux;
- Antigravity CLI (`agy`): Windows támogatott út + Linux.

Mock, emulált siker vagy GUI-makró nem helyettesíti a valós platformbizonyítékot.
WSL Linuxnak számít, és nem címkézhető Windows-native PASS-nak.

### Kötelező állapot- és memóriaprotokoll

Minden TASK-ISL indításakor és nagyobb checkpointjánál szinkronizálni kell:

1. task frontmatter és végrehajtási napló;
2. `docs/projects/EPICS.yaml`;
3. `terminals/root/state.md`;
4. `terminals/root/todo.md`;
5. tartós tanulság esetén `terminals/root/MEMORY.md`;
6. kapcsolódó ADR/README/knowledge dokumentáció.

Minden futás elején explicit goal, mérhető sikerkritérium, kilépési feltétel és
erőforráskeret szükséges. `done` csak teljes Implementáció szekcióval, futtatott
tesztbizonyítékkal és a készítőtől független review-val lehetséges.

---

## 2026-07-18 — Fejlesztési folyamat érettsége és kontrollprogram

### Tartós folyamat-tanulság

A Nexus dokumentált fejlesztési modellje erős, de a kész állapotot nem elég
taskfrontmatterrel vagy zöld helyi teszttel kijelenteni. A bizonyítható
változásegység minimális lánca:

`goal → task → owner/base → branch/commit → required CI → független review →
merge → artifact/release → state reconciliation`.

A 2026-07-18-i felmérés négy rendszerszintű hibát bizonyított:

- a nagy, kevert `main` munkafa miatt a done taskok nem köthetők egyértelmű
  commit-/PR-egységhez;
- az `EPICS.yaml`, a projects/checkpoint DB és az Epic Router egymással versengő
  source-of-truth állítást használ;
- a kézi task/EPICS/state/todo/memória többszörös írás már elsodródott;
- a task-séma, review/archive és teljes provenance nincs CI-ben tranzakciósan
  kikényszerítve.

Javasolt tartós felelősséghatár: DB a tranzakciós runtime state/ownership
számára; verziókezelt task/program dokumentum a goal, scope, acceptance és exit
számára; generált/reconciliált `state.md` és `todo.md`; `MEMORY.md` csak tartós
tanulság számára. A végleges döntést ADR-ben kell meghozni, tartós dual-write
nélkül.

### Elfogadott fejlesztési program

Létrejött a `NEXUS-DEVELOPMENT-PROCESS` program 4 mérföldkővel és 11 taskkal:
`docs/tasks/development-process/`. Első párhuzamos feladat a teljes munkafa
veszteségmentes leltára (`TASK-DP-001`) és a kanonikus állapotmodell ADR
(`TASK-DP-002`). A programot kizárólag a `TASK-DP-011` friss, független reviewer
PASS auditja zárhatja.

Részletes bizonyíték:
`docs/knowledge/fejlesztesi-folyamat-erettsegi-ertekeles.md`.

A 4 mérföldkő, 11 task, dependency kapuk, evidence manifest és független audit
létrehozási indoklása:
`docs/knowledge/fejlesztesi-folyamat-taskprogram-letrehozasa.md`.

---

## 2026-07-21 — Codex-elsődleges autonóm VPS runner

### Tartós architekturális tanulság

Headless Codex-autonómiánál három külön engedélyezési síkot kell kezelni:

1. a CLI általános approval policyja;
2. az MCP szerver/tool approval módja;
3. a tényleges biztonsági enforcement: sandbox + helyi allowlist +
   terminal-scoped token + szerveroldali autorizáció.

Az `approval_policy="never"` önmagában nem engedélyezi a headless MCP toolokat;
a lokális MCP szerverhez külön `default_tools_approval_mode="approve"` kell.
Enélkül a Codex `user cancelled MCP tool call` eredménnyel áll le. Az automatikus
MCP-approval csak akkor elfogadható, ha a child nem kap master tokent, a szerver
minden hívásnál termináljogot ellenőriz, a provider/model/sandbox lokális
allowlistből jön, és az endpoint helyi vagy kontrollált hálózaton érhető el.

### Tartós lifecycle-tanulság

- Az első indulás régi `UNREAD` backlogját fail-closed kell karanténba tenni;
  részleges inbox-lekérés mellett tilos sessiont indítani.
- Poll/SSE csak wake mechanizmus; a launch előtt szerveroldali claim és helyi
  aktív marker is kell.
- Process `exit 0` nem üzleti completion. Siker csak a tartós `complete_task`
  eredménnyel együtt állítható.
- Döntésre váró `blocked` állapotot az ütemezőnek tiszteletben kell tartania,
  különben ugyanazt a drága felderítő sessiont végtelenül újraindítja. Célzott
  új inbox-task ettől még folytathatja a rendszert.
- Az autonóm agent helyes viselkedése nem a mindenáron történő kódírás: az első
  Conductor-ciklus kanonikus prioritásütközést talált, tartósan eszkalált,
  frissítette a task/state/todo/MEMORY láncot, és módosítás nélkül leállt.

Linux + Codex (Debian 13, Codex 0.144.6) read-only és workspace-write canary
PASS. Windows-native Codex 0.144.5 jelenleg BLOCKED a sandbox-helper access
denied hibája miatt; WSL ezt nem helyettesíti. Claude/Antigravity valós 3×2
platformevidence továbbra is kötelező.

Részletes runbook és bizonyíték:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.

---

## 2026-07-22 — Attached PTY completion és tulajdonlási invariánsok

### Tartós architekturális tanulság

Hosszú életű attached CLI-sessionnél a képernyő és az üzleti taskállapot két
külön igazságforrás. PTY-output, prompt-visszatérés, processz-élet vagy inbox
`READ` állapot nem bizonyítja a task befejezését. A completion kizárólag a
szerveroldali `complete_task`-ból létrehozott, terminal/message-id kötött durable
receipt; az SSE csak wake, ezért reconnect után cursoros reconciliáció kell.
A következő nudge kapuja: matching receipt **ÉS** stabil, provider-specifikus
PTY-idle. Az idle önmagában sosem completion.

Vegyes `headless | attached` runnerhez terminálonként delegáló
`TerminalSinkRouter` szükséges; a sink nem vehet át mailbox-/launch-döntést a
polltól. A PTY és a helyi dashboard gateway a runner tulajdona, mert ez őrzi az
outbound-only topológiát. A node-pty session csak a runner folyamatán belül
hosszú életű; crash után új PTY és durable receipt/claim reconciliáció kell,
nem „reattach”.

A dashboard távoli billentyűinjektálási felület: alapból tiltott és localhostra
kötött, egy lejáró controller lease írhat, több viewer olvashat, a replay
bounded memóriapuffer, a nyers transcript pedig alapból nem perzisztálható. A
legacy tmux watcherből csak tiszta classifier-logika vihető át, automatikus
Enter/kill/értesítési mellékhatás nem.

### Tartós implementációs tanulság

A durable nyugta csak akkor bizonyítja az üzleti completiont, ha az üzleti
állapotváltással **ugyanabban az adatbázis-tranzakcióban** jön létre. Külön
írásnál a task és a nyugta crash esetén szétcsúszhatna. Az idempotens retry
kulcsa az `(island_id, terminal_id, message_id)` hármas; a szerver ugyanazt a
sequence-t adja vissza, nem hoz létre új completiont.

A reconnect utáni replay kliensoldali védelme ugyanilyen fontos: a válaszban
érkező terminálnak és islandnek egyeznie kell a kért scope-pal, a sequence-eknek
szigorúan növekedniük, a `nextCursor` értéknek pedig monoton haladnia kell. A
streamkulcsnak a server+terminal mellett az islandet és a credential nem
visszafejthető fingerprintjét is tartalmaznia kell, különben egy jogosultság-
rotáció régi cursorral eseményt ugorhat át. A helyi cursor temp-file + rename
módon, verziózott formában mentendő, és memóriában csak a sikeres rename után
léphet előre; sérült fájl, írási hiba vagy cursor-regresszió fail-closed állapot.

Az olvasási scope nem helyettesíti az írási erőforrás-tulajdont. A claimnek a
hitelesített islandet a taskkal együtt tartósan kell tárolnia, a completionnek
pedig ugyanabban a tranzakcióban kell ellenőriznie a terminal+task+island
egyezést, amelyben az állapot és a receipt készül. Minden régi REST/file-DONE
út, amely ezt nem tudja bizonyítani, island-scoped tasknál kötelezően fail-closed;
egy privilegizált `root` név sem jogosít hallgatólagos cross-terminal írásra.

A route-szintű „read, majd async I/O, majd write” ellenőrzés nem ownership:
TOCTOU ablakot hagy két claim között. A claim és release kötelezően adatbázis-
tranzakciós CAS (`WHERE` + affected-row check); az aktív
`(island, terminal, task)` tuple-t csak matching scoped release vagy completion
módosíthatja. A generikus context setter nem létesíthet scoped claimet és nem
írhat felül meglévőt. A legacy dispatch queue- és context-változásának is egy
tranzakcióban kell történnie, hogy a fail-closed guard ne hagyjon félállapotot.

A receipt feed elkészülte önmagában még nem indokol PTY-nudge-ot: a runner
főciklus csak a későbbi lifecycle-szeletben kapcsolhatja össze a matching
receiptet a stabil provider-idle feltétellel.

Kanonikus terv és döntés:
`docs/plans/ATTACHED-SINK-STEP-3.md`,
`docs/architecture/decisions/ADR-087-attached-terminal-lifecycle.md`.

---

## 2026-07-22 — Natív PTY platform- és leállítási tanulságok

A natív dependency reprodukálhatóságához a pontos production verzió önmagában
nem elég: a lockot tiszta Linux checkoutban kell generálni, majd ugyanazt a
lockot minden támogatott OS- és Node-vonalon `npm ci`-jal telepíteni. 2026
júliusában a Node 20 már EOL, ezért release-kapu csak Node 22/24-re épülhet; az
engine minimum is Node 22. A prebuild kényelmi út, de a source-build
prerequisite-eket és fallbacket dokumentálni/CI-ben biztosítani kell.

A `node-pty.kill()` nem egységes process-tree supervisor. Linuxon az interaktív
háttér-job külön process groupba kerülhet, miközben ugyanabban a forkpty
sessionben marad. A helyes cleanup: a session ID rögzítése a TERM előtt,
descendant-first `SIGTERM`, rövid grace, majd session-szintű `SIGKILL` — ezt
TERM-et ignoráló fixture-rel kell tesztelni. Windowson a ConPTY close rendezi a
natív output-workert, de child túlélhet; ezért a lezárás előtt snapshotolt PID-
fát külön, gyermek-először kell ellenőrizni és `taskkill /T /F` fallbackkel
takarítani.

Natív spawn maga is blokkolhat, ezért a smoke belső timeoutja nem elég: külön
watchdog processz és CI-s hard timeout kell. A kapu stdout/stderr-e bounded.
Ismert upstream helperhiba csak pontos blokk-illesztéssel minősíthető
dokumentált fallbacknek; a teljes stderr lenullázása hamis zöldet okozna.
Bármely maradék stderr fail-closed, és ezt külön injekciós negatív tesztnek kell
bizonyítania.

Kanonikus evidence: `162f7e7`,
`docs/plans/ATTACHED-SINK-STEP-3.md`, valamint a `TASK-ISL-007` 3B naplója.

---

## 2026-07-23 — Attached lifecycle leállítási és shutdown-invariánsok

Egy leállított implementációs jelölt nem azonos egy lezárt szelettel. Stopkor
először az agenteket és a kapcsolódó projektfolyamatokat kell megszüntetni, majd
a kanonikus state/todo/task/epic/koordinációs állapotban rögzíteni a pontos
commitot, a munkafa jellegét, az utolsó review-verdiktet és a folytatási
feltételeket. Nyitott P1 mellett tilos `done`, release-ready vagy sikeres
shutdown állapotot állítani.

Az attached session cleanup egyetlen, session/generation szintű tranzakció.
Root-exit és koordinált shutdown ugyanazt a cleanup-promise-t és ugyanazt a
hibahalmazt kell hogy megfigyelje. A subscription előzetes dispose-a nem
„fogyaszthatja el” a hibát; bármely dispose-, process-tree- vagy marker-cleanup
hiba tartósan megőrzendő, a sink shutdownnak rejectálnia, a runnernek pedig
nem nulla exitet kell adnia.

Az automatikus restart állapotgépben a pending spawn startup-timeoutja nem
végállapot. Ha a későn megérkező session teljes cleanupja sikeres, az attempt
még az aktuális generációhoz tartozik, és nem történt explicit cancel vagy
shutdown, a bounded restart policy folytatandó. A restart budget csak igazolt
stabilitási ablak után nullázható.

A hard shutdown költségvetés összegződik: a folyamatban lévő spawn garantált
settlement/rollback felső korlátja + a teljes cleanup deadline + biztonsági
margin. A sink által jelentett `minimumShutdownGraceMs` ennél nem lehet kisebb,
és a spawn deadline csak akkor valódi garancia, ha a host ki is kényszeríti,
valamint a későn teljesülő erőforrást teljesen visszagörgeti. Egy egyszerű
`Promise.race` ownership/rollback nélkül nem elég.

A 2026-07-23-i C review ezt három P1-ként bizonyította. A C-szelet csak a három
regresszió javítása, teljes QUALITY-kör és új, független P0/P1/P2-mentes review
után commitolható lezárt implementációként. A stop checkpointjának utolsó
publikált/implementációs baseline-ja `origin/main@e627495`; C implementációs
commit, push vagy deploy nem történt. Egy külön lokális dokumentációs checkpoint
nem jelent C-elfogadást.
