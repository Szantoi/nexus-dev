# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-16

## Aktuális fókusz

VPS-deploy + lokális ébresztés (pull-modell). 1. lépés token-auth KÉSZ (`36a4dad`). 2. lépés lokális runner MVP KÉSZ: `src/runner/` — kifelé irányuló poll az UNREAD-sorra, zárt parancskészletű `claude -p` session-indítás Windowson tmux nélkül, prompt stdin-en (network-adat sosem ér parancssort), runner.yaml gitignore + .example, indítás: `node scripts/runner-start.mjs`. Élőben verifikálva a 3466 ellen backend-tokennel. SSE-ébresztés is KÉSZ: a runner a `/api/mailbox/:terminal/subscribe` streamre kötve ~90 ms alatt ébred (poll marad biztonsági hálónak; az SSE-esemény csak ébreszt, a launch-döntés a pollé). Következő: Tailscale/VPS (Gábor kell hozzá) vagy runner-regisztráció+heartbeat. Gábor 2026-07-16-i iránya: EGY központi szerver minden szigetnek, sziget-saját tudással + funkció-szkópolt tool-nézetekkel (backlogban), agent-management lokálisan (= runner).

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
