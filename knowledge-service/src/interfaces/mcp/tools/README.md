# MCP tools — registry-based decomposition (EPIC-KS-MCP-SPLIT)

`mcp.ts` (~5,600 sor) történelmileg egyben tartalmazza a ~100 MCP tool
definícióját ÉS implementációját egy óriási `switch`-ben. A cél: minden tool
ebbe a mappába kerül át, csoportonként egy modulba, a `ToolRegistry`-n
keresztül regisztrálva.

## Hogyan működik a varrat

- `mcp.ts` induláskor meghívja a `registerAllTools()`-t (ebből a mappából).
- `tools/list`: a legacy `TOOLS` tömb + `toolRegistry.getDefinitions()` uniója.
- `tools/call` → `handleToolCall()`: ha a registry ismeri a tool nevét, a
  registry handlere fut; különben a legacy switch. A hibakezelés közös
  (a `handleToolCall` catch-e adja a `{error}` JSON-t).

## Új tool hozzáadása

Írj egy `register<Group>Tools()` függvényt (minta: `knowledge.tools.ts`),
és hívd meg az `index.ts` `registerAllTools()`-jából. A definíció és az
implementáció egy helyen él; az eredményt a `success()`/`error()` helperrel
add vissza.

## Legacy tool migrálása a switch-ből

1. Hozd létre (vagy bővítsd) a csoport modulját: `<group>.tools.ts`.
2. Másold át a definíciót a `TOOLS` tömbből és az implementációt a
   `handleToolCall` megfelelő `case`-éből.
3. Töröld a definíciót a `TOOLS`-ból és a `case`-t a switch-ből.
4. Írj unit tesztet: `src/__tests__/unit/mcpToolRegistry.test.ts` mintájára
   (a registry-n keresztül hívd a toolt, mock-old a mögöttes modult).
5. `npm run typecheck && npm run lint && npm test` — mind zöld maradjon.

Ha egy csoportnak már van saját definíció+handler modulja (mint a
workflowManager vagy a task-message-box), elég egy vékony adapter
(minta: `workflow.tools.ts`).

## Konvenciók

- A `callerTerminal` a `ToolContext.terminal`-ban érkezik.
- A tool-jogosultságokat továbbra is a `config/tool-permissions.yaml`
  vezérli (a `canUseTool` check a JSON-RPC rétegben fut, tool-függetlenül).
- Egy fájl = egy csoport; ha egy csoport 300+ sor fölé nő, bontsd tovább.
