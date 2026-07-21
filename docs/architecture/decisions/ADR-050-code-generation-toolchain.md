# ADR-050: Kódgenerálási eszközlánc és Phase 1 MCP toolok

- **Státusz:** accepted (részlegesen rekonstruált — a generátor-szkriptek nem részei a repónak)
- **Dátum:** eredeti dátum ismeretlen (Phase 1 MCP toolok: 2026-07-07, MSG-BACKEND-173); rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (eredeti ADR az előd-repóban)
- **Rekonstruált:** igen — kód, MCP-tool-regisztráció és a Phase 1 státuszdokumentum alapján

## Kontextus

Ismétlődő kódírási feladatokra (API-kliens generálás, minta-scaffold, frontend-
ellenőrzés) nem LLM-generálás, hanem determinisztikus, újrafuttatható szkript való
(QUALITY.md 5. és 8.: paraméterezhető szkript > tokenégetés). Emellett a flotta
koordinációjához hiányoztak a gépi státusz-eszközök.

## Döntés

- **Phase 4 — Codegen MCP-integráció:** a kódgenerátor-szkriptek
  (`$SPACEOS_ROOT/scripts/codegen` alatt) MCP toolokon át hívhatók:
  `codegenEngine` (API-kliens generálás kernel/orchestrator forrásból),
  `patternScaffold` (minta-alapú scaffold), `frontendVerify`.
- **ADR-050.Phase1 — Phase 1 MCP toolok** (MSG-BACKEND-173, 2026-07-07): 5 kritikus
  koordinációs tool — terminal status aggregator, dependency resolver (EPICS.yaml-ből,
  cache-elve, ciklusdetektálással, kritikus úttal), és társaik — production-ready
  implementációval.
- A cutting-domén "Quote Estimation" mintája (parametrikus kalkuláció, cache) ezen
  ADR alá tartozik a pattern-matcher szerint.

## Design intent

Az LLM ott dolgozzon, ahol ítélőképesség kell; a mechanikus generálás determinista
szkript dolga, amelyet az agent toolként hív. Az MCP-integráció célja, hogy a
generálás a flotta bármely agentje számára egységes, dokumentált felületen legyen
elérhető (ACI-elv).

## Alternatívák

Az eredeti ADR elveszett. A Phase 1 státuszdokumentum ROI-érveléséből
rekonstruálható szándék: a manuális státuszellenőrzés (15 perc/nap) és a kézi
kódírás kiváltása; az elvetett alternatíva a "mindent az LLM ír" status quo volt.

## Következmények

- A codegen-engine a `SPACEOS_ROOT` alatti szkriptkönyvtárra mutat
  (`/opt/spaceos/scripts/codegen` default) — ezek a szkriptek NEM részei a nexus-dev
  repónak, így DEV-környezetben a toolok csak a VPS-elrendezésben működnek.
  Ez a QC-007 (konfig-központosítás) és a Windows-tanulságok "/opt hardcode" témája.
- A Phase 1 toolok regisztrációja a `mcp.ts` tool-katalógusában él.

## Biztonsági hatás

A codegen `spawn`-nal futtat külső szkripteket — a paraméterek validálása kötelező.
Kifelé ható kódgenerálás emberi jóváhagyási kapu mögé való (QUALITY.md 8.).

## Kapcsolódó kód

- `knowledge-service/src/codegen/` — codegenEngine.ts, patternScaffold.ts, frontendVerify.ts
- `knowledge-service/src/mcp.ts:1882,4560` — Code Generation Tools (Phase 4);
  `mcp.ts:2233` — Phase 1 MCP Tools (ADR-050.Phase1)
- `knowledge-service/src/pipeline/domainPatternMatcher.ts:44` — cutting/Quote Estimation
- `knowledge-service/docs/MCP_TOOLS_PHASE1_STATUS.md` — Phase 1 állapotjelentés
- `knowledge-service/src/__tests__/phase1-tools-test-plan.md` — Phase 1 tesztterv

## Bizonyíték

- Kódkomment: `codegen/codegenEngine.ts:3` ("Part of ADR-050 Phase 4")
- Dokumentum: `MCP_TOOLS_PHASE1_STATUS.md` (MSG-BACKEND-173, 2026-07-07)
- git: 823db70 (Initial commit, 2026-07-14)

## Nyitott kérdések

- A Phase 1–3 tartalma (a Phase 4 előtti fázisok) nem rekonstruálható teljes
  bizonyossággal; a `PHASE1_MCP_TOOLS_REVIEW.md` eredeti architektúra-review
  elveszett (helyreállító csonkja: [PHASE1_MCP_TOOLS_REVIEW.md](PHASE1_MCP_TOOLS_REVIEW.md)).
