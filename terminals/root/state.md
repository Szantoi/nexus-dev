# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-22

## Aktuális fókusz

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
