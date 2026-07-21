---
id: TASK-ISL-003
title: Egységes REST/MCP/federation autorizáció és szigetizoláció
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M1
epic: ISL-IDENTITY-ISOLATION
status: blocked
blocked_reason: >
  A közvetlen TASK-ISL-002 függőség in_progress, a teljes összetett identitás és
  cross-island negatív mátrix még nincs kész. Feloldás: TASK-ISL-002 done, majd
  az egységes REST/MCP/TMB/federation policy implementálása és bizonyítása.
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-002]
parallel_with: [TASK-ISL-005, TASK-ISL-007]
owner_role: security
created: 2026-07-18
source: SZIGET-02 and SZIGET-06
---

# Egységes REST/MCP/federation autorizáció és szigetizoláció

## Cél

Minden interfész ugyanabból a szerver által hitelesített identitásból és közös
policy-rétegből döntsön; kliensmező soha ne adhasson szigetjogosultságot.

## Mikor jó?

Egy A szigeti token REST-en, MCP-n, TMB-n és federationön sem olvashat vagy
módosíthat B szigeti erőforrást, és nem személyesíthet meg másik forrást.

## Scope

1. Közös authorization service/policy és explicit műveletkatalógus.
2. REST knowledge szigetkötése a hitelesített contexthez.
3. TMB read/get/append/complete ownership- és szigetellenőrzése.
4. Federation source binding, destination policy és message-level authorization.
5. Epic-router és minden mutációs route least-privilege védelme.
6. Auditált deny-ok titok és érzékeny payload nélkül.

## Elfogadási feltételek

- [ ] Minden route/tool közös policy-döntést használ vagy indokolt kivételként dokumentált.
- [ ] Kliens `island`, `from_island` vagy `terminal` mezője nem növel jogosultságot.
- [ ] IDOR, role escalation, cross-island read/write és impersonation teszt negatív.
- [ ] Root/conductor kivételek explicit, minimálisak és auditáltak.
- [ ] Open mód productionként nem indítható dokumentált, explicit override nélkül.

## Kötelező ellenőrzés

Táblavezérelt auth-mátrix teszt minden szerepre és interfészre; required módban
valós HTTP+MCP integrációs teszt, külön cross-island támadási esetekkel.

## Kilépési feltétel

`done`, ha nincs közvetlen, policy-t megkerülő erőforrás-hozzáférési útvonal és
a negatív izolációs suite zöld. Nyitott kritikus IDOR esetén nem zárható le.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
