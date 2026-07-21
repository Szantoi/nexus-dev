---
id: TASK-ISL-015
title: Szigetszintű observability, recovery, backup és operátori runbook
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M4
epic: ISL-OPERABILITY
status: blocked
blocked_reason: >
  A közvetlen TASK-ISL-005, TASK-ISL-006, TASK-ISL-013 és TASK-ISL-014
  függőségek nem done állapotúak. Van deploy-szintű log/marker/rollback evidence,
  de nincs teljes metrika-, riasztás-, DLQ-, backup/restore- és RPO/RTO mátrix.
  Feloldás: függőségek done és a kötelező chaos/restore bizonyíték PASS.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-005, TASK-ISL-006, TASK-ISL-013, TASK-ISL-014]
parallel_with: []
owner_role: sre
created: 2026-07-18
source: SZIGET-10
---

# Szigetszintű observability, recovery, backup és operátori runbook

## Cél

Az operátor szigetenként meg tudja állapítani, hol tart egy task, ki birtokolja,
miért vár vagy bukott, és biztonságosan helyre tudja állítani a rendszert.

## Mikor jó?

Minden fontos hibamód riasztást és actionable diagnózist ad; a backup/restore és
a crash recovery mért RPO/RTO célon belül bizonyított.

## Scope

1. Sziget-, terminál-, runner- és CLI-címkézett metrikák kontrollált cardinalityvel.
2. Queue age/depth, claim latency, expired lease, duplicate attempt, retry, DLQ,
   review wait és federation latency metrikák.
3. Strukturált correlation ID a task teljes életciklusán.
4. Readiness külön a degraded állapottól; tartós store hiánya ne legyen néma fallback.
5. Runner offline, lease stuck, queue stuck, relay outage és DLQ riasztás.
6. Backup, restore, integrity check és verziókompatibilitási runbook.
7. Manuális beavatkozás auditja; veszélyes repair emberi kapuval.

## Elfogadási feltételek

- [ ] Egy task trace-e indítástól review/completionig visszakövethető.
- [ ] Minden felsorolt hibamódhoz metrika, riasztás és runbook tartozik.
- [ ] Backupból izolált környezetbe sikeres restore történt, mért RPO/RTO-val.
- [ ] Degraded dependency nem jelent hamis ready állapotot.
- [ ] DLQ elem és stale lease biztonságosan inspect/retry/quarantine-elhető.
- [ ] Logredaction automatikus tesztekkel védett.

## Kötelező ellenőrzés

Crash- és outage-injektálás, backup/restore próba, riasztás-fire teszt, trace
korreláció, cardinality baseline és secret-canary redaction teszt.

## Kilépési feltétel

`done`, ha az operátor kódolvasás nélkül diagnosztizálni és a runbook alapján
helyreállítani tudja a golden hibamódokat. Nem tesztelt backup nem elfogadható.

## Végrehajtási napló

### 2026-07-21 — előzetes operability checkpoint

A runner strukturált JSONL sessionlogot, terminal/message/provider/model
korrelációt, aktív session markert, tartós processed/quarantine state-et és
systemd restartot ad. A telepítés minden fájlt timestampes backupba ment;
izolált configure→promote→rollback dry-run 49 fájllal PASS. Az eredeti VPS
rollback baseline: `/opt/joinerytech/backups/codex-autonomy-20260721T195555Z`.

A blokkolt Conductor-state új költséges ciklust nem engedett, miközben a célzott
mailbox wake út megmaradt. Az operátori status/log/pause/restart/rollback
parancsok a tudásanyagban szerepelnek. A teljes TASK-ISL-015 acceptance (SLO,
metrikák, alert-fire, DLQ, restore, RPO/RTO, redaction canary) még nyitott, ezért
a task `blocked`.

Részletek: `docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.
