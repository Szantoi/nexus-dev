# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-21

## Aktuális fókusz

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

**NEXUS-ISLAND-RUNTIME program: ISL-001 DONE, epic lezárva** (2026-07-21):
Gábor tulajdonosi döntése után (hívásgráf-audit + subscriptionManager
kapuzás) a `TASK-ISL-001` **6 review-kör** alatt konvergált és `done`
(független reviewer zárta). A hívásgráf-módszertan azonnal igazolta magát:
a 4-6. kör **5 további, korábban nem dokumentált launch-utat** tárt fel,
amit a regex 3 körön át nem látott — köztük az MCP `complete_task` →
checkpoint-launch FŐ ÉL (ADR-053), a `POST /api/epic-router/.../complete`
(terminál-token, nem root!), a telegram-webhook (hardcodolt secret-fallback),
és a `POST /api/subscriptions/test-trigger`. Végleges ADR-081 launch-leltár:
**22 élő + 1 fájlrendszeri kategória + 1 holt + 1 alvó út** — ez lesz az
ISL-013 (launch authority) pontos munkalistája. Az `ISL-ARCHITECTURE` epic
`done` (EPICS.yaml). **A ISL-002…017 implementációs taskok innen
indíthatók** (közvetlen függőségeik felszabadultak; a lánc a design intentre
épül). Kiemelt üzemeltetési következmény: a launch authority (ISL-013)
bevezetésekor a NAPI checkpoint-automatizmus is átmegy a kapun → a legitim
folyamat sebessége/épsége kiemelt terv-szempont.

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

**Következő:** (1) runner-regisztráció + heartbeat; (2) runner mint auto-induló Windows-szolgáltatás; (3) opcionális: szigetek teljes kódfrissítése vagy központi service-re állítása (a mailbox-drift megszűnt, a kód-drift marad). Gábor iránya: központi szerver sziget-saját tudással (kiszolgáló réteg KÉSZ), agent-management lokálisan (= runner, KÉSZ).

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
