# Nexus-dev — SpaceOS Nexus fejlesztő műhely

A SpaceOS Nexus agent-infrastruktúra **fejlesztési repója**. A fő komponens a
[`knowledge-service/`](knowledge-service/README.md): MCP-szerver (tool-registry),
RAG-tudáskereső, terminál-mailbox és pipeline-automatizmusok. A tiszta
release-repó a `nexus-core`; élesbe csak az itt leírt release-folyamaton át
kerül kód.

## Cél, leállási feltétel, állapot

A munkára a [QUALITY.md](QUALITY.md) elvárásai vonatkoznak (1. pont: minden
programnak mérhető célja ÉS leállási feltétele van).

- **Kanonikus állapotfájl: [`docs/projects/EPICS.yaml`](docs/projects/EPICS.yaml)** —
  program → projekt → mérföldkő → epic szinten itt él a cél (`goal`), a
  leállási feltétel (`stopping_condition`) és az állapot. Task-szinten a
  task-fájl frontmattere a kanonikus forrás; az emberi munkanapló a
  `terminals/root/todo.md`. A szinkron-eljárást az EPICS.yaml fejléce rögzíti.
- **Aktív programok és taskjaik: [`docs/tasks/README.md`](docs/tasks/README.md)** —
  többek közt a [QUALITY-megfelelőségi program](docs/tasks/quality-compliance/README.md)
  (programcél + leállási feltétel a program README-jében is kimondva).
- **Archiválási konvenció:** a lezárt (`done`) taskfájlok a program `archive/`
  almappájába kerülnek, a végükre írt `## Implementáció` szekcióval
  (mi készült, hogyan, milyen bizonyítékkal) — részletek:
  [docs/tasks/README.md#archiválás](docs/tasks/README.md#archiválás).
- **Architektúra-döntések (ADR): [`docs/architecture/decisions/README.md`](docs/architecture/decisions/README.md)**.

## Repó-térkép

| Útvonal | Tartalom |
|---|---|
| [`knowledge-service/`](knowledge-service/README.md) | A szolgáltatás (Express + MCP + RAG + mailbox + pipeline) |
| [`docs/projects/EPICS.yaml`](docs/projects/EPICS.yaml) | Kanonikus program-/epic-állapot |
| [`docs/tasks/`](docs/tasks/README.md) | Programokra bontott taskok + archívum |
| [`docs/architecture/decisions/`](docs/architecture/decisions/README.md) | ADR-index |
| [`docs/knowledge/`](docs/knowledge/nexus-dev-workshop.md) | Tudásanyagok (RAG-ba indexelve) |
| [`scripts/`](scripts) | Fejlesztői és minőség-kapu scriptek (lásd lent) |
| [`scripts/deploy/`](scripts/deploy/README.md) | Biztonságos release-build + deploy + auto-rollback |
| `terminals/` | Terminál-mailboxok (a mailbox-forgalom nem kerül gitre) |
| [`QUALITY.md`](QUALITY.md) | Minőségi elvárások (minden munkára kötelező) |

## DEV / PROD szeparáció

| Környezet | Port | Bind | Auth | Telegram / Nightwatch / automatizmusok |
|---|---|---|---|---|
| **DEV** (ez a repó) | **3466** | `127.0.0.1` | `AUTH_MODE=open` (explicit lokális kivétel) | KI (a `.env.dev` kapcsolja ki) |
| **PROD** | 3456 | loopback / Tailscale | `AUTH_MODE=required` (kód-default) | BE |

A DEV-környezet izolált: külön port, külön data-könyvtár, nem küld Telegramot
és nem indít automatikusan sessionöket. PROD-ra kód csak a
[release-folyamattal](scripts/deploy/README.md) kerül.

## Gyorsindítás (lokális fejlesztés)

```bash
# 0) egyszer: függőségek (bare checkout után)
npm --prefix knowledge-service ci

# 1) egyszer: lokális DEV env a verziókezelt, titokmentes sablonból
#    (a .env.dev runtime fájl, git-ignorált — SOSEM kerül commitba)
cp knowledge-service/.env.dev.example knowledge-service/.env.dev
#    PowerShell: Copy-Item knowledge-service\.env.dev.example knowledge-service\.env.dev

# 2) DEV szerver indítása (tsx, build nélkül; a 3466-os portot kényszeríti)
node scripts/dev-start.mjs

# 3) health-check
curl http://127.0.0.1:3466/health
```

Ha a `.env.dev` hiányzik, a `dev-start.mjs` érthető hibával és a pontos
másolási paranccsal áll le. A perzisztens vektortárhoz futó ChromaDB kell
(`CHROMA_URL`, default `http://localhost:8001`); nélküle a szolgáltatás
in-memory vektortárral indul. Részletek:
[knowledge-service/README.md](knowledge-service/README.md).

## Minőségi kapuk lokálisan (CI-repro)

Minden CI-kapu package scriptként fut, így lokálisan ugyanazzal a paranccsal
reprodukálható (`knowledge-service/` alól: `typecheck`, `lint:ratchet`,
`test:coverage`, `audit:prod`, `secret-scan`, `check:size`, `check:links`).
A kapuk táblázata és a ratchet-szabályok:
[knowledge-service/README.md — CI minőségi kapuk](knowledge-service/README.md#ci-minőségi-kapuk-task-qc-005).

Repo-szintű ellenőrzők (Node, függőség nélkül):

| Script | Mit ellenőriz |
|---|---|
| `node scripts/check-doc-links.mjs` | docs-linkek + kódbeli ADR-hivatkozások érvényessége |
| `node scripts/secret-scan.mjs` | titok-minták a tracked fájlokban (konfig: `.secret-scan.json`) |
| `node scripts/check-file-size.mjs` | 800 soros méretkapu a production TS-fájlokra (allowlist: `knowledge-service/.file-size-allowlist.json`) |
| `node scripts/lint-ratchet.mjs` | Biome-warningszám nem nőhet a baseline fölé |

## Production release és deploy

A release-előkészítés és az éles telepítés **szét van választva** —
architektúra, konfiguráció, exit-kódok és rollback-viselkedés:
[`scripts/deploy/README.md`](scripts/deploy/README.md).

```bash
bash scripts/deploy/build-release.sh  --config scripts/deploy/deploy.config.sh   # kapuk + artifact
bash scripts/deploy/deploy-release.sh --config ... --artifact <út>.tar.gz --dry-run
bash scripts/deploy/deploy-release.sh --config ... --artifact <út>.tar.gz --confirm  # emberi kapu!
```

Teszt- vagy health-check hiba esetén a deploy megáll, illetve automatikusan
visszaáll az előző release-re. A régi `scripts/deploy-to-prod.sh` **elavult,
csak dokumentált vészhelyzeti fallback** — ne használd új deployhoz.
Éles deploy minden esetben emberi jóváhagyáshoz kötött (QUALITY.md 8. pont).
