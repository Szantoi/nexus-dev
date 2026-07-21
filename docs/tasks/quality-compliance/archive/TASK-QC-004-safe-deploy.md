---
id: TASK-QC-004
title: Biztonságos, konfigurálható deploy és automatikus rollback
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-STABILITY
status: done
priority: critical
depends_on: [TASK-QC-003]
parallel_with: [TASK-QC-006, TASK-QC-008]
owner_role: devops
created: 2026-07-18
source: QUALITY.md sections 7 and 8
---

# Biztonságos, konfigurálható deploy és automatikus rollback

## Cél

Az éles telepítés teszt- vagy health-check hiba esetén ne hagyhasson hibás release-t futni, és minden környezetfüggő értéket validált konfigurációból olvasson.

## Jelenlegi bizonyíték

- A `scripts/deploy-to-prod.sh` emberi megerősítést és backupot használ.
- Az `npm test 2>/dev/null || echo ...` lenyeli a teszthibát.
- Health-check hiba után csak kiír egy kézi rollback parancsot.
- A source, target, backup, log, port és health URL hardcoded.
- A script deploy közben commitol, tagel és pushol, ami összemossa a release-előkészítést az éles telepítéssel.

## Scope

1. Válaszd szét a build/release előkészítést és a production deployt.
2. A deploy csak előre elkészített, azonosítható artifactot telepítsen; ne commitoljon vagy pusholjon.
3. Minden útvonalat, service-nevet, portot, health URL-t és timeoutot validált konfigurációból olvasson.
4. Typecheck, teszt, audit és build bármely hibája azonnal állítsa le a deployt.
5. Készíts atomikus vagy verziózott release-cserét, ellenőrzött backupot és automatikus rollbacket.
6. Sikertelen health check után ellenőrizd a visszaállított verzió health állapotát is.
7. Tartsd meg az emberi kaput éles deploy előtt.
8. Készíts dry-run módot és hermetikus script-teszteket ideiglenes könyvtárakkal/mock service-szel.

## Nem cél

- Valós production deploy futtatása a task során.
- Branch push, tag vagy release publikálása emberi jóváhagyás nélkül.
- Infrastruktúra-szolgáltató cseréje.

## Elfogadási feltételek

- [x] Teszthiba esetén semmilyen production fájl nem változik. *(S3: snapshot-összevetéssel bizonyítva)*
- [x] Health-check hiba automatikusan visszaállítja az előző release-t. *(S4: exit 20, current visszaállt)*
- [x] A rollback utáni health check kötelező és naplózott. *(S4/S5: a deploy-naplóban `health-check (rollback)` sorok)*
- [x] Nincs hardcoded `/opt/...`, port vagy service URL a deploy logikában. *(minden a validált konfigból; `/opt/...` csak a kommentelt sablon példaértékeiben)*
- [x] A deploy nem végez git add/commit/tag/push műveletet. *(a scriptekben az egyetlen git-hívás a read-only `rev-parse` a release-azonosítóhoz)*
- [x] Van dry-run és automatizált happy-path + rollback-path teszt. *(S1, S4, S5, S7)*
- [x] Éles módhoz explicit emberi megerősítés szükséges. *(`--confirm` kapcsoló + interaktív "yes"; S1-ben tesztelve)*

## Kötelező ellenőrzés

Futtasd a deploy script tesztjeit legalább ezekkel a szcenáriókkal:

1. sikeres deploy;
2. build hiba;
3. teszthiba;
4. első health-check hiba, sikeres rollback;
5. rollback health-check hiba;
6. hiányos vagy érvénytelen konfiguráció;
7. dry-run nem módosít fájlt és nem indít szolgáltatást.

## Átadandó bizonyíték

- Minden szcenárió parancsa, exit code-ja és releváns logja.
- A backup/release könyvtárstruktúra leírása.
- Kézi production futtatás nélkül igazolt rollback.

## Kockázat és rollback

Ez éles rendszert érintő kód. A régi deploy scriptet a migráció alatt csak dokumentált vészhelyzeti fallbackként szabad megtartani, és törléséhez külön emberi jóváhagyás kell.

## Implementáció (2026-07-18)

### Mi készült

Új, kettéválasztott deploy-lánc a `scripts/deploy/` alatt (valós PROD futtatás NÉLKÜL, hermetikus tesztekkel igazolva):

| Fájl | Szerep |
|---|---|
| `scripts/deploy/build-release.sh` | Release-előkészítés: typecheck → teszt → audit → build kapuk (bármely hiba → azonnali exit 10, nincs lenyelt exit code), majd azonosítható artifact (`<SERVICE_NAME>-<RELEASE_ID>.tar.gz`, RELEASE_ID = UTC időbélyeg ms-felbontással + git hash) + `manifest.json`. NEM commitol, NEM tagel, NEM pushol, service-hez nem nyúl. |
| `scripts/deploy/deploy-release.sh` | Csak kész artifactot telepít: konfig-validálás → artifact-ellenőrzés → emberi kapu (`--confirm` + interaktív "yes") → backup-ellenőrzés → kicsomagolás + opcionális `POST_UNPACK_CMD` (a service eddig zavartalanul fut) → stop → verziózott váltás → start → health-check; hibánál automatikus rollback + a visszaállított verzió kötelező, naplózott health-checkje. `--dry-run`: teljes terv, nulla módosítás. |
| `scripts/deploy/lib.sh` | Közös lib: naplózás, konfig-betöltés + szigorú validálás (env-felülírás `NEXUS_DEPLOY_<KULCS>`-csal), health-check retry-logika, igazolt release-váltás. |
| `scripts/deploy/deploy.config.example.sh` | Kommentelt konfig-sablon (verziókezelt); a lokális `deploy.config.sh` gitignore-olt (`scripts/deploy/.gitignore`). |
| `scripts/deploy/test/run-tests.sh` + `test/mock-health-server.mjs` | Hermetikus teszt-szuite: temp könyvtárak, mock service-stop/start scriptek parancsnaplóval, mock Node health-szerver (véletlen port, állapotfájl-vezérelt). |
| `scripts/deploy/README.md` | Architektúra, konfig-kulcsok, exit code-ok, VPS-előkészítési lépések. |

### Release/backup könyvtárstruktúra (`DEPLOY_ROOT`)

```
$DEPLOY_ROOT/
├── releases/<RELEASE_ID>/   # minden telepített release megmarad (a hibás is, vizsgálatra)
├── current                  # aktív release: symlink (Linux; readlinkkel igazolt) vagy másolat (SWITCH_MODE)
├── current.release-id       # autoritatív pointer az aktív release-re
└── logs/deploy-*.log        # minden deploy/rollback teljes naplója
```

A backup maga az előző `releases/<id>`: deploy előtt a script igazolja a sértetlenségét (könyvtár létezik + belső `RELEASE_ID` egyezik a pointerrel); ha nem, a deployt megtagadja (exit 11), mert nem lenne mire visszaállni.

### A 7 kötelező szcenárió bizonyítéka

Parancs (Git Bash, Windows dev gépen): `bash scripts/deploy/test/run-tests.sh` → **szuite exit 0, 70 assert PASS, 0 FAIL, 1 indokolt SKIP** (2026-07-18).

| # | Szcenárió | Script exit | Kulcs-bizonyíték a logból |
|---|---|---|---|
| 1 | sikeres deploy | 0 | `RESULT=deployed`; emberi kapu: `--confirm` nélkül és "no" válaszra exit 2, deploy-gyökér létre sem jön; 2. deploynál `backup ellenőrizve`, előző release megmarad |
| 2 | build hiba | 10 | `A build kapu hibázott — release-készítés MEGSZAKÍTVA, artifact nem készült`; nincs `.tar.gz` |
| 3 | teszthiba | 10 | `A teszt kapu hibázott…`; a build lépés ki sem próbálkozott (marker-fájl hiányzik); a production fa snapshot-ja bitre azonos |
| 4 | health-hiba + sikeres rollback | 20 | `AUTOMATIKUS ROLLBACK indul` → `health-check (rollback) OK` → `ROLLBACK SIKERES`, `RESULT=rolled-back`; `current.release-id` visszaállt az előző release-re; a hibás release megőrizve |
| 5 | rollback health-hiba | 21 | `ROLLBACK UTÁNI health-check IS SIKERTELEN` + `KÉZI BEAVATKOZÁS`, `RESULT=rollback-unhealthy` |
| 6 | hiányos/érvénytelen konfig | 2 | a hibaüzenet megnevezi a kulcsot (`HEALTH_URL`, `HEALTH_RETRIES='sok'`, `SWITCH_MODE`) és a sablonra mutat; semmi nem jön létre |
| 7 | dry-run | 0 | deploy-fa, forrás, artifact-könyvtár sha256-snapshotja bitre azonos; a mock service stop/start parancsnaplója üresen maradt, health-check sem futott |
| +8 | symlink-mód | SKIP (Windows) | Git Bash alatt az `ln -s` másolatot készít, valódi symlink nincs — a script ezt readlinkkel detektálja és hibaként jelzi; Linux VPS-en a szcenárió lefut. A váltás-logikát az S1–S7 copy-módban fedi. |

### Konfig-sablon

`scripts/deploy/deploy.config.example.sh` — minden környezetfüggő érték itt él, kulcsonként kommentelve: service-név, forrás-/artifact-/deploy-útvonalak, a négy build-kapu parancsa, `ARTIFACT_INCLUDE`, service stop/start parancsok, `POST_UNPACK_CMD` (pl. `npm ci --omit=dev` a célgépen — natív modulok miatt), health URL/minta/timeout/retry, `SWITCH_MODE`. Minden kulcs `NEXUS_DEPLOY_<KULCS>` env-változóval felülírható; a validátor abszolút útvonalat, számot, http(s) URL-t, enum-értéket követel, és CRLF-sorvéget is hibaként jelez.

### A régi script státusza

`scripts/deploy-to-prod.sh` **MEGMARADT, dokumentált vészhelyzeti fallback** — a fejlécében elhelyezett figyelmeztetés rögzíti az ismert hibáit (lenyelt teszthiba, deploy közbeni commit/tag/push, hardcodolt útvonalak, kézi rollback) és azt, hogy **a törléséhez külön emberi jóváhagyás szükséges**. Viselkedése nem változott.

### Nyitott kérdések (emberi döntést igényel)

1. **VPS egyszeri előkészítése** az első éles használat előtt: `DEPLOY_ROOT` létrehozása, a systemd unit `WorkingDirectory`-jának átállítása `$DEPLOY_ROOT/current`-re, valamint a runtime `.env`/`config/agents.yaml` elérésének módja (symlink a release-be vagy abszolút útvonal) — részletek: `scripts/deploy/README.md`.
2. Az első deploynak még nincs rollback-célpontja — a script ezt explicit figyelmeztetéssel jelzi.
3. Commit/push szándékosan nem történt (emberi kapu, a QC-program szabálya szerint).

