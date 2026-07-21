---
id: TASK-ISL-014
title: Hitelesített federation outbox, relay, ACK és dead-letter transport
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M4
epic: ISL-FEDERATION
status: blocked
blocked_reason: >
  A közvetlen TASK-ISL-003…005 függőségek nem done állapotúak; nincs még
  kanonikus, névterezett store és atomi idempotenciaalap a federation
  outbox/relay/ACK/DLQ implementációhoz. Feloldás: mindhárom függőség done.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-003, TASK-ISL-004, TASK-ISL-005]
parallel_with: [TASK-ISL-013]
owner_role: integration
created: 2026-07-18
source: SZIGET-06
---

# Hitelesített federation outbox, relay, ACK és dead-letter transport

## Cél

Külön service-példányokon működő szigetek között tartós, hitelesített,
idempotens és operátor által helyreállítható üzenetszállítás legyen.

## Mikor jó?

Hálózatszakadás, relay restart, ACK-vesztés vagy ismételt kézbesítés mellett az
üzenet egyszer kerül üzleti feldolgozásra, vagy látható DLQ állapotba jut.

## Scope

1. Tranzakciós outbox a forrásoldali üzleti írással egy tranzakcióban.
2. Hitelesített relay; forrássziget csak szerveridentitásból származhat.
3. Inbox dedup adatbázis-szintű idempotency constrainttel.
4. ACK, retry backoff, attempt limit és dead-letter workflow.
5. Message signing/integrity, replay protection és kulcsrotációs terv.
6. Ordering semantics és delivery guarantee pontos dokumentálása.
7. Operátori inspect/retry/quarantine auditált toolokkal.

## Elfogadási feltételek

- [ ] Két külön service-példány között valós üzenetkézbesítés működik.
- [ ] Kliens nem hamisíthat forrásszigetet vagy célterminált jogosultság nélkül.
- [ ] ACK-vesztés és replay nem okoz dupla üzleti feldolgozást.
- [ ] Outage alatt az outbox tartós, helyreállás után automatikusan ürül.
- [ ] Attempt limit után DLQ és actionable operátori információ keletkezik.
- [ ] Payload/log nem tartalmaz indokolatlan titkot vagy személyes adatot.

## Kötelező ellenőrzés

Két izolált service+DB E2E, hálózati megszakítás, relay kill/restart, duplikált
POST, ACK drop, rossz aláírás, replay és DLQ→retry teszt.

## Kilépési feltétel

`done`, ha a transport nem közös DB-feltételezésre épül, és outage/replay teszt
zöld. Nem definiált delivery semantics mellett nem zárható le.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
