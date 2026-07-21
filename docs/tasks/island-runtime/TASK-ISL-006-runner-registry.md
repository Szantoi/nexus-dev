---
id: TASK-ISL-006
title: Tartós runner registry, capability routing és heartbeat
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M2
epic: ISL-RUNNER-CONTROL
status: blocked
blocked_reason: >
  TASK-ISL-002 in_progress és TASK-ISL-005 blocked; nincs még tartós,
  hitelesített runner registry, heartbeat és lease/fencing alapú routing.
  Feloldás: mindkét függőség done és a restart/duplicate-host tesztek PASS.
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-002, TASK-ISL-005]
parallel_with: []
owner_role: backend
created: 2026-07-18
source: SZIGET-04 and SZIGET-10
---

# Tartós runner registry, capability routing és heartbeat

## Cél

A szerver tudja, mely hitelesített runner mely szigetet, terminált, operációs
rendszert és CLI-adaptert képes kiszolgálni, és csak élő runnernek adjon lease-t.

## Mikor jó?

Offline vagy inkompatibilis runner nem kap taskot; kiesése és újraregisztrációja
után az ownership helyesen és auditálhatóan rendeződik.

## Scope

1. Tartós runner record, egyedi `runner_id` és hitelesített regisztráció.
2. Heartbeat TTL, drain/maintenance/offline állapot és capability inventory.
3. OS, shell, CLI, verzió, workspace és terminál-routing kompatibilitás.
4. Lease assignment csak friss, jogosult és kompatibilis runnerhez.
5. Tokenrotáció, runner revocation és audit.
6. Flottastátusz és operátori diagnosztika érzékeny adat nélkül.

## Elfogadási feltételek

- [ ] Registry restart után megmarad.
- [ ] Lejárt heartbeatű runner nem kap új taskot.
- [ ] Capability mismatch queue-ban hagyja a taskot actionable okkal.
- [ ] Két runner ugyanazzal az ID-val nem lehet egyszerre aktív epoch/fence nélkül.
- [ ] Revokált runner heartbeatje és lease-renewja visszautasított.

## Kötelező ellenőrzés

Fake-clock TTL teszt, service restart, runner reconnect, duplicate ID,
capability-routing és tokenrevocation integrációs teszt.

## Kilépési feltétel

`done`, ha minden lease egy élő registry-bejegyzéshez kötött, és a flottaállapot
reprodukálhatóan megmagyarázza, miért fut vagy vár egy task.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
