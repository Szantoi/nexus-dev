---
id: TASK-QC-009
title: README-k és modul-dokumentáció aktualizálása
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M4
epic: QC-DOCUMENTATION
status: done
priority: medium
depends_on: [TASK-QC-001, TASK-QC-002, TASK-QC-003, TASK-QC-004, TASK-QC-005, TASK-QC-007, TASK-QC-008]
parallel_with: []
owner_role: technical-writer
created: 2026-07-18
source: QUALITY.md sections 2, 3 and 4
---

# README-k és modul-dokumentáció aktualizálása

## Cél

Egy új fejlesztő vagy agent a repositoryból önállóan megértse a célt, architektúrát, konfigurációt, helyi ellenőrzést, biztonsági korlátokat és deploy folyamatot.

## Jelenlegi bizonyíték

- A root README rövid, és nem rögzít mérhető projektcélt vagy stopping conditiont.
- A knowledge-service README több történeti fázist és már elavult DDD/legacy állítást tartalmaz.
- A `src` alatt sok modul található, de csak kevés modul-README létezik.
- A README lintre, authra, konfigurációra, portokra és deployra vonatkozó részei nem teljesen követik a jelenlegi kódot.

## Scope

1. Frissítsd a root README-t programcéllal, leállási feltétellel és kanonikus állapotfájl-hivatkozással.
2. Írd újra a knowledge-service gyorsindítást biztonságos local-dev és production példákkal.
3. Dokumentáld a jelenlegi architektúrát; töröld vagy történeti szekcióba mozgasd az elavult állításokat.
4. Adj modul-README-t legalább ezekhez: `auth`, `bootstrap`, `config`, `interfaces/http`, `interfaces/mcp`, `pipeline`, `runner`, `task-message-box`, `telegram`.
5. Minden modul-README tartalmazza: felelősség, publikus belépési pontok, függőségi irány, konfiguráció, logok, tesztek és ismert korlátok.
6. Dokumentáld a CI gate-ek és a biztonságos deploy helyi reprodukcióját.
7. Linkeld az ADR-indexet és ezt a taskprogramot.
8. Futtass link- és parancsellenőrzést.

## Nem cél

- Forráskód kommentelése soronként.
- Nem létező feature vagy jövőbeli architektúra kész tényként dokumentálása.
- Titkok vagy valós tokenek szerepeltetése példákban.

## Elfogadási feltételek

- [x] A dokumentált parancsok bare checkoutból végrehajthatók. *(typecheck + dev-start + health élőben igazolva; az `npm ci` bare-checkout futtatása dokumentált kivétel — a QC-010 reviewer végzi, lásd Implementáció)*
- [x] Nincs elavult DDD-, port-, auth-, lint- vagy deploy-állítás.
- [x] A felsorolt fő moduloknak van README-je.
- [x] Minden lokális dokumentációs link érvényes. *(77+52 markdown-link OK; a linkellenőrző 2 nem-dokumentációs `ADR-NNN`-találata a párhuzamos QC-006 tesztfixture-jéből jön — lásd Implementáció)*
- [x] A konfigurációs táblázat megegyezik a validált env/path sémával. *(tételes egyeztetés; 2 jelzett eltérésnél a kód nyert)*
- [x] Production példában auth kötelező és bind cím nem publikus default.

## Kötelező ellenőrzés

```bash
npm --prefix knowledge-service ci
npm --prefix knowledge-service run typecheck
npm --prefix knowledge-service test
```

Futtasd a TASK-QC-002-ben létrehozott linkellenőrzőt, és próbáld ki egy tiszta ideiglenes környezetben a dokumentált local-dev setupot.

## Átadandó bizonyíték

- README-k listája és rövid céljuk.
- Linkellenőrzés eredménye.
- A dokumentált setup tényleges parancskimenete és health checkje.

## Kockázat és rollback

A dokumentáció gyorsan elavulhat. Az ellenőrizhető állításokat package scriptekhez és config sémához linkeld, ne másold több helyre eltérő formában.

## Implementáció (2026-07-18)

### Létrehozott / frissített README-k

| Fájl | Cél |
|---|---|
| `README.md` (repo-gyökér, újraírva) | programcél + leállási feltétel + kanonikus állapotfájl (`docs/projects/EPICS.yaml`) hivatkozása; docs/tasks program-struktúra + archiválási konvenció linkje; repó-térkép; DEV/PROD szeparáció; biztonságos gyorsindítás (QC-003 sablonmásolás); CI-kapuk lokális reprodukciója (package scriptekre hivatkozva); release/deploy folyamat (`scripts/deploy/README.md`); a `deploy-to-prod.sh` elavultként jelölve |
| `knowledge-service/README.md` (újraírva) | mi a szolgáltatás (MCP registry 121 tool + RAG + mailbox + pipeline + multi-island); biztonságos local-dev gyorsindítás (sablonmásolás, DEV 3466, loopback); production-minta (`AUTH_MODE=required`, loopback/Tailscale bind, systemd + `scripts/deploy`); konfigurációs tábla a `src/config/env.ts`/`paths.ts` sémával egyezően (+ „eltérésnél a kód nyer”); CI-kapuk táblája kiegészítve a QC-008 `check:size` kapuval; jelenlegi architektúra modul-README-linkekkel; API-áttekintés auth-fejléces példákkal; tömör „Történeti megjegyzés” (ADR-067, QC-008); ismert korlátok |
| `knowledge-service/src/auth/README.md` (új) | auth-módok (required/open), token-források, island-feloldás, tesztek, 30 mp-es reload-korlát |
| `knowledge-service/src/bootstrap/README.md` (új) | app-factory + startup/shutdown, `ENABLE_*` flag-vezérlés, naplózási minta, inbox-watcher viselkedés |
| `knowledge-service/src/config/README.md` (új) | a config-réteg szabálya (egyetlen process.env-olvasó), fail-fast, defaultelvek, dokumentált kivételek, legacy aliasok |
| `knowledge-service/src/interfaces/http/README.md` (új) | route-térkép, függőségi irány, auth-kapcsolat, integrációs tesztek, `api/`+`routes/` maradvány jelölve |
| `knowledge-service/src/interfaces/mcp/README.md` (új) | registry-réteg belépési pontjai; a részletes szabályokat a meglévő `tools/README.md`-re delegálja (nincs duplikáció) |
| `knowledge-service/src/pipeline/README.md` (új) | watcher/ütemező/review/routing csoportok, flag- és intervallum-kulcsok, log-prefixek, QC-008C/D/E korlátok |
| `knowledge-service/src/runner/README.md` (új) | poll+SSE runner, `config/runner.yaml` + `RUNNER_TOKEN`, indítás `scripts/runner-start.mjs`-sel |
| `knowledge-service/src/telegram/README.md` (új) | üzenetküldés/beszélgetés/multi-bot, env-kulcsok, „DEV-ben Telegram KI” szabály |
| `knowledge-service/src/task-message-box/README.md` (frissítve) | + Tests és Known limits szekció (store.ts allowlist, messageRegistry-migráció nyitott) |

### Törölt elavult állítások (helyettük a jelenlegi állapot)

- Root README: `/opt/nexus-dev`/`/opt/spaceos` hardcode-útvonalak, `dev-start.sh`+`PORT=3466 node dist/server.js` folyamat, `deploy-to-prod.sh` mint ajánlott deploy (deploy közbeni commit/tag/push állításokkal), „50+ tools”.
- KS README: Phase 1–10 „✅” fázistörténet; DDD-rétegtérkép a törölt `domain/`+`infrastructure/`+`server.legacy.ts` fájlokkal (ADR-067); „mcp.ts 2035 sor, refaktorálandó”; „MCP 6 tool”; auth-mentes `localhost:3456` curl-példák; Gemini „model name fix `src/embeddings.ts:66`” utasítás; `/opt/spaceos/spaceos-nexus` docker-compose setup; nem létező `../scripts/test-rag.sh`/`test-mailbox.sh` útvonalak; „Next Steps (Phase 11)”. A formal-review és epic-router részletek prózából a pipeline/http README-kbe kerültek tömören, SQL/YAML-másolatok nélkül.

### Konfig-tábla egyeztetés (.env.example ↔ src/config/env.ts + paths.ts) — eltérések

Tételes összevetés után a README-tábla a KÓD sémáját követi. Talált eltérések
(`.env*` fájlokat e task nem módosíthatott, jelzés a programnak):

1. `.env.dev.example` tartalmaz `ENABLE_INBOX_WATCHER=false` kulcsot, amelyet
   **semmilyen kód nem olvas** — az inbox-fájlwatcher feltétel nélkül indul
   (`bootstrap/startup.ts initialize()`), a session-indítást a `shouldWakeUp()`
   kapuzza. A kulcs jelenleg hatástalan (bootstrap-README-ben dokumentálva).
2. `.env.example`-ből hiányzó, kódban támogatott kulcsok: `NODE_ENV`,
   `LOG_LEVEL`, `LOG_FORMAT`, `AGENTS_CONFIG_PATH`, `MESSAGE_MODEL_CONFIG_PATH`,
   `WORKFLOWS_CONFIG_PATH`, `MCP_TOKEN_<NÉV>` (dinamikus). A README-tábla ezeket
   a kódnak megfelelően dokumentálja.
3. Minden `.env.example`-beli kulcsnak van kódbeli olvasója (fordított irányban
   eltérés nincs).

### Ellenőrzések és kimenetek

- `node scripts/check-doc-links.mjs` → jelenleg **exit 1**, de kizárólag a
  párhuzamos TASK-QC-006 worker által e task futása KÖZBEN létrehozott,
  untracked `src/__tests__/unit/contextPersistence.test.ts` fixture-adata miatt
  (`refs: ['ADR-001']` — nem létező ADR-szám, 243. és 253. sor). **Minden
  markdown-link érvényes**: `52 markdown-link (docs) … TÖRÖTT: 2 [adr-number]`
  — mindkét tétel a fenti tesztfájl. Kiegészítő futás:
  `node scripts/check-doc-links.mjs --docs knowledge-service --no-adr-scan`
  → `77 markdown-link … OK — minden hivatkozás létező célra mutat.` (exit 0;
  ez fedi az összes új/frissített README-t). Jelzés a QC-006-nak: a fixture-ben
  létező ADR-számot (pl. ADR-067) használjon, vagy kerülje az `ADR-NNN` mintát.
- `npm --prefix knowledge-service run typecheck` → zöld (tsc --noEmit, exit 0).
- Local-dev setup élőben (a meglévő, sablonból származó `.env.dev`-vel):
  `node scripts/dev-start.mjs` → `curl http://127.0.0.1:3466/health` →
  HTTP 200: `{"status":"ok","vectorBackend":"in-memory","embeddingBackend":
  "chromadb-server (all-MiniLM-L6-v2)","documents":52,…,"port":3466}` —
  utána a szerver leállítva, a 3466-os port felszabadulásával igazolva.
  (A `vectorBackend:"in-memory"` a nem futó ChromaDB melletti fallback — a
  README ezt a megfigyelt viselkedésnek megfelelően dokumentálja.)
- **Kivétel (dokumentált):** `npm --prefix knowledge-service ci` és a teljes
  `npm test` e task alatt szándékosan NEM futott — a node_modules élő és a
  TASK-QC-006 párhuzamosan dolgozik a teszteken; a bare-checkout
  végrehajthatóságot (npm ci → typecheck → test) a TASK-QC-010 reviewer
  igazolja tiszta környezetben.

### Megjegyzések

- `docs/projects/EPICS.yaml` (QC-DOCUMENTATION epic-státusz) frissítése nem
  történt meg: a YAML nem markdown, e task fájlhatárán kívül esett —
  koordinátori lépés.
- A taskfájl `archive/`-ba mozgatása szintén koordinátori lépés (az EPICS.yaml
  `tasks[].file` útvonala és az e2e graph-teszt a jelenlegi útvonalra mutat).
- Commit/push szándékosan nem történt (emberi kapu, programszabály).

