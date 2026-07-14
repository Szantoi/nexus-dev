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

**Státusz:** javaslat leadva Gábornak 2026-07-14-én, döntésre vár.
