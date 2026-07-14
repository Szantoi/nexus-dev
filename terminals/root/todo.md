# todo.md — ROOT terminál teendők

> A feladatok nyilvántartása. Új feladat ide kerül; kész feladat pipát kap és dátumot.
> Állapot-kontextus: state.md, hosszú távú tanulságok: MEMORY.md.

**Utolsó frissítés:** 2026-07-14

## Aktív

- [ ] Modernizálási terv jóváhagyatása Gáborral (fázissorrend + DDD-döntés)

## Backlog — Knowledge-service modernizáció (audit: 2026-07-14, részletek: MEMORY.md)

### 1. fázis — Takarítás
- [ ] Halott kód törlése: `server.legacy.ts`, `embeddings-old.ts`, `coldStart.prototype.ts`, `test-embedding.ts`, `pipeline/phaseCoordinator.ts.broken.bak`
- [ ] js-yaml v5 ↔ @types/js-yaml v4 eltérés feloldása
- [ ] ts-node VAGY tsx — az egyik kivezetése (tsx jelenleg használatlan)
- [ ] `@xenova/transformers` (deprecated) + `sharp` kivezetése, ha az embedding tényleg csak ChromaDB-oldali
- [ ] `engines` mező a package.json-ba

### 2. fázis — Tooling-alap
- [ ] Biome bevezetése (lint + format)
- [ ] Minimál CI: `tsc --noEmit` + hermetikus vitest suite
- [ ] Zod-validált központi config-modul (process.env egyetlen belépési ponton, fail-fast)
- [ ] Pino strukturált logger a 944 `console.*` helyett
- [ ] Bash scriptek → cross-platform Node scriptek (dev-start, deploy)

### 3. fázis — mcp.ts dekompozíció
- [ ] ~102 tool kiszervezése a meglévő `base-tool.ts` absztrakcióra, tool-csoportonként, inkrementálisan
- [ ] Unit-tesztek az újonnan kiszervezett toolokra

### 4. fázis — Architektúra-döntés
- [ ] DDD-scaffolding: bekötni VAGY törölni (Gábor döntése)
- [ ] `src/routes/` maradék 2 fájl átmozgatása `interfaces/http/routes/` alá
- [ ] `pipeline/` alfolderezés (watchers/, planning/, epics/, coordination/, integrations/)
- [ ] Két `memoryStore.ts` (root vs pipeline) egyeztetése/átnevezése

### 5. fázis — Teszt-megerősítés
- [ ] vitest.config létrehozása
- [ ] Élő-szerveres 8 teszt szétválasztása külön smoke-suite-ba (CI-ból ki)

## Kész

- [x] 2026-07-14 — Knowledge-service teljes audit (architektúra, tooling, tesztek)
