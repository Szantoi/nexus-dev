---
id: TASK-DP-008
title: "Független review és archiválási kapu"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M3
epic: DP-REVIEW-GOVERNANCE
status: blocked
blocked_reason: >
  Nem indítható, amíg TASK-DP-004 el nem készül (a program README
  végrehajtási hulláma szerinti sorrend).
priority: critical
depends_on: [TASK-DP-004, TASK-DP-006, TASK-DP-007]
parallel_with: []
owner_role: quality-engineer
created: 2026-07-18
source: "DEVPROC-06 and DEVPROC-10"
---

# Független review és archiválási kapu

## Cél

A készítőtől független review minden task és változásegység kötelező,
géppel ellenőrizhető életciklus-átmenete legyen, és bizonyíték nélkül ne lehessen
`done` vagy archivált állapotot létrehozni.

## Mikor jó?

Az implementáló nem tudja saját munkáját elfogadni; a reviewer döntése az adott
commit- és CI-verzióhoz kötött; új commit érvényteleníti; az archiválás csak PASS
után lehetséges.

## Scope

1. Definiálj review record sémát: task, implementáló, reviewer, függetlenség,
   commit, CI run, scope, döntés, findingok és timestamp.
2. Integráld a review-t a DP-004 lifecycle-ba és a DP-006 PR-folyamatba.
3. Különítsd el a `PASS`, `FAIL`, `REQUEST_CHANGES` és kivétel/escalation
   átmeneteket.
4. Az archive művelet validálja az Implementáció szakaszt, evidence manifestet,
   state syncet és review recordot.
5. Új diff vagy lejárt CI esetén tedd stale-lé a korábbi review-t.
6. Biztosíts adverzáriális review-checklistet biztonságra, adatvesztésre,
   rollbackre, cross-platform működésre és scope-túllépésre.
7. Dokumentáld az emberi és CLI-agent reviewer identitásának auditálását.

## Elfogadási feltételek

- [ ] Az implementáló és reviewer azonossága fail-closed hibát ad.
- [ ] Review csak zöld, azonos commitra mutató required CI mellett PASS-olhat.
- [ ] Új commit után a korábbi PASS nem enged archive-ot vagy merge-et.
- [ ] `done` és archive hiányos Implementáció/evidence esetén elutasított.
- [ ] Finding és döntés append-only auditban megmarad.
- [ ] A reviewer a task összes acceptance és exit feltételét tételesen értékeli.
- [ ] A coordinator archive művelete idempotens és visszaellenőrizhető.

## Kötelező ellenőrzés

Negatív teszt önreview-val, stale review-val, más commitra mutató CI-vel, hiányos
evidence-szel és közvetlen fájlmozgatással; pozitív teszt külön reviewerrel és
teljes lifecycle-lal. A teszt ne igényeljen éles merge-et.

## Kilépési feltétel

`done`, ha az önreview és a bizonyíték nélküli lezárás minden támogatott
belépési ponton blokkolt, és egy mintatask külön reviewerrel archiválható. Ha
valamelyik legacy út megkerüli a kaput, a task nem zárható le.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
