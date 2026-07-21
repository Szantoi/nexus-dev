---
id: TASK-ISL-005
title: Atomi task claim, lejáró lease, fencing és idempotencia
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M2
epic: ISL-OWNERSHIP
status: blocked
blocked_reason: >
  TASK-ISL-004 még blocked; a mostani operatív claim a legacy terminal contextet
  használja, és nem helyettesíti a kanonikus store-ra épülő atomi lease/fencing
  modellt. Feloldás: TASK-ISL-004 done, majd konkurencia- és crash-evidence.
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-004]
parallel_with: [TASK-ISL-003, TASK-ISL-007]
owner_role: backend
created: 2026-07-18
source: SZIGET-04
---

# Atomi task claim, lejáró lease, fencing és idempotencia

## Cél

A task ownership szerveroldali, atomi és időkorlátos legyen; verseny, retry és
crash ne okozhasson párhuzamos vagy kétszeres üzleti végrehajtást.

## Mikor jó?

N párhuzamos runner claimjéből pontosan egy sikeres, az elhalt tulajdonos lease-e
lejár, a régi tulajdonos fencing miatt többé nem írhat, és az újrapróbálás
idempotens.

## Scope

1. Feltételes atomi claim, `lease_owner`, `lease_expires_at`, `version/fence`.
2. Heartbeat/renew, explicit release és szerveridő alapú timeout.
3. Attempt budget, exponential backoff és dead-letter átmenet.
4. Idempotency key adatbázis-kényszerrel, nem csak alkalmazásoldali SELECT-tel.
5. Completion/failure update csak érvényes lease és fence mellett.
6. Auditált ownership history és konfliktusmetrika.

## Elfogadási feltételek

- [ ] Legalább 20 párhuzamos claimből minden futásban pontosan egy nyer.
- [ ] Lejárt runner nem tud késői completiont írni.
- [ ] Retry azonos idempotency key mellett nem duplikál rekordot vagy mellékhatást.
- [ ] Attempt limit után látható DLQ/blocked állapot keletkezik.
- [ ] Óraeltérés és processzrestart tesztek determinisztikusak.

## Kötelező ellenőrzés

Valós adatbázisos konkurenciateszt külön processzekkel, kill/crash teszt,
lease-renew verseny, stale fence negatív teszt és idempotens replay.

## Kilépési feltétel

`done`, ha processzlokális dedup nélkül is bizonyított az egyedi ownership.
Flaky konkurenciateszt vagy reprodukálható dupla completion mellett tilos lezárni.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
