---
id: TASK-QC-007
title: Runtime konfiguráció és környezetfüggő útvonalak központosítása
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M3
epic: QC-MAINTAINABILITY
status: done
priority: high
depends_on: []
parallel_with: [TASK-QC-001, TASK-QC-002, TASK-QC-003, TASK-QC-005]
owner_role: backend
created: 2026-07-18
source: QUALITY.md section 3
---

# Runtime konfiguráció és környezetfüggő útvonalak központosítása

## Cél

Minden környezetfüggő runtime érték egy validált, típusos konfigurációs rétegen keresztül legyen elérhető; feature-modul ne olvasson közvetlenül `process.env`-et és ne tartalmazzon hostspecifikus literalt.

## Jelenlegi bizonyíték

- `workflowManager.ts` közvetlen `/opt/spaceos/config/workflows` és `/opt/spaceos/docs/projects/EPICS.yaml` útvonalat használ.
- `pipeline/preReviewGate.ts` több fix `/opt/spaceos/...` working directoryt tartalmaz.
- `pipeline/pipeline.ts` fix `http://localhost:3456` URL-t hív shelles curl paranccsal.
- Számos feature-modul használ `process.env.X || '/opt/spaceos'` mintát a központi config helyett.
- Már létezik `src/config/env.ts` és `src/config/paths.ts`, erre kell konszolidálni.

## Scope

1. Készíts leltárt a production runtime kódban található közvetlen `process.env`, `/opt/...`, localhost URL és fix port használatokról.
2. Bővítsd a zod-validált scalar configot és a centralizált path configot.
3. A feature-modulok kizárólag a config API-t importálják.
4. Útvonalakat `path.join`/`resolve` segítségével képezz, platformfüggetlen defaultokkal.
5. A szolgáltatás saját HTTP hívásait shelles `curl` helyett típusos HTTP klienssel vagy közvetlen application service hívással valósítsd meg.
6. A hiányzó kötelező production konfiguráció fail-fast, érthető hibaüzenetet adjon.
7. Dokumentáld az összes támogatott env-változót a sablonban és README-ben.
8. Adj config unit teszteket Windows- és POSIX-szerű útvonalpéldákkal.

## Nem cél

- Teszt fixture-ökben vagy dokumentációs példákban szereplő `/opt/...` automatikus eltávolítása.
- Domainállandók konfigurációba mozgatása.
- Titkok értékeinek kezelése; azt a TASK-QC-003 kezeli.

## Elfogadási feltételek

- [x] Production runtime feature-modulban nincs közvetlen `process.env` olvasás.
- [x] Production runtime feature-modulban nincs hostspecifikus `/opt/...` literal.
- [x] Nincs fix localhost szolgáltatás-URL vagy port a feature-modulokban.
- [x] Minden konfiguráció validált és típusos.
- [x] Az útvonal-defaultok bare checkouton és Windowson is működnek.
- [x] A hiányzó/hibás konfiguráció regressziós teszttel fail-fast.

## Kötelező ellenőrzés

```bash
rg -n "process\.env|/opt/(spaceos|nexus)|localhost:[0-9]+" knowledge-service/src \
  -g '*.ts' -g '!**/__tests__/**'
cd knowledge-service
npm run typecheck
npm test
```

A maradó találatokat egyenként indokold; komment vagy felhasználónak szánt példa nem számít runtime konfigurációnak.

## Átadandó bizonyíték

- Előtte/utána konfigurációleltár.
- Új env-változók és defaultok táblázata.
- Config- és teljes tesztkimenet.

## Kockázat és rollback

A defaultok megváltoztatása adatot írhat rossz helyre. A migráció alatt minden effektív útvonalat startupkor biztonságosan, titok nélkül naplózni kell.


## Implementáció (2026-07-18)

### Előtte/utána leltár

Ellenőrző parancs (változatlan):
`rg -n "process\.env|/opt/(spaceos|nexus)|localhost:[0-9]+" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'`

- **Előtte:** ~70 runtime fájl érintett; több mint 30 fájl hordozta a saját
  `const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos'` másolatát;
  fix `/opt/spaceos/...` working directoryk (`preReviewGate.ts`,
  `workflowManager.ts`, `taskEscalation.ts`, `telegramBot.ts`), shelles
  `curl http://localhost:3456` (`pipeline.ts`), fix `http://localhost:3456`
  fetch-ek (`watchInbox`, `watchQueue`, `telegramBot`), szórt
  `parseInt(process.env.X || '...')` minták.
- **Utána:** 75 találat, ebből 55 a config rétegben (`src/config/paths.ts`: 34,
  `src/config/env.ts`: 21 — ez a réteg definíció szerint olvas process.env-et).
  A maradék találatok tételes indoklása:

| Fájl | Találat | Indoklás |
|---|---|---|
| `src/auth/tokenAuth.ts` (5) | `MCP_AUTH_TOKEN`, dinamikus `AGENT_TOKEN_*` scan | Auth-infrastruktúra réteg (nem feature-modul): dinamikus kulcsfelderítés + runtime token-reload, a tesztek futásidőben mutálják; a nem commitolt biztonsági munka része, érintetlenül hagyva |
| `src/runner/runnerConfig.ts` (2) | `RUNNER_CONFIG_PATH`, `RUNNER_TOKEN` | Saját, zod-validált config-loader modul (a runner konfig belépési pontja); a teszt futásidőben állítja a RUNNER_TOKEN-t |
| `src/codegen/frontendVerify.ts` (1) | `{ ...process.env, FORCE_COLOR: '0' }` | Child-process környezet-továbbadás, nem konfig-olvasás |
| `src/generators/componentScaffold.ts` (1) | `process.env.REACT_APP_API_URL` | Generált frontend-kód template-szövegén belül (string literal), nem a szolgáltatás runtime konfigja |
| `src/pipeline/watchDone.ts` (2) | `localhost:5173` | Reviewer-promptba ágyazott felhasználói példaparancs (frontend dev-szerver), nem szolgáltatás-URL |
| `src/pipeline/projectDispatcher.ts` (3), `ideaScan.ts` (1), `autonomousDev.ts` (1), `mailbox.ts` (1), `inboxWatcher.ts` (1), `vectorStore.ts` (1), `pipeline.ts` (1) | `/opt/...`, `localhost` kommentben | Kizárólag kommentek/doksi-példák (a task szerint nem számítanak) |

### Architektúra

- **`src/config/env.ts`** — minden skalár env-változó zod-sémában, fail-fast
  validációval. Új: `parseEnv()` (tesztelhető, `EnvValidationError`-t dob),
  üres string = "nincs beállítva" kezelés, `SELF_BASE_URL` / `CHROMA_EFFECTIVE_URL`
  / `MCP_SERVER_URL` származtatott URL-ek, `secrets` lusta getter-objektum
  (runtime reload + teszt-mutációk támogatása), `getSpaceosMode()`.
- **`src/config/paths.ts`** — minden fájlrendszer-útvonal `path.join/resolve`
  alapon. `SPACEOS_ROOT` default: a checkout gyökere (platformfüggetlen, bare
  checkouton és Windowson is működik; `/opt/spaceos` hardcode megszűnt).
  Konstans exportok + lusta `getX()` getterek ott, ahol a tesztek futásidőben
  írják az env-et. Legacy aliasok megtartva: `TERMINALS_DIR`,
  `REGISTRY_DB_PATH`, `MEMORY_DB_PATH`, `CHROMADB_URL`, `TELEGRAM_TOKEN`,
  `GEMINI_API_KEY`.
- **Startup naplózás:** `logPathConfig()` (eddig hívatlan volt) most a
  `bootstrap/startup.ts initialize()` elején fut — az effektív útvonalakat
  (titok nélkül) naplózza: SPACEOS_ROOT, DATA_DIR, TERMINALS_PATH,
  KNOWLEDGE_BASE_PATH, LOGS_DIR, PROJECTS_DIR, EPICS_PATH, WORKFLOWS_DIR.
- **Belső HTTP hívások:** a `pipeline.ts` shelles curl-je típusos `fetch`
  lett a `SELF_BASE_URL`-re; a `watchInbox`/`watchQueue`/`telegramBot`
  fix `localhost:3456` fetch-ei szintén `SELF_BASE_URL`-t használnak
  (DEV-en így a 3466-os saját portot hívja, nem a PROD 3456-ot — korábbi
  látens hiba javítva).

### Új/központosított env-változók és defaultok

| Változó | Default | Megjegyzés |
|---|---|---|
| `SPACEOS_ROOT` | checkout gyökere (`<repo>`) | korábban `/opt/spaceos` hardcode |
| `KNOWLEDGE_SERVICE_URL` | `http://127.0.0.1:<PORT>` | saját API önhívásokhoz |
| `EPICS_PATH` | `<PROJECTS_DIR>/EPICS.yaml` | |
| `PROJECTS_DIR` | `<SPACEOS_ROOT>/docs/projects` | |
| `GOALS_DIR` | `<SPACEOS_ROOT>/store/goals` | |
| `IDEAS_DIR` | `<SPACEOS_ROOT>/docs/planning/ideas` | |
| `QUEUE_DIR` | `<SPACEOS_ROOT>/docs/planning/queue` | |
| `PLANNING_FOCUS_PATH` | `<SPACEOS_ROOT>/docs/planning/domain-focus.md` | korábbi `process.cwd()`-alapú default hibás volt bare checkouton |
| `CONDUCTOR_STATE_DIR` | `<SPACEOS_ROOT>/terminals/conductor` | |
| `WORKFLOWS_DIR` | `<SPACEOS_ROOT>/config/workflows` | |
| `TELEGRAM_BOTS_CONFIG` | `<SPACEOS_ROOT>/config/telegram-bots.yaml` | |
| `BACKEND_DIR` | `<SPACEOS_ROOT>/backend` | |
| `FRONTEND_PORTAL_PATH` | `frontend/portal` (SPACEOS_ROOT-hoz képest) | |
| `DATAHAVEN_CLIENT_DIR` | `<SPACEOS_ROOT>/datahaven-web/client` | preReviewGate |
| `GENERATORS_DIR` | `<knowledge-service>/src/generators` | korábban PROD-layout hardcode |
| `IDEA_SCAN_PROJECT_PATH` | `<SPACEOS_ROOT>/docs/tasks/new` | |
| `AUTONOMOUS_DEV_FOCUS_FILE` | `<SPACEOS_ROOT>/docs/tasks/new/PROJECT_STATUS.md` | |
| `WORKFLOW_DB` / `TELEGRAM_DB_PATH` / `GOLDEN_PATHS_DIR` | `<DATA_DIR>/...` | |
| `ENABLE_*` flagek (11 db) | `false` (kivéve `ENABLE_HOURLY_DIGEST`, `PRE_REVIEW_ENABLED`: opt-out) | csak a literál `'true'` kapcsol be — megőrzött szemantika |
| Intervallumok (`NIGHTWATCH_INTERVAL` stb., 10 db) | korábbi inline defaultok | nem-numerikus érték most fail-fast (korábban NaN) |
| `REVIEW_MODE` | `terminal` | enum: `terminal`/`api` |
| `AUTONOMOUS_DEV_*` (6 db) | korábbi inline defaultok | enum-validálva |
| `DAILY_COST_BUDGET` | `50` | |
| `DATAHAVEN_URL` / `MARVEEN_URL` / `MCP_SERVER_URL` / `MCP_DOCUMENTATION_URL` | ld. `.env.example` | URL-validált |
| Titkok (`TELEGRAM_*`, `SLACK_*`, `DISCORD_*`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GOOGLE_API_KEY`, `ADMIN_SECRET`, `TERMINAL_TOKEN_SECRET`, `DASHBOARD_AUTH_TOKEN`, `DATAHAVEN_TOKEN`) | — | lusta `secrets` getter; értékkezelés a TASK-QC-003 hatásköre |

Minden változó dokumentálva a `.env.example`-ben (hozzáfűzött szekció).

### Tesztek

- Új: `src/__tests__/unit/configCentralization.test.ts` — 16 teszt:
  fail-fast (hibás PORT/AUTH_MODE/TRUST_PROXY_HOPS/intervallum), üres string
  = unset, flag-szemantika, POSIX- és Windows-stílusú `SPACEOS_ROOT`
  útvonalképzés, bare-checkout default, explicit override elsőbbség, legacy
  alias, `SELF_BASE_URL` származtatás, lusta secrets.
- `npm run typecheck`: hibamentes.
- `npm test` (hermetikus suite): **59 fájl, 974 passed, 1 skipped, 0 failed**
  (baseline: 958 passed — a többlet az új config-tesztek + párhuzamos taskok).
- Startup napló smoke: `logPathConfig()` Windows bare checkouton a repo alá
  mutató effektív útvonalakat naplóz (bizonyíték a task-futásban).

### Kockázat / megjegyzések

- A default-konszolidáció miatt ha egy telepítés **beállítja a
  `SPACEOS_ROOT`-ot, de nem** a `KNOWLEDGE_BASE_PATH`/`LOGS_DIR`/
  `TERMINALS_PATH`-t, ezek defaultja mostantól konzisztensen a
  `SPACEOS_ROOT` alá képződik (korábban repo-relatív volt). A PROD `.env`
  explicit átvizsgálása deploy előtt ajánlott; az effektív útvonalak
  startupkor naplózódnak (ez a task előírt mitigációja).
- Telegram token-precedencia egységesítve: `TELEGRAM_BOT_TOKEN` nyer,
  `TELEGRAM_TOKEN` a fallback (a `channelProvider` korábban fordítva nézte;
  csak akkor jelent eltérést, ha a kettő eltérő értékkel egyszerre volt beállítva).
- A `dev-token-spaceos-dashboard-2026` és `spaceos-webhook-secret-2026`
  default-értékek viselkedés-kompatibilitás miatt megmaradtak a config
  rétegben — eltávolításuk a TASK-QC-003 dolga (megjelölve kommentben).

### Utólagos javítás — conductor-ellenőrzés után (2026-07-18)

**Hiba:** a `src/__tests__/unit/terminalStatusAggregator.test.ts` „should respond
in <100ms" tesztje lassabb gépen elhasalt. Gyökérok: a `terminalConfig.ts`
konszolidált `TERMINALS_PATH`-defaultja már a VALÓDI checkout `terminals/`
mappájára mutat, így a `contextPersistence.getContextSaturation()` élesben
olvasta a repó STATUS.md/.turn-count/.session-state fájljait mind a 8
terminálra — a korábbi nemlétező `/opt/spaceos/terminals` default azonnali
ENOENT-tel „gyors" volt. Ez egyben hermetikussági hiba is volt: a unit teszt a
repó fájlrendszerétől függött.

**Javítás:** a tesztfájl tetején `vi.mock('../../contextPersistence', ...)`
determinisztikus, a valós visszatérési alakot tükröző értékekkel (a meglévő
unit-teszt `vi.mock`-mintáit követve). A teszt így a kimondott szándékának
megfelelően kizárólag az in-memory `terminalStatus` registry-ből dolgozik;
a perf-tesztek futásideje ~130 ms-ról ~40-50 ms összidőre esett.

**Egyéb érintett tesztek átvizsgálva:** a `contextPersistence`/`terminalConfig`
valós útvonalaitól egyedül ez a tesztfájl függött; az
`mcp-tools.integration.test.ts` már eleve temp `SPACEOS_ROOT`-ot állít be
importok előtt (hermetikus).

**Bizonyíték:**
- `npx vitest run src/__tests__/unit/terminalStatusAggregator.test.ts` kétszer:
  16 passed / 0 failed mindkétszer (tests 48 ms, ill. 41 ms).
- Teljes `npm test` kétszer egymás után: **59 fájl, 974 passed / 1 skipped /
  0 failed, exit 0 mindkétszer** (07:42 és 07:43 futás).
- Megjegyzés: egy korábbi, dupla terheléses futásban egyszer előfordult 1
  időzítés-érzékeny bukás egy másik (nem azonosított, nem reprodukálódó)
  tesztben; három egymást követő teljes futás azóta hibátlan. A suite több,
  már korábban is meglévő fix ms-budget assertet tartalmaz (pl.
  `dependencyResolver`, `componentScaffold`, `identity` tesztek) — ezek
  terhelés alatti flakiness-e nem e task hatásköre, jelezve a programnak.
