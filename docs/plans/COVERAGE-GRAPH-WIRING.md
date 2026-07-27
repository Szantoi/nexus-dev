# COVERAGE-GRAPH-WIRING — Teszt→kód térkép sweep-kompatibilis üzembe állítása

> **Állapot:** TERV — implementáció NEM KEZDŐDHET meg `@root` jóváhagyása előtt.
> **Szerző:** @root-Antigravity, 2026-07-27
> **Kapcsolódó:** AG-1 feladat (AGENT-CHANNEL.md 2026-07-27), `coverageExtractor.ts`, `graph-corpus.yaml`

---

## 1. Probléma-nyilatkozat

A `coverageExtractor.ts` (`COVERS` élek) kész és tesztelt, de a
`config/graph-corpus.yaml` `spaceos` bejegyzéséből szándékosan ki van véve,
mert a jelenlegi modellje két inkompatibilis problémát okozna:

| Probléma | Hatás |
|---|---|
| `coverage-final.json` gitignore-olt, gépfüggő | A VPS-timer (`graph:index:auto` 15 percenként) fail-closed hibával megáll: nincs coverage fájl → a docs+src gráffrissítés IS leáll |
| Két gép eltérő coverage-adata | Fingerprint-thrash: A gép COVERS-élei különböznek B gépétől → minden futásban re-indexel, B gép söpri A gép COVERS-éleit és fordítva |

**Cél:** a COVERS-réteg a spaceos-gráfba kerüljön, de úgy, hogy:
1. a VPS 15 perces timer ne törjön el,
2. két gép ne söpörje egymás COVERS-éleit,
3. a COVERS-réteg hiánya/elavulása **őszintén** jelenjen meg (fail-closed → a válasz mondja ki, nem hallgat el).

---

## 2. Lehetséges megközelítések

### A) A VPS maga futtatja a teszteket és indexel

```
VPS napi timer:
  npm run test:coverage      # generál coverage-final.json-t
  npm run graph:index:auto   # --island spaceos (COVERS is benne)
```

**Előnyök:**
- Egyszerű: nincs CI-integráció, nincs artifact-transzfer.
- Mindig az adott gépen élő kód coveragéja kerül be.

**Hátrányok:**
- A VPS-en a `test:coverage` ~2–3 percet vesz igénybe (bővülő suite-tel nő).
- A VPS-napi és a lokális dev-indexelés (lokál gép) **eltérő COVERS-éleket** produkál — a két gép még mindig egymás éleit söpörné a napi spaceos-sync futáskor.
- A coverage adatok a VPS fájlrendszerén maradnak, nem verziózottak.
- Ha a VPS tesztek buknak, a coverage nem keletkezik és az indexelés fail-close → _ugyanaz a blokoló hatás, mint ma_.

**Minősítés:** ❌ Nem oldja meg a kétgépes sweep-divergencia problémát.

---

### B) CI-artifact: a CI publikálja, az indexelő letölti

```
CI pipeline:
  npm run test:coverage
  artifact feltöltés: coverage/coverage-final.json → S3/R2/GCS

VPS napi timer:
  artifact letöltés → coverage/coverage-final.json
  npm run graph:index:auto   # COVERS is benne
```

**Előnyök:**
- Egyetlen kanonikus forrás: a CI-ból érkező, main-branchen keletkező coverage.
- A lokális dev-gép nem indexel COVERS-t → nincs kétgépes sweep-divergencia.
- A coverage a main kódjának felel meg (nem egy esetleges lokális WIP-nek).

**Hátrányok:**
- Infrastruktúra-komplexitás: S3/R2/GCS bucket, artifact feltöltés CI-ben, letöltési logika az indexelőben vagy egy wrapper script-ben.
- Network dependency: a VPS a letöltéskor elérhető kell legyen az artifact store-nak.
- Ha a CI nem fut (pl. hétvégén nincs push), a coverage elavul — de ez elfogadható, ha a COVERS-réteg hiányát/elavultságát jelzi a rendszer.

**Minősítés:** ✅ Megoldja a kétgépes divergenciát, de infrastruktúra-befektetést igényel.

---

### C) A spaceos COVERS-indexelés egyetlen gépre kötve (ajánlott)

A `coverageExtractor` mint _opcionális_ forrás csak azon a gépen fut, ahol a
coverage-adat keletkezik (és ahol ezt explicit be van kötve). Technikai megvalósítás:

#### C/1 — Külön `spaceos-covers` sziget (JAVASOLT)

Új sziget a `graph-corpus.yaml`-ban, `${NEXUS_COVERAGE_ROOT}` env-változóval:

```yaml
islands:
  spaceos:          # változatlan: docs + typescript
    repo_root: "."
    sources:
      - path: docs
        extractor: markdown
      - path: knowledge-service/src
        extractor: typescript

  spaceos-covers:   # ÚJ: csak ahol NEXUS_COVERAGE_ROOT be van állítva
    repo_root: "."
    sources:
      - path: "${NEXUS_COVERAGE_ROOT}"   # pl. knowledge-service/coverage
        extractor: coverage
```

- Ha `NEXUS_COVERAGE_ROOT` nincs beállítva → `IslandNotOnThisHostError` → a `--all-islands` futás átugorja (csak logging, nincs hiba).
- A VPS-en és a lokál gépen **mindenki maga gondozza a saját** `spaceos-covers` szigetét.
- A `sweepStale` csak a `spaceos-covers` szigetben söpör → a `spaceos` docs+src élek érintetlenek maradnak.
- A COVERS-réteg az MCP toolokban külön szigetként lekérdezhető, de az `island`-szűrés mindkettőre vonatkozik.

**Előnyök:**
- Nulla infrastruktúra-befektetés.
- Nincs kétgépes sweep-divergencia (mindenki saját sziget).
- Az `IslandNotOnThisHostError` mechanizmus már létezik és tesztelt (`joinerytech` sziget mintájára).
- Fail-closed megmarad: ha nincs coverage fájl, a `coverageExtractor` dob, az indexelés megáll.

**Hátrányok:**
- A `spaceos-covers` és `spaceos` közt nem lesznek COVERS-élek a `search_hybrid`-ban, csak önálló lekérdezéssel (az éleket az indexelő a forrás scope-ján belül hozza létre — az archiektúra jelenleg nem támogatja a kereszt-szigetes éleket).
- Több sziget esetén az MCP toolok hívójának explicit `island` argumentum kell majd — de az MCP toolok ma is az `island`-t a hívó identitásából veszik, nem argumentumból. A `search_graph` tool dokumentációja pontosítandó.

**Minősítés:** ✅✅ Legjobb kompromisszum ma.

#### C/2 — Meglévő szigetbe opcionális forrásként

A coverage-forrás a `spaceos` bejegyzésbe kerül, de **kivételkezelő wrapperrel**:
ha a coverage fájl hiányzik, az extractor _warning_-ot ad és 0 entitást ad vissza,
az indexelő nem dob hibát.

❌ **Ez a fail-closed invariánst sérti**: 0 entitás = sweep → a korábbi COVERS-élek kitörlődnek, és nincs jelzés. Az `[GraphIndex] source ... extracted 0 entities` guard pontosan erre a hibára van. Nem javasolt.

---

## 3. Ajánlott megközelítés: C/1

**Miért C/1?**

- A joinerytech-mechanizmus (env-változó alapú skip) már production-tesztelt.
- Nulla új infrastruktúra.
- A kétgépes divergencia lehetetlenné válik, mert minden gép saját szigetet ír.
- A fail-closed invariáns marad: ha nincs coverage fájl → hiba, az indexelés megáll.
- Ha később CI-artifact-alapú megközelítés (B) kell, a `NEXUS_COVERAGE_ROOT` egyszerűen a letöltött fájl mappájára mutat.

---

## 4. Implementációs terv (jóváhagyás után)

> Sorrend, minden lépés önálló commit és quality-kör.

### 4.1 `graph-corpus.yaml` — `spaceos-covers` sziget hozzáadása

```yaml
  # spaceos-covers: COVERS (test→source) edges for the spaceos island.
  # Only active where NEXUS_COVERAGE_ROOT is set (the directory containing
  # coverage-final.json). Run "npm run test:coverage" before indexing.
  # --all-islands skips this island where the variable is unset.
  spaceos-covers:
    repo_root: "."
    sources:
      - path: "${NEXUS_COVERAGE_ROOT}"
        extractor: coverage
```

### 4.2 Fingerprint-konzisztencia

Az új sziget nem érinti a `spaceos` ujjlenyomatát (más sziget = más meta-node).
A `spaceos-covers` saját `KnowledgeIndexMeta`-t kap.

### 4.3 `graph:index:auto` szkript kiegészítése (opcionális)

A `package.json` `graph:index:auto` szkripte `--all-islands`-ot hív. Ahol
`NEXUS_COVERAGE_ROOT` be van állítva és a coverage fájl létezik, a covers-sziget
automatikusan frissül. Ez nulla kódbeli változtatás az indexelő logikájában.

### 4.4 Dokumentáció

- `config/graph-corpus.yaml` komment frissítése (a `coverage` extractor bekötési feltételei).
- `docs/plans/GRAPHRAG-PILOT.md` COVERS-szekció: az aktuális állapot + a `spaceos-covers` sziget.
- README GraphRAG-szekció: rövid megjegyzés az opcionális COVERS-rétegről.

### 4.5 Quality-kapuk

Az implementáció kódot nem érint (csak YAML + dokumentáció), de a szokásos
kapukat le kell futtatni:
- `npx tsc --noEmit`
- `npm run test:parallel`
- `npm run lint:ratchet` (786 plafonon!)
- `npm run check:size`
- `npm run check:links`
- `npm run secret-scan:all`
- `npm run audit:prod`
- `npm run check:tasks`

---

## 5. Nyitott kérdések @root felé

1. **C/1 megfelelő-e**, vagy preferált a B (CI-artifact) megközelítés?  
   Ha igen, szükséges-e a CI-infrastruktúra kiépítése most, vagy halasztható?

2. **`spaceos-covers` szigetnév helyes-e**, vagy más konvenciót kövessünk  
   (pl. `spaceos:covers` — de ez ütközhet az island ID regex-szel: `ISLAND_ID_RX`)?

3. **VPS `NEXUS_COVERAGE_ROOT` beállítása:** ki a felelős (Gábor kapuja), és  
   mikor akarjuk aktiválni?

4. **Elavulási jelzés:** az MCP tooloknak jelezniük kellene-e, ha a  
   `spaceos-covers` sziget nem létezik/elavult? (Pl. `get_dependencies` warningban  
   megemlíti, hogy a COVERS-réteg hiányzik.) Ez implementációs kérdés, döntés kell.

---

## 6. Alternatíva elvetési indoklás

| Opció | Elvetés oka |
|---|---|
| **A — VPS maga futtat tesztet** | Kétgépes sweep-divergencia megmarad; VPS-en 2–3 perces CI-futás |
| **B — CI-artifact** | Infrastruktúra-befektetés; elegáns, de halasztható |
| **C/2 — 0-entitás warning** | Sérti a fail-closed invariánst |

---

*Ez a dokumentum terv; implementáció csak `@root` jóváhagyása után kezdődhet.*

---

# v2 — A DÖNTÖTT ÉS IMPLEMENTÁLT DIZÁJN (2026-07-27, @root)

> A v1 @root-review-ja két rést talált a C/1-ben (R1: az island kizárólag a
> hívó identitásából jön és egy identitás EGY szigetre képez → a külön
> `spaceos-covers` sziget MCP-ről elérhetetlen lenne; R2: kimondatlan egy-író
> szabály). Az Antigravity keret-limit miatt a revíziót és az implementációt
> @root vette át (Gábor jóváhagyásával). A választott irány a review-ban
> felvetett **(b) alternatíva: egy sziget, relációtípus-szkópolt sweep**.

## A dizájn három eleme

1. **Relációtípus-tulajdonjog (registry):** minden extractor DEKLARÁLJA, mely
   reláció-típusokat állíthat elő (`EXTRACTOR_RELATION_TYPES`: markdown →
   REFERENCES; typescript/csharp → DEPENDS_ON, PART_OF; coverage → COVERS).
   Az indexelő fail-closed kikényszeríti: deklarálatlan típus kibocsátása
   hiba — az ilyen él sosem lenne söpörve, tehát némán elavulna.
2. **Típus-szkópolt sweep (`sweepStale(tag, island, sweepRelationTypes)`):**
   a futás CSAK az aktív forrásai által deklarált él-típusokat söpri. A
   VPS-timer (docs+src korpusz) így soha nem törli a dev gép COVERS-éleit.
   Az entitás-sweep sziget-szintű marad — az entitások közös szókincs, minden
   feltétel nélküli forrás minden futásban újrapecsételi őket. (Emiatt
   KORLÁT: gépfüggő forrás nem lehet entitások kizárólagos tulajdonosa — a
   coverage-forrás végpontjai a ts-forrás moduljai, ez teljesül.)
3. **Env-kapuzott forrás + per-forrás fingerprint:** a `graph-corpus.yaml`-ban
   a forrás-útvonal lehet `${VAR}`: ahol a változó nincs beállítva, a forrás
   EXPLICIT kihagyással kimarad (log + a sweep-szkópból is kimarad) — ahol be
   van állítva, kötelezően létezik (fail-closed). A `--if-changed` ujjlenyomat
   FORRÁSONKÉNT tárolódik (`KnowledgeIndexMeta.sourceHashesJson`, kulcs:
   `extractor:deklarált-útvonal` — gépfüggetlen): egy futás csak a SAJÁT
   forrásainak bejegyzéseit hasonlítja/frissíti/invalidálja, a másik gép
   bejegyzéseit megőrzi. E nélkül a két gép eltérő forrás-halmaza minden
   futásban kölcsönösen érvénytelenítené egymás fingerprint-jét (re-index
   hurok).

## Amit ez megold (v1-célok + review-leletek)

| Cél | Hogyan |
|---|---|
| VPS-timer nem törik el | a coverage-forrás env-kapuzott, a VPS-en explicit skip |
| Nincs kétgépes él-söprés | a docs+src futás sweep-szkópjában nincs COVERS |
| Nincs fingerprint-thrash | per-forrás hash, idegen bejegyzés megőrzve |
| R1 lekérdezhetőség | a COVERS a `spaceos` szigetben él — a meglévő identitás-modellel elérhető |
| R2 egy-író | a `NEXUS_COVERAGE_ROOT`-ot kizárólag a coverage-t termelő gépen szabad beállítani (yaml-komment rögzíti) |
| Fail-closed őszinteség | skip = log + „NOT swept”; hiányzó fájl beállított env-nél = hiba; deklarálatlan típus = hiba |

## Adverzariális review (3 lencse, 2026-07-27) — leletek és sorsuk

A szerző=jóváhagyó helyzet miatt az implementáció 3 független adverzariális
review-agenten ment át (adatvesztés/sweep; hamis-frissesség; config/fail-
closed). 4 P1 + 3 P2 + 3 P3 lelet — a P1-ek és a javítható P2-k JAVÍTVA:

- **P1 (javítva): üresre szűrt gated forrás sweep-je.** A sweep-szkóp a
  szűrés ELŐTT dőlt el → egy all-orphan coverage-eredmény 0 írással söpörte
  volna ki az összes COVERS-élt, és a hamis-üres fingerprint be is égett
  volna. Fix: a szkóp a szűrés UTÁN dől el, és az üresre szűrt gated forrás
  fail-closed hiba.
- **P1 (javítva): „szellem-hash”.** Configból eltávolított forrás bejegyzése
  a metában maradt → a forrás visszakerülésekor hamis skip egy olyan gráfon,
  amiből az entitás-sweep már törölte az adatait. Fix: a meta-írás csak a
  config által deklarált kulcsokat tartja meg (aktív + env-kapuzott).
- **P1 (javítva): checkout-drift + skip.** Egy másik gép futása (eltérő
  checkout) sziget-szintű entitás-sweepje elviheti e gép éleit, miközben a
  hash-ek egyeznek → tartós hamis „naprakész”. Fix: a bejegyzés a futás
  syncTag-jét is tárolja (`{h,t}`), és skip CSAK akkor, ha a bejegyzés a
  sziget LEGUTOLSÓ futásából származik (`t === indexedAt`) — gépváltás után
  az első futás mindig teljes index (árban: egy váltásonkénti újraindexelés).
- **P2 (javítva):** üres `--config` némán defaultra esett → hiba; duplikált
  (extractor, path) forrás-bejegyzés → hiba; bulk/all-gated ágak tesztei
  pótolva.
- **P1 (pre-existing, NEM javítva — follow-up): átfedő futások upsert-
  clobbere.** Egy lassú, régebbi tagű futás feltétel nélküli SET-jei
  felülírhatják egy gyorsabb, újabb futás friss adatát (és feltámaszthatnak
  törölt node-okat), miközben a meta az újabb futásé marad. Ez a viselkedés
  a mostani változás ELŐTT is fennállt; érdemi gyógyír egy futás-lease
  (pl. meta-node-alapú) — külön tétel.

## Ismert korlátok / follow-up

- **Átfedő futások upsert-clobbere** (lásd fent, pre-existing) — futás-lease
  follow-up.
- **Checkout-drift átmeneti törlés:** két gép eltérő checkoutja esetén a
  később futó gép sweepje törli a másik gép még nem szinkronizált entitásait
  (minden entitás-típusra, nem COVERS-specifikus, pre-existing). Öngyógyuló:
  az érintett gép következő futása visszaírja — a latest-run-kapu garantálja,
  hogy ez a futás nem skippel.
- **Elgépelt env-változónév** a forrás-útvonalban megkülönböztethetetlen a
  szándékos „ezen a gépen nincs” esettől (explicit skip-log van, hiba nincs)
  — inherens korlát, a log az őr.
- **Elavulás-jelzés az MCP toolokban** (v1 4. nyitott kérdése): a
  `sourceHashesJson` + `indexedAt` alapján a toolok jelezhetnék, ha a
  COVERS-réteg régebbi, mint a kód-réteg — külön tétel, nincs implementálva.
- A meta olvasás-módosítás-írás nem atomi: két átfedő futás legfeljebb egy
  felesleges újraindexelést okoz, hamis „naprakész”-t nem (invalidáció
  feltétel nélkül nyer; az író-ág monoton `indexedAt`-kapus).
- A régi (egész-korpusz `corpusHash`) meta-formátum olvasáskor üresre
  degradál → az átállás utáni első futás egyszeri teljes index.
