# MCP tools — registry-based decomposition (EPIC-KS-MCP-SPLIT → TASK-QC-008)

Történelmileg az `mcp.ts` (~5,600 sor) egyben tartalmazta a tool-definíciókat
ÉS az implementációt egy óriási `switch`-ben. A migráció a TASK-QC-008-cal
lezárult: **minden tool ebben a mappában él**, csoportonként egy modulban, a
`ToolRegistry`-n keresztül regisztrálva. Az `mcp.ts` már csak transport
(JSON-RPC + auth + permission), legacy `TOOLS` tömb és switch fallback nincs.

## Hogyan működik

- `mcp.ts` betöltéskor meghívja a `registerAllTools()`-t (ebből a mappából).
- `tools/list`: kizárólag `toolRegistry.getDefinitions()`, a hívó terminál
  jogosultságaira szűrve.
- `tools/call`: permission check → ismeretlen tool esetén szabványos JSON-RPC
  hiba (`-32602`, `Unknown tool: <name>`) → registry handler. A handler-kivételt
  az `mcp.ts` `dispatchToolCall`-ja alakítja `{error: msg}` JSON-tartalommá
  (a régi switch-korszakkal azonos alak).
- A publikus szerződést (toolnevek + schema-k) a
  `src/__tests__/integration/mcpContract.integration.test.ts` rögzíti — toolt
  hozzáadni/átnevezni csak a contract teszt tudatos frissítésével lehet.

## Új tool hozzáadása

Írj egy `register<Group>Tools()` függvényt (minta: `knowledge.tools.ts`),
és hívd meg az `index.ts` `registerAllTools()`-jából. A definíció és az
implementáció egy helyen él; az eredményt a `success()`/`error()` helperrel
add vissza. Frissítsd a contract teszt pinnelt névlistáját, és írj unit
tesztet a `src/__tests__/unit/mcpToolRegistry.test.ts` mintájára.

## Konvenciók

- A `callerTerminal` a `ToolContext.terminal`-ban, a tudás-sziget a
  `ToolContext.island`-ben érkezik (island-et SOHA nem az args-ból veszünk).
- A tool-jogosultságokat továbbra is a `config/tool-permissions.yaml`
  vezérli (a `canUseTool` check a JSON-RPC rétegben fut, tool-függetlenül).
- Egy fájl = egy csoport; ha egy csoport 300+ sor fölé nő, bontsd tovább.
- A production fájlokra 800 soros méretkapu fut CI-ben
  (`npm run check:size`, allowlist: `knowledge-service/.file-size-allowlist.json`).
