---
id: TASK-ISL-013
title: Egyetlen launch authority és kikényszerített task workflow
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M4
epic: ISL-WORKFLOW
status: blocked
blocked_reason: >
  A közvetlen TASK-ISL-003…007 függőségek nem done állapotúak. A VPS rollout
  operatív single-launch prototípust ad, de nem helyettesíti a kanonikus
  store/lease/review/budget/dependency állapotgépet. Feloldás: minden függőség
  done és az ADR-081 teljes launch-leltárának kód- és E2E bizonyítása.
updated: 2026-07-21
priority: critical
depends_on: [TASK-ISL-003, TASK-ISL-004, TASK-ISL-005, TASK-ISL-006, TASK-ISL-007]
parallel_with: [TASK-ISL-014]
owner_role: backend
created: 2026-07-18
source: SZIGET-07 and SZIGET-08
---

# Egyetlen launch authority és kikényszerített task workflow

## Cél

Minden task ugyanazon queue/lease útvonalon induljon, és a completion, review,
budget, dependency és eszkaláció egyetlen kanonikus állapotgép része legyen.

## Mikor jó?

Ugyanazt a taskot nem indíthatja el külön service watcher és külső runner; review-
köteles task nem juthat közvetlenül `completed` állapotba.

## Scope

1. Jelöld ki és kódban kényszerítsd ki az egyetlen launch authorityt.
2. A watcher/SSE csak durable queue wake-up legyen, ne ownershipforrás.
3. Vond össze a mailbox, Epic Router és TMB completion útvonalait.
4. Állapotgép: queued→leased→running→review_pending→completed/blocked/DLQ.
5. Budget, attempt és dependency ellenőrzés az atomi claim előtt.
6. Review eredmény, reviewer identity és bizonyíték tartós tárolása.
7. Feature flag és visszagörgetési terv a legacy launch út kivezetésére.

## Elfogadási feltételek

- [ ] Egy taskból egyetlen launch event és lease keletkezik.
- [ ] Service watcher + runner együttes konfigurációja sem duplikál indítást.
- [ ] Review-köteles task review nélkül nem complete-elhető sem REST-en, sem MCP-n.
- [ ] Budget/dependency sértés claim előtt actionable állapotot ad.
- [ ] Minden transition historyval és hitelesített actorral rögzített.
- [ ] Legacy út kikapcsolható és eltávolítási tervvel rendelkezik.

## Kötelező ellenőrzés

Két launch authority szimulált versenye, minden API completion útvonal, review
PASS/FAIL, budget exhaustion, dependency blocked, service restart és replay.

## Kilépési feltétel

`done`, ha kódkereséssel és E2E teszttel is bizonyított, hogy csak a kanonikus
claim ad végrehajtási jogot. Kettős launch reprodukció mellett tilos lezárni.

## Végrehajtási napló

### 2026-07-21 — operatív single-launch checkpoint

- **Goal:** a JoineryTech deploymenten megszüntetni a watcher/legacy launcher és
  külső runner közötti kettős sessionindítás lehetőségét.
- **Sikerkritérium:** watcher csak SSE wake; legacy launcherek off; runner claim
  indítás előtt; terminálonként aktív marker; refusal esetén release; completion
  csak tartós MCP `complete_task` után.
- **Kilépési feltétel:** a deployment-checkpoint PASS, de TASK-ISL-013 csak a
  teljes ADR-081 hívásgráf és kanonikus workflow tesztje után lehet `done`.

A felsorolt guardok megvalósultak. A régi JoineryTech tmux agent-sessionök
leálltak; a root és monitor tudatosan megmaradt. A read-only és write canary,
valamint az első időzített Conductor-ciklus nem duplikálódott. A jelen claim a
legacy terminálcontextre épül, ezért nem minősül atomi lease/fencing
megoldásnak. A task státusza változatlanul `blocked`. Részletek:
`docs/knowledge/codex-autonom-runner-vps-uzemeltetes.md`.
