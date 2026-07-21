---
id: TASK-DP-011
title: "Független végponttól végpontig folyamat-audit"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M4
epic: DP-INDEPENDENT-VERIFICATION
status: blocked
blocked_reason: >
  Nem indítható, amíg TASK-DP-004 … TASK-DP-010 el nem készül (a program README
  végrehajtási hulláma szerinti sorrend).
priority: critical
depends_on: [TASK-DP-001, TASK-DP-002, TASK-DP-003, TASK-DP-004, TASK-DP-005, TASK-DP-006, TASK-DP-007, TASK-DP-008, TASK-DP-009, TASK-DP-010]
parallel_with: []
owner_role: independent-reviewer
created: 2026-07-18
source: "DEVPROC-01 through DEVPROC-10"
---

# Független végponttól végpontig folyamat-audit

## Cél

Friss kontextusú, a DP-001…010 kivitelezésében részt nem vevő reviewer
adverzáriálisan bizonyítsa, hogy a fejlesztési folyamat dokumentált és tényleges
kontrolljai a goaltól a release- és állapotszinkronig működnek.

## Mikor jó?

Egy reprezentatív, nem éles mintaváltozás végigmegy a teljes láncon Windows és
Linux bizonyítékkal; minden megkerülési próba elbukik; nincs kritikus vagy magas
finding; az audit reprodukálható PASS jelentést ad.

## Scope

1. Ellenőrizd a 10 előfeltétel-task státuszát, evidence manifestjét, commitját,
   CI-jét és reviewerfüggetlenségét.
2. Tiszta környezetben hozz létre biztonságos mintataskot explicit goallal,
   sikerkritériummal és kilépési feltétellel.
3. Vidd végig a start → checkpoint → commit/PR → Linux/Windows CI → review →
   merge-szimuláció/non-prod merge → release dry-run/canary → archive →
   state-sync láncon.
4. Próbáld meg megkerülni a task-sémát, dependencyt, ownershipot, required CI-t,
   önreview-tilalmat, stale review-t, archive- és release-kaput.
5. Injektálj félbeszakított state transitiont, projekcióeltérést, CI-hibát és
   smoke/health hibát; ellenőrizd a recoveryt.
6. Készíts findinglistát severityvel, reprodukcióval, bizonyítékkal és ownerrel.
7. A reviewer nem javíthatja saját auditfindingját; külön follow-up task kell.

## Elfogadási feltételek

- [ ] A reviewer bizonyítottan független minden DP implementációtól.
- [ ] A teljes happy path ugyanarra a task- és commitazonosítóra mutat.
- [ ] Windows és Linux required ellenőrzés PASS.
- [ ] Minden kötelező negatív megkerülési próba blokkolt.
- [ ] Crash/reconciliation és release rollback helyreállítja az invariánsokat.
- [ ] Task, EPICS, state, todo és memória végállapota konzisztens.
- [ ] Nincs nyitott kritikus vagy magas finding.
- [ ] Az auditjelentés tételes végső döntése `PASS`.

## Kötelező ellenőrzés

A program minden „Mikor jó?” pontjához és a knowledge dokumentum minden
DEVPROC findingjához külön evidence-hivatkozás szükséges. A reviewer rögzítse az
OS-, shell-, Node-, Git- és toolverziókat, parancsokat és exit code-okat. Éles
deploy nem szükséges; a non-production release és rollback valós legyen.

## Kilépési feltétel

`done` kizárólag PASS auditjelentéssel, nulla nyitott kritikus/magas findinggal
és konzisztens állapotprojekciókkal. FAIL esetén az érintett taskot vissza kell
nyitni vagy új javító taskot kell létrehozni; a program nem zárható le.

## Végrehajtási napló

A reviewer a program README evidence sémája szerint tölti ki. A saját auditját
nem review-zhatja; a program lezárását a coordinator rögzíti.
