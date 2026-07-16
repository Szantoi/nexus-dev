# todo.md — ROOT terminál teendők

> A feladatok nyilvántartása. Új feladat ide kerül; kész feladat pipát kap és dátumot.
> Állapot-kontextus: state.md, hosszú távú tanulságok: MEMORY.md.

**Utolsó frissítés:** 2026-07-16

## Aktív

_(nincs aktív feladat — a backlogból választható a következő)_

## Backlog

### Opcionális cleanup (nincs sürgősség)
- [ ] mcp.ts legacy TOOLS tömb + switch törlése (fallback eltávolítása)
- [ ] identity.ts/terminalConfig `/opt/spaceos` fallback-útvonalak rendezése Windowson (get_identity ma /opt/spaceos-t ad vissza)

### 4. fázis — Architektúra
- [ ] `src/routes/` maradék 2 fájl átmozgatása `interfaces/http/routes/` alá
- [ ] `pipeline/` alfolderezés (watchers/, planning/, epics/, coordination/, integrations/)
- [ ] Két `memoryStore.ts` (root vs pipeline) egyeztetése/átnevezése
- [ ] `DomainError`-hierarchia kiterjesztése (72 nyers `throw new Error` cseréje)

### VPS-deploy + lokális ébresztés (terv 2026-07-15, Gábor igénye: lokális wake + erős biztonság)
- [ ] Tailscale a VPS és a lokális gépek közé; knowledge-service csak tailnet-interfészen figyeljen (publikus port zárva)
- [ ] Epic-router külön token-rendszerének (SHA256-derivált, TERMINAL_TOKEN_SECRET) egyesítése a tokenAuth-tal
- [ ] Runner-regisztráció + heartbeat: terminál→gép hozzárendelés a szerveren; offline gép feladata a sorban várakozik, flotta-státusz mutatja az elérhetőséget
- [ ] `search_knowledge` domain-szűrő paraméter (projekt-szkópolt RAG egy kollekcióban, ChromaDB `where`)

### Egy szerver — több sziget (Gábor 2026-07-16: központi + sziget-saját tudás, ne fusson szigetenként szerver)
- [ ] Sziget-szkópolt tudás-kiszolgálás: `search_knowledge`/indexer island+domain szeparációval (chunk-metaadat már van: `domain`; kell: island dimenzió + szűrés identitás alapján)
- [ ] Funkció-szkópolt MCP tool-nézetek: a tool-permission mátrix (terminálonkénti szűrés, ma 262 vs 226) kiegészítése funkció-profilokkal (pl. knowledge-only, mailbox-only endpoint-nézet), hogy egy agentnek ne 200+ toolból kelljen válogatnia — monolit marad, csak a felület szeletelődik
- [ ] Szerver-székhely melletti mailbox-útvonal quirk: POST inbox a `Development\terminals\` alá írt a repo helyett (getMailboxPath/SPACEOS_ROOT eltérés) — kivizsgálni

### Kisebb tételek
- [ ] 159 `any` fokozatos csökkentése (Biome noExplicitAny warn → error ratchet)
- [ ] Biome warn-ra vett szabályok ratchetelése (noAssignInExpressions, noControlCharactersInRegex, useIterableCallbackReturn)
- [ ] deploy-to-prod.sh cross-platform kiváltása (Node), prod-layout env-fájllal
- [ ] README.md frissítése (elavult: Voyage/Gemini setup, lint-szekció, portok)

## Kész

- [x] 2026-07-14 — Knowledge-service teljes audit (architektúra, tooling, tesztek)
- [x] 2026-07-14 — Modernizálási terv jóváhagyva (Gábor: "Csináld meg")
- [x] 2026-07-14 — 1. fázis: halott kód (~4000 sor) törölve, dependency-k rendezve (`0d9cba7`)
- [x] 2026-07-14 — 2. fázis: Biome + CI + zod env-config + logger + teszt-szétválasztás (`c14dc14`)
- [x] 2026-07-14 — BUGFIX: duplikált `get_workflow` MCP tool → `get_workflow_details` (elérhetetlen tool)
- [x] 2026-07-14 — 3. fázis indítás: ToolRegistry-varrat + 3 csoport kiszervezve + migrációs recept (`7730c93`)
- [x] 2026-07-14 — Runtime-verifikáció Windowson: boot 3466, health OK, MCP 121 tool, registry-hívások élesben (`e349f97`)
- [x] 2026-07-14 — workflowDb + indexer hardcodolt útvonalak → config/paths (C:\opt szemét-írás megszűnt)
- [x] 2026-07-15 — 5. fázis: teszt-megerősítés KÉSZ — 98 → 0 bukás, hermetikus suite 49 fájl / 888 teszt zöld
- [x] 2026-07-15 — Minden commit pusholva GitHubra (origin/main)
- [x] 2026-07-15 — 3. fázis TELJES: 103 tool migrálva 14 modulba (ToolRegistry pattern), 889 teszt zöld
- [x] 2026-07-15 — 4. fázis DDD-döntés LEZÁRVA: scaffolding törölve (chat-root review, "A opció", `046b8bb`)
- [x] 2026-07-15 — `C:\opt` maradványok (spaceos + nexus-dev) törölve Gábor jóváhagyásával
- [x] 2026-07-15 — Token-auth réteg: auth/tokenAuth.ts modul + AUTH_MODE fail-closed + globális /api kapu + agents.yaml gitignore/example, 19 új teszt, élőben verifikálva (`36a4dad`)
- [x] 2026-07-16 — Lokális runner MVP: src/runner/ (poll → zárt parancskészletű `claude -p` session-indítás, Windows-first, tmux nélkül), 25 új teszt, élőben verifikálva a 3466 ellen (dedup, model-whitelist, backend-token)
- [x] 2026-07-16 — Runner SSE-ébresztés: sseListener + pollLoop.wake(), élőben ~90 ms wake-latencia (60 mp-es poll mellett), 9 új teszt; az esemény csak ébreszt, a launch-döntés a pollnál marad
