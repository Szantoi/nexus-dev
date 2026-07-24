# GraphRAG Implementációs Roadmap

**Készült:** 2026-07-24
**Státusz:** DRAFT / Ötlet fázis
**Kapcsolódó:** [graphrag-research-2026.md](../knowledge/graphrag-research-2026.md)

---

## Executive Summary

A JoineryTech platform elérte azt a komplexitást (5000+ kódfájl, 20+ modul, 300+ dokumentum), ahol a GraphRAG valós értéket ad a hagyományos vector RAG-hoz képest. Ez a dokumentum egy fokozatos implementációs tervet vázol fel.

---

## 1. Probléma Definíció

### Jelenlegi Korlátok

| Probléma | Példa | Következmény |
|----------|-------|--------------|
| Flat search | "Melyik komponens hívja az Inventory API-t?" | Nem tudja megválaszolni |
| Nincs impact analysis | "Ha módosítom a Cutting árazást, mi törik?" | Hallucináció |
| Cross-module vakság | "Az EHS milyen Kernel szolgáltatásokat használ?" | Talán találja, talán nem |
| Onboarding nehézség | Új fejlesztő: "Hogyan kapcsolódik a Procurement a Kernel-hez?" | Órákig keres |

### Célállapot

```
Developer: "Ha módosítom az InventoryService.GetStock() metódust, mi törik?"

GraphRAG válasz:
┌─────────────────────────────────────────────────────────┐
│ InventoryService.GetStock()                             │
│     │                                                   │
│     ├── CALLED_BY → ProcurementService.CheckAvailability│
│     │                   │                               │
│     │                   └── USED_BY → PurchaseOrderPage │
│     │                                                   │
│     ├── CALLED_BY → CuttingQuoteService.CalculateStock  │
│     │                   │                               │
│     │                   └── USED_BY → QuoteWizard       │
│     │                                                   │
│     └── CALLED_BY → ProductionScheduler.PlanBatch       │
│                                                         │
│ Érintett: 3 service, 2 UI komponens, 1 scheduler        │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Architektúra Terv

### 2.1 Célarchitektúra

```
┌─────────────────────────────────────────────────────────────┐
│                    Knowledge Service                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   ChromaDB   │    │  Graph Store │    │   Hybrid     │  │
│  │   (Vector)   │◄──►│  (Neo4j/PG)  │◄──►│   Router     │  │
│  │              │    │              │    │              │  │
│  │  Embeddings  │    │  Entities    │    │  Query       │  │
│  │  Chunks      │    │  Relations   │    │  Classifier  │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         ▲                   ▲                   │           │
│         │                   │                   ▼           │
│  ┌──────┴───────────────────┴───────────────────────────┐  │
│  │                    MCP Tools                          │  │
│  │  search_knowledge (existing)                          │  │
│  │  search_graph (NEW)                                   │  │
│  │  search_hybrid (NEW)                                  │  │
│  │  get_dependencies (NEW)                               │  │
│  │  impact_analysis (NEW)                                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Entitás Modell

```typescript
// Kód entitások
interface CodeEntity {
  id: string;                    // "CuttingQuoteService"
  type: 'Module' | 'Class' | 'Function' | 'API' | 'Component';
  file_path: string;             // "src/spaceos-modules-cutting/..."
  language: 'csharp' | 'typescript';
  metadata: Record<string, any>;
}

// Dokumentum entitások
interface DocEntity {
  id: string;                    // "ADR-041"
  type: 'ADR' | 'Pattern' | 'Task' | 'Epic';
  file_path: string;
  metadata: Record<string, any>;
}

// Kapcsolatok
type RelationType =
  | 'USES'           // A uses B
  | 'DEPENDS_ON'     // A depends on B
  | 'CALLS'          // A calls B
  | 'IMPLEMENTS'     // A implements B
  | 'REFERENCES'     // Doc references Code
  | 'PART_OF'        // A is part of Module B
  | 'TESTED_BY';     // A is tested by B
```

---

## 3. Fázisok

### Fázis 0: Előkészítés (1 hét)

**Cél:** Infrastruktúra és baseline

| Feladat | Output |
|---------|--------|
| Graph DB választás | Döntés: Neo4j Community vs PostgreSQL+AGE vs NetworkX |
| Benchmark setup | Teszt kérdések + elvárt válaszok |
| Meglévő ChromaDB audit | Dokumentum count, embedding quality |

**Döntési Mátrix:**

| Szempont | Neo4j | PostgreSQL+AGE | NetworkX |
|----------|-------|----------------|----------|
| Telepítés | Docker | Meglévő PG | Pip |
| Skálázhatóság | Magas | Közepes | Alacsony |
| Query nyelv | Cypher | Cypher-like | Python |
| LangChain support | Natív | Korlátozott | Manuális |
| Költség | Free (Community) | Free | Free |
| **Ajánlás Pilot-ra** | ✅ | - | ✅ (gyors start) |

---

### Fázis 1: Pilot - Cutting Modul (2-3 hét)

**Cél:** Proof of Concept egy modulon

**Scope:**
- `spaceos-modules-cutting` (575 C# fájl)
- Entitások: Class, Interface, Service, Controller
- Kapcsolatok: USES, CALLS, IMPLEMENTS

**Lépések:**

1. **AST-based Entity Extraction**
   ```bash
   # C# AST parsing with Roslyn vagy LLM
   Input: 575 .cs fájl
   Output: ~200-300 entitás + ~500-1000 kapcsolat
   ```

2. **Graph Construction**
   ```python
   # NetworkX pilot
   G = nx.DiGraph()
   G.add_node("CuttingQuoteService", type="Service", module="Cutting")
   G.add_edge("CuttingQuoteService", "InventoryProvider", relation="USES")
   ```

3. **Basic Query API**
   ```python
   def get_dependencies(entity_id: str) -> List[str]:
       return list(nx.ancestors(G, entity_id))

   def get_dependents(entity_id: str) -> List[str]:
       return list(nx.descendants(G, entity_id))
   ```

**Success Criteria:**
- [ ] 90%+ entitás extraction accuracy
- [ ] "Mi használja a CuttingQuoteService-t?" kérdésre helyes válasz
- [ ] <500ms query latencia

---

### Fázis 2: Entity Extraction Pipeline (2-3 hét)

**Cél:** Automatizált, karbantartható extraction

**Komponensek:**

1. **C# Extractor**
   - Roslyn-based AST parsing VAGY
   - LLM-based extraction (Claude/GPT-4)
   - Output: JSON entitás + kapcsolat lista

2. **TypeScript Extractor**
   - ts-morph AST parsing VAGY
   - LLM-based extraction
   - Output: JSON entitás + kapcsolat lista

3. **Documentation Extractor**
   - Markdown parsing + NER
   - ADR → references kód entitásokat
   - Task → references modulokat

**Pipeline:**
```
┌─────────┐    ┌──────────┐    ┌─────────┐    ┌───────────┐
│ Source  │───►│ Extractor│───►│ Dedup   │───►│ Graph DB  │
│ Files   │    │ (LLM/AST)│    │ + Merge │    │           │
└─────────┘    └──────────┘    └─────────┘    └───────────┘
     │                                              │
     │         ┌──────────────────────────────┐    │
     └────────►│ Incremental Update Trigger   │◄───┘
               │ (File watcher / Git hook)    │
               └──────────────────────────────┘
```

---

### Fázis 3: Hybrid Search MCP Tool (2 hét)

**Cél:** Graph + Vector kombinált keresés

**Új MCP Tools:**

```typescript
// 1. Graph-only search
toolRegistry.register({
  name: 'search_graph',
  description: 'Search code/doc entities and their relationships',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      entity_type: { type: 'string', enum: ['Module', 'Class', 'Function', 'API'] },
      relation: { type: 'string', enum: ['USES', 'DEPENDS_ON', 'CALLS'] },
      depth: { type: 'number', default: 2 }
    }
  }
});

// 2. Impact analysis
toolRegistry.register({
  name: 'impact_analysis',
  description: 'Find all entities affected by changes to a given entity',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string' },
      change_type: { type: 'string', enum: ['modify', 'delete', 'deprecate'] }
    }
  }
});

// 3. Hybrid search
toolRegistry.register({
  name: 'search_hybrid',
  description: 'Combined vector + graph search for complex questions',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      strategy: { type: 'string', enum: ['vector_first', 'graph_first', 'parallel'] }
    }
  }
});
```

**Query Router Logic:**
```
Query: "Hogyan működik az árazás?"
  → Vector search (szemantikus)

Query: "Mi hívja a GetStock metódust?"
  → Graph traversal (strukturális)

Query: "Ha módosítom az Inventory API-t, milyen UI komponensek érintettek?"
  → Hybrid (Graph traversal + Vector context)
```

---

### Fázis 4: Production Deployment (2-3 hét)

**Cél:** Teljes JoineryTech lefedés + monitoring

**Scope:**
- 4123 C# fájl (20 modul)
- 663 TS/TSX fájl (10 frontend modul)
- 314 dokumentum

**Infra:**
```yaml
# docker-compose.graphrag.yml
services:
  neo4j:
    image: neo4j:5-community
    ports:
      - "7474:7474"  # Browser
      - "7687:7687"  # Bolt
    volumes:
      - neo4j_data:/data
    environment:
      - NEO4J_AUTH=neo4j/password

  # VAGY PostgreSQL + AGE extension
  postgres-age:
    image: apache/age:latest
    ports:
      - "5433:5432"
```

**Monitoring:**
- Query latencia tracking
- Graph méret (node/edge count)
- Cache hit rate
- Extraction job státusz

---

## 4. Kockázatok és Mitigáció

| Kockázat | Valószínűség | Hatás | Mitigáció |
|----------|--------------|-------|-----------|
| LLM extraction pontatlan | Közepes | Magas | AST-based fallback, human review |
| Graph túl nagy | Alacsony | Közepes | Pruning, modulonkénti partícionálás |
| Latencia túl magas | Közepes | Közepes | Caching, pre-computation |
| Karbantartási teher | Magas | Közepes | Inkrementális update, git hook |

---

## 5. Success Metrics

### Pilot (Fázis 1)
- [ ] 90%+ entity extraction accuracy
- [ ] 3 teszt kérdésre helyes válasz
- [ ] <500ms query latency

### MVP (Fázis 3)
- [ ] 95%+ coverage (Cutting modul)
- [ ] 5 impact analysis kérdés helyes
- [ ] <1s hybrid query latency

### Production (Fázis 4)
- [ ] Teljes JoineryTech lefedés
- [ ] 50% csökkenés onboarding időben
- [ ] 60% hallucináció csökkenés mérve

---

## 6. Alternatívák

### Ha GraphRAG túl komplex:

1. **Lightweight: Dependency Graph Only**
   - Csak `DEPENDS_ON` kapcsolatok
   - Build tools-ból (MSBuild, npm) kinyerhető
   - Nincs LLM extraction

2. **External: LightRAG as Service**
   - [HKUDS/LightRAG](https://github.com/hkuds/lightrag) ready-to-use
   - Docker deployment
   - API integration

3. **Managed: Neo4j AuraDB**
   - Fully managed graph DB
   - Magasabb költség, alacsonyabb ops teher

---

## 7. Következő Lépések

1. **Döntés:** Pilot indítás (Y/N)?
2. **Ha Y:** Graph DB választás (Neo4j vs NetworkX)
3. **Erőforrás:** Ki viszi? (Backend terminál?)
4. **Ütemezés:** Mikor indul?

---

_Nexus Development - GraphRAG Roadmap - 2026-07-24_
