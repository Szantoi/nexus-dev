---
id: TASK-ISL-012
title: Linux runner host, systemd és process izoláció
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M3
epic: ISL-CROSS-PLATFORM-HOSTS
status: blocked
blocked_reason: >
  A közvetlen függőségek (TASK-ISL-006, TASK-ISL-008, TASK-ISL-009,
  TASK-ISL-010) nem done állapotúak. A Linux Codex út operatív PASS, de a
  kötelező Claude/Antigravity, reboot, forced-kill és jogosultsági negatív
  mátrix hiányzik. Feloldás: a függőségek és a teljes Linux evidence lezárása.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-006, TASK-ISL-008, TASK-ISL-009, TASK-ISL-010]
parallel_with: [TASK-ISL-011]
owner_role: linux-platform
created: 2026-07-18
source: Linux CLI runner requirement
---

# Linux runner host, systemd és process izoláció

## Cél

A runner támogatott Linux-disztribúción nem-root systemd service-ként induljon,
és biztonságosan kezelje mindhárom CLI agent processzcsoportját.

## Mikor jó?

Boot, SIGTERM, runner crash, service restart és host reboot után ownership- és
processzszivárgás nélkül helyreáll, és mindhárom CLI golden taskja végigfut.

## Scope

1. Támogatott disztribúció, shell és Node runtime baseline.
2. Idempotens systemd unit/install/start/stop/status/uninstall folyamat.
3. Dedikált nem-root user, szűk filesystem- és network-jogosultság.
4. Secret/config systemd credential/env-file védelemmel, logredactionnel.
5. Process group/cgroup, SIGTERM→grace→SIGKILL és child cleanup.
6. Working directory, PATH és CLI binary discovery determinisztikus kezelése.
7. journald/fájllog, rotáció és reboot recovery.

## Nem cél

- Rootként futó agent CLI.
- Tmux jelenlétének kötelezővé tétele headless runnerhez.

## Elfogadási feltételek

- [ ] Reboot után a runner emberi beavatkozás nélkül online lesz.
- [ ] Service user csak engedélyezett workspace-eket ér el.
- [ ] Codex, Claude és Antigravity valós Linux hoston PASS.
- [ ] SIGTERM/kill után nincs árva process, a lease rendeződik.
- [ ] Unit hardening és hálózati policy dokumentált és ellenőrzött.
- [ ] Install/uninstall idempotens, rollback reprodukálható.

## Kötelező ellenőrzés

Valós Linux VM/gép: install, daemon-reload, reboot, három CLI smoke, concurrent
task, SIGKILL, network/auth hiba, permission negatív teszt és újratelepítés.

## Kilépési feltétel

`done`, ha a Linux evidence mindhárom CLI-hez PASS és a service nem rootként fut.
Konténeres mock nem helyettesíti a reboot/systemd bizonyítékot.

## Végrehajtási napló

### 2026-07-21 — előzetes Linux Codex rollout evidence

- **Goal:** nem-root systemd runnerrel igazolni a Codex headless
  mailbox→claim→CLI→MCP→completion láncot.
- **Sikerkritérium:** aktív/engedélyezett runner és timer; read-only és
  workspace-write canary; duplikált indítás elleni guard; rollback.
- **Kilépési feltétel:** a Codex rész PASS, minden hiányzó TASK-ISL-012 feltétel
  explicit nyitott marad; `done` csak a teljes három-CLI és recovery mátrix után.

Debian 13 (trixie), x86_64, bash 5.2.37, Node v22.22.1, Codex 0.144.6:

- `joinerytech-codex-runner.service`: enabled + active, nem-root `gabor` user;
- `joinerytech-autonomy-enqueue.timer`: enabled + active;
- `KillMode=control-group`, `NoNewPrivileges=true`, `ProtectSystem=full`,
  explicit `ReadWritePaths`;
- `MSG-EXPLORER-025` read-only és `MSG-EXPLORER-026` workspace-write PASS;
- `MSG-CONDUCTOR-049` valós időzített autonóm ciklus szabályosan eszkalált és
  tartósan lezárt;
- blokkolt Conductor-state mellett az enqueue oneshot ismétlés nélkül skipel;
- backup-first configure, workspace-write promóció és rollback dry-run PASS.

Maradó: Claude/Antigravity valós smoke, reboot, SIGKILL, negatív permission és
clean reinstall. Emiatt a task továbbra is `blocked`. Részletes runbook:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.
