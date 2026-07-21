# src/interfaces/mcp — MCP tool-registry réteg

## Felelősség

Az MCP-n kiszolgált tool-készlet **egyetlen forrása**: definíciók +
implementációk csoportonként egy modulban, a `ToolRegistry`-n keresztül
regisztrálva. A transport (JSON-RPC, auth, permission) NEM itt, hanem a
[`src/mcp.ts`](../../mcp.ts)-ben él — az kizárólag ebből a registryből
szolgálja ki a `tools/list`-et és `tools/call`-t (TASK-QC-008 óta legacy
fallback nélkül).

## Publikus belépési pontok

- [`tools/index.ts`](tools/index.ts) — `registerAllTools()` + `toolRegistry`;
  ezt hívja az `mcp.ts` betöltéskor.
- [`tools/base-tool.ts`](tools/base-tool.ts) — `ToolRegistry`, `ToolContext`
  (`terminal`, `island`), `success()`/`error()` helperek.
- Tool-csoportok: `knowledge`, `mailbox`, `identity`, `session`, `skills`,
  `goal`, `project`, `codegen`, `focus-queue`, `task-message-box`, `telegram`,
  `terminal-status`, `worker`, `workflow` (`*.tools.ts`).

A részletes szabályok (új tool hozzáadása, konvenciók, contract-teszt):
**[tools/README.md](tools/README.md)** — ott, nem itt duplikálva.

## Függőségi irány

tool-modul → feature-modul (vectorStore, mailbox, task-message-box, pipeline
stb.) → config. A tool-réteg nem importál a transportból (`mcp.ts`), és
fordítva a transport csak a registry API-t látja.

## Konfiguráció

- Tool-jogosultságok: `config/tool-permissions.yaml` (a permission-check a
  JSON-RPC rétegben fut, 30 mp-es auto-reloaddal).
- A hívó identitása/szigete a `ToolContext`-ben érkezik (az auth-rétegtől) —
  islandet argumentumból átvenni tilos.

## Logok

Tool-hívási hibák a transporton keresztül `{error: msg}` content-alakban
térnek vissza; szerver-oldali részletek a `core/logger`-en.

## Tesztek

- Kontraktus (pinnelt toolnév-lista + schema-alak + auth/permission ágak):
  `npx vitest run src/__tests__/integration/mcpContract.integration.test.ts`
- Registry-egység: `src/__tests__/unit/mcpToolRegistry.test.ts`;
  transport: `unit/mcpTransport.test.ts`; MCP-eszközök integrációban:
  `integration/mcp-tools.integration.test.ts`.

## Ismert korlátok

- Tool átnevezése/törlése publikus szerződés-változás: csak a contract-teszt
  tudatos frissítésével, indoklással.
- Egy tool-csoport-fájl 300+ sor felett bontandó; a 800 soros méretkapu
  (`npm run check:size`) CI-ben is fut.
