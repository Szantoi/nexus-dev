---
id: TASK-ISL-011
title: Windows runner host, szolgáltatás és process izoláció
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M3
epic: ISL-CROSS-PLATFORM-HOSTS
status: blocked
blocked_reason: >
  A közvetlen függőségek (TASK-ISL-006, TASK-ISL-008, TASK-ISL-009,
  TASK-ISL-010) nem done állapotúak. A helyi Windows-native Codex smoke ezen
  felül a codex-windows-sandbox-setup.exe hozzáférési hibáján blokkolt.
  Feloldás: függőségek lezárása, sandbox helper javítása, majd szolgáltatás-,
  reboot-, process-tree- és három-CLI evidence PASS.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-006, TASK-ISL-008, TASK-ISL-009, TASK-ISL-010]
parallel_with: [TASK-ISL-012]
owner_role: windows-platform
created: 2026-07-18
source: Windows CLI runner requirement
---

# Windows runner host, szolgáltatás és process izoláció

## Cél

A runner natív Windows hoston automatikusan, least-privilege szolgáltatásként
induljon, és biztonságosan kezelje mindhárom CLI agent processzfáját.

## Mikor jó?

Boot, runner crash, service restart, task cancel és host reboot után nem vész el
ownership, nem marad árva process, és a három CLI golden taskja végigfut.

## Scope

1. Támogatott Windows-verzió, PowerShell és Node runtime baseline.
2. Idempotens install/start/stop/status/uninstall szolgáltatáskezelés.
3. Külön, minimális jogosultságú service account és szűk workspace-hozzáférés.
4. Secret/config tárolás ACL-lel; token nem kerül command line-ba vagy logba.
5. Windows quoting, Unicode/space path, drive/UNC policy és hosszú path kezelés.
6. Process tree/job object alapú cancel/kill, reboot recovery és logrotáció.
7. Native/WSL/Git Bash execution path explicit routingja és címkézése.

## Nem cél

- Admin joggal vagy interaktív desktop sessionnel történő folyamatos futtatás.
- WSL-futás Windows-native bizonyítékként feltüntetése.

## Elfogadási feltételek

- [ ] Reboot után a runner emberi beavatkozás nélkül online lesz.
- [ ] Service account csak engedélyezett workspace-eket ér el.
- [ ] Codex, Claude és Antigravity adapter valós Windows execution pathon PASS.
- [ ] Cancel/crash után nincs árva process, a lease helyesen rendeződik.
- [ ] Install/uninstall ismételhető és rollback dokumentált.
- [ ] Event Log/fájllog alapján egy futás teljesen visszakövethető, titok nélkül.

## Kötelező ellenőrzés

Natív Windows VM/gép: install, reboot, három CLI smoke, concurrent task, forced
kill, service restart, Unicode/space path, ACL negatív teszt és uninstall/reinstall.

## Kilépési feltétel

`done`, ha a Windows evidence három CLI-hez PASS, és nincs admin/desktop session
függés. Reboot nem helyettesíthető unit teszttel.

## Végrehajtási napló

### 2026-07-21 — környezet-felderítési checkpoint

Windows 11 Home 10.0.26200, 64-bit; Windows PowerShell 5.1.26100.8875;
Node v24.13.0; Codex 0.144.5. A natív `codex exec` elindult, de a
command-execution a `codex-windows-sandbox-setup.exe` access denied hibán
megállt. Telepített, használható WSL disztribúció nincs. Eredmény: **BLOCKED**,
nem mock-PASS. Windows service/reboot/cancel/ACL és Claude/Antigravity evidence
még nem készült. Részletek:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.
