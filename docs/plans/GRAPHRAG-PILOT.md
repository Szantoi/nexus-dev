# GraphRAG Pilot — végrehajtási terv (v1.0)

**Készült:** 2026-07-24
**Státusz:** JÓVÁHAGYVA (Gábor, 2026-07-24) — implementáció folyamatban
**Kapcsolódó:** [GRAPHRAG-IMPLEMENTATION-ROADMAP.md](GRAPHRAG-IMPLEMENTATION-ROADMAP.md) (DRAFT ötlet-fázis → ez a terv konkretizálja),
[graphrag-research-2026.md](../knowledge/graphrag-research-2026.md)

---

## Gábor döntései (2026-07-24)

1. **Általános Nexus-képesség** — a GraphRAG NEM kötődik konkrét projekthez
   (JoineryTech, doorstar…): a knowledge-service sziget-agnosztikus rétegeként
   épül, ahogy a vector-RAG is (szigetenkénti szeparáció, hívó-identitásból).
   A korpusz-specifikus extractorok (C#, TS, docs) pluginszerűen csatlakoznak.
2. **Graph store: Neo4j Community (Docker)** — a VPS-en fut, loopback+tailnet
   bindolással (SOHA 0.0.0.0 — Chroma-incidens tanulság), memória-korláttal.

## Architektúra-elvek (a meglévő minták követése)

- **Sziget-szeparáció**: minden node `island` property-t kap; az island a hívó
  identitásából jön (`context.island`), SOHA nem a tool-argumentumból —
  bitre ugyanaz az elv, mint a `vectorStore.ts`-ben.
- **Graceful degradation**: ha a Neo4j nem elérhető, a graph-funkciók
  kikapcsolt állapotot jeleznek (informatív hibával), a KS többi része
  változatlanul megy — mint a Chroma → in-memory fallback szelleme.
- **Névütközés-kerülés**: a meglévő `src/graph/` az EPICS workflow-DAG modul.
  Az új modul: **`src/knowledgeGraph/`**.
- **A korpusz is config**: hogy MELYIK sziget MIT indexel, az a
  `config/graph-corpus.yaml`-ban van, nem a kódban — egy másik repó vagy egy új
  nyelv bekötése konfigurációs lépés (lásd G2.5).
- **Config-vezérelt**: `GRAPH_URL` / `GRAPH_USER` / `GRAPH_DATABASE` /
  `GRAPH_QUERY_TIMEOUT_MS` env-ből, zod-validáltan (default: kikapcsolva, ha
  nincs URL; a séma csak `bolt://`/`neo4j://`-t fogad, és tiltja a URL-be
  ágyazott jelszót — a connection-URL logba kerül). A `GRAPH_PASSWORD` titok,
  ezért — a többi titokhoz hasonlóan — nem a sémában, hanem a
  `secrets.graphPassword` getterben él.
- **Determinizmus először**: az extraction AST-/parser-alapú (TS compiler,
  markdown-linkek), NEM LLM-alapú — olcsó, reprodukálható, tesztelhető.
  LLM-extraction később, külön döntéssel.

## Entitás-modell (roadmap 2.2 alapján, szűkítve a pilotra)

- Node: `Entity { id, island, type, name, filePath?, language?, meta? }`
  - Kód: `Module | Class | Function | API`
  - Doc: `ADR | Plan | Task | Knowledge | Doc`
- Él: `RELATES { type }` — pilot: `DEPENDS_ON` (TS import), `REFERENCES`
  (markdown link / ADR-említés), `PART_OF` (fájl → modul).

## Szeletek

### G1 — Infra + store + MCP toolok (EZ A PILOT MAGJA)
- [x] Neo4j 5.26 LTS Community a VPS-en (`docker/neo4j/docker-compose.yml`,
  jelszó a VPS-oldali `.env`-ben, chmod 600; loopback+tailnet bind; 1.5 GB cap)
- [x] `neo4j-driver-lite@6.2.0` exact-pin (tiszta JS, nincs natív kód) + audit
  0 sebezhetőség (mellékjavítás: js-yaml CVE → 5.2.2)
  — Linux-lock ellenőrzés a VPS-en: push után `npm ci` próba
- [x] `src/knowledgeGraph/graphStore.ts` — driver-életciklus, island-scope
  (`<island>|<id>` kulcs, minden query island-szűrt), séma-bootstrap
  (kulcs-unicitás + island-index), upsert, bounded traversal (max depth 5,
  szerveroldali timeout), `graphHealth()` probe; unavailable → fail-closed hiba
- [x] MCP toolok (`graph.tools.ts`): `search_graph`, `get_dependencies`,
  `impact_analysis` — island KIZÁRÓLAG a contextből (teszt bizonyítja);
  explicit jogosultság a `tool-permissions.yaml`-ban (read-only → "all")
- [x] Tesztek: 54 unit (fake driver + valós fixture-fák) + MCP kontrakt-teszt
  bővítve 124 toolra

### G2 — Extractorok + indexelés
- [x] Docs-extractor: `docs/**/*.md` → Doc-entitások (típus az útvonalból) +
  `REFERENCES` élek (relatív markdown-linkek + ADR-szám-említések)
- [x] TS-extractor: TS compiler parser (createSourceFile, típusellenőrzés
  nélkül) → Module entitások + `DEPENDS_ON` (relatív importok) + `PART_OF`
- [x] `npm run graph:index` CLI — idempotens **upsert-then-sweep** (batch-elt
  upsert 500/kör, majd a régi elemek söprése; hibánál a korábbi gráf érintetlen
  marad), forrásfa-ellenőrzéssel (üres/rossz `--repo-root` nem söpörheti ki a
  szigetet)
- [x] Valós indexelés lefutott (2026-07-25): 497 node, 1632 él; smoke-query
  igazolva élesben (vectorStore.ts függői, hub-node depth-5 → truncated,
  nemlétező id → `found: false`, idegen sziget → üres)

### G2.5 — Config-vezérelt korpusz (a projekt-függetlenség utolsó darabja)
- [x] `config/graph-corpus.yaml`: szigetenként `repo_root` + `sources[]`
  (`path` + `extractor`), zod-validálva. A `repo_root` lehet abszolút (másik
  repó!) vagy a nexus-dev gyökeréhez relatív; a `path` nem szökhet ki a
  `repo_root` alól (az entitás-id-k repo-relatívak, kiszökve ütköznének).
- [x] `extractors/registry.ts`: az `extractor` név → függvény leképezés egy
  helyen (`markdown`, `typescript`). Új nyelv = EGY bejegyzés + a modul; a
  config-séma, a CLI és az indexelő változatlan.
- [x] `indexCli` már csak egy **feloldott korpuszt** futtat
  (`runGraphIndex(corpus, syncTag)`), forrásonkénti lét-ellenőrzéssel.
  Fail-closed: nem konfigurált szigetre nem indexel (nem üres indexelés!).
  Kapcsolók: `--island`, `--config`, `--repo-root` (override).
- [x] Élő bizonyítás: két sziget párhuzamosan, két különböző korpusszal,
  KIZÁRÓLAG configból (`spaceos`: docs + KS-src = 500 node; `smoke-isle`:
  csak `docs/plans` = 5 node) — a második sziget nem látta az első kódját,
  a takarítás után az első érintetlen maradt.
- **Review-3 (2026-07-25, 4 lencse + leletenkénti cáfolat, 37 agent):** a 20
  nyers leletből 3 maradt állva (a többit a cáfolat-panel elvetette).
  Javítva: (1) **P1 — a saját refaktorom nyitotta vissza a review-2-es
  adatvesztést**: a „0 entitás" kapu összesített volt, így egy ép testvér-
  forrás átvitte a futást, és a sweep kitörölte az üres forrás teljes
  részgráfját, exit 0-val → a kapu most **forrásonkénti**, plusz a nem-könyvtár
  forrás is hangosan bukik; (2) **P2 — üres `--repo-root`** a process CWD-jére
  bázisolta volna az egész indexet → explicit hiba; (3) **P3 — `constructor`
  nevű sziget** az `Object.prototype`-ról jött vissza a fail-closed ág helyett
  → `hasOwnProperty`-ellenőrzés. Elvetve (dokumentált döntés vagy hatástalan):
  szimlink-alapú lexikai containment, átfedő források, `path: "."`,
  extractor-heurisztikák „repo-specifikussága", YAML-hibaüzenet burkolása.

### G3 — Hybrid + kiterjesztés (külön döntések)
- [ ] `search_hybrid` (vector + graph kombinált) — a query-router logika
- [ ] C#-extractor (JoineryTech) — ha Gábor arra viszi
- [ ] Inkrementális update (git hook / watcher)

## Review-történet

- **Review-1 (2026-07-24, 6-lencsés adverzáriális Workflow, 87 agent,
  leletenként 3-fős cáfolat-panel):** 27 nyers → 22 megerősített lelet.
  Érdemi (dedup után): **2 P2 kód** (NaN átcsúszik a depth-clampen →
  `*1..NaN` Cypher; clear-then-upsert reindex részleges gráfot szolgál ki
  hiba után), **5 P3 kód** (limit-NaN → LIMIT 0 néma üres találat; 200-as
  traversal-cap jelzés nélkül; constraint-bootstrap verseny; CLI
  close-hiba = hamis index-hiba; extractor-hiányok: duplikált él, egyszintű
  PART_OF, `.js` specifier, CommonMark-linkformák, ADR zero-padding),
  **2 P1 + 3 P2 tesztrés** (island-szűrés/kulcs-konstrukció, relation-kulcsok,
  unavailable-wrapping, bootstrap, traversal-toolok island-pinje,
  runGraphIndex).
- **Fix-kör:** `clampInt` (NaN→default); **upsert-then-sweep** reindex
  (syncTag-stempel + sweep CSAK teljes sikeres upsert után — a sziget soha
  nem üres/félkész); `TraversalResult.truncated` (MAX+1 limit-detektálás,
  mindkét tool jelzi — az `affected_count` truncated esetén alsó korlát);
  megosztott `constraintReady` promise (versenymentes, hibánál retry);
  CLI catch/finally szétválasztás; extractor-fixek (él-dedup, PART_OF-lánc
  a srcRootig, `.js`→`.ts` map, CommonMark-regex, ADR-szám-normalizálás).
  +16 új teszt (össz 40 a modulban). Élő reindex az új úton: 497 node /
  1632 él.
- **Review-2 (2026-07-25, 9-agentes független verifikáció: 6 fix-verifikátor
  mutációs teszteléssel + 2 regresszió-vadász + teljességi kritikus):** a 11
  fixből 10 „fixed+testGuard" verdikttel átment; a maradék egy **nem-hiba úton
  megmaradó adatvesztést** talált, plusz 4 P1/P2 jött a vadászoktól és a
  kritikustól. Javítva:
  - **Üres/rossz korpusz kisöpörte a szigetet** (P1): hibás `--repo-root` vagy
    olvashatatlan fa → 0 upsert → a sweep mindent törölt, exit 0-val. Most a
    forrásfák létezése előfeltétel, és 0 entitásnál a CLI elutasítja a sweepet.
  - **Nemlétező entity_id = „semmi nem törik el"** (P1): a traversal
    `OPTIONAL MATCH`-re váltott, a `found` flag megkülönbözteti az elgépelt/
    nem indexelt id-t a valóban függőség-mentes entitástól; a toolok explicit
    „nincs ilyen entitás" hibát adnak.
  - **A mélység-korlát némán csonkított** (P1): a `depth` most visszajön a
    válaszban (a leszorított érték is látszik), az `impact_analysis` leírása
    kimondja, hogy alsó korlátot ad.
  - **Jelszó a logba / laza URL-validáció** (P1): a séma csak bolt/neo4j sémát
    fogad és tiltja a URL-be ágyazott credentialt, a log csak `host:port`-ot ír.
  - **Párhuzamos indexelés kiürítette volna a szigetet** (P2): a sweep
    `<> $syncTag` helyett `< $syncTag` (monoton ISO-tag), üres tagre hibát dob.
  - **Island-index hiánya** (P2): a séma-bootstrap létrehozza
    (`knowledge_entity_island`) — enélkül minden island-szűrt query az összes
    sziget node-jait pásztázta.
  - **Query-timeout hiánya** (P2): kliensoldali `GRAPH_QUERY_TIMEOUT_MS` +
    szerveroldali `db.transaction.timeout` — egy mély traversal nem foghatja
    meg a megosztott instance-t az összes sziget elől.
  - **±Infinity a clampen** (P2): a NaN továbbra is defaultra esik, a végtelen
    viszont a korlátra szorul (nem defaultra); a tool-határon a nem-szám
    `depth`/`limit` hangos hiba, a `null` a tool saját defaultja.
  - Kisebbek: `.ts` forrás elsőbbsége lefordított `.js` testvér mellett;
    sweep island-szűrésének teszt-lefedése (mutációval igazolt rés volt);
    tool-permissions bejegyzés; compose-keményítés (7474 csak loopback,
    healthcheck, log-rotáció, jelszó-rotációs recept, `.env.example`).
  +14 új teszt (össz 54 a modulban). Élő újravalidálás a VPS Neo4j ellen.

## Kapuk és konvenciók

- Minden szelet: implementáció → gate-ek → **független adverzáriális review**
  → fix → PASS → commit/push (@root) → CI.
- Új dependency: exact-pin + `npm audit` + a lock Linux-oldali validálása
  (lásd [[audit-prod-idozitett-bomba]] tanulság — a memóriában).
- A Neo4j-jelszó SOHA nem kerül gitre; a runner/KS oldalon env-ből jön.

## Ismert korlátok (pilot)

- A compose a tailnet-IP-re (100.82.133.87) is bindol — ha boot-kor a
  tailscale0 még nincs fenn, a konténer-start újrapróbát igényelhet.
- Egy Neo4j-instance, logikai szeparáció island-property-vel (nem külön DB —
  a Community edition nem támogat multi-db-t); a tool-réteg kényszeríti ki
  az island-szűrést minden query-ben.
- **Hiányzó hívó-identitás → alapértelmezett sziget.** A `context.island`
  hiányában a store (a `vectorStore`-ral azonos konvenció szerint) a
  `DEFAULT_ISLAND`-re esik vissza. Ma minden MCP-hívás authentikált és kap
  szigetet, de egy jövőbeli transport (stdio-híd, in-process hívás) így némán
  az elsődleges szigetet kapná. A fail-closed identitás-kapu repo-szintű
  döntés (a nyitott credential/RBAC-kapu hatóköre), nem ebbe a szeletbe
  tartozik.
- **A sweep egyetlen tranzakció.** Pilot-méretben (ezres node) rendben; nagy
  átnevezésnél a `DETACH DELETE` heap-igényes lehet (a `CALL … IN
  TRANSACTIONS` viszont nem használható a driver managed-tranzakcióival).
- **A traversal költsége az útvonalak számával nő**, nem a találatokéval
  (a `min(length(p))` aggregáció miatt a LIMIT nem tolható le). A 200-as
  találati sapka + a kliens/szerver timeout a védőháló; hub-node-on mély
  lekérdezés így is drága.
- **A csonkolás nem reprezentatív minta**: a rendezés `distance, id`, tehát a
  sapka fölött az ábécé végéről esnek ki elemek. A `truncated` flag jelzi, de
  valódi összlétszámot nem adunk.
- **`graphHealth()` nincs bekötve a `/health` végpontba** — szándékos: egy
  elérhetetlen Neo4j-re várakozó probe nem foghatja meg a health-választ.
- **`npm run graph:index` devDependency-ket igényel** (`tsx`, `typescript`) —
  `--omit=dev` telepítésű prod hoston nem fut (ugyanaz a helyzet, mint a
  meglévő `index` scriptnél).
- **A `run()` minden Cypher-hibát `GraphUnavailableError`-ra képez** —
  szintaktikai/szemantikai hiba is „store unavailable"-ként jelenik meg. A
  Cypher statikus és élesben validált (lásd G2 smoke), ezért a pilotban ez
  megengedett egyszerűsítés.
