---
id: TASK-ISL-007
title: Platformfüggetlen CLI-adapter és process supervisor szerződés
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M3
epic: ISL-CLI-ADAPTERS
status: in_progress
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-001]
parallel_with: [TASK-ISL-002, TASK-ISL-004]
owner_role: platform
created: 2026-07-18
source: cross-platform CLI requirement and SZIGET-07
---

# Platformfüggetlen CLI-adapter és process supervisor szerződés

## Cél

A runner ne Claude-specifikus folyamatot indítson, hanem egységes, tesztelhető
adapteren keresztül kezeljen headless és PTY-alapú CLI agenteket Windows és Linux alatt.

## Mikor jó?

Új CLI támogatása a core poll/lease logika módosítása nélkül, egy adapterrel
megoldható; a process lifecycle és a strukturált események minden platformon azonosak.

## Scope

1. `detect`, `version`, `capabilities`, `launch`, `send`, `events`, `cancel`,
   `resume`, `terminate`, `health` adapter contract.
2. Headless stdio és interaktív PTY capability külön kezelése.
3. Strukturált normalizált eventek: started, progress, tool, output, blocked,
   completed, failed, cancelled.
4. Cross-platform spawn argumentlistával, shell-injection nélkül.
5. Process-tree leállítás, timeout, output limit, backpressure és secret redaction.
6. Adapterverziózás, capability negotiation és fake adapter tesztharness.
7. Explicit sandbox/permission policy; veszélyes auto-approve ne legyen default.

## Elfogadási feltételek

- [ ] Core runner nem tartalmaz Codex/Claude/Antigravity-specifikus elágazást.
- [ ] Headless és PTY adapter ugyanarra a lifecycle-re normalizálható.
- [ ] Args/prompt nem kerül shell string interpolációba.
- [ ] Cancel/timeout a teljes processzfát lezárja Windowson és Linuxon.
- [ ] Kimeneti limit és hibás JSON/stream nem dönti le a runnert.
- [ ] Fake adapterrel minden lifecycle-ág determinisztikusan tesztelt.

## Kötelező ellenőrzés

Windows és Linux CI-fixture, unicode/space path, nagy stdout/stderr, child tree,
timeout, cancellation, malformed event és secret-redaction teszt.

## Kilépési feltétel

`done`, ha a három valós adapter csak a contractot implementálja, és a platform-
specifikus rész a process supervisor absztrakció mögött marad.

## Végrehajtási napló

### 2026-07-21 — Codex-elsődleges operatív checkpoint

- **Goal:** providerfüggetlen, shell-interpoláció nélküli headless CLI-varrat
  létrehozása, amelyből a Codex Linuxon tartós mailbox-taskot tud végrehajtani.
- **Sikerkritérium:** zárt adapterregistry; validált provider/terminal/model
  konfiguráció; normalizált JSONL lifecycle; timeout/output/process-tree guard;
  unit teszt; valós Linux Codex canary.
- **Kilépési feltétel:** ez a checkpoint akkor zárható, ha a fenti Linux Codex
  út PASS és a hiányzó teljes contractsűrűség külön maradó tételként rögzített.
  A TASK-ISL-007 `done` feltétele továbbra is a teljes headless + PTY, cancel,
  resume, backpressure és mindhárom adapterre alkalmazott contract.
- **Erőforráskeret:** egy implementációs kör; célzott teszt + teljes suite;
  legfeljebb három javítási retry; secret nem kerülhet logba.

Megvalósult:

- `cliAdapter.ts`, `adapterRegistry.ts`, `cliDiscovery.ts` és a három provider-
  adapter elkészült;
- az argv tömbként jut a `spawn` hívásba, `shell` használata nélkül;
- timeout, maximális output, process-tree termination és normalizált eseménylog
  működik;
- a hálózati task csak lokálisan engedélyezett terminált/modellt választhat; a
  binary, provider, sandbox, credential-env és extra argumentum lokális config;
- célzott runner/mailbox/launch-authority tesztek: 6 fájl, 69 teszt PASS;
  typecheck, teljes Vitest suite
  és build PASS.

Valós Linux evidence: Debian 13, x86_64, Node v22.22.1, Codex 0.144.6;
`MSG-EXPLORER-025` read-only és `MSG-EXPLORER-026` workspace-write canary PASS.
Részletes napló és rollback:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.

**Maradó FAIL/nyitott feltétel:** PTY/send/resume nincs teljesen implementálva;
Claude és Antigravity valós adapterbizonyítéka hiányzik; a natív Windows Codex
smoke sandbox-helper jogosultsági hibán blokkolt. Emiatt a task `in_progress`,
nem `done`, és független review még szükséges.
