---
id: TASK-ISL-010
title: Antigravity CLI adapter Windows és Linux környezetre
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M3
epic: ISL-CLI-ADAPTERS
status: blocked
blocked_reason: >
  TASK-ISL-007 még in_progress. Az Antigravity adapter kódja elkészült, de az
  aktuális `agy --help` capability-felderítés és a valós Linux/Windows auth-
  golden-path evidence hiányzik. Feloldás: contract done és 2 platform PASS.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-007]
parallel_with: [TASK-ISL-008, TASK-ISL-009]
owner_role: platform-antigravity
created: 2026-07-18
source: Google Antigravity CLI official codelabs, TASK-ISL-007
---

# Antigravity CLI adapter Windows és Linux környezetre

## Cél

Az Antigravity CLI (`agy`) valós, telepített verzióját capability discoveryvel
integrálni, headless mód esetén stdio, egyébként izolált PTY lifecycle használatával.

## Mikor jó?

Az `agy` ugyanabba a lease-, process-, event- és completion-szerződésbe illeszkedik,
mint a Codex és Claude, dokumentált permission móddal és valós platformbizonyítékkal.

## Scope

1. Telepítés, verzió és flag discovery `agy --help` és hivatalos dokumentáció alapján.
2. Külön capability: headless, structured output, PTY, resume, MCP, sandbox.
3. Ha van stabil headless mód, azt használd; egyébként robusztus PTY-adapter kell.
4. Permission módok explicit mappingje; hoston korlátlan auto-approve ne legyen default.
5. Prompt/input, progress, tool action, completion és error normalizálása.
6. OAuth/login igényt előflight ellenőrzés jelezze; auth adat ne kerüljön logba.
7. Cancellation, timeout, terminal resize/EOF és process-tree cleanup.

## Nem cél

- Antigravity IDE GUI automatizálása a CLI helyett.
- Nem dokumentált flag vagy belső protokoll beégetése.

## Elfogadási feltételek

- [ ] Az aktuális `agy` capability riport artifactként rögzített.
- [ ] Linux és Windows célkörnyezet valós golden taskot futtat.
- [ ] Headless hiányában a PTY adapter determinisztikus timeout/cancel kezelést ad.
- [ ] Permission kérés nem okoz végtelenül függő lease-t.
- [ ] Ismeretlen CLI-verzió fail-closed vagy explicit kompatibilitási módban indul.
- [ ] A core runnerben nincs Antigravity-specifikus elágazás.

## Kötelező platformbizonyíték

- `windows-native + agy`, vagy a hivatalos támogatási út pontos címkéje
- `linux-native + agy`

Ha a telepített kiadás nem kínál automatizálható CLI felületet, a helyes eredmény
`UNSUPPORTED` és a task `blocked`; GUI-makró nem elfogadható helyettesítés.

## Kilépési feltétel

`done`, ha mindkét célplatformon valós PASS és a permission/lifecycle szerződés
bizonyított. Dokumentáció és binary ellentmondásakor a tényleges verziót és a
forrásdátumot rögzíteni, majd döntést kérni kell.

## Végrehajtási napló

### 2026-07-21 — kódszintű checkpoint

Az `agy` provider adapter, registry-kötés, lokális capability discovery,
shell nélküli spawn-spec és normalizált lifecycle varrat elkészült; a stub/unit
teszt PASS. Aktuális telepített binary és autholt Linux/Windows golden-path nem
állt rendelkezésre, ezért a helyes eredmény **BLOCKED**, nem mock-PASS.
