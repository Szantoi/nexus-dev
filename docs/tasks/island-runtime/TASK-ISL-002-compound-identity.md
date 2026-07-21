---
id: TASK-ISL-002
title: Összetett sziget–terminál–runner identitás és egységes konfiguráció
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M1
epic: ISL-IDENTITY-ISOLATION
status: in_progress
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-001]
parallel_with: [TASK-ISL-004, TASK-ISL-007]
owner_role: backend
created: 2026-07-18
source: SZIGET-01, SZIGET-03 and SZIGET-09
---

# Összetett sziget–terminál–runner identitás és egységes konfiguráció

## Cél

Minden terminál, mailbox, task, runner és session szigetnévtérben kapjon stabil,
validált identitást, és a terminálkonfigurációnak egyetlen kanonikus forrása legyen.

## Mikor jó?

Az `island-a/backend` és `island-b/backend` egyszerre létezhet path-, config-,
mailbox-, queue- és sessionütközés nélkül.

## Feloldási feltétel

TASK-ISL-001 `done`, az identitási ADR elfogadva.

## Scope

1. Vezesd be a típusos `IslandId`, `TerminalId`, `RunnerId` és compound key modellt.
2. Vond össze a JSON/YAML terminálkonfigurációt egy validált sémába.
3. Namespace-eld a mailbox-, state-, log- és sessionútvonalakat.
4. Adj explicit legacy név→compound identity migrációt és ütközésdetektálást.
5. A config-hiba legyen fail-closed és actionable.
6. Kerüld a string-összefűzéses pathkezelést; validáld a path traversal ellen.

## Elfogadási feltételek

- [ ] Egyetlen terminálkonfigurációs loader és séma marad.
- [ ] Ismétlődő terminálszerepek két szigeten izoláltan működnek.
- [ ] Minden perzisztált új rekord tartalmazza a szükséges szigetazonosítót.
- [ ] Legacy config automatikusan vagy dokumentált migrációval kezelhető.
- [ ] Hibás, hiányos és traversal-gyanús azonosító fail-closed eredményt ad.
- [ ] Windows és Linux path-tesztek zöldek.

## Kötelező ellenőrzés

Unit- és integrációs teszt legalább két szigettel, azonos `backend` szereppel,
Windows és POSIX path-fixture-rel. Futtasd a typechecket, lintet és a teljes
érintett identity/config/mailbox suite-ot.

## Kilépési feltétel

`done`, ha a régi globális terminálnév egyetlen érintett runtime útvonalon sem
szolgál önmagában tenantkulcsként. Migrációs adatvesztés veszélyénél állj meg.

## Végrehajtási napló

### 2026-07-21 — autonóm runner identity checkpoint

- **Goal:** a runner által indított child ne master credentialt, hanem kizárólag
  a konfigurált terminál saját tokenjét kapja, és a hálózati task ne választhassa
  meg a provider/binary/sandbox identitást.
- **Sikerkritérium:** terminal-scoped credential env; lokális terminal/model
  allowlist; claimnél szerveroldali terminal authorization; secretmentes log.
- **Kilépési feltétel:** a checkpoint PASS, de a task csak első osztályú
  `island_id/terminal_id/runner_id` névterezés és migráció után lehet `done`.

A checkpoint megvalósult és unit/integrációs teszttel ellenőrzött. A child csak
a terminálhoz rendelt env credentialt kapja; a claim route az egységes REST auth
és mailbox authorization réteget használja; a provider és sandbox csak lokális
runnerconfigból jöhet. A hiányzó összetett, több-szigetes runtime identitás miatt
a task `in_progress`. Részletek:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.
