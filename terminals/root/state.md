# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-16

## Aktuális fókusz

VPS-deploy + lokális ébresztés (pull-modell) **ÉLESBEN, végponttól végpontig igazolva**. A teljes lánc: token-auth (`36a4dad`) → lokális runner MVP (`src/runner/`, zárt parancskészletű `claude -p`, Windows-first) → SSE-ébresztés (~90 ms) → Tailscale-hálózat → VPS-deploy. Élő E2E: feladat a VPS-agyba → SSE-ébresztés a tailneten át → lokális runner elindítja a sessiont.

**VPS (109.122.222.198, Debian 13):** részletek a memóriában [[vps-uzemeltetes]]. nexus-dev deploy: `/opt/nexus-dev`, port 3466, **csak a tailnet-interfészen** (100.82.133.87) figyel, `AUTH_MODE=required`, `systemd nexus-dev-ks.service`, külön `nexus-dev-knowledge` Chroma-kollekció. Tailnet: VPS=nexus-vps (100.82.133.87), Windows=nexus-dev-win (100.78.193.104). Biztonsági javítás: a publikusan nyitott ChromaDB (8001) bezárva.

Következő: runner-regisztráció + heartbeat (flotta-státusz), VPS knowledge-base indexelése (nexus-dev-knowledge ~üres), runner mint auto-induló Windows-szolgáltatás. Gábor 2026-07-16-i iránya: EGY központi szerver minden szigetnek, sziget-saját tudással + funkció-szkópolt tool-nézetekkel (backlogban), agent-management lokálisan (= runner).

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
- ✅ Minden commit pusholva GitHubra (origin/main)

## Környezet

- DEV: port 3466 — MŰKÖDIK Windowson (`node scripts/dev-start.mjs`)
- ChromaDB nem fut a gépen → in-memory fallback (indexelés OK, perzisztencia nincs)
- `C:\opt` (spaceos + nexus-dev maradványok) TÖRÖLVE 2026-07-15 — Gábor jóváhagyta
- PowerShell-sajátosság: tsc/npx kimenetét fájlba kell irányítani (pipeline-crash), a Bash tool megbízhatóbb

## Nyitott kérdések

- Megjegyzés: a Claude havi költségkeret elfogyott a háttér-agenteknél — a további munkát inline érdemes végezni
