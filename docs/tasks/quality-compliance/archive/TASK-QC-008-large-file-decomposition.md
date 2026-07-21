---
id: TASK-QC-008
title: MCP legacy fallback eltávolítása és nagy fájlok felbontása
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M3
epic: QC-MAINTAINABILITY
status: done
priority: high
depends_on: [TASK-QC-002, TASK-QC-005]
parallel_with: [TASK-QC-004, TASK-QC-006]
owner_role: backend
created: 2026-07-18
source: QUALITY.md section 3
---

# MCP legacy fallback eltávolítása és nagy fájlok felbontása

## Cél

Az MCP transport csak protokoll- és auth-felelősséget viseljen; a tool-definíciók és handlerek moduláris registryből érkezzenek. A repositoryban automatizált méretkorlát akadályozza meg új god-file kialakulását.

## Jelenlegi bizonyíték

- `knowledge-service/src/mcp.ts` 5561 sor.
- A registry 100 toolt definiál; a legacy `TOOLS` tömb 99 toolt, amelyek mind megtalálhatók a registryben. A registryben ezen felül a `search_knowledge` található.
- `handleToolCall` előbb a registryt használja, majd egy több ezer soros, gyakorlatilag duplikált switch fallbacket.
- A `tools/list` összefűzi a legacy és registry listát, ezért duplikált definíciók kockázata áll fenn.
- További nagy fájlok: `sessionStarter.ts` 1430, `messageRegistry.ts` 1118, `pipeline/reviewer.ts` 1053, `pipeline/terminalReviewer.ts` 1017 sor.

## Scope

### A. MCP biztonságos karcsúsítása

1. Írj contract tesztet, amely rögzíti a toolnevek egyediségét, számát, schema alakját és a kiválasztott kritikus handlerek viselkedését.
2. Igazold programból, hogy minden legacy toolnak van registry handlere.
3. Távolítsd el a legacy `TOOLS` tömböt, switch fallbacket és a kizárólag ezekhez szükséges importokat.
4. A `tools/list`, `tools/call` és info endpoint kizárólag a registryt használja.
5. Ismeretlen tool szabványos, tesztelt MCP hibát adjon.
6. A permission filter és az island/terminal context viselkedése maradjon változatlan.

### B. Méretkorlát és következő szeletek

1. Adj scriptet, amely az új vagy módosított production TypeScript-fájlokra 800 soros alapkorlátot érvényesít.
2. A script engedjen ideiglenes, indokolt allowlistet lejárati dátummal és felelőssel.
3. Bontsd fel a `sessionStarter.ts`, `messageRegistry.ts`, `reviewer.ts` és `terminalReviewer.ts` fájlokat felelősség szerint, vagy készíts külön, ütemezett follow-up taskot mindegyikhez, ha ez egy PR-ben túl kockázatos.
4. Egy kivonatolt modul se legyen körkörös import oka.

## Nem cél

- Toolnevek vagy publikus MCP schema önkényes megváltoztatása.
- Új MCP feature hozzáadása.
- Mechanikus, felelősség nélküli soralapú darabolás.

## Elfogadási feltételek

- [x] Az `mcp.ts` legfeljebb 800 soros. (417 sor)
- [x] Nincs legacy tool array vagy switch fallback.
- [x] Minden toolnév egyedi, és minden listázott toolnak van handlerje.
- [x] A toolkészlet és kritikus schema-k contract teszttel védettek.
- [x] Permission, auth és multi-island regressziós tesztek zöldek.
- [x] A méretellenőrző CI-ben fut.
- [x] Minden 800 sor feletti maradványhoz létezik indokolt, dátumozott follow-up task. (QC-008A–E)

## Kötelező ellenőrzés

```bash
cd knowledge-service
npm run typecheck
npm test
npm run test:coverage
```

Futtasd a méretellenőrző scriptet, valamint egy MCP `initialize`, `tools/list`, engedélyezett `tools/call`, tiltott `tools/call` és ismeretlen tool integrációs tesztet.

## Átadandó bizonyíték

- Sor- és importszám előtte/utána.
- Toolnév/schema contract diff; publikus eltérés esetén indoklás és jóváhagyás.
- Teljes tesztkimenet.

## Kockázat és rollback

Az MCP publikus szerződés. A legacy törlés csak a contract tesztek elkészülte után történhet; eltérés esetén a teljes refaktort egyben kell visszaállítani.

## Implementáció (2026-07-18)

### A. MCP karcsúsítás

**Sor- és importszám előtte/utána:**

| Mérőszám | Előtte | Utána |
|---|---|---|
| `src/mcp.ts` sorok | 5561 | **417** |
| `src/mcp.ts` top-level importok | 39 | **9** |
| Törölt sorok (git diff) | — | −5277 (mcp.ts: −5392/+248) |

Az új `mcp.ts` kizárólag transport-felelősségű: JSON-RPC (initialize,
tools/list, tools/call, notifications), auth (tokenAuth), tool-permission
(config/tool-permissions.yaml, 30 mp-es auto-reload — most már `unref()`-elt
timerrel), `authorizeMailboxRest`, valamint egy `dispatchToolCall` wrapper,
amely a registry handler kivételét a korábbi `{error: msg}` JSON-alakra képezi.
A `tools/list`, `tools/call` és a GET info endpoint kizárólag a registryből
(`interfaces/mcp/tools`) szolgál ki.

**Programmatikus legacy↔registry contract-diff (törlés ELŐTT, tsx script):**

- legacy `TOOLS` tömb: **105 elem**, registry: **121 tool**; duplikátum egyikben sincs.
- **Mind a 105 legacy toolnév létezik a registryben** — a registryből semmi nem hiányzik.
- Registry-only 16 tool (eddig is csak a registry szolgálta ki őket):
  `search_knowledge`, `tmb_*` (6 db), workflow-csoport (9 db).
- 20 schema- és 8 leírás-eltérés a legacy és a registry definíciók közt
  (pl. `get_skill_metadata`/`delete_skill`: `skill_name` → `name`;
  több toolnál a beágyazott `items` objektum-részletesség egyszerűsödött).
  **Indoklás, miért nem publikus szerződés-törés:** a dispatch az
  EPIC-KS-MCP-SPLIT óta registry-first, tehát ezeknél a tooloknál MÁR EDDIG IS
  a registry handler futott (a legacy switch-ágak halott kódok voltak), és a
  `tools/list` a registry-definíciót is kiszolgálta (duplikáltan). A törléssel
  a stale legacy másolat tűnik el; az effektív kontraktus (ténylegesen futó
  handler + registry-definíció) változatlan. Mellékhatás: a `tools/list` eddig
  105 nevet DUPLIKÁLTAN adott vissza (legacy+registry összefűzés), mostantól
  121 egyedi definíciót ad.

**Contract teszt:** `src/__tests__/integration/mcpContract.integration.test.ts`
(19 teszt, supertest a valódi routeren): pinnelt 121-es toolnév-lista,
egyediség, schema-alak minden definícióra, kritikus schema-pinek
(`search_knowledge` teljes schema; `get_identity`, `list_inbox`, `create_task`,
`send_message`, `set_focus_queue`, `fetch_task` property+required),
initialize/tools/list/tools/call viselkedés, permission-szűrt lista és hívás
(backend ↛ `set_focus_queue`, −32003), ismeretlen tool → **szabványos MCP hiba**
(HTTP 400, JSON-RPC `-32602`, `Unknown tool: <name>` — korábban csendes 200 +
`{error}` content volt), handler-hiba `{error}` alakjának megőrzése,
auth-elutasítások (401/−32001, 403/−32002), GET info endpoint.

### B. Méretkapu

- `scripts/check-file-size.mjs` (repo gyökér, Node-only): production TS fájlok
  (src/**, kivéve __tests__/*.test.ts/*.d.ts) max **800 sor**; e felett csak
  lejáratos+felelős+taskos allowlist-tétellel (`knowledge-service/.file-size-allowlist.json`).
  Lejárt vagy hiányzó tétel → exit 1 (negatív ágak kézzel igazolva). Stale
  tételekre takarítási jelzést ad.
- Package script: `npm run check:size`; CI-lépés a `.github/workflows/ci.yml`-ben
  a lint ratchet után, lokális repro-kommenttel (QC-005 minta).
- **Allowlist-tartalom (mind: owner=backend, lejárat=2026-10-18):**
  `src/sessionStarter.ts` (1431 → TASK-QC-008A), `src/messageRegistry.ts`
  (1118 → QC-008B), `src/pipeline/reviewer.ts` (1053 → QC-008C),
  `src/pipeline/terminalReviewer.ts` (1017 → QC-008D), `src/mailbox.ts` (943),
  `src/task-message-box/store.ts` (866), `src/pipeline/telegramBot.ts` (835),
  `src/interfaces/http/routes/epic-router.routes.ts` (821) → QC-008E.
- Follow-up taskok (ready, indoklással, javasolt vágási felületekkel):
  `TASK-QC-008A-sessionstarter-decomposition.md`,
  `TASK-QC-008B-messageregistry-decomposition.md`,
  `TASK-QC-008C-pipeline-reviewer-decomposition.md`,
  `TASK-QC-008D-terminalreviewer-decomposition.md`,
  `TASK-QC-008E-remaining-large-files.md`.
- Körkörös import nem keletkezett (nem jött létre új modul; a typecheck és a
  teljes suite zöld).

### Ellenőrzések (2026-07-18)

- `npm run typecheck` — zöld.
- `npm test` — **60 fájl, 993 passed / 1 skipped** (korábban 59 fájl, 974 passed;
  +19 contract teszt).
- `npm run test:coverage` — kapu zöld; **javult**: statements 24,54%, branches
  19,86%, functions 24,41%, lines 24,74% (baseline 23,36/19,03/23,29/23,51;
  küszöb 23/18/23/23). A javulás oka: a halott legacy kód törlése csökkentette
  a nevezőt, és a contract tesztek most a valódi routert fedik.
- `npm run lint:ratchet` — zöld, a warningszám 801 → **786** (−15; a baseline
  leszorítása külön lépésként javasolt: `node scripts/lint-ratchet.mjs --update`).
- `npm run check:size` — zöld (216 fájl vizsgálva, 8 allowlistelt kivétel).
- MCP integráció: initialize, tools/list (nincs duplikátum), engedélyezett
  tools/call (`list_terminals`), tiltott tools/call (backend →
  `set_focus_queue`, 403/−32003), ismeretlen tool (400/−32602) — mind a
  contract tesztben, zöld.
- Frissítve: `src/interfaces/mcp/tools/README.md` (a legacy varrat leírása
  helyett a registry-only működés + contract-teszt szabály).

