---
id: TASK-ISL-017
title: Független szigetizolációs, 3×2 platform- és chaos-ellenőrzés
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M5
epic: ISL-INDEPENDENT-VERIFICATION
status: blocked
blocked_reason: >
  A közvetlen TASK-ISL-001…016 függőségek közül csak TASK-ISL-001 done. A
  Linux Codex rollout canary előzetes evidence, nem a független 3×2 E2E/chaos
  kapu. Feloldás: minden feature- és dokumentációs task done, majd friss,
  kivitelezéstől független reviewer teljes mátrix-PASS eredménye.
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-001, TASK-ISL-002, TASK-ISL-003, TASK-ISL-004, TASK-ISL-005, TASK-ISL-006, TASK-ISL-007, TASK-ISL-008, TASK-ISL-009, TASK-ISL-010, TASK-ISL-011, TASK-ISL-012, TASK-ISL-013, TASK-ISL-014, TASK-ISL-015, TASK-ISL-016]
parallel_with: []
owner_role: independent-reviewer
created: 2026-07-18
source: QUALITY.md sections 4 and 8, island readiness acceptance criteria
---

# Független szigetizolációs, 3×2 platform- és chaos-ellenőrzés

## Cél

A kivitelezésben részt nem vevő, friss kontextusú reviewer próbálja megcáfolni,
hogy a rendszer garantált szigetüzemre és többplatformos CLI agentfuttatásra kész.

## Mikor jó?

Minden programinvariáns reprodukálható PASS, a 3 CLI × 2 OS valós mátrix teljes,
és nincs nyitott kritikus vagy magas eltérés.

## Feloldási feltétel

TASK-ISL-001…016 mind `done`, teljes Implementáció szekcióval és külön reviewer-
bizonyítékkal. A task implementálója nem lehet korábbi task készítője.

## Kötelező tesztmátrix

| CLI | Windows | Linux |
|---|---|---|
| Codex | valós golden task + crash/cancel | valós golden task + crash/cancel |
| Claude Code | valós golden task + crash/cancel | valós golden task + crash/cancel |
| Antigravity | valós golden task + crash/cancel | valós golden task + crash/cancel |

A Windows execution pathot pontosan címkézni kell. WSL nem írható Windows-native
PASS-nak. Minden cellához platform evidence YAML és redaktált log tartozik.

## Adverzáriális scope

1. Két sziget azonos `backend` terminállal: cross-read/write/complete támadás.
2. 20 runner egyidejű claimje ugyanarra a taskra.
3. Runner kill, service restart, stale lease owner késői completionje.
4. SSE kiesés, hálózatszakadás, relay restart, ACK drop és duplicate replay.
5. Review-, budget- és dependency-kapu megkerülési próbák minden API-n.
6. Hamis `from_island`, message IDOR, role escalation és revokált runner.
7. Canonical store migráció, backup/restore és fájlprojekció újraépítése.
8. Windows reboot/service recovery és Linux reboot/systemd recovery.
9. Secret-canary logredaction és path/command injection próbák.
10. Dokumentációból clean-room setup és rollback.

## Elfogadási feltételek

- [ ] A 3×2 valós platformmátrix mind a hat cellája PASS.
- [ ] Cross-island hozzáférési tesztek minden interfészen deny eredményt adnak.
- [ ] Konkurenciatesztben egyetlen claim és egyetlen üzleti completion történik.
- [ ] Crash/restart után nincs elveszett task vagy párhuzamos aktív lease.
- [ ] Federation outage/replay idempotens és DLQ-val helyreállítható.
- [ ] Review/budget/dependency kapu egyik interfészen sem kerülhető meg.
- [ ] Backup/restore, reboot és clean-room setup reprodukálható.
- [ ] CI-equivalent suite, typecheck, lint, coverage, audit és linkkapu zöld.
- [ ] Nincs nyitott kritikus/magas finding.
- [ ] Minden state/memory/todo/EPICS/task állapot egyezik.

## Átadandó bizonyíték

- Követelmény→teszt→artifact mátrix.
- Minden parancs, dátum, OS/shell/CLI-verzió és exit code.
- Findinglista prioritással, reprodukcióval és fájl/sor hivatkozással.
- PASS esetén lezárási jelentés; FAIL esetén újranyitott taskok.

## Kilépési feltétel

- `done`: minden feltétel PASS, nincs kritikus/magas finding.
- `ready`: bármely bizonyíték hiányzik vagy reprodukálható hiba maradt.
- `blocked`: külső auth/licenc/hardver vagy emberi döntés nélkül nem folytatható,
  pontos feloldási feltétellel.

Waiver nem változtathat FAIL/UNSUPPORTED eredményt PASS-ra. A program csak e task
`done` állapota után zárható le.

## Végrehajtési napló

Az independent reviewer a program README protokollja szerint tölti ki.
