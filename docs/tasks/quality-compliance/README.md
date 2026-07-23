# QUALITY.md megfelelőségi program

Ez a könyvtár a 2026-07-18-i megfelelőségi felmérés során azonosított javításokat bontja végrehajtható feladatokra. A normatív forrás a repository gyökerében lévő `QUALITY.md`.

## Programcél

A Nexus knowledge-service legyen bizonyíthatóan összhangban a `QUALITY.md` célkezelési, tervezési, kódminőségi, tesztelési, dokumentációs, stabilitási és biztonsági követelményeivel.

## Leállási feltétel

A program akkor zárható le, ha:

1. minden alábbi task `done` állapotú;
2. a hermetikus teszt-, typecheck-, lint-, coverage- és dependency-audit kapu CI-ben zöld;
3. nincs verziókezelt runtime `.env` vagy titok;
4. az éles deploy teszthibánál megáll, health-check hibánál automatikusan visszaáll;
5. az ADR-hivatkozások érvényes dokumentumra mutatnak;
6. a runtime konfigurációban nincsenek közvetlen, környezetfüggő `/opt/...` vagy fix szolgáltatás-URL literalok;
7. a projektállapot és az elvégzett munka ugyanazt az állapotot mutatja;
8. egy friss kontextusú reviewer a `TASK-QC-010` szerint bizonyítékokkal elfogadja az eredményt.

## Hierarchia

- Program: `NEXUS-QUALITY`
- Projekt: `nexus/knowledge-service`
- Mérföldkövek:
  - `QC-M1` — irányítás és tervezési nyomvonal
  - `QC-M2` — biztonság és stabilitás
  - `QC-M3` — karbantarthatóság
  - `QC-M4` — dokumentáció és független igazolás

## Feladatok

| Sorrend | Feladat | Mérföldkő | Prioritás | Függőség |
|---|---|---|---|---|
| 1 | [TASK-QC-001 — Projektállapot és célhierarchia](archive/TASK-QC-001-project-state.md) ✅ done | QC-M1 | magas | nincs |
| 2 | [TASK-QC-002 — ADR-k és design intent](archive/TASK-QC-002-adr-recovery.md) ✅ done | QC-M1 | magas | nincs |
| 3 | [TASK-QC-003 — `.env` és titokhigiénia](archive/TASK-QC-003-env-hygiene.md) ✅ done | QC-M2 | kritikus | nincs |
| 4 | [TASK-QC-004 — Biztonságos deploy és rollback](archive/TASK-QC-004-safe-deploy.md) ✅ done | QC-M2 | kritikus | QC-003 |
| 5 | [TASK-QC-005 — CI minőségi kapuk](archive/TASK-QC-005-ci-quality-gates.md) ✅ done | QC-M2 | magas | nincs |
| 6 | [TASK-QC-006 — Kritikus tesztlefedettség](archive/TASK-QC-006-critical-coverage.md) ✅ done | QC-M2 | magas | QC-005 |
| 7 | [TASK-QC-007 — Konfiguráció központosítása](archive/TASK-QC-007-config-centralization.md) ✅ done | QC-M3 | magas | nincs |
| 8 | [TASK-QC-008 — Nagy fájlok és MCP fallback megszüntetése](archive/TASK-QC-008-large-file-decomposition.md) ✅ done | QC-M3 | magas | QC-002, QC-005 |
| 9 | [TASK-QC-009 — README- és modul-dokumentáció](archive/TASK-QC-009-documentation.md) ✅ done | QC-M4 | közepes | QC-001, QC-002, QC-003, QC-004, QC-005, QC-007, QC-008 |
| 10 | [TASK-QC-010 — Független megfelelőségi ellenőrzés](archive/TASK-QC-010-independent-verification.md) ✅ done (2. körben PASS) | QC-M4 | magas | QC-001…QC-009 |

## Follow-up taskok — a QC-010 független review nyomán (2026-07-18)

A QC-010 első futása (lásd `TASK-QC-010-independent-verification.md` Implementáció-szekció)
három, a QC-006 tesztírás közben feltárt, de nem javított és nem trackelt hibát talált.
Egyik sem kritikus (nincs adatvesztés az elsődleges rekordban, nincs biztonsági rés),
de mindhárom reprodukálható és dedikált taskot kapott:

- [QC-011](archive/TASK-QC-011-workflowdb-history-bug.md) ✅ done — `workflowDb.addHistory` named-param hiba (közepes)
- [QC-012](archive/TASK-QC-012-goalstore-id-collision.md) ✅ done — `goalStore.generateGoalId` ütközési kockázat (alacsony-közepes)
- [QC-013](TASK-QC-013-inbox-watcher-env-flag.md) — `ENABLE_INBOX_WATCHER` hatástalan env-kulcs (közepes)

Ezek nem blokkolják a NEXUS-QUALITY program lezárását (a QC-010 döntése szerint
"nem blokkoló, de jelentendő" tételek), és nem részei a mind a 10 eredeti
QC-task `done`-jának — külön nyomon követendők.

## Follow-up taskok (a QC-008 nyomán, a program leállási feltételének NEM részei)

A 800 sor feletti maradványfájlok bontása külön, ütemezett taskokban él
(allowlist-lejárat: 2026-10-18):
[QC-008A](TASK-QC-008A-sessionstarter-decomposition.md) sessionStarter ·
[QC-008B](TASK-QC-008B-messageregistry-decomposition.md) messageRegistry ·
[QC-008C](TASK-QC-008C-pipeline-reviewer-decomposition.md) pipeline/reviewer ·
[QC-008D](TASK-QC-008D-terminalreviewer-decomposition.md) terminalReviewer ·
[QC-008E](TASK-QC-008E-remaining-large-files.md) további 800+ sorosok.

## Javasolt végrehajtási hullámok

- 1. hullám, párhuzamosan: QC-001, QC-002, QC-003, QC-005, QC-007.
- 2. hullám, párhuzamosan: QC-004, QC-006, QC-008.
- 3. hullám: QC-009.
- 4. hullám: QC-010, kötelezően másik reviewerrel.

## Közös végrehajtási szabályok

- Egy worker egyszerre egy taskot kapjon; a scope bővítését előbb dokumentálja.
- Meglévő, nem kapcsolódó munkafamódosítást tilos felülírni vagy visszaállítani.
- A készítő a saját taskját teszteli, de a program lezárását külön reviewer végzi.
- `done` csak a taskban előírt parancsok kimenetével és fájlhivatkozásokkal fogadható el.
- Irreverzibilis művelet, éles deploy, titokrotáció, push vagy publikálás emberi jóváhagyást igényel.
- Minden task végén frissíteni kell a task frontmatterét, az `EPICS.yaml` állapotát és a terminál task-ledgerét.

## Felmérési baseline (2026-07-18)

- Hermetikus teszt: 958 sikeres, 1 kihagyott.
- Coverage: statements 23,36%, branches 19,03%, functions 23,29%, lines 23,51%.
- Biome: 1231 nem blokkoló diagnosztika (797 warning, 434 info).
- Dependency audit: 0 ismert npm-sérülékenység.
- Legnagyobb TypeScript-fájl: `knowledge-service/src/mcp.ts`, 5561 sor.
- A `.github/workflows/ci.yml` jelenleg nem futtat coverage-et vagy dependency-auditot.

