---
id: TASK-QC-003
title: Verziókezelt .env és titokhigiénia rendezése
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-SECURITY
status: done
priority: critical
depends_on: []
parallel_with: [TASK-QC-001, TASK-QC-002, TASK-QC-005, TASK-QC-007]
owner_role: security
created: 2026-07-18
source: QUALITY.md section 7
---

# Verziókezelt `.env` és titokhigiénia rendezése

## Cél

Runtime `.env` fájl ne legyen verziókezelve, miközben a fejlesztői indítás dokumentált, biztonságos sablonból továbbra is reprodukálható marad.

## Jelenlegi bizonyíték

- A `knowledge-service/.env.dev` jelenleg tracked fájl.
- A `scripts/dev-start.mjs`, `scripts/dev-start.sh` és `scripts/runner-start.mjs` közvetlenül erre támaszkodik.
- A fájl jelenleg nem tartalmaz titkot, de a szabály szerint runtime `.env` akkor sem kerülhet gitbe.
- A `knowledge-service/.env.example` biztonságos alapértékeket dokumentál.

## Scope

1. Hozz létre titokmentes fejlesztői sablont, például `.env.dev.example` néven.
2. Távolítsd el a `.env.dev` fájlt a git indexből anélkül, hogy a felhasználó lokális példányát indokolatlanul törölnéd.
3. Bővítsd a `.gitignore` szabályokat minden runtime env-változatra, explicit engedve az `*.example` sablonokat.
4. Tedd az indító scripteket kompatibilissé a lokális `.env.dev` hiányával: érthető hiba vagy dokumentált sablonmásolási lépés szükséges.
5. Adj secret-scan kaput a CI-hez vagy dokumentáld a már használt scanner konfigurációját.
6. Ellenőrizd a teljes git-történet aktuális snapshotját token-, secret- és privát kulcs mintákra. Találat esetén ne rotálj automatikusan: jelentsd és kérj emberi jóváhagyást.

## Nem cél

- Valódi titkok létrehozása vagy commitolása.
- Éles tokenek rotációja emberi jóváhagyás nélkül.

## Elfogadási feltételek

- [x] `git ls-files` nem listáz runtime `.env` fájlt.
- [x] Csak `.env.example`/`.env.*.example` sablonok verziókezeltek.
- [x] A default bind cím loopback, az auth default `required`.
- [x] A fejlesztői indítás dokumentáltan működik lokális, ignorált env-fájllal.
- [x] A secret scanner CI-ben fut és találatnál hibát ad. *(Scanner + konfig kész, találatnál exit 1; a CI-bekötés a TASK-QC-005-nek átadva — lásd Implementáció.)*
- [x] A sablonokban nincs működő token vagy jelszó.

## Kötelező ellenőrzés

```bash
git ls-files | grep -E '(^|/)\.env($|\.)'
npm --prefix knowledge-service run typecheck
npm --prefix knowledge-service test
```

Futtasd a kiválasztott secret scannert is a teljes tracked snapshoton.

## Átadandó bizonyíték

- `git ls-files` eredmény.
- Secret-scan eredmény.
- A fejlesztői boot parancsa és health-check válasza.

## Kockázat és rollback

A lokális indítás megszakadhat, ha a migráció nem kezeli a hiányzó fájlt. A rollback a scriptváltozás visszaállítása lehet, de runtime env-fájlt tilos újra commitolni.

## Implementáció (2026-07-18)

### Mi készült

1. **Új sablon:** `knowledge-service/.env.dev.example` — titokmentes, kommentelt DEV-sablon a korábbi `.env.dev` alapján (port 3466, `HOST=127.0.0.1`, `AUTH_MODE=open` explicit lokális kivételként dokumentálva, Telegram/Nightwatch/Inbox-watcher kikapcsolva). A fájl tetején szerepel a másolási parancs POSIX-ra és PowerShellre.
2. **Index-eltávolítás:** `git rm --cached knowledge-service/.env.dev` — a lokális fájl megmaradt (ellenőrizve), csak az indexből került ki. Az új sablon `git add`-dal stage-elve, hogy az index konzisztens legyen.
3. **`.gitignore` bővítés** (repo gyökér ÉS `knowledge-service/`): `.env` + `.env.*` ignorálva, `!.env.example` és `!.env.*.example` negációval. `git check-ignore -v` igazolta: `.env.dev` és `.env.runner` ignorált, a `*.example` sablonok nem.
4. **Indító scriptek:**
   - `scripts/dev-start.mjs`: hiányzó `.env.dev` esetén exit 1 + platformfüggő másolási parancs (`cp` / `Copy-Item`) a hibaüzenetben. Élesben tesztelve (fájl ideiglenes átnevezésével): a hibaüzenet és az exit kód helyes, a fájl visszaállítva.
   - `scripts/dev-start.sh`: ugyanez POSIX-ban (`[ ! -f .env.dev ]` → hibaüzenet + `exit 1`); `bash -n` szintaxis-ellenőrzés OK.
   - `scripts/runner-start.mjs`: ha se `.env.runner`, se `.env.dev` nincs, egyértelmű WARNING + másolási parancs (nem hard error, mert a runner tisztán process-env-ből is futhat); `node --check` OK.
5. **Secret-scanner:** gitleaks nincs telepítve a gépen, ezért függőségmentes Node scanner készült: `scripts/secret-scan.mjs` + konfig a gyökérben: `.secret-scan.json` (11 minta: private key blokk, AWS AKIA, GitHub ghp_/github_pat_, Telegram bot token, Slack xox*, Anthropic sk-ant-, OpenAI sk-proj-, npm token, JWT, generikus secret-hozzárendelés). Path-allowlist + inline `secret-scan:allow` marker támogatott. Exit: 0 tiszta, 1 találat, 2 konfig-hiba. Önteszt: mind a 11 minta szintetikus mintapéldányon DETECT.

### Parancsok és kimenetek

```
$ git ls-files | grep -E '(^|/)\.env($|\.)'
knowledge-service/.env.dev.example
knowledge-service/.env.example
```

```
$ node scripts/secret-scan.mjs
[secret-scan] OK — no findings in 346 scanned tracked files (11 patterns).
(exit 0)
```

```
$ npm --prefix knowledge-service run typecheck   → OK (tsc --noEmit, hibamentes)
$ npm --prefix knowledge-service test            → 58 fájl, 958 passed, 1 skipped (baseline-nal egyező)
```

### Fejlesztői boot (dokumentált lépés)

1. Első alkalommal: `cp knowledge-service/.env.dev.example knowledge-service/.env.dev` (PowerShell: `Copy-Item knowledge-service\.env.dev.example knowledge-service\.env.dev`).
2. Indítás: `node scripts/dev-start.mjs`
3. Health-check: `curl http://127.0.0.1:3466/health` → HTTP 200, válasz:
   `{"status":"ok","vectorBackend":"chroma","embeddingBackend":"chromadb-server (all-MiniLM-L6-v2)","documents":4817,...,"port":3466}` — élesben igazolva 2026-07-18-án, utána a DEV szerver leállítva.

### CI-átadás (TASK-QC-005)

A scanner CI-bekötése a QC-005 scope-ja. Javasolt lépés a workflow-ba:

```yaml
- name: Secret scan (tracked snapshot)
  run: node scripts/secret-scan.mjs
```

### Megjegyzések

- A kód-defaultok (`src/config/env.ts`) már loopback bindet (`HOST` default `127.0.0.1`) és `AUTH_MODE` default `required`-et adnak — `src/**` módosítás nem volt szükséges.
- A snapshot-scan titok-gyanús találatot NEM adott; git-történeti (múltbeli commitokra kiterjedő) mélyscan gitleaks telepítése után futtatható (`gitleaks git .`), ez emberi döntésre vár.
- Commit/push szándékosan nem történt (emberi kapu); az index előkészítve (`D .env.dev`, `A .env.dev.example`).

