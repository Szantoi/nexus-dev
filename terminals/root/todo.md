# todo.md — ROOT terminál teendők

> A feladatok nyilvántartása. Új feladat ide kerül; kész feladat pipát kap és dátumot.
> Állapot-kontextus: state.md, hosszú távú tanulságok: MEMORY.md.

**Utolsó frissítés:** 2026-07-16

## Aktív

_(Jelenleg nincs aktív feladat — a modernizáció teljes)_

## Backlog

### Opcionális cleanup (nincs sürgősség)
- [ ] mcp.ts legacy TOOLS tömb + switch törlése (fallback eltávolítása)
- [ ] auth-réteg külön modulba szervezése

### Architektúra (future)
- [ ] `src/routes/` maradék 2 fájl átmozgatása `interfaces/http/routes/` alá
- [ ] `pipeline/` alfolderezés (watchers/, planning/, epics/, coordination/, integrations/)
- [ ] Két `memoryStore.ts` (root vs pipeline) egyeztetése/átnevezése
- [ ] `DomainError`-hierarchia kiterjesztése (72 nyers `throw new Error` cseréje)

### Kisebb tételek
- [ ] 159 `any` fokozatos csökkentése (Biome noExplicitAny warn → error ratchet)
- [ ] Biome warn-ra vett szabályok ratchetelése (noAssignInExpressions, noControlCharactersInRegex, useIterableCallbackReturn)
- [ ] deploy-to-prod.sh cross-platform kiváltása (Node), prod-layout env-fájllal

## Kész

- [x] 2026-07-16 — **TMUX Enter variants**: 5 különböző Enter típus beragadt promptok ellen (`d22edbd`)
- [x] 2026-07-16 — **Dokumentáció frissítve**: README.md + knowledge-service/README.md (`57111b3`)
- [x] 2026-07-15 — 4. fázis DDD-döntés: scaffolding TÖRÖLVE (~2300 LOC) (`046b8bb`)
- [x] 2026-07-15 — 5. fázis: teszt-megerősítés KÉSZ — 98 → 0 bukás, 889 teszt zöld
- [x] 2026-07-15 — 3. fázis TELJES: 103 tool migrálva 14 modulba (ToolRegistry pattern) (`72b953c`)
- [x] 2026-07-15 — Minden commit pusholva GitHubra (origin/main)
- [x] 2026-07-14 — Knowledge-service teljes audit (architektúra, tooling, tesztek)
- [x] 2026-07-14 — Modernizálási terv jóváhagyva (Gábor: "Csináld meg")
- [x] 2026-07-14 — 1. fázis: halott kód (~4000 sor) törölve, dependency-k rendezve (`0d9cba7`)
- [x] 2026-07-14 — 2. fázis: Biome + CI + zod env-config + logger + teszt-szétválasztás (`c14dc14`)
- [x] 2026-07-14 — BUGFIX: duplikált `get_workflow` MCP tool → `get_workflow_details`
- [x] 2026-07-14 — Runtime-verifikáció: boot 3466, health OK, MCP 121 tool (`e349f97`)
- [x] 2026-07-14 — workflowDb + indexer hardcodolt útvonalak → config/paths
