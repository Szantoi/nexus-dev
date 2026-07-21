---
id: TASK-ISL-004
title: Egyetlen kanonikus task- és message-store
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M2
epic: ISL-CANONICAL-STATE
status: blocked
blocked_reason: >
  TASK-ISL-002 még in_progress; a legacy mailbox, TMB, Epic Router és registry
  egyetlen tranzakciós store-ba migrálása nem kezdhető lezárt identitásséma
  nélkül. Feloldás: TASK-ISL-002 done és jóváhagyott migrációs baseline.
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-001, TASK-ISL-002]
parallel_with: [TASK-ISL-007]
owner_role: backend
created: 2026-07-18
source: SZIGET-03 and SZIGET-05
---

# Egyetlen kanonikus task- és message-store

## Cél

A mailbox, task queue, status history és terminal context egy tranzakciós,
szigetnévteres igazságforrásból működjön; a fájlrendszer csak projekció legyen.

## Mikor jó?

Ugyanaz a task nem lehet egyszerre eltérő státuszban a mailboxban, a TMB-ben és
az Epic Routerben, és restart után ugyanaz az állapot áll helyre.

## Scope

1. Valósítsd meg az ADR-ben kiválasztott kanonikus sémát és repository API-t.
2. Egyesítsd a message lifecycle-t, historyt és terminal contextet.
3. A fájlprojekció legyen idempotens, újraépíthető és nem autoritatív.
4. Készíts legacy importot, reconciliation riportot és számlálható dry-runt.
5. Kerüld a tartós dual-write-ot; átmeneti dual-write csak mérhető eltérésriporttal.
6. Adatbázis-migráció legyen verziózott, újrafuttatható és rollbackelhető.

## Elfogadási feltételek

- [ ] Egyetlen dokumentált source of truth marad task/message állapotra.
- [ ] Minden state transition validált és historyval együtt atomikus.
- [ ] Restart és projekció-újraépítés adatvesztés nélkül működik.
- [ ] Legacy adatok dry-run és valódi fixture migrációja egyező darabszámot ad.
- [ ] Nincs néma overwrite vagy globális terminálnév okozta ütközés.

## Kötelező ellenőrzés

Migrációs round-trip, crash közbeni tranzakció, restart, két sziget azonos
terminállal, projekció törlés/újraépítés és státusztörténet integrációs teszt.

## Kilépési feltétel

`done`, ha minden runtime írás a kanonikus repositoryn keresztül történik, vagy
az átmeneti adapter explicit kivezetési dátummal dokumentált. Adatvesztés vagy
nem egyező reconciliation esetén állj meg.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
