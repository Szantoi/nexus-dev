---
id: TASK-ISL-008
title: Codex CLI adapter Windows és Linux környezetre
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M3
epic: ISL-CLI-ADAPTERS
status: blocked
blocked_reason: >
  TASK-ISL-007 még in_progress, és a kötelező Windows-native Codex smoke a
  codex-windows-sandbox-setup.exe hozzáférési hibáján blokkolt. Feloldás: az
  adaptercontract lezárása, a Windows sandbox helper helyreállítása és a teljes
  Windows mailbox→runner→Codex→MCP canary PASS.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-007]
parallel_with: [TASK-ISL-009, TASK-ISL-010]
owner_role: platform-codex
created: 2026-07-18
source: Codex CLI official manual, TASK-ISL-007
---

# Codex CLI adapter Windows és Linux környezetre

## Cél

A runner a Codex CLI stabil, non-interaktív felületén biztonságosan tudjon taskot
indítani, eseményt feldolgozni, megszakítani és eredményt lezárni.

## Mikor jó?

Ugyanaz a golden task Codexszel Windows és Linux hoston strukturált, auditálható
eredményt ad, a lease és a process lifecycle megtartásával.

## Scope

1. Capability discovery `codex --version` és a telepített verzió helpje alapján.
2. Elsődleges automatizálási út: `codex exec`, gépi JSONL kimenettel.
3. Explicit working directory, sandbox és approval policy; deprecated
   `--full-auto` és veszélyes bypass ne legyen alapértelmezett.
4. Prompt/context stdin vagy biztonságos argumentlista útján, parancsinjekció nélkül.
5. Eventnormalizálás, session/thread azonosító, final output és token usage.
6. Cancellation, timeout, resume támogatás csak dokumentált capability esetén.
7. Auth-hiba legyen redaktált és actionable; API key ne legyen tartós logban.

## Nem cél

- Codex UI automatizálása.
- Nem dokumentált belső fájlformátumok parszerelése.

## Elfogadási feltételek

- [ ] Windows és Linux valós `codex exec` smoke PASS.
- [ ] JSONL progress, completion és failure események helyesen normalizáltak.
- [ ] Workspace-write csak az adott task policyja alapján engedélyezhető.
- [ ] Cancel/timeout után nem marad árva Codex- vagy child process.
- [ ] Verzió- vagy capability-eltérés jól érthető `unsupported/blocked` eredményt ad.
- [ ] Unit teszt stub CLI-val, integrációs teszt valós CLI-val rendelkezésre áll.

## Kötelező platformbizonyíték

- `windows-native + codex`
- `linux-native + codex`

Mindkettőn verzió, shell, parancsszerződés, exit code és redaktált log artifact.

## Kilépési feltétel

`done`, ha mindkét valós platform PASS. Hiányzó auth/telepítés esetén `blocked`,
nem mock-PASS. Veszélyes permission bypass nem fogadható el kompatibilitási javításként.

## Végrehajtási napló

### 2026-07-21 — előzetes implementációs és platformevidence

- **Goal:** a Codex CLI-t elsődleges, headless providerként működtetni a Linux
  VPS-en explicit sandboxdal, terminal-scoped MCP auth-tal és JSONL eseményekkel.
- **Sikerkritérium:** read-only, majd workspace-write canary teljes
  fetch→ack→work→complete útja exit 0-val és tartós completionnel.
- **Kilépési feltétel:** a Linux rész PASS; a task csak Windows-native PASS és
  TASK-ISL-007 lezárása után léphet `in_progress`, majd review után `done`
  állapotba.

Linux-native eredmény: **PASS** (Debian 13, bash 5.2.37, Node v22.22.1,
Codex 0.144.6). `MSG-EXPLORER-025` read-only és `MSG-EXPLORER-026`
workspace-write canary: MCP fetch/ack/complete PASS, helyes workdir és
`AGENTS.md`, tiszta fájlírási próba, exit 0, final `completed`.

A headless MCP-hívásokhoz a lokális MCP szervereken
`default_tools_approval_mode="approve"` szükséges; az általános
`approval_policy="never"` önmagában nem elég. A szerveroldali terminal-tokenes
authorizáció marad a kötelező enforcement boundary.

Windows-native eredmény: **BLOCKED** (Windows 11 10.0.26200, PowerShell
5.1.26100.8875, Node v24.13.0, Codex 0.144.5): a Codex command execution a
`codex-windows-sandbox-setup.exe` access denied hibán megáll; használható WSL
disztribúció nincs. Mockkal nem minősítettük PASS-nak.

Részletes evidence:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.
