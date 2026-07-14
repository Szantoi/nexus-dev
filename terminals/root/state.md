# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-14 (este)

## Aktuális fókusz

Knowledge-service modernizáció VÉGREHAJTÁS — 1–3. fázis kész, 5. fázis folyamatban.

## Állapot

- ✅ 1. fázis (takarítás): halott kód törölve, dependency-k rendezve — commit `0d9cba7`
- ✅ 2. fázis (tooling): Biome + CI + zod env-config + logger (944 console.* cserélve) + smoke/hermetikus teszt-szétválasztás — commit `c14dc14`
  - Bónusz bugfix: duplikált `get_workflow` MCP tool (az új workflow-manager tool elérhetetlen volt) → `get_workflow_details`
- ✅ 3. fázis (mcp.ts dekompozíció) ELINDÍTVA: ToolRegistry-varrat él, 3 csoport (~16 tool) kiszervezve, minta + README kész — commit `7730c93`. Maradék ~85 tool migrálása inkrementálisan folytatható (recept: `src/interfaces/mcp/tools/README.md`).
- ✅ Runtime-verifikáció: szerver bootol Windowson a 3466-on, MCP tools/list 121 tool duplikáció nélkül, registry-toolok élesben hívhatók — commit `e349f97`
- ⏳ 5. fázis (teszt-megerősítés): háttér-agent javítja a 98 környezetfüggő teszt-bukást (15 fájl)
- ⏸️ 4. fázis (DDD-döntés): Gábor döntésére vár — bekötni vagy törölni a halott domain/ réteget

## Környezet

- DEV: port 3466 — MŰKÖDIK Windowson (`node scripts/dev-start.mjs`)
- ChromaDB nem fut a gépen → in-memory fallback (indexelés OK, perzisztencia nincs)
- Ismert szemét: `C:\opt\spaceos` (5 MB régi teszt-runtime-adat korábbi futásokból) — törölhető, ha senkinek nem kell
- PowerShell-sajátosság: tsc/npx kimenetét fájlba kell irányítani (pipeline-crash), a Bash tool megbízhatóbb

## Nyitott kérdések

- DDD-scaffolding sorsa (4. fázis) — Gábor dönt
- CI tesztlépése akkor lesz zöld, ha az 5. fázis (teszt-agent) végez
