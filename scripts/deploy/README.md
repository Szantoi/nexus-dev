# scripts/deploy — biztonságos, konfigurálható deploy + automatikus rollback

> TASK-QC-004 eredménye (2026-07-18). A régi `scripts/deploy-to-prod.sh` helyett
> használandó; az csak dokumentált vészhelyzeti fallback, törléséhez emberi
> jóváhagyás kell.

## Architektúra — release-előkészítés és deploy szétválasztva

```
build-release.sh  (forrásgépen / CI-ben)          deploy-release.sh  (célgépen)
┌──────────────────────────────────┐              ┌─────────────────────────────────┐
│ 1. typecheck   ─ hiba → exit 10  │   artifact   │ 1. konfig-validálás   (exit 2)  │
│ 2. teszt       ─ hiba → exit 10  │  ─────────►  │ 2. artifact-ellenőrzés (exit 11)│
│ 3. audit       ─ hiba → exit 10  │  .tar.gz     │ 3. EMBERI KAPU: --confirm + yes │
│ 4. build       ─ hiba → exit 10  │  (RELEASE_ID │ 4. backup-ellenőrzés  (exit 11) │
│ 5. artifact: dist + manifest +   │  + manifest) │ 5. kicsomagolás + npm ci        │
│    RELEASE_ID (ts + git hash)    │              │ 6. stop → váltás → start        │
└──────────────────────────────────┘              │ 7. health-check                 │
   NEM commitol, NEM tagel,                       │    hiba → AUTO ROLLBACK +       │
   NEM pushol, service-hez nem nyúl               │    a visszaállított verzió      │
                                                  │    health-checkje is (naplózva) │
                                                  └─────────────────────────────────┘
```

## Könyvtárstruktúra a célgépen (`DEPLOY_ROOT`)

```
$DEPLOY_ROOT/
├── releases/<RELEASE_ID>/   # minden telepített release érintetlenül megmarad
│                            # (a hibás release is — vizsgálatra)
├── current                  # az aktív release: symlink (Linux) vagy másolat
├── current.release-id       # az aktív release azonosítója (autoritatív pointer)
└── logs/deploy-*.log        # minden deploy/rollback teljes naplója
```

A "backup" ebben a modellben maga az előző `releases/<id>` könyvtár: deploy
előtt a script IGAZOLJA, hogy sértetlen (létezik + a benne lévő `RELEASE_ID`
egyezik a pointerrel) — ha nem, a deployt megtagadja (nem lenne mire visszaállni).

## Használat

```bash
# 0) egyszer: konfig a sablonból (a deploy.config.sh gitignore-olt!)
cp scripts/deploy/deploy.config.example.sh scripts/deploy/deploy.config.sh

# 1) release-artifact készítése (minden kapu kötelezően zöld)
bash scripts/deploy/build-release.sh --config scripts/deploy/deploy.config.sh
#    → ARTIFACT=<út>.tar.gz és RELEASE_ID=<id> zárósorok

# 2) terv megtekintése — SEMMIT nem módosít
bash scripts/deploy/deploy-release.sh --config ... --artifact <út>.tar.gz --dry-run

# 3) éles deploy — emberi kapu: --confirm + interaktív "yes"
bash scripts/deploy/deploy-release.sh --config ... --artifact <út>.tar.gz --confirm
```

## Konfiguráció

Minden útvonal, service-név, port, health-URL és timeout a konfigfájlból jön
(sablon: `deploy.config.example.sh`, kulcsonként kommentelve); bármely kulcs
felülírható `NEXUS_DEPLOY_<KULCS>` env-változóval. Hiányzó/érvénytelen érték →
azonnali, a kulcsot megnevező hiba (exit 2), mielőtt bármi módosulna.

| Kulcs | Szerep |
|---|---|
| `SERVICE_NAME` | azonosító a naplókban és az artifact nevében |
| `SERVICE_DIR`, `ARTIFACT_DIR` | build-forrás, ill. artifact + build-napló célhelye |
| `BUILD_TYPECHECK_CMD` / `BUILD_TEST_CMD` / `BUILD_AUDIT_CMD` / `BUILD_CMD` | a négy kapu parancsa |
| `ARTIFACT_INCLUDE` | mi kerül az artifactba (SERVICE_DIR-relatív) |
| `DEPLOY_ROOT` | verziózott release-fa gyökere a célgépen |
| `SERVICE_STOP_CMD` / `SERVICE_START_CMD` | service-kezelés (pl. `sudo systemctl stop nexus-dev-ks`) |
| `POST_UNPACK_CMD` | opcionális; kicsomagolás után, MÉG a stop előtt fut (pl. `npm ci --omit=dev`) |
| `HEALTH_URL`, `HEALTH_EXPECT` | health-endpoint + a válaszban várt fix string |
| `HEALTH_TIMEOUT_SECONDS`, `HEALTH_RETRIES`, `HEALTH_RETRY_DELAY_SECONDS`, `START_GRACE_SECONDS` | időzítések |
| `SWITCH_MODE` | `symlink` (Linux, ajánlott — readlinkkel igazolt) vagy `copy` |

## Exit code-ok (géppel parszolható `RESULT=` zárósor is van)

| Kód | Jelentés |
|---|---|
| 0 | siker (`RESULT=deployed`) |
| 2 | konfig-/használati hiba vagy hiányzó megerősítés — semmi nem változott |
| 10 | build-kapu hiba (typecheck/teszt/audit/build) — artifact nem készült |
| 11 | artifact- vagy backup-ellenőrzési hiba — a futó service érintetlen |
| 12 | service-stop hiba — release-váltás nem történt |
| 20 | deploy sikertelen, automatikus rollback SIKERES (`RESULT=rolled-back`) |
| 21 | rollback is sikertelen/lehetetlen — KÉZI BEAVATKOZÁS (`RESULT=rollback-*`) |

## Tesztek (hermetikus — VPS/SSH/valós service nélkül)

```bash
bash scripts/deploy/test/run-tests.sh
```

Minden fájlművelet temp könyvtárban történik; a service-kezelés mock-script,
a health-endpoint egy lokális mock Node-szerver (`test/mock-health-server.mjs`),
amelynek állapotát a telepített release `health.mode` fájlja vezérli. Lefedett
szcenáriók: sikeres deploy (emberi kapuval), build-hiba, teszthiba,
health-hiba + sikeres rollback, rollback-health-hiba, hiányos konfig, dry-run
módosításmentessége, valamint symlink-mód (Windows Git Bash alatt indokolt SKIP).

## Egyszeri kézi előkészítés a VPS-en (emberi jóváhagyással)

1. `DEPLOY_ROOT` létrehozása (pl. `/opt/nexus-dev/ks-deploy`).
2. A systemd unit (`nexus-dev-ks.service` / `nexus-ks.service`)
   `WorkingDirectory`-jának átállítása `$DEPLOY_ROOT/current`-re
   (+ `daemon-reload`).
3. A runtime `.env` és a `config/agents.yaml` NEM része az artifactnak — ezek
   a célgépen élnek; a service ezekhez a `WorkingDirectory`-n vagy abszolút
   útvonalon fér hozzá (döntés: symlinkelés a release-be vagy env-útvonal).
4. Első deploy: a script figyelmeztet, hogy még nincs rollback-célpont.
