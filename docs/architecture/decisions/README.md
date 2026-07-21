# Architecture Decision Records (ADR) — index

Ez a könyvtár a Nexus knowledge-service architektúra-döntéseit rögzíti
(QUALITY.md 2.: a döntéseket ÉS a design intentet is dokumentáljuk).

Új döntéshez használd a [TEMPLATE.md](TEMPLATE.md) sablont, a következő szabad
sorszámmal (jelenleg: **087**).

## A számozásról és a rekonstrukcióról

A nexus-dev repó 2026-07-14-én "Initial commit"-tal (823db70) indult: a korábbi
SpaceOS/Nexus előd-repó ADR-dokumentumai NEM kerültek át, csak a kód, amely
hivatkozik rájuk. A TASK-QC-002 keretében (2026-07-18) a kódban hivatkozott
ADR-eket kódból, tesztekből és git-történetből rekonstruáltuk. Ezért:

- a sorszámozás hiányos (a 001…040, 042…045, 047, 051, 055…058, 061…065 sorszámú
  döntések az előd-repóban éltek, ide nem hivatkozik rájuk semmi — nem
  rekonstruáltuk őket);
- a rekonstruált ADR-ek fejlécében szerepel a bizonyíték; ahol a bizonyíték nem
  volt elegendő, az ADR `proposed` státuszú, nyitott kérdésekkel (review kell);
- történelmet nem írtunk át: az eredeti döntési dátumok ismeretlenségét jelöljük.

## Index

| ADR | Cím | Státusz | Dátum |
|---|---|---|---|
| [ADR-041](ADR-041-graph-based-workflow-architecture.md) | Gráf-alapú workflow-architektúra | accepted (rekonstruált) | ismeretlen |
| [ADR-046](ADR-046-tiered-memory-architecture.md) | Rétegzett memória-architektúra + session-életciklus | accepted (rekonstruált) | ismeretlen |
| [ADR-048](ADR-048-kernel-row-level-security.md) | Kernel domén — RLS minta | **proposed** (bizonyítékhiány) | ismeretlen |
| [ADR-049](ADR-049-dual-session-chat-work-architecture.md) | Dual-session chat/work + párhuzamos workerek | accepted (rekonstruált) | ≤2026-06-29 |
| [ADR-050](ADR-050-code-generation-toolchain.md) | Kódgenerálási eszközlánc + Phase 1 MCP toolok | accepted (részlegesen rekonstruált) | ~2026-07-07 |
| [ADR-052](ADR-052-fsm-subscription-system.md) | FSM feliratkozási rendszer + eszkaláció | accepted (rekonstruált) | 2026-06-30 / 07-02 |
| [ADR-053](ADR-053-mode4-program-awareness.md) | Mode #4 Program-Awareness | accepted (rekonstruált) | 2026-07-02 |
| [ADR-054](ADR-054-crm-lead-opportunity-fsm.md) | CRM domén — Lead/Opportunity FSM | **proposed** (bizonyítékhiány) | ismeretlen |
| [ADR-059](ADR-059-monitor-driven-goal-progression.md) | Monitor-vezérelt cél-progresszió | accepted (rekonstruált) | 2026-07-04 |
| [ADR-060](ADR-060-cli-agnostic-telegram-architecture.md) | CLI-agnosztikus Telegram-architektúra | accepted (rekonstruált) | 2026-07-04 |
| [ADR-066](ADR-066-cross-island-federation.md) | Sziget-közi federáció + kanonikus üzenetmodell | accepted | 2026-07-12 |
| [ADR-067](ADR-067-remove-unused-ddd-scaffolding.md) | Használatlan DDD-scaffolding eltávolítása | accepted | 2026-07-15 |
| [ADR-068](ADR-068-canonical-project-task-state.md) | Kanonikus projekt- és taskállapot-architektúra | **proposed** (független review vár — TASK-DP-002) | 2026-07-18 |
| [ADR-077](ADR-077-island-terminal-runner-identity.md) | Összetett island_id/terminal_id/runner_id identitás (NEXUS-ISLAND-RUNTIME) | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-078](ADR-078-canonical-task-message-store.md) | Kanonikus task/message store és legacy-kivezetés (runtime adatsík) | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-079](ADR-079-claim-lease-fencing-state-machine.md) | Claim/lease/fencing/idempotencia állapotgép | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-080](ADR-080-unified-authorization-policy.md) | Egységes autorizációs policy és döntési sorrend | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-081](ADR-081-single-launch-authority.md) | Egyetlen launch authority és review/budget/dependency kapuk | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-082](ADR-082-cli-adapter-contract.md) | CLI adapter capability- és lifecycle-szerződés | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-083](ADR-083-federation-outbox-relay-dlq.md) | Federation outbox/relay/inbox/ACK/DLQ protokoll | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-084](ADR-084-migration-threat-rollback-plan.md) | Adat-, fenyegetés-, migrációs és rollback terv (sziget-runtime) | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-085](ADR-085-slo-platform-evidence-strategy.md) | SLO-k és platformbizonyítási stratégia (sziget-runtime) | **proposed** (független review vár — TASK-ISL-001) | 2026-07-18 |
| [ADR-086](ADR-086-change-provenance-branch-protection.md) | Change provenance — branch/commit/PR-névadás, protected main, bot-commit kapu | **proposed** (branch protection terv, nincs alkalmazva — TASK-DP-006) | 2026-07-18 |

Kiegészítő: [PHASE1_MCP_TOOLS_REVIEW.md](PHASE1_MCP_TOOLS_REVIEW.md) — elveszett
architektúra-review helyreállító csonkja (a `phase1-tools-test-plan.md` hivatkozza).

## Linkellenőrzés

A `scripts/check-doc-links.mjs` (Node, függőség nélkül) ellenőrzi:

1. a `docs/` alatti markdown-fájlok lokális linkjeit,
2. a forráskódbeli `docs/architecture/decisions/...` útvonal-hivatkozásokat,
3. a forráskódbeli `ADR-NNN` említéseket (létezik-e `ADR-NNN-*.md` ebben a könyvtárban).

Futtatás a repo gyökeréből:

```bash
node scripts/check-doc-links.mjs
node scripts/check-doc-links.mjs --help   # paraméterek
```

Törött link esetén nem-nulla exit koddal áll le.
