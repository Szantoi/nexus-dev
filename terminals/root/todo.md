# todo.md — ROOT terminál teendők

> A feladatok nyilvántartása. Új feladat ide kerül; kész feladat pipát kap és dátumot.
> Állapot-kontextus: state.md, hosszú távú tanulságok: MEMORY.md.
> Program/mérföldkő/epic szintű GÉPI állapot: `docs/projects/EPICS.yaml` — task-zárás
> után oda is szinkronizálni kell (eljárás a fájl fejlécében; TASK-QC-001).

**Utolsó frissítés:** 2026-07-21

## Aktív

- [ ] **NEXUS-DEVELOPMENT-PROCESS program (2026-07-18):** bizonyítható,
  kikényszerített fejlesztési lánc — 11 task a
  `docs/tasks/development-process/` alatt. `TASK-DP-001` (munkafa-leltár, 2
  kör), `TASK-DP-002` (kanonikus állapot ADR-068, 3 kör — talált egy
  harmadik, önálló task-tracker rendszert is: `create_project` MCP tool +
  saját TASKS.yaml, nyitott kérdésként DP-004 elé), `TASK-DP-003`
  (task-séma CI-kapu, `scripts/check-tasks.mjs`, 3 kör — js-yaml
  Date-koercíciós bug + 2 hiányzó cross-check javítva, `npm run
  check:tasks` most **exit 0** a teljes repóra) és `TASK-DP-006`
  (branch/commit/PR provenance, ADR-086 — TERVEZETT, nem alkalmazott
  branch-protection, 2 kör) **mind `done`, archiválva**. A `check:tasks`
  kapu bevezetése közben 21 elavult ledger-hiba (hiányzó `blocked_reason`/
  `execution_evidence`) is kiderült és javítva — eközben az is kiderült,
  hogy `TASK-DP-004` és `TASK-DP-007` függőségei már teljesültek, ezért
  `blocked`→`ready`-re állítva, INDÍTHATÓK. `TASK-DP-005` csak DP-004
  után. Emberi jóváhagyásra vár: a branch-protection JSON tényleges
  alkalmazása GitHubon. Végső mérce: task → commit/PR → Linux/Windows CI →
  független review → non-production release/rollback → konzisztens state
  bizonyítéklánc és `TASK-DP-011` PASS audit.

- [ ] **NEXUS-ISLAND-RUNTIME program AKTÍV — Codex/Linux autonóm rollout
  működik:** ISL-002 és ISL-007 `in_progress`; minden ISL blocked reason a
  tényleges aktuális függőségre/platformhiányra frissítve. A JoineryTech VPS
  runner+timer aktív, read-only/write canary PASS, első valós időzített
  Conductor-ciklus szabályosan eszkalált és lezárt. Következő kapuk:
  (a) `MSG-ROOT-004` root döntés és célzott válasz-task a Conductornak;
  (b) Windows Codex sandbox-helper javítás + native service evidence;
  (c) Claude/Antigravity Linux+Windows smoke;
  (d) ISL-004…006 kanonikus store + atomi lease/fencing + runner registry;
  (e) ADR-081 teljes launch-authority implementáció és független review;
  (f) tiszta commit/PR, secret-scan, Linux/Windows CI és GitHub release.
  Részletes runbook: `docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.


- [ ] **joinerytech pre-existens registry-bug (owner: joinerytech-csapat):** a régi `messageRegistry` SQLite CHECK-constraintje (`type IN (...)`, `priority IN ('critical','high','medium','low')`) elutasít pár valódi üzenetet a sync során (3678 halmozott hiba a log életében — nem a mailbox-fix okozta). Az üzenetek fájlként megvannak/kézbesíthetők, csak a registry-index hiányos. A modern nexus-kódban ez a modul már más — a végleges gyógyír a sziget kódfrissítése.
- [ ] **joinerytech testvér path-bugok:** `task-message-box/store.ts:28` (`../../../..`) és `indexer.ts:15` ugyanazt a `src/`-re tévedő útvonalhibát hordozza, mint a mailbox volt. Nem javítva (sebészi scope a mailbox volt) — a kódfrissítéssel oldódik.
- [ ] **doorstar-ks felügyelet-hiány:** a 3460 NEM systemd, hanem `setsid`/`nohup` node-folyamat (egy korábbi Claude-session indította). Túléli az ssh-t, de **nem indul újra reboot/crash után**. Javasolt: systemd user-unit (mint a nexus-dev/prod). Nem sürgős, de rögzítendő.

## Backlog

### 4. fázis — Architektúra (EPICS.yaml: `EPIC-KS-ARCH-REFACTOR`, KS-M3)
- [ ] `src/routes/` maradék 2 fájl átmozgatása `interfaces/http/routes/` alá
- [ ] `pipeline/` alfolderezés (watchers/, planning/, epics/, coordination/, integrations/)
- [ ] Két `memoryStore.ts` (root vs pipeline) egyeztetése/átnevezése
- [ ] `DomainError`-hierarchia kiterjesztése (72 nyers `throw new Error` cseréje)

### VPS-deploy + lokális ébresztés (terv 2026-07-15, Gábor igénye: lokális wake + erős biztonság)
- [ ] Epic-router külön token-rendszerének (SHA256-derivált, TERMINAL_TOKEN_SECRET) egyesítése a tokenAuth-tal
- [ ] Runner-regisztráció + heartbeat: terminál→gép hozzárendelés a szerveren; offline gép feladata a sorban várakozik, flotta-státusz mutatja az elérhetőséget
- [ ] VPS knowledge-base indexelése: a `nexus-dev-knowledge` kollekció ~üres (1 doc) — indexer futtatása a docs/knowledge-re
- [ ] Chroma végleges zárás: compose-ban `127.0.0.1:8001:8000` + recreate (most DOCKER-USER iptables + systemd tartja); Gábor jóváhagyásával
- [ ] Runner mint Windows-szolgáltatás (auto-indulás bootkor) — most kézzel indul
- [ ] `search_knowledge` domain-szűrő paraméter (projekt-szkópolt RAG egy kollekcióban, ChromaDB `where`)

### Egy szerver — több sziget (Gábor 2026-07-16: központi + sziget-saját tudás, ne fusson szigetenként szerver)
- [ ] **A meglévő sziget-service-ek kiváltása**: ma 3456 (nexus), 3458, 3460 (doorstar) külön processz fut — a több-szigetes kiszolgálás kész, ezek beolvaszthatók EGY service-be (agent_islands mapping + kliensek átirányítása). Ez a tényleges "ne fusson szigetenként szerver" lépés.
- [ ] Indexer sziget-paraméter: `addChunks` már fogad islandot, de az indexer CLI még csak az ISLAND_ID-t indexeli — több sziget indexelése egy futásból
- [ ] `search_knowledge` domain-szűrő (szigeten BELÜLI projekt-szkóp; a chunk-metaadatban már van `domain`)
- [ ] Funkció-szkópolt MCP tool-nézetek: a tool-permission mátrix kiegészítése funkció-profilokkal (pl. knowledge-only, mailbox-only), hogy egy agentnek ne 200+ toolból kelljen válogatnia — monolit marad, csak a felület szeletelődik

### Kisebb tételek
- [ ] 159 `any` fokozatos csökkentése (Biome noExplicitAny warn → error ratchet)
- [ ] Biome warn-ra vett szabályok ratchetelése (noAssignInExpressions, noControlCharactersInRegex, useIterableCallbackReturn)
- [ ] deploy-to-prod.sh cross-platform kiváltása (Node), prod-layout env-fájllal
- [ ] README.md frissítése (elavult: Voyage/Gemini setup, lint-szekció, portok)

## Kész

- [x] 2026-07-21 — **Codex-elsődleges Linux autonóm rollout checkpoint:**
  providerfüggetlen runner, terminal-scoped auth, backlog-karantén,
  claim/release, active marker, durable completion, systemd runner+timer és
  backup/rollback. Read-only (`MSG-EXPLORER-025`) + workspace-write
  (`MSG-EXPLORER-026`) canary PASS; első időzített Conductor-ciklus
  (`MSG-CONDUCTOR-049`) biztonságosan eszkalált és lezárt; blocked-state guard
  megakadályozza az ismétlődő költséges ciklust. Ez checkpoint, nem a teljes
  ISL-program lezárása.
- [x] 2026-07-21 — **TASK-ISL-001 (szigetüzemi célarchitektúra) DONE** — 6
  review-kör, hívásgráf-alapú launch-audit. Gábor döntése oldotta fel a
  blokkot (módszertan + kapuzás). A hívásgráf-módszer 5 új launch-utat
  talált a regex 3 köréhez képest; végleges ADR-081 leltár: 22 élő + 1
  fájlrendszeri kategória + 1 holt + 1 alvó út. Független reviewer zárta
  `done`-ra (6. kör PASS). `ISL-ARCHITECTURE` epic `done`. Tanulság
  memóriában: [[nexus-dp-isl-programs]].
- [x] 2026-07-21 — **TASK-QC-011 (workflowDb history-bug) DONE** — hiányzó
  better-sqlite3 named param + néma catch → history-vesztés; fix `?? null`
  + `{success,error?}` propagálás; független review PASS, 1314 teszt zöld.
- [x] 2026-07-21 — **TASK-QC-012 (goalStore ID-ütközés) DONE** — ms-alapú
  szuffix ütközés → néma felülírás; fix perzisztens számláló + mutex + `wx`
  + retry; független review PASS (cross-process támadás szimulációval kivédve).

- [x] 2026-07-21 — **Árva mailbox-fák LEZÁRVA** (Gábor: A opció — átnézés, majd „arhiváld"). Mindkét fa teljes tartalma átnézve: prod 18 fájl (07-13…16), joinerytech 74 fájl (07-13…21). **Eredmény: EGYETLEN nyitott teendő sincs** — a prod árvában minden inbox-task `COMPLETED`/feldolgozott (merge-conflict megoldva: nincs MERGE_HEAD; nexus-dev audit: architect elvégezte; migráció: a dda0bcc release maga volt az), az outbox DONE-ok lezárt munka nyugtái; a joinerytech árvában `44 done/UNREAD` + 28 „task" amiből a conductor-inboxosok mind `goal-completed-*` autonóm nyugták (mislabelt type), a maradék lezárt Fázis-0 munka (a live fa DONE-jai bizonyítják). Értékes FYI kiemelve Gábornak: architect 07-16 session — 4 OpenAPI 3.1 spec (6476 sor, 81 endpoint), Cabinet-motor kanonikus döntés, nexus-dev audit DEPLOY READY. **Archiválás**: mindkét fa átnevezve `terminals.orphan-archive-20260721`-re + README-ARCHIVE.md; health 3456/3458 OK utána. Fontos lelet: a joinerytech árvából **25 fájl git-követett** volt (checkout hozta vissza őket 07-17-én — ezért a bulk timestamp!) → az átnevezés után 25 `D` a `git status`-ban; a joinerytech-csapat döntése, hogy commitolja-e a törlést (amíg nem, egy checkout visszahozhatja a fát — ártalmatlan, mert már semmi sem írja/olvassa).

- [x] 2026-07-21 — **Terjesztés: sebészi mailbox-fix a két sziget-service-en** (Gábor: „sebészi mailbox-fix most"). Felmérés kiderítette: joinerytech (3458) és doorstar (3460) a modernizáció ELŐTTI kódot futtatja (régi 5700+ soros mcp.ts, nincs auth-réteg/runner) — de a valódi adatveszTŐ bug a mailbox-hasadás. **Ground truth bizonyítva**: a régi `mailbox.ts` a saját `REPO_ROOT=__dirname/../../..`-ból számol (joinerytech→`/opt/joinerytech/src/terminals` árva; doorstar→nem létező `/opt/terminals`), miközben MINDKÉT `.env` már helyesen beállítja a `TERMINALS_PATH`-t a kanonikus fára (CLAUDE.md-vel igazolt: `/opt/joinerytech/terminals`, `/opt/doorstar/terminals`). **Fix**: egyetlen sor mind a 4 fájlban (2 dist + 2 src), `.bak-mailboxfix` backuppal — `TERMINALS_ROOT = process.env.TERMINALS_PATH || <régi>` (config-vezérelt, fallback-biztos, blast-radius=1 sor). Restart: joinerytech `sudo systemctl restart spaceos-knowledge.service` (PID stabil, NRestarts=0, health OK); doorstar `setsid nohup` (health OK). Igazolva: valós env-ben a helyes `TERMINALS_PATH`, joinerytech log már `/opt/joinerytech/terminals/...`-t olvas, nightwatch `inbox:0…goals:0/30` → **nincs spawn-vihar**. Nem publikus (ufw default-deny; 3458/3460 nem engedélyezett) → auth nem sürgős. Mellékleletek külön todo-tételként (registry-bug, testvér path-bugok, doorstar felügyelet, joinerytech árva-fa).

- [x] 2026-07-18 — **NEXUS-QUALITY program LEZÁRVA**: QC-001…010 mind `done`
  (`docs/tasks/quality-compliance/archive/`). A QC-010 független review 2
  körben futott: 1. kör FAIL (ledger-szinkron hiánya — javítva), 2. kör friss
  reviewerrel **PASS** (minden kaput újra lefuttatott, a javításokat is
  ellenőrizte). 3 nem blokkoló, trackelt follow-up maradt nyitva: QC-011
  (workflowDb history-bug), QC-012 (goalStore ID-ütközés), QC-013
  (ENABLE_INBOX_WATCHER hatástalan env) — mind `ready`, owner: backend. A
  QC-008A…E nagyfájl follow-upok is külön backlogban élnek.

- [x] 2026-07-18 — **NEXUS-DEVELOPMENT-PROCESS dokumentáció és taskprogram
  elkészült:** fejlesztésifolyamat-érettségi felmérés; 4 mérföldkő, 11
  végrehajtható task; kötelező goal/success/exit, evidence manifest,
  state/todo/MEMORY szinkron, Linux/Windows CI, külön reviewer és végső
  clean-room audit

- [x] 2026-07-18 — **NEXUS-ISLAND-RUNTIME taskprogram elkészült:** 5 mérföldkő,
  12 epic, 17 végrehajtható task; közös goal/success/exit, checkpoint,
  state/todo/MEMORY és Implementáció dokumentációs protokoll; kötelező
  Codex/Claude/Antigravity × Windows/Linux valós tesztmátrix
- [x] 2026-07-14 — Knowledge-service teljes audit (architektúra, tooling, tesztek)
- [x] 2026-07-14 — Modernizálási terv jóváhagyva (Gábor: "Csináld meg")
- [x] 2026-07-14 — 1. fázis: halott kód (~4000 sor) törölve, dependency-k rendezve (`0d9cba7`)
- [x] 2026-07-14 — 2. fázis: Biome + CI + zod env-config + logger + teszt-szétválasztás (`c14dc14`)
- [x] 2026-07-14 — BUGFIX: duplikált `get_workflow` MCP tool → `get_workflow_details` (elérhetetlen tool)
- [x] 2026-07-14 — 3. fázis indítás: ToolRegistry-varrat + 3 csoport kiszervezve + migrációs recept (`7730c93`)
- [x] 2026-07-14 — Runtime-verifikáció Windowson: boot 3466, health OK, MCP 121 tool, registry-hívások élesben (`e349f97`)
- [x] 2026-07-14 — workflowDb + indexer hardcodolt útvonalak → config/paths (C:\opt szemét-írás megszűnt)
- [x] 2026-07-15 — 5. fázis: teszt-megerősítés KÉSZ — 98 → 0 bukás, hermetikus suite 49 fájl / 888 teszt zöld
- [x] 2026-07-15 — Minden commit pusholva GitHubra (origin/main)
- [x] 2026-07-15 — 3. fázis TELJES: 103 tool migrálva 14 modulba (ToolRegistry pattern), 889 teszt zöld
- [x] 2026-07-15 — 4. fázis DDD-döntés LEZÁRVA: scaffolding törölve (chat-root review, "A opció", `046b8bb`)
- [x] 2026-07-15 — `C:\opt` maradványok (spaceos + nexus-dev) törölve Gábor jóváhagyásával
- [x] 2026-07-15 — Token-auth réteg: auth/tokenAuth.ts modul + AUTH_MODE fail-closed + globális /api kapu + agents.yaml gitignore/example, 19 új teszt, élőben verifikálva (`36a4dad`)
- [x] 2026-07-16 — Lokális runner MVP: src/runner/ (poll → zárt parancskészletű `claude -p` session-indítás, Windows-first, tmux nélkül), 25 új teszt, élőben verifikálva a 3466 ellen (dedup, model-whitelist, backend-token)
- [x] 2026-07-16 — Runner SSE-ébresztés: sseListener + pollLoop.wake(), élőben ~90 ms wake-latencia (60 mp-es poll mellett), 9 új teszt; az esemény csak ébreszt, a launch-döntés a pollnál marad
- [x] 2026-07-16 — Tailscale hálózat: VPS (nexus-vps, 100.82.133.87) + Windows-gép (100.78.193.104) egy tailneten; a szerver csak a tailnet-interfészen figyel
- [x] 2026-07-16 — VPS biztonsági javítások: ChromaDB (8001) publikus lyuk zárva (DOCKER-USER iptables + systemd perzisztencia); Postgres félrevezető ufw-szabály törölve
- [x] 2026-07-16 — HOST env (config-vezérelt bind-cím) — `71ac72a`
- [x] 2026-07-16 — nexus-dev deploy a VPS-re (/opt/nexus-dev, port 3466, tailnet-only, AUTH_MODE=required, systemd nexus-dev-ks.service, külön nexus-dev-knowledge kollekció); E2E igazolva: lokális runner ← tailnet → VPS-agy SSE-ébresztéssel
- [x] 2026-07-16 — BUGFIX mailbox útvonal: `__dirname/../../..` a repo szülőjére mutatott (/opt), config-vezérelt TERMINALS_PATH-ra javítva + regressziós teszt — `a21aa20`
- [x] 2026-07-16 — **PROD RELEASE** (`dda0bcc` a nexus-core `release/vps` ágán): a mai javítások élesben a 3456-on. Rendrakás is: a 288 „dirty" fájl oka kiderült — a prod `src/`-je ÜRES volt (csak `dist/`-ből futott, júl. 15-i build). A forrás visszaállítva (`git archive` a nexus-devből), a prod most a SAJÁT forrásából épül. Nohup → **systemd (`nexus-ks.service`)**, auto-restart + boot. Igazolva: mailbox-hasadás gyógyult (az API az élő fát olvassa), auth open módban = változatlan viselkedés, port-PID == MainPID, 0 restart/0 hiba. Backup: /opt/nexus/backups/pre-release-20260716-2253
- [x] 2026-07-18 — **TASK-QC-001**: EPICS.yaml séma-bővítés (additív: `programs[]` cél + leállási feltétel + mérhető mérföldkövek; epic `program`/`milestone`/`tasks` mezők) + állapot-szinkron a ledgerrel (EPIC-KS-MCP-SPLIT active→done, EPIC-KS-ARCH-DECISION pending→done, új EPIC-KS-ARCH-REFACTOR backlog-epic) + NEXUS-QUALITY program és 7 QC-epic felvéve; graph-típusok bővítve (types.ts, additív); typecheck + 85 graph/workflow teszt zöld
- [x] 2026-07-18 — **TASK-QC-002**: 12 ADR helyreállítva git-/kód-bizonyítékkal (`docs/architecture/decisions/`) + `scripts/check-doc-links.mjs` linkellenőrző; 2 ADR tudatosan `proposed` (048, 054)
- [x] 2026-07-18 — **TASK-QC-003**: `.env.dev` kikerült a git-indexből (lokális fájl megmaradt), `.env.dev.example` sablon, `scripts/secret-scan.mjs` (0 találat 347 fájlon)
- [x] 2026-07-18 — **TASK-QC-004**: veszélyes `deploy-to-prod.sh` kiváltva — `scripts/deploy/build-release.sh` + `deploy-release.sh` (build/deploy szétválasztva, auto-rollback, dry-run, 70 hermetikus teszt); a régi script dokumentált vészhelyzeti fallback
- [x] 2026-07-18 — **TASK-QC-005**: CI-kapuk élnek (typecheck, lint-ratchet, teszt+coverage, `npm audit`, secret-scan, linkcheck), minden lokálisan is futtatható package scriptként
- [x] 2026-07-18 — **TASK-QC-006**: kritikus tesztlefedettség 24,5%→41% (küszöb 38/32/37/38), auth/config-modulokra 80/70 per-file kapu, 1307 teszt zöld; tesztírás közben 3 nem javított bugot talált (→ QC-011/012/013)
- [x] 2026-07-18 — **TASK-QC-007**: config-központosítás (~55 fájl), `/opt/spaceos` hardcode-ok kivezetve (`identity.ts` is, lásd `config/paths.ts`), shelles curl → típusos fetch
- [x] 2026-07-18 — **TASK-QC-008**: `mcp.ts` legacy TOOLS tömb + switch fallback törölve (5561→417 sor), 121 tool kizárólag registryből, contract-tesztek + 800 soros méretkapu CI-ben; a maradék nagy fájlokra QC-008A…E follow-up
- [x] 2026-07-18 — **TASK-QC-009**: root + knowledge-service README újraírva, 8 modul-README, elavult (Phase-történet, `/opt`, auth-mentes példák) állítások törölve
- [x] 2026-07-16 — **Több-szigetes kiszolgálás** (`9cb2083`): vectorStore kollekció-cache szigetenként (indulási kötés helyett), sziget a hívó IDENTITÁSÁBÓL (agents.yaml `agent_islands`) — sosem a kérésből; 9 új teszt. Élőben igazolva a VPS-en: ugyanaz a service+tool, backend-token → nexus-dev (1 találat), spaceos-reader-token → spaceos (4817 chunkból); args-ból sziget-igénylés hatástalan
