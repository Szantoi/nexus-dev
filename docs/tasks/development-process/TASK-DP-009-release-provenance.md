---
id: TASK-DP-009
title: "Release provenance, smoke, canary és rollback"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M4
epic: DP-RELEASE-CONTROLS
status: blocked
blocked_reason: >
  Nem indítható, amíg TASK-DP-007, TASK-DP-008 el nem készül (a program README
  végrehajtási hulláma szerinti sorrend).
priority: critical
depends_on: [TASK-DP-006, TASK-DP-007, TASK-DP-008]
parallel_with: []
owner_role: release-manager
created: 2026-07-18
source: "DEVPROC-08 and DEVPROC-10"
---

# Release provenance, smoke, canary és rollback

## Cél

Csak zöld, review-zott commitból előállított, checksumolt artifact kerülhessen
környezetbe, és a deploy, smoke/canary, health és rollback ugyanahhoz a release
manifesthez tartozzon.

## Mikor jó?

Egy futó példányról visszakereshető a task, commit, CI, reviewer és artifact;
hibás build, smoke vagy health esetén a release megáll vagy automatikusan az
előző bizonyított verzióra áll vissza.

## Scope

1. Definiálj release manifestet task/PR, commit, CI run, reviewer, artifact
   checksum, dependency lock, build environment és konfigurációs séma adatokkal.
2. Az artifact egyszer készüljön; stage/prod ugyanazt a változatlan artifactot
   használja környezeti titkok beégetése nélkül.
3. Kösd össze a preflight, backup, migráció, deploy, health, smoke/canary és
   rollback lépést egy véges, auditált workflow-ba.
4. Tarts dry-run és hermetikus deploy-fixture módot Windowson és Linuxon.
5. Jelöld és fail-closed módon tereld biztonságos útra a régi veszélyes
   `scripts/deploy-to-prod.sh` használatát.
6. Rögzíts RTO/RPO, retry/timeout és emberi jóváhagyási kapukat.
7. A logokból redaktáld a tokent, env-értéket és érzékeny hostadatot.

## Elfogadási feltételek

- [ ] Release nem indul hiányzó task, zöld CI vagy független review nélkül.
- [ ] Artifact checksum build és deploy előtt/után egyezik.
- [ ] Smoke vagy health hiba bizonyítottan rollbacket vagy biztonságos leállást
  okoz.
- [ ] Migrációs hiba nem hagy félaktív release-t vagy ismeretlen DB-verziót.
- [ ] A futó `/health` vagy verzió endpoint a release ID-t és commitot jelzi
  titok nélkül.
- [ ] A korábbi artifact és konfiguráció rollbackhez elérhető és ellenőrzött.
- [ ] Éles deployhoz explicit emberi jóváhagyás és külön auditbejegyzés kell.

## Kötelező ellenőrzés

Hermetikus dry-run sikerrel, hibás teszttel, hibás builddel, checksum-eltéréssel,
health timeouttal, smoke hibával és rollbackkel. Valós non-production canary
szükséges; production deploy nem kötelező e task lezárásához, de ha történik,
külön jóváhagyással és bizonyítékkal történjen.

## Kilépési feltétel

`done`, ha a teljes release state machine és rollback non-production
környezetben reprodukált, a manifest végig ugyanarra a commitra mutat, és a régi
megkerülő út nem használható véletlenül. Éles bizonyítás hiányát dokumentáld,
de ne állíts production PASS-t.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.
