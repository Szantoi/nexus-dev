# task-message-box — the canonical message store

This module is the **single source of truth** for messages (tasks, questions,
responses, info) across the fleet: local intra-island terminal↔terminal, and — with
island fields — cross-island federation (ADR-066). It is SQLite-backed and DB-first:
the `.md` files are an *optional, best-effort projection* of the DB rows, never the
source of truth.

## Why this module exists (the history / the "whys")

Development was organic, so two message systems grew in parallel:

- **`messageRegistry.ts`** — the older, file-oriented system, still used by ~10
  pipeline consumers (inboxWatcher, the `watch*` files, taskEscalation, terminalStatus,
  sessionStarter). It carries rich features (content-hash verification, status history,
  filesystem sync) but a sprawling **12 UPPERCASE** status vocabulary that even
  contains both `COMPLETED` **and** `DONE`.
- **`task-message-box`** (this module) — the newer, cleaner, DB-first store with a
  tight **6 lowercase** status vocabulary.

Two vocabularies + LLMs hand-writing status text into `.md` frontmatter (`DONE` vs
`done` vs `Completed`) = the "black box" drift problem. The fix is **one canonical
model** that agent-management reads from the DB, not from free-text files.

Gábor's directive (2026-07-12): *"A fogalmakat is rendbe kell rakni. Nem lehet
adósság."* — put the **concepts** in order, no debt. This module is being made the
canonical store; `messageRegistry`'s consumers migrate onto it (VPS-coordinated),
its features are absorbed here, and it is then retired.

## The canonical model — two independent dimensions

Declared in **`config/message-model.yaml`** (config-driven; nothing hardcoded in
code — change the model there). Loaded by `message-model.ts`.

- **`type`** = the message's **purpose**: `task | question | response | info`.
  `done`/`blocked` are **not** types (that was a conceptual conflation) — a "done
  report" is a `response` whose status is `completed`.
- **`status`** = the message's **lifecycle**:
  `unread → read → in_progress → completed | blocked → archived`.
  The allowed transitions form a state machine, also declared in the config.

Every legacy value maps cleanly to the canonical model (no data debt): see
`legacy_status_map`, `central_status_map`, `legacy_type_map` in the config, and the
`mapLegacy*` functions in `message-model.ts`.

## What this module provides

| Concern | API |
|---------|-----|
| Create / read / query | `createTask`, `getMessage`, `readMessage`, `queryMessages`, `getInbox`, `getOutbox` |
| Canonical status change | `updateMessageStatus(id, toStatus, by)` — validates the transition, appends to the audit trail |
| Audit trail | `getStatusHistory(id)` — chronological `{from, to, at, by}[]` (stored as JSON on the row) |
| Integrity | `verifyMessageHash(id)`, `verifyAllMessages()` — detect drift between a row and its `content_hash` |
| Federation (cross-island) | `sendFederationMessage`, `getFederationInbox` (token-optimized: metadata only) |

## Design principles honored here

- **Config-driven, not hardcoded** — the vocabulary, state machine, and legacy
  mappings live in `config/message-model.yaml` (env-overridable via
  `MESSAGE_MODEL_CONFIG_PATH`).
- **DB-first** — status changes go through `updateMessageStatus` (constrained enum +
  validated transition), never by parsing `.md` text. The `.md` render is best-effort.
- **Traceable** — every status change is logged (`[TaskMessageBox] id: from → to (by)`)
  and recorded in `status_history`. Integrity is verifiable via the hash functions.
- **Provably working** — unit/HTTP tests cover the model, transitions, mappings,
  audit trail, hash verification, and the federation API. Nothing here ships unproven.

## Tests

```bash
npx vitest run src/__tests__/messageModel.test.ts \
  src/__tests__/messageStatusHistory.test.ts \
  src/__tests__/federationStore.test.ts \
  src/__tests__/federationRoutes.test.ts
```

## Known limits

- `store.ts` is above the 800-line size gate (allowlisted until 2026-10-18,
  decomposition tracked in TASK-QC-008E).
- The `messageRegistry.ts` consumer migration (step 3 below) is still open —
  until then the two systems coexist.

## Status: additive foundation done (2026-07-12)

Steps 1–2 of the consolidation are complete and tested: the canonical model +
config + transition/audit + hash verification are in place, **without touching the
10 messageRegistry consumers**. The consumer migration (step 3) is coordinated on the
VPS side once this foundation is confirmed. See
`docs/knowledge/federation/CONCEPT_canonical_message_model.md` for the full plan.
