# ADR-077: Összetett island_id / terminal_id / runner_id identitás

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés

## Kontextus

A `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` SZIGET-01, SZIGET-03
és SZIGET-09 megállapításai szerint a jelenlegi rendszerben a terminál-identitás
lényegében `agentnév → sziget` — egy globális, nem összetett kulcs. Konkrét
kódbizonyíték (2026-07-18-i felderítés):

- `knowledge-service/config/agents.yaml.example`: `agent_islands` egy **lapos**
  `agent_name → island` map. Egy agentnév (pl. `backend`) szerkezetileg csak
  EGY szigethez rendelhető — két sziget nem definiálhat egymástól független
  `backend` identitást.
- `knowledge-service/src/terminalConfig.ts` (`config/terminals.yaml` betöltő) és
  `knowledge-service/src/config/terminals.ts` (`config/terminals.json` betöltő)
  **egyszerre él**, ugyanazokban a fogyasztókban (`sessionManager.ts`,
  `terminalStatus.ts` mindkettőt importálja). A két fájl terminálhalmaza
  ELTÉR: a `nexus` terminál a YAML-ban létezik, a JSON-ban nem; a
  `config/README.md` a `terminalConfig.ts` létezését meg sem említi.
- `knowledge-service/src/config/paths.ts`: `ISLAND_ID` KIZÁRÓLAG a Chroma
  kollekció nevét szigeteli (`${ISLAND_ID}-knowledge`). A `getTerminalsPath()`,
  a `DATA_DIR` és minden alatta élő SQLite (task-message-box, epic router,
  dispatch, memory, agent messages) **nem** tartalmaz sziget-szegmenst.
- `knowledge-service/src/pipeline/epicRouter.ts`: saját, harmadik, hardcodolt
  `TERMINALS` tömb (9 név), amiből hiányzik `nexus`, `federation`, `reviewer`,
  `backend-2`, `frontend-2`, `chat-root`.

## Döntés

1. **Kanonikus identitás-hármas:** minden erőforrás elsődleges címe
   `island_id / terminal_id / resource_id`; a futó végrehajtóé
   `island_id / terminal_id / runner_id`. A `terminal_id` szerepnév, ezért
   szigetenként ismétlődhet — az egyértelműséget mindig az `(island_id,
   terminal_id)` PÁR adja, sosem a `terminal_id` önmagában.
2. **Slug-formátum, validált betöltéskor:** `island_id` és `terminal_id`
   mintája `^[a-z][a-z0-9-]{1,31}$`. Érvénytelen érték a configbetöltést
   fail-closed módon elutasítja (nem csendes fallback).
3. **Egyetlen terminálkonfiguráció-forrás:** `config/terminals.yaml` +
   `src/terminalConfig.ts` marad kanonikus (gazdagabb RBAC/ütemezési modell,
   ez tartalmazza a `nexus` identitást is). `config/terminals.json` +
   `src/config/terminals.ts` **kivezetésre kerül** — a benne élő, a YAML-ból
   hiányzó képességek (`getInboxPath`/`getOutboxPath`, `sessionMode`,
   `tmuxSocket`) a YAML-sémába költöznek át (additív mezőkkel), migrációs
   ablakkal (ADR-084).
4. **A sémának sziget-dimenziót kell kapnia:** a mai `system_roles:` +
   `terminals:` lapos szerepkatalógus egy `islands:` gyökér alá kerül, ahol
   minden sziget saját `terminals:` térképet definiál (saját `backend`,
   saját `nexus` stb.), opcionális `role_template` mezővel a duplikáció
   elkerülésére a közös alapértékekhez (modell, típus, token-budget). Az
   `agents.yaml` tokentérképe `token → agent_name` helyett
   `token → {island_id, terminal_id}` párra vált; a mai `agent_islands`
   lapos map megszűnik, mert maga a probléma forrása.
5. **`runner_id`:** opak, egyedi azonosító (pl. `crypto.randomUUID()`),
   amelyet a runner első regisztrációkor generál és tartósan megőriz (nem
   process-indításonként újragenerált). Egy runner **több** `(island_id,
   terminal_id)` párt is kiszolgálhat — a runner saját configja (`runner.yaml`
   terminals listája) sorolja fel ezeket, és a runner tokenje (ADR-080) csak
   ezekre a párokra jogosít.
6. **Névtér-kódolás:**
   - fájlrendszeri út: beágyazott könyvtár `TERMINALS_PATH/<island_id>/<terminal_id>/...`;
   - DB-sorok: **külön oszlopok** (`island_id`, `terminal_id`), nem
     összefűzött string — indexelhetőség és egyértelműség miatt;
   - session-/lognév: `<island_id>__<terminal_id>` (dupla aláhúzás,
     fájlrendszer- és tmux-biztos elválasztó, nincs ütközés a slug-mintával,
     mert az kizárja az aláhúzást).
7. **Relációs tárolási modell (egy hosztos és több-szigetes eset egyaránt):**
   az `island_id` NOT NULL oszlop minden érintett táblán (task-message-box,
   runner registry stb.), minden alkalmazási lekérdezés egy közös
   `withIsland(island_id)` repository-rétegen keresztül megy (SQLite-ban
   nincs sor-szintű biztonság, ezt a réteget az ADR-080 autorizációs döntése
   kényszeríti ki). Fizikailag különálló SQLite-fájl szigetenként is
   megengedett üzemeltetési opció (pl. VPS-enkénti telepítésnél), de nem
   kötelező — mindkét modellt támogatnia kell a sémának.

## Design intent

A cél, hogy az identitás **szerkezetileg** ne lehessen kétértelmű — ne egy
konvenció (namespace-elt string, amit egy hanyag hívó megkerülhet), hanem egy
összetett kulcs, ami minden táblában, configban és autorizációs döntésben
jelen van. Ez ugyanazt a fail-closed szemléletet folytatja, amit a
`tokenAuth.ts` már bevezetett a sziget-identitásra ("a kliens sosem adhatja
meg, kizárólag a szerver oldja fel") — most ez a szemlélet a `terminal_id`-ra
és a `runner_id`-ra is kiterjed.

## Alternatívák

- **Lapos terminálnév + külön sziget-lookup (jelenlegi állapot)** — elvetve:
  szerkezetileg kizárja, hogy két sziget azonos nevű terminált definiáljon.
- **Sziget beégetése a terminálnévbe** (pl. `nexus-dev.backend`) — elvetve:
  csak string-konvenció, nem ad valódi index/query-szintű szigetelést,
  eltöri a meglévő aliasokat és ütemezési szabályokat, és minden hardcodolt
  terminálnév-hivatkozást migrálni kellene a kódban/dokumentációban egy
  törékeny string-mintára.
- **Külön configfájl szigetenként (N YAML)** — elvetve MOST: a jelenlegi
  sziget-számhoz (2-3) aránytalan üzemeltetési többlet; a séma viszont
  lehetővé teszi, hogy egy sziget `terminals:` blokkja később külön fájlba
  kerüljön (`islands: {nexus-dev: !include islands/nexus-dev.yaml}` jellegű
  bővítés), ha a méret indokolja.

## Következmények

- Minden downstream ISL-task (ISL-002…006, ISL-013, ISL-014) erre az
  identitásra épít; a `config/terminals.json`/`src/config/terminals.ts`
  kivezetése egy dedikált migrációs lépés (ISL-002 hatálya).
- A jelenlegi `agents.yaml.example` és minden éles `agents.yaml` migrálandó
  új sémára — secrets-fájl, gitignore-olt, ezért nem git-migráció, hanem
  üzemeltetői lépés (ADR-084).
- A `pipeline/epicRouter.ts` saját `TERMINALS` tömbje feleslegessé válik,
  amint a kanonikus configra épül (ADR-078 hatálya).

## Biztonsági hatás

A token → `(island_id, terminal_id)` közvetlen leképezés megszünteti azt a
szerkezeti rést, hogy egy agentnév csak egyetlen szigethez tartozhat — ez
önmagában nem autorizációs döntés (azt az ADR-080 mondja ki), de az
autorizáció EBBŐL az identitásból tud csak helyesen dönteni.

## Kapcsolódó kód

- `knowledge-service/src/terminalConfig.ts` — megmarad, bővül sziget-dimenzióval
- `knowledge-service/src/config/terminals.ts` — kivezetendő (ADR-084 migráció)
- `knowledge-service/config/terminals.yaml` — kanonikus séma, `islands:` gyökérre bővül
- `knowledge-service/config/terminals.json` — kivezetendő
- `knowledge-service/src/config/paths.ts` — `getTerminalsPath()` sziget-szegmenssel egészül ki
- `knowledge-service/src/auth/tokenAuth.ts` — `getIslandForAgent` → `(island_id, terminal_id)` felbontásra cserélendő
- `knowledge-service/config/agents.yaml.example` — séma-migráció (`agent_islands` megszűnik)
- `knowledge-service/src/pipeline/epicRouter.ts` — hardcodolt `TERMINALS` tömb kivezetendő

## Bizonyíték

- Kód-felderítés 2026-07-18 (jelen ADR alapja): `agents.yaml.example` lapos
  `agent_islands` map; `terminalConfig.ts` vs `config/terminals.ts` egyidejű
  importja `sessionManager.ts`/`terminalStatus.ts`-ben; `paths.ts` `ISLAND_ID`
  csak a Chroma-kollekciónevet szigeteli; `epicRouter.ts:715` hardcodolt
  `TERMINALS` tömb.
- `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` SZIGET-01,
  SZIGET-03, SZIGET-09.

## Nyitott kérdések

- A `role_template` mechanizmus pontos sémája (mennyi közös alapérték
  örökölhető szigetek között) implementációs részlet — ISL-002 dönti el.
- Külön configfájl szigetenként: ha a szigetszám jelentősen nő, újra
  megfontolandó — nem blokkolja a jelen döntést.
