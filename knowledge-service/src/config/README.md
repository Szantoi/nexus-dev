# src/config — validált runtime-konfiguráció (az egyetlen process.env-olvasó réteg)

## Felelősség

Minden környezetfüggő runtime-érték egyetlen, típusos, validált rétegen át
érhető el (TASK-QC-007). **Szabály: feature-modul nem olvas `process.env`-et
és nem tartalmaz hostspecifikus literált** — mindent innen importál.
Érvénytelen konfiguráció startupkor, kulcsonként olvasható hibaüzenettel
állítja le a processzt (fail-fast).

## Publikus belépési pontok

| Fájl | Mit ad |
|---|---|
| [`env.ts`](env.ts) | zod-sémás skalárok: `env` singleton, `parseEnv()` (tesztekhez), származtatott URL-ek (`SELF_BASE_URL`, `CHROMA_EFFECTIVE_URL`, `MCP_SERVER_URL`), lusta `secrets` getter-objektum, `getSpaceosMode()` |
| [`paths.ts`](paths.ts) | minden fájlrendszer-útvonal (`path.join/resolve`, platformfüggetlen defaultok); konstansok + lusta `getX()` getterek; `logPathConfig()` startup-naplózás |
| [`terminals.ts`](terminals.ts) | terminál-térkép betöltése a `config/terminals.json`-ból (session-nevek, modellek, session-mód) |

## Kulcsdefaultok és elvek

- `AUTH_MODE` default **`required`**, `HOST` default **`127.0.0.1`** — a
  biztonságos irány a default; lazítani csak lokálisan szabad.
- `SPACEOS_ROOT` default: **a checkout gyökere** — bare checkouton és
  Windowson is működik; eltérő layoutú telepítés explicit beállítja.
- Üres string = „nincs beállítva” (a kikommentelt `.env` sablonsorok nem
  buktatják a validálást).
- Titkok kizárólag a `secrets` lusta getteren át (runtime token-reload és
  teszt-mutációk miatt); értékük naplóba sosem kerül.

A támogatott kulcsok teljes, kommentelt listája: [`.env.example`](../../.env.example);
üzemeltetői összefoglaló: [service-README](../../README.md#konfiguráció).
Eltérés esetén a séma (env.ts/paths.ts) a mérvadó.

## Függőségi irány

A legbelső réteg: az `env.ts` semmitől nem függ (dotenv + zod), a `paths.ts`
csak a `core/logger`-től. Mindenki más ide mutat.

## Logok

`logPathConfig()` — a `bootstrap/startup.ts initialize()` elején egyszer
kiírja az effektív (titokmentes) útvonalakat (SPACEOS_ROOT, DATA_DIR,
TERMINALS_PATH, KNOWLEDGE_BASE_PATH, LOGS_DIR, PROJECTS_DIR, EPICS_PATH,
WORKFLOWS_DIR), hogy a félrekonfigurált telepítés azonnal látsszon.

## Tesztek

`npx vitest run src/__tests__/unit/configCentralization.test.ts src/__tests__/unit/envSecurity.test.ts`
— fail-fast ágak, flag-szemantika, POSIX/Windows útvonalképzés, alias- és
override-elsőbbség, lusta secrets.

## Ismert korlátok

- Dokumentált kivételek a rétegszabály alól (közvetlen `process.env`-olvasók):
  `auth/tokenAuth.ts` (dinamikus `MCP_TOKEN_*` scan + runtime reload) és
  `runner/runnerConfig.ts` (saját zod-loader) — indoklás a TASK-QC-007
  archív taskfájlban.
- Két viselkedés-kompatibilitási dev-default token még a rétegben él
  (`DASHBOARD_AUTH_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` fallbackje);
  kivezetésük a QC-program biztonsági szálán követett.
- Legacy alias-kulcsok (`TERMINALS_DIR`, `REGISTRY_DB_PATH`, `MEMORY_DB_PATH`,
  `CHROMADB_URL`, `TELEGRAM_TOKEN`, `GEMINI_API_KEY`) kompatibilitásból
  támogatottak — új konfigban a kanonikus nevet használd.
