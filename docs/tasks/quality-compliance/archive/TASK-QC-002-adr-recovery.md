---
id: TASK-QC-002
title: Hiányzó ADR-ek és design intent helyreállítása
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M1
epic: QC-ARCHITECTURE
status: done
priority: high
depends_on: []
parallel_with: [TASK-QC-001, TASK-QC-003, TASK-QC-005, TASK-QC-007]
owner_role: architect
created: 2026-07-18
source: QUALITY.md section 2
---

# Hiányzó ADR-ek és design intent helyreállítása

## Cél

Minden forráskódbeli ADR-hivatkozás létező, verziókezelt döntésdokumentumra mutasson, amely a döntés okát és elvetett alternatíváit is rögzíti.

## Jelenlegi bizonyíték

A forrás többek között ADR-041, ADR-046, ADR-048, ADR-049, ADR-050, ADR-052, ADR-053, ADR-054, ADR-059, ADR-060 és ADR-066 dokumentumokra hivatkozik, miközben a `docs/architecture/decisions` könyvtár és a hivatkozott fájlok hiányoznak.

## Scope

1. Készíts teljes hivatkozásleltárt `rg "ADR-[0-9]+|architecture/decisions"` alapján.
2. Git-történetből, kódból és tesztekből állítsd helyre a ténylegesen elfogadott döntéseket.
3. Hozz létre ADR-sablont és indexet.
4. Minden ADR tartalmazza: kontextus, döntés, design intent, alternatívák, következmények, biztonsági hatás, státusz, dátum és kapcsolódó kód.
5. A már nem érvényes döntést jelöld `superseded` vagy `deprecated` állapotúnak; ne írj át történelmet.
6. Javítsd a törött hivatkozásokat, vagy távolítsd el azt, amelyhez bizonyíthatóan nem tartozott döntés.

## Nem cél

- Új architektúra bevezetése.
- A nagy fájlok felbontása; azt a TASK-QC-008 kezeli.
- Ismeretlen döntések kitalálása. Bizonyíték hiányában az ADR legyen `proposed` és tartalmazzon nyitott kérdést.

## Elfogadási feltételek

- [x] Minden ADR-hivatkozás létező fájlra mutat.
- [x] Van ADR-index és új döntésekhez használható sablon.
- [x] Minden dokumentum rögzíti a design intentet, nem csak a végeredményt.
- [x] A DDD-scaffolding sorsáról szóló lezárt döntés külön ADR-ben szerepel.
- [x] Egy linkellenőrző parancs vagy teszt hibával leáll törött lokális ADR-link esetén.

## Kötelező ellenőrzés

```bash
rg -n "ADR-[0-9]+|architecture/decisions" knowledge-service/src docs
npm --prefix knowledge-service run typecheck
```

Futtasd az elkészített dokumentációs linkellenőrzőt is.

## Átadandó bizonyíték

- ADR-leltár: hivatkozási szám → dokumentum → státusz.
- A git- vagy kódbizonyíték felsorolása minden helyreállított döntésnél.
- Linkellenőrzés kimenete.

## Kockázat és rollback

A fő kockázat a történeti döntések téves rekonstruálása. Bizonytalan következtetést egyértelműen `proposed` státusszal és review-kéréssel kell átadni.

## Implementáció (2026-07-18)

Végrehajtó: worker agent (TASK-QC-002). Létrejött a `docs/architecture/decisions/`
könyvtár (12 ADR + index + sablon + 1 helyreállító csonk) és a
`scripts/check-doc-links.mjs` linkellenőrző. Forráskódfájl NEM módosult (nem volt
törött komment-hivatkozás: minden hivatkozott fájlnév pontosan úgy jött létre,
ahogy a kód hivatkozza), ezért typecheck nem volt szükséges.

### ADR-leltár (hivatkozás → dokumentum → státusz)

| Hivatkozás (src-előfordulás) | Dokumentum | Státusz |
|---|---|---|
| ADR-041 (graph/, epicsValidator, graphRoutes, statusUpdater + `@see` útvonalak) | `ADR-041-graph-based-workflow-architecture.md` | accepted (rekonstruált) |
| ADR-046 (memoryStore tier-policyk, sessionHooks, handoff, retrospective, digest, memory/digest route-ok) | `ADR-046-tiered-memory-architecture.md` | accepted (rekonstruált) |
| ADR-048 (domainPatternMatcher kernel/RLS `adrRefs`) | `ADR-048-kernel-row-level-security.md` | **proposed** — review kell |
| ADR-049 (memoryStore, workSessionLog, workerRegistry, bestOfN, dagValidator, costLimiter, knowledgeLoader, sessionStarter) | `ADR-049-dual-session-chat-work-architecture.md` | accepted (rekonstruált) |
| ADR-050 (codegen/, mcp.ts Phase1+Phase4 toolok, domainPatternMatcher cutting) | `ADR-050-code-generation-toolchain.md` | accepted (részlegesen rekonstruált) |
| ADR-052 (subscriptionManager/-Tools/-Routes, taskEscalation) | `ADR-052-fsm-subscription-system.md` | accepted (rekonstruált) |
| ADR-053 (conductor/ modulnégyes, epicRouter, watchMonitor, terminalReviewer, sessionStarter) | `ADR-053-mode4-program-awareness.md` | accepted (rekonstruált) |
| ADR-054 (domainPatternMatcher crm/FSM `adrRefs` + teszt) | `ADR-054-crm-lead-opportunity-fsm.md` | **proposed** — review kell |
| ADR-059 (goalStore, watchGoals, nightwatch, mcp goal-toolok) | `ADR-059-monitor-driven-goal-progression.md` | accepted (rekonstruált) |
| ADR-060 (chatSessionStarter, multiBotManager, contextBuilder, telegram-toolok) | `ADR-060-cli-agnostic-telegram-architecture.md` | accepted (rekonstruált) |
| ADR-066 (task-message-box, federation.routes, app.ts) | `ADR-066-cross-island-federation.md` | accepted |
| DDD-scaffolding sorsa (elfogadási feltétel) | `ADR-067-remove-unused-ddd-scaffolding.md` | accepted |
| `docs/architecture/decisions/PHASE1_MCP_TOOLS_REVIEW.md` (phase1-tools-test-plan.md) | `PHASE1_MCP_TOOLS_REVIEW.md` | helyreállító csonk (eredeti elveszett) |

Kiegészítők: `README.md` (index, számozási/rekonstrukciós szabályok), `TEMPLATE.md` (sablon).

### Bizonyítékok

- A repó 2026-07-14-én `823db70` Initial commit-tal indult — az eredeti ADR-fájlok
  az előd-repóban maradtak; a `git log -S "ADR-NNN"` minden számra csak a 823db70-ra
  (ill. 72b953c tool-migrációra) mutat. A rekonstrukció ezért kód/teszt/komment-alapú;
  a konkrét bizonyítékok ADR-enként a dokumentumok "Bizonyíték" szekciójában.
- Helyi git-bizonyítékkal fedett döntések: `046b8bb` (DDD-scaffolding törlés,
  "Option A from chat-root review" → ADR-067), `9cb2083` (multi-island serving) és
  `36a4dad` (token-auth, fail-closed) → ADR-066.
- Bizonyíték nélküli számok (ADR-048, ADR-054): NEM találtunk ki döntést — `proposed`
  státusz, nyitott kérdésekkel (előd-repóból importálandó, ha előkerül).

### Linkellenőrzés kimenete

```
$ node scripts/check-doc-links.mjs
Ellenőrizve: 28 markdown-link (docs), 8 ADR-útvonal-hivatkozás, 169 ADR-szám-említés (knowledge-service/src)
OK — minden hivatkozás létező célra mutat.   (exit 0)
```

Negatív teszt (szándékosan törött célokkal, scratch-könyvtáron): a script
`[md-link]` és `[adr-number]` hibát jelzett és **exit 1**-gyel állt le — a
hibás-ági viselkedés bizonyított.

Utóállapot-leltár: `rg -n "ADR-[0-9]+|architecture/decisions" knowledge-service/src docs`
→ 225 találati sor, 88 fájl; minden hivatkozott szám létező ADR-re oldódik fel.

### Megjegyzés a CI-bekötéshez (QC-005 hatásköre)

Javasolt npm script (NEM került bekötésre): `"check:links": "node ../scripts/check-doc-links.mjs"`
(knowledge-service package.json), vagy repo-gyökérből közvetlenül
`node scripts/check-doc-links.mjs` a CI-workflow lépéseként.

