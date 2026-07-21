# ADR-066: Sziget-közi federáció és kanonikus üzenetmodell

- **Státusz:** accepted
- **Dátum:** 2026-07-12 (Gábor direktívája) — increment 1–2 + multi-island serving: 2026-07-12..17; rekonstruálva: 2026-07-18
- **Döntéshozó(k):** Gábor + Nexus architektúra
- **Rekonstruált:** részben — a helyi git-történet és a modul-README nagyrészt lefedi

## Kontextus

A flotta több "szigeten" (island) fut (pl. dev gép, VPS), és a szigetek közti
üzenetküldésre nem volt csatorna. Emellett két párhuzamos üzenetrendszer nőtt ki
organikusan: a fájl-orientált `messageRegistry` (12 NAGYBETŰS státusz, benne
`COMPLETED` ÉS `DONE` egyszerre) és az újabb, DB-first `task-message-box` (6
kisbetűs státusz). A két szókincs + az LLM-ek kézzel írt frontmatter-státuszai
"fekete doboz" driftet okoztak. Gábor direktívája (2026-07-12): "A fogalmakat is
rendbe kell rakni. Nem lehet adósság."

## Döntés

- **Kanonikus üzenet-store:** a `task-message-box` modul az üzenetek (task, question,
  response, info) egyetlen igazságforrása — SQLite-alapú, DB-first; az `.md` fájlok
  csak best-effort projekciók.
- **Két független dimenzió:** `type` (cél: task | question | response | info) és
  `status` (életciklus: unread → read → in_progress → completed | blocked → archived);
  a `done`/`blocked` NEM típus. Az átmenetek állapotgépként, configból deklarálva
  (`config/message-model.yaml`, env-felülírható) — semmi hardcode.
- **Federációs API (increment 2):** minden sziget knowledge-service-e egységes
  végpontokat ad: `POST /api/federation/send`, `GET /api/federation/inbox`
  (token-optimalizált, csak metaadat), `GET /api/federation/message/:id`,
  `POST /api/federation/ack`. Auth: szigetenkénti Bearer-token (az MCP-auth
  újrahasznosítva), a tokenből agent-identitás képződik.
- **Multi-island serving:** az island a kérés identitásából szkópolódik kérésenként
  (git 9cb2083).
- **Migráció, nem big-bang:** a messageRegistry ~10 fogyasztója fokozatosan,
  VPS-koordináltan migrál a kanonikus store-ra; a legacy értékek veszteségmentesen
  mappelődnek (`legacy_status_map`, `legacy_type_map`).

## Design intent

Egy kanonikus, gépi fogalommodell, amelyet az agent-menedzsment a DB-ből olvas, nem
szabad szöveges fájlokból — a státusz-drift osztályát szünteti meg. Token-optimalizált
federáció: az inbox csak metaadatot ad, a törzs igény szerint kérhető le.
Config-vezérelt szókincs: a modell változtatása YAML-szerkesztés, nem kódmódosítás.

## Alternatívák

- A `messageRegistry` kiterjesztése federációra — elvetve: a 12-státuszos szókincs
  és a fájl-first működés maga volt a hibaforrás.
- Big-bang csere — elvetve: a 10 fogyasztó egyben migrálása kockázatos; additív
  alap + fokozatos migráció lett a terv (README "Status: additive foundation done").

## Következmények

- A `messageRegistry` **deprecated irányba tart**: feature-jei (hash-verifikáció,
  státusz-történet) a task-message-boxba szívódnak fel, majd a modul kivezetendő.
- Minden státuszváltás validált átmenet + audit trail + log — a drift detektálható
  (`verifyAllMessages`).
- A federációs útvonal a token-auth réteg (AUTH_MODE fail-closed, git 36a4dad)
  minőségére támaszkodik.

## Biztonsági hatás

Sziget-közi auth Bearer-tokennel, fail-closed móddal; a tokenek env-ből jönnek,
gitre nem kerülnek. Az inbox metaadat-only válasza az adatminimalizálást is szolgálja.

## Kapcsolódó kód

- `knowledge-service/src/task-message-box/` — store, message-model, schema, mcp-tools, README
- `knowledge-service/src/interfaces/http/routes/federation.routes.ts` — increment 2 API
- `knowledge-service/src/bootstrap/app.ts:201` — router bekötése
- Tesztek: `__tests__/federationStore.test.ts` (increment 1),
  `__tests__/federationRoutes.test.ts` (increment 2) — összesen 36 unit/HTTP teszt

## Bizonyíték

- `knowledge-service/src/task-message-box/README.md` — a történet és a "miértek"
  dokumentálva, Gábor 2026-07-12-i direktívájával
- git: 9cb2083 ("feat(knowledge): multi-island serving — island scoped per request
  from identity"), 36a4dad ("token-auth layer — identity from token, AUTH_MODE
  fail-closed gate")
- Terv-dokumentum hivatkozás: `docs/knowledge/federation/CONCEPT_canonical_message_model.md`
  (a README hivatkozza; ebben a repóban jelenleg nem található — nyitott kérdés)

## Nyitott kérdések

- A README által hivatkozott `docs/knowledge/federation/CONCEPT_canonical_message_model.md`
  nincs a repóban — importálandó vagy a hivatkozás pontosítandó (a fájl a VPS-oldali
  munkafán élhet).
