# PHASE1_MCP_TOOLS_REVIEW — helyreállító csonk

- **Státusz:** elveszett eredeti; ez a fájl helyreállító csonk (2026-07-18)

Az eredeti "Phase 1 MCP Tools" architektúra-review dokumentum az előd-repóban élt,
és nem került át a nexus-dev workspace-be (823db70 Initial commit, 2026-07-14).
Erre a fájlra hivatkozik:

- `knowledge-service/src/__tests__/phase1-tools-test-plan.md` (References szekció)

## Ami a tartalomból rekonstruálható

A Phase 1 MCP toolok (MSG-BACKEND-173, 2026-07-07) implementációs állapota és
tool-készlete fennmaradt itt:

- `knowledge-service/docs/MCP_TOOLS_PHASE1_STATUS.md` — az 5 kritikus tool
  (terminal status aggregator, dependency resolver, stb.) leírása, API-kkal és
  ROI-érveléssel
- `knowledge-service/src/__tests__/phase1-tools-test-plan.md` — tesztterv és
  elfogadási kritériumok

A kapcsolódó architektúra-döntés: [ADR-050](ADR-050-code-generation-toolchain.md)
(ADR-050.Phase1 jelöléssel hivatkozza a `mcp.ts:2233`).

## Teendő

Ha az eredeti review előkerül az előd-repóból, ide importálandó és ez a csonk
lecserélendő az eredetire.
