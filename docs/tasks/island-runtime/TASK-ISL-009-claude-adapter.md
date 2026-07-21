---
id: TASK-ISL-009
title: Claude Code CLI adapter Windows és Linux környezetre
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M3
epic: ISL-CLI-ADAPTERS
status: blocked
blocked_reason: >
  TASK-ISL-007 még in_progress. A Claude adapter kódja elkészült, de a kötelező
  valós Linux/Windows auth- és golden-path evidence hiányzik. Feloldás:
  adaptercontract done és mindkét valós platform PASS.
updated: 2026-07-21
priority: high
depends_on: [TASK-ISL-007]
parallel_with: [TASK-ISL-008, TASK-ISL-010]
owner_role: platform-claude
created: 2026-07-18
source: Anthropic Claude Code CLI reference, TASK-ISL-007
---

# Claude Code CLI adapter Windows és Linux környezetre

## Cél

A meglévő Claude-specifikus runnerindítást szabványos adapterré alakítani,
strukturált outputtal, explicit tool- és turnkerettel, Windows/Linux támogatással.

## Mikor jó?

A Claude adapter nem szivárog a core runnerbe, és valós környezetben ugyanazt a
task lifecycle-t biztosítja, mint a többi CLI adapter.

## Scope

1. Capability discovery `claude --version`, `claude --help` és `claude doctor` alapján.
2. Automatizálási út: `claude -p`, dokumentált `json` vagy `stream-json` outputtal.
3. Explicit `--max-turns`, model és allowed/disallowed tool policy.
4. Permission prompt és emberi kapu kezelése; veszélyes permission skip ne legyen default.
5. Session ID/resume csak stabil, dokumentált felületen.
6. Cancellation, timeout, process-tree cleanup és auth-error redaction.
7. Windows esetén dokumentáld, hogy native, Git for Windows vagy WSL út futott.

## Nem cél

- Tmux vagy képernyőtartalom alapján Claude-specifikus állapotdetektálás megtartása.
- Nem támogatott CLI flag feltételezése.

## Elfogadási feltételek

- [ ] Linux natív és hivatalosan támogatott Windows execution path valós PASS.
- [ ] Strukturált stream hiba, partial output és non-zero exit kezelve.
- [ ] Turn/tool budget kimerülése normalizált blocked/failed állapotot ad.
- [ ] Cancel után nincs árva CLI vagy child process.
- [ ] A core runnerben nincs Claude-specifikus command vagy output parser.

## Kötelező platformbizonyíték

- `linux-native + claude`
- `windows-native + claude`, vagy gyártó által támogatott Windows út pontos
  `windows-wsl`/Git Bash megjelöléssel; a kettőt tilos összemosni.

## Kilépési feltétel

`done`, ha mindkét célkörnyezet valós PASS és a permission policy least-privilege.
Licenc-, auth- vagy platformhiány esetén `blocked` a feloldási lépéssel.

## Végrehajtási napló

### 2026-07-21 — kódszintű checkpoint

A provider adapter `claude -p` argumentlistát, strukturált output módot,
`max_turns` és `max_budget_usd` lokális configot, shell nélküli spawn-specet és
normalizált lifecycle eseményeket ad. A stub/unit teszt PASS. Valós autholt
Linux/Windows futás nem történt, ezért ez nem platform-PASS és a task `blocked`.
Következő lépés: aktuális hivatalos CLI capability ellenőrzés, majd két valós
golden-path és cancel/budget teszt.
