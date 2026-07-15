# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-15

## Aktuális fókusz

Knowledge-service modernizáció — 1., 2., 3. (indítás) és 5. fázis KÉSZ. Következő: 4. fázis (DDD-döntés, Gábor) + mcp.ts maradék toolok migrálása.

## Állapot

- ✅ 1. fázis (takarítás): halott kód törölve, dependency-k rendezve — commit `0d9cba7`
- ✅ 2. fázis (tooling): Biome + CI + zod env-config + logger (944 console.* cserélve) + smoke/hermetikus teszt-szétválasztás — commit `c14dc14`
  - Bónusz bugfix: duplikált `get_workflow` MCP tool (az új workflow-manager tool elérhetetlen volt) → `get_workflow_details`
- ✅ 3. fázis (mcp.ts dekompozíció) ELINDÍTVA: ToolRegistry-varrat él, 3 csoport (~16 tool) kiszervezve, minta + README kész — commit `7730c93`. Maradék ~85 tool migrálása inkrementálisan folytatható (recept: `src/interfaces/mcp/tools/README.md`).
- ✅ Runtime-verifikáció: szerver bootol Windowson a 3466-on, MCP tools/list 121 tool duplikáció nélkül, registry-toolok élesben hívhatók — commit `e349f97`
- ✅ 5. fázis (teszt-megerősítés) KÉSZ: 98 → 0 tesztbukás. Hermetikus suite: 49 fájl / 888 teszt zöld. A háttér-agent részmunkáját (EPICS_PATH/SPACEOS_ROOT env-varratok, temp-fixture-ök) verifikáltam és befejeztem: graphRoutes fixture séma-kiegészítés, mcp-tools pattern-elvárások igazítása a stub-viselkedéshez, epic-router terminál-kontextus reset a concurrent teszthez, hookTimeout 30s (terhelés alatti import-lassulás).
- ⏸️ 4. fázis (DDD-döntés): Gábor döntésére vár — bekötni vagy törölni a halott domain/ réteget
- ✅ Minden commit pusholva GitHubra (origin/main)

## Környezet

- DEV: port 3466 — MŰKÖDIK Windowson (`node scripts/dev-start.mjs`)
- ChromaDB nem fut a gépen → in-memory fallback (indexelés OK, perzisztencia nincs)
- Ismert szemét: `C:\opt\spaceos` (5 MB régi teszt-runtime-adat korábbi futásokból) — törölhető, ha senkinek nem kell
- PowerShell-sajátosság: tsc/npx kimenetét fájlba kell irányítani (pipeline-crash), a Bash tool megbízhatóbb

## Nyitott kérdések

- DDD-scaffolding sorsa (4. fázis) — Gábor dönt
- Megjegyzés: a Claude havi költségkeret elfogyott a háttér-agenteknél — a további munkát inline érdemes végezni
