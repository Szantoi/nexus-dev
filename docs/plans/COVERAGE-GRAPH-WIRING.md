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
