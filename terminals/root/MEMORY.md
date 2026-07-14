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

**Státusz:** Gábor jóváhagyta ("Csináld meg a rendszer fejlesztését"), végrehajtás 2026-07-14-én elindult.

---

## 2026-07-14 (este) — Modernizáció végrehajtás, 1–3. fázis

### Elkészült (commitok: 0d9cba7, c14dc14, 1c4e8e6, 7730c93, e349f97)

- **1. fázis:** ~4000 sor halott kód törölve; sharp/@types/js-yaml/ts-node ki, engines be.
- **2. fázis:** Biome (lint-gate, 0 error), CI workflow, `config/env.ts` (zod, fail-fast), `core/logger.ts` (LOG_LEVEL/LOG_FORMAT, console-kompatibilis), 944 console.* → logger codemoddal (104 fájl; kódgeneráló template-ekben szándékosan console maradt), hermetikus/smoke teszt-szétválasztás, cross-platform `scripts/dev-start.mjs`.
- **3. fázis (elindítva):** ToolRegistry-varrat az mcp.ts-ben (registry először, legacy switch fallback), 3 csoport kiszervezve (knowledge, tmb_*, workflow), 6 unit teszt, migrációs recept a `src/interfaces/mcp/tools/README.md`-ben. Maradék ~85 tool.
- **Runtime-verifikáció:** Windowson bootol a 3466-on; MCP tools/list 121 tool, duplikátum nincs; registry-toolok élesben hívva.

### Talált és javított bugok

1. **Duplikált `get_workflow` MCP tool** (Biome noDuplicateCase találat): a 2026-07-14-én hozzáadott workflow-manager tool elérhetetlen volt a legacy mögött → átnevezve `get_workflow_details`-re.
2. **CHROMA_URL-t a kód sosem olvasta** (ChromaClient host/port beégetve; .env-ben ráadásul CHROMA_HOST néven szerepelt) → env.ts + vectorStore javítva.
3. **workflowDb.ts beégetett `/opt/nexus/...` útja** import-időben `C:\opt\...` szemetet írt Windowson → config/paths + WORKFLOW_DB env.
4. **indexer.ts saját KNOWLEDGE_BASE_PATH duplikátuma** más defaulttal, mint a config/paths → egyesítve.
5. **paths.ts defaultok** a prod (`/opt/spaceos/spaceos-nexus`) beágyazást feltételezték, nem a repo-layoutot → `../` javítás.

### Tanulságok (Windows dev gép)

- PowerShellben a tsc/npx kimenetét fájlba kell irányítani (pipeline OOM-crash / npx.ps1 NullReference); a Git Bash tool megbízhatóbb.
- PowerShell `Set-Content -Encoding utf8` BOM-ot ír — fájlmódosításhoz Node-szkript kell.
- `C:\opt\spaceos` (5 MB) régi teszt-runtime-adat — még törlendő, ha Gábor jóváhagyja.

### Nyitott

- 5. fázis: 98 környezetfüggő tesztbukás javítása (agent dolgozik rajta).
- 4. fázis DDD-döntés: Gábor.
