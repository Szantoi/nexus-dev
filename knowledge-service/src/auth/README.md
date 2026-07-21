# src/auth — Bearer-token autentikáció és terminál-identitás

## Felelősség

A MCP- és REST-felületek védelme Bearer-tokennel, és a hívó **terminál-identitás
+ tudás-sziget (island)** feloldása. Az identitás mindig a bemutatott tokenből
származik — sosem kliens által állított claimből (multi-island kiszolgálás
alapja, lásd `ADR-066`).

## Publikus belépési pontok

Egyetlen fájl: [`tokenAuth.ts`](tokenAuth.ts).

- `authenticateMcp` / `authenticateRest` — Express middleware-ek; sikeres auth
  után a `req.mcpTerminal` és `req.mcpIsland` mezőket töltik.
- `apiAuthGate`, `requireRootForMutations` — REST-oldali kapuk
  (a `bootstrap/app.ts` fűzi be őket).
- `loadAgentTokens()` — token-térkép újratöltése (30 mp-enként automatikus).

## Működés (üzemmódok)

`AUTH_MODE` (env, kód-default: **`required`**):

- `required` — fail-closed: minden védett felülethez érvényes Bearer-token
  kell; ha egyetlen token sincs konfigurálva, minden kérés 503-mal elutasítva,
  a `default_agent` fallback tiltott. Kitett (VPS) környezetben kötelező.
- `open` — kizárólag lokális fejlesztésre (`.env.dev`): token nélkül minden
  hívó `root`; a `default_agent` fallback él.

Token-források (env felülírja a YAML-t):

| Forrás | Jelentés |
|---|---|
| `config/agents.yaml` | `master_token` + `agents` térkép (token → ágensnév), `agent_islands`, `default_island` — 30 mp-enként auto-reload |
| `MCP_AUTH_TOKEN` | master token (a `root` identitást adja) |
| `MCP_TOKEN_<NÉV>` | ágensenkénti token (pl. `MCP_TOKEN_CONDUCTOR` → `conductor`) |

## Függőségi irány

Csak a `config` rétegtől (`env`, `paths.AGENTS_CONFIG_PATH`, `ISLAND_ID`) és a
`core/logger`-től függ. Feature-modulok EZT importálják, fordítva soha.

## Konfiguráció (env-kulcsok)

`AUTH_MODE`, `MCP_AUTH_TOKEN`, `MCP_TOKEN_<NÉV>` (dinamikus prefix-scan),
`AGENTS_CONFIG_PATH` (default: `<knowledge-service>/config/agents.yaml`).
Az `agents.yaml`-nak csak a [`config/agents.yaml.example`](../../config/agents.yaml.example)
sablonja verziókezelt — valódi token sosem kerül repóba.

## Logok

Minden auth-döntés (elfogadás/elutasítás oka, token-reload) a `core/logger`-en
megy ki; tokenérték soha nem kerül naplóba.

## Tesztek

`npx vitest run src/__tests__/unit/tokenAuth.test.ts src/__tests__/unit/mcpAuth.test.ts src/__tests__/integration/authGate.integration.test.ts`
(továbbá: `unit/appSecurity.test.ts`, `unit/islandScoping.test.ts`).

## Ismert korlátok

- A token-térkép memóriában él; a 30 mp-es auto-reload miatt egy visszavont
  token legfeljebb 30 mp-ig még érvényes lehet.
- A `process.env`-et ez a modul közvetlenül olvassa a dinamikus
  `MCP_TOKEN_*`-scan és a runtime token-reload miatt — ez dokumentált kivétel
  a config-rétegszabály alól (TASK-QC-007).
