# Nexus knowledge-service

A SpaceOS/Nexus agent-flotta központi szolgáltatása: **Express HTTP API + MCP
(JSON-RPC) szerver** egyetlen processzben. Fő képességei:

- **MCP tool-registry** — a Claude Code terminálok tool-készlete (121 tool;
  a pontos listát a
  [contract-teszt](src/__tests__/integration/mcpContract.integration.test.ts) pinneli),
- **RAG tudáskereső** — a `docs/knowledge/**/*.md` fa indexelése ChromaDB
  vektortárba, keresés REST-en és MCP-n,
- **Terminál-mailbox** — inbox/outbox üzenetek, SSE wake-up értesítések,
- **[task-message-box](src/task-message-box/README.md)** — kanonikus, SQLite-alapú üzenettár,
- **Pipeline-automatizmusok** — ütemezők, watcherek, review-folyamat, epic-routing
  ([src/pipeline](src/pipeline/README.md)),
- **Multi-island kiszolgálás** — kérésenként a hívó identitásából képzett
  tudás-sziget (island) szerinti szeparáció.

A repó-szintű kontextus (programcélok, DEV/PROD szeparáció, release-folyamat):
[../README.md](../README.md). Minőségi elvárások: [../QUALITY.md](../QUALITY.md).
Architektúra-döntések: [ADR-index](../docs/architecture/decisions/README.md).
Folyó minőségi program: [QUALITY-megfelelőség](../docs/tasks/quality-compliance/README.md).

---

## Gyorsindítás — lokális fejlesztés (DEV, port 3466)

A repo gyökeréből:

```bash
# 0) egyszer: függőségek (bare checkout után)
npm --prefix knowledge-service ci

# 1) egyszer: lokális DEV env a verziókezelt, titokmentes sablonból.
#    A .env.dev runtime fájl: git-ignorált, SOSEM kerül commitba.
cp knowledge-service/.env.dev.example knowledge-service/.env.dev
#    PowerShell: Copy-Item knowledge-service\.env.dev.example knowledge-service\.env.dev

# 2) indítás (tsx, build nélkül; PORT=3466 kényszerítve, ha nincs beállítva)
node scripts/dev-start.mjs

# 3) health-check
curl http://127.0.0.1:3466/health
```

A DEV-sablon szándékosan izolált: loopback bind, `AUTH_MODE=open` (kizárólag
lokális kivétel — a kód-default `required`), Telegram/Nightwatch/automatizmusok
kikapcsolva. Hiányzó `.env.dev` esetén a `dev-start.mjs` a pontos másolási
paranccsal áll le.

**ChromaDB:** a perzisztens vektortárhoz futó ChromaDB-szerver kell a
`CHROMA_URL` címen (default `http://localhost:8001`). Nélküle a szolgáltatás
elindul és **in-memory vektortárra** vált (a `/health` `vectorBackend`
mezője mutatja: `chroma` vagy `in-memory`) — ez újraindításkor elvész.

Alternatíva sablonmásolás nélkül (a service-könyvtárból): `npm run dev` —
ekkor a kód-defaultok élnek (PORT=3456, `AUTH_MODE=required`), ezért lokálban
a `dev-start.mjs` az ajánlott út.

## Production futtatás (biztonságos minta)

Élesben **kötelező az auth és a nem-publikus bind** — a kód-defaultok ezt
adják, a lényeg, hogy ne írd felül őket lazábbra:

```bash
# .env (a célgépen él, sosem verziókezelt)
NODE_ENV=production
PORT=3456
HOST=127.0.0.1            # vagy privát Tailscale-cím (100.x.y.z) — SOHA nem 0.0.0.0
AUTH_MODE=required        # kód-default; minden kéréshez érvényes Bearer-token kell
MCP_AUTH_TOKEN=<32+ bájt véletlen master token>   # ágensenkénti tokenek: config/agents.yaml
```

Futtatás systemd alatt, verziózott release-fából (a unit `WorkingDirectory`-ja
a `$DEPLOY_ROOT/current` symlinkre mutat):

```ini
# /etc/systemd/system/nexus-ks.service (minta)
[Service]
WorkingDirectory=/opt/nexus/ks-deploy/current
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
```

A release-build (typecheck→teszt→audit→build kapukkal), az emberi jóváhagyáshoz
kötött deploy és az automatikus rollback folyamata:
[../scripts/deploy/README.md](../scripts/deploy/README.md). A régi
`scripts/deploy-to-prod.sh` elavult vészhelyzeti fallback — új deployhoz tilos.
A VPS-elérés modellje (SSH/Tailscale/tűzfal):
[../docs/knowledge/vps-hozzaferes-modell.md](../docs/knowledge/vps-hozzaferes-modell.md).

## Konfiguráció

Szabály (TASK-QC-007): **kizárólag a [`src/config/env.ts`](src/config/env.ts)
(zod-validált skalárok) és a [`src/config/paths.ts`](src/config/paths.ts)
(útvonalak) olvas `process.env`-et** — feature-modul csak innen importál.
Érvénytelen érték startupkor, olvasható hibával áll le (fail-fast); az effektív
útvonalakat a startup naplózza. A teljes, kommentelt kulcslista:
[`.env.example`](.env.example). Eltérés esetén mindig a kód (env.ts/paths.ts) a mérvadó.

A legfontosabb kulcsok (a séma-defaultokkal egyezően):

| Kulcs | Default | Szerep |
|---|---|---|
| `PORT` | `3456` (DEV-konvenció: 3466) | HTTP port |
| `HOST` | `127.0.0.1` | bind-cím — élesben is loopback/privát |
| `AUTH_MODE` | `required` | `required` = fail-closed; `open` csak lokális dev |
| `MCP_AUTH_TOKEN` / `MCP_TOKEN_<NÉV>` | — | master, ill. ágensenkénti Bearer-token (env felülírja az `agents.yaml`-t) |
| `ISLAND_ID` | `spaceos` | sziget-azonosító (collection- és log-prefix) |
| `SPACEOS_ROOT` | a checkout gyökere | a terminals/docs/config fa gyökere; eltérő layoutnál kötelező beállítani |
| `DATA_DIR` | `knowledge-service/data` | SQLite DB-k, runtime fájlok |
| `CHROMA_URL` | `http://localhost:8001` | ChromaDB (legacy alias: `CHROMADB_URL`) |
| `KNOWLEDGE_SERVICE_URL` | `http://127.0.0.1:<PORT>` | a szolgáltatás ÖNHÍVÁSAINAK bázis-URL-je |
| `CORS_ORIGINS` | üres (same-origin) | engedélyezett böngésző-originök |
| `TRUST_PROXY_HOPS` | `0` | megbízható reverse-proxy hopok |
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `pretty` | naplózás (`core/logger.ts`) |

További csoportok (mind az `env.ts`/`paths.ts` sémában, a `.env.example`-ben
kommentelve):

- **Háttérszolgáltatás-flagek:** `ENABLE_NIGHTWATCH`, `ENABLE_HEARTBEAT`,
  `ENABLE_AUTO_RESTART`, `ENABLE_MESSAGE_ROUTER`, `ENABLE_TELEGRAM_COORDINATOR`,
  `ENABLE_AUTONOMOUS_DEV`, `ENABLE_ROOT_MONITOR`, `ENABLE_IDEA_SCAN`,
  `ENABLE_PHASE_COORDINATOR`, `ENABLE_MULTI_BOT` — default mind KI;
  `ENABLE_HOURLY_DIGEST` és `PRE_REVIEW_ENABLED` opt-out (BE, hacsak nem `false`).
- **Ütemező-intervallumok, review- és autonomous-dev tuning, költségkeret:**
  `*_INTERVAL*`, `REVIEW_MODE`, `AUTONOMOUS_DEV_*`, `DAILY_COST_BUDGET`.
- **Útvonalak és DB-k:** `TERMINALS_PATH`, `KNOWLEDGE_BASE_PATH`, `LOGS_DIR`,
  `EPICS_PATH`, `WORKFLOWS_DIR`, `*_DB` stb. — lásd `paths.ts`.
- **Titkok** (értékük sosem kerül repóba): `ADMIN_SECRET`,
  `TERMINAL_TOKEN_SECRET`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`,
  `VOYAGE_API_KEY`, `GOOGLE_API_KEY` stb. — lusta getterrel az `env.ts`
  `secrets` objektumán át.

Konfig-fájlok a [`config/`](config) alatt: `agents.yaml` (tokenek — csak
`.example` sablonja verziókezelt), `terminals.json`, `tool-permissions.yaml`,
`message-model.yaml`, `workflows.yaml`, `runner.yaml.example`.

## CI minőségi kapuk (TASK-QC-005)

A CI (`.github/workflows/ci.yml`) minden kaput package scripten át futtat, így
egy elbukó kapu lokálisan ugyanazzal a paranccsal reprodukálható (ebből a
könyvtárból):

| Kapu | Parancs | Bukik, ha |
|---|---|---|
| Typecheck | `npm run typecheck` | bármely TS-hiba |
| Lint ratchet | `npm run lint:ratchet` | Biome-error, VAGY warningszám > `.lint-baseline.json` |
| Tesztek + coverage | `npm run test:coverage` | teszthiba, VAGY coverage a `vitest.config.ts` küszöbe alatt |
| Méretkapu | `npm run check:size` | production TS-fájl > 800 sor allowlist-tétel nélkül (`.file-size-allowlist.json`) |
| Prod dependency audit | `npm run audit:prod` | high/critical advisory a production függőségekben |
| Secret scan | `npm run secret-scan` | titok-minta tracked fájlban (konfig: repo-gyökér `.secret-scan.json`) |
| Doc-linkek | `npm run check:links` | törött docs-link / ADR-hivatkozás |

Ratchet-szabály: a lint-baseline és a coverage-küszöbök csak szigorodó irányba
mozoghatnak (kevesebb warning, több coverage). Baseline-leszorítás:
`node ../scripts/lint-ratchet.mjs --update`; a küszöbemelés a TASK-QC-006
hatásköre. Lazítás csak dokumentált ADR-rel.

**Release-kapu (kézi, deploy előtt kötelező):** `npm run test:smoke` — élő
smoke-teszt bootolt service + ChromaDB ellen; szándékosan nem része a
hermetikus CI-nek.

## Tesztek

```bash
npm test                # teljes hermetikus suite (vitest)
npm run test:unit       # src/__tests__/unit
npm run test:integration
npm run test:e2e
npm run test:coverage   # küszöbök: vitest.config.ts
```

A tesztek a [`src/__tests__/`](src/__tests__) alatt élnek (`unit/`,
`integration/`, `e2e/`, `agent/`, `fixtures/`, `helpers/`).

## Architektúra (jelenlegi állapot)

Belépési pont: `src/server.ts` → [`bootstrap`](src/bootstrap/README.md)
(app-factory + startup/shutdown). Fő modulok és README-ik:

| Modul | Felelősség |
|---|---|
| [`src/config`](src/config/README.md) | validált env- és útvonal-konfiguráció (az egyetlen `process.env`-olvasó réteg) |
| [`src/auth`](src/auth/README.md) | Bearer-token auth, terminál-identitás, island-scope |
| [`src/bootstrap`](src/bootstrap/README.md) | Express app-factory, startup, graceful shutdown |
| [`src/interfaces/http`](src/interfaces/http/README.md) | REST route-modulok (`/api/...`, `/health`) |
| [`src/interfaces/mcp`](src/interfaces/mcp/README.md) | MCP tool-registry (a `tools/list` és `tools/call` egyetlen forrása) |
| [`src/mcp.ts`](src/mcp.ts) | MCP transport: JSON-RPC + auth + tool-permission (registry-only, TASK-QC-008) |
| [`src/pipeline`](src/pipeline/README.md) | ütemezők, watcherek, review, epic-routing, Telegram-koordináció |
| [`src/task-message-box`](src/task-message-box/README.md) | kanonikus üzenettár (SQLite, config-vezérelt állapotgép) |
| [`src/runner`](src/runner/README.md) | tmux-mentes lokális session-runner (poll + SSE wake) |
| [`src/telegram`](src/telegram/README.md) | Telegram-üzenetküldés, beszélgetés-kezelés, multi-bot |
| `src/core` | logger, közös típusok, hibaosztályok |
| `src/graph`, `src/api`, `src/routes` | EPICS-gráf típusok/validálás + még nem migrált route-ok |

Történeti megjegyzés: a korábbi DDD-scaffolding (üres `domain/` +
`infrastructure/` rétegek) az [ADR-067](../docs/architecture/decisions/ADR-067-remove-unused-ddd-scaffolding.md)
döntéssel törölve; a ~5600 soros `mcp.ts` god-fájl a TASK-QC-008-cal
registry-only transportra (417 sor) karcsúsodott. A további történet az
[ADR-indexben](../docs/architecture/decisions/README.md) és a
[QC-program archívumában](../docs/tasks/quality-compliance/README.md) él.

## API-áttekintés

A példák a DEV portot (3466) használják. `AUTH_MODE=required` esetén minden
védett végponthoz `Authorization: Bearer <token>` fejléc kell.

```bash
# Health / readiness
curl http://127.0.0.1:3466/health

# Tudáskeresés (REST)
curl "http://127.0.0.1:3466/api/knowledge/search?q=deploy+rollback&topK=5"
curl -X POST http://127.0.0.1:3466/api/knowledge/index    # újraindexelés

# Mailbox
curl "http://127.0.0.1:3466/api/mailbox/conductor/inbox?status=UNREAD"
curl -N http://127.0.0.1:3466/api/mailbox/conductor/subscribe   # SSE wake-up

# MCP (JSON-RPC)
curl http://127.0.0.1:3466/mcp                                  # szerver-info
curl -X POST http://127.0.0.1:3466/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

Claude Code kliens-konfig (`.mcp.json`):

```json
{
  "mcpServers": {
    "nexus-knowledge": {
      "type": "http",
      "url": "http://127.0.0.1:3466/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "timeout": 60000
    }
  }
}
```

A teljes route-lista: [`src/interfaces/http/README.md`](src/interfaces/http/README.md);
a tool-készlet szabályai: [`src/interfaces/mcp/tools/README.md`](src/interfaces/mcp/tools/README.md).

## Ismert korlátok

- 800 sor feletti örökölt fájlok bontása ütemezett follow-up taskokban fut
  (QC-008A–E, allowlist-lejárat: 2026-10-18) — lásd
  [QC-program](../docs/tasks/quality-compliance/README.md).
- A `src/messageRegistry.ts` (régi, fájl-orientált üzenetrendszer) kivezetése
  a task-message-box-ra migrálással folyamatban
  ([részletek](src/task-message-box/README.md)).
- A coverage-emelés a TASK-QC-006-ban fut; a mindenkori küszöb a
  `vitest.config.ts`-ben él (ide nem másoljuk).
