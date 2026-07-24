# GraphRAG Kutatás és Módszertanok 2026

**Készült:** 2026-07-24
**Szerző:** SpaceOS Root Terminal
**Cél:** Alapozó tudás GraphRAG implementációhoz a Nexus/JoineryTech platformon

---

## 1. Mi a GraphRAG?

A **GraphRAG** (Graph-based Retrieval-Augmented Generation) a hagyományos RAG kiterjesztése, amely **tudásgráfokat (knowledge graph)** kombinál a vektor-alapú szemantikus kereséssel.

### Hagyományos RAG vs GraphRAG

| Szempont | Vector RAG | GraphRAG |
|----------|------------|----------|
| **Adatstruktúra** | Flat chunks + embeddings | Entitások + Kapcsolatok + Embeddings |
| **Keresés** | Cosine similarity | Graph traversal + Similarity |
| **Kontextus** | Legközelebbi chunkek | Kapcsolódó entitások hálója |
| **Multi-hop** | Nem támogatott | Natívan támogatott |
| **Hallucináció** | 25-35% | 10-15% (~60% csökkenés) |

### Működési Elv

```
┌─────────────────────────────────────────────────────────────┐
│                     GraphRAG Pipeline                        │
├─────────────────────────────────────────────────────────────┤
│  1. INDEXING                                                 │
│     Raw Docs → Entity Extraction → Relation Mining →        │
│     Knowledge Graph + Community Detection (Leiden)          │
│                                                              │
│  2. RETRIEVAL                                                │
│     Query → Graph Traversal + Vector Search →               │
│     Relevant Subgraph + Text Chunks                         │
│                                                              │
│  3. GENERATION                                               │
│     Subgraph Context + Query → LLM → Grounded Answer        │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 2026 State-of-the-Art Módszertanok

### 2.1 Microsoft GraphRAG (Referencia Implementáció)

**Publikáció:** Microsoft Research, 2024 (20,000+ GitHub stars)
**Konferencia:** Folyamatosan fejlesztett, széles körben hivatkozott

**Architektúra:**
1. **Entity Extraction** - GPT-4 speciális promptokkal
2. **Relationship Mapping** - Co-occurrence + szemantikus hasonlóság
3. **Community Detection** - Leiden algoritmus hierarchikus klaszterezéshez
4. **Hierarchical Summarization** - Community-szintű összefoglalók

**Eredmények:**
- 86% pontosság enterprise benchmarkon (vs 32% baseline RAG)
- 62% hallucináció csökkenés

**Forrás:** [Microsoft Research GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/)

---

### 2.2 LightRAG (EMNLP 2025)

**Publikáció:** HKUDS, EMNLP 2025
**GitHub:** [HKUDS/LightRAG](https://github.com/hkuds/lightrag)

**Jellemzők:**
- Lightweight graph + text indexing
- Dual-level retrieval (local + global)
- Korlátozott hardveren is futtatható
- Multimodal támogatás (RAG-Anything, 2025 június)

**Friss Fejlesztések (2025-2026):**
- 2026.03: Setup wizard Docker támogatással
- 2025.11: RAGAS evaluáció + Langfuse tracing
- 2025.08: Reranker támogatás

**Mikor használd:** Korlátozott erőforrások, gyors prototípus

---

### 2.3 MiniRAG (ACL 2026)

**Publikáció:** HKUDS, ACL 2026
**GitHub:** [HKUDS/MiniRAG](https://github.com/hkuds/minirag)

**Jellemzők:**
- Kis, open-source LLM-ekkel működik
- Unified text + entity indexing
- Semantics-aware graph struktúra
- Topology-enhanced keresés

**Támogatott Adatbázisok:**
- Neo4j, PostgreSQL, TiDB (10+ heterogén graph DB)
- API & Docker deployment

**Mikor használd:** Cost-sensitive deployment, small LLM preferencia

---

### 2.4 PathRAG (2025)

**Publikáció:** arXiv 2025
**Fókusz:** Relációs útvonalak pruning-ja

**Jellemzők:**
- Key relational paths extraction
- Text prompt konverzió az LLM számára
- Koherensebb, kontextus-aware generálás

**Összehasonlítás:** NaiveRAG, HyDE, GraphRAG, LightRAG ellen tesztelve

---

### 2.5 Egyéb Jelentős Kutatások

| Név | Konferencia | Fókusz |
|-----|-------------|--------|
| **TagRAG** | 2026 | Tag-guided hierarchikus KG retrieval |
| **AtomicRAG** | 2026 | Atom-Entity graphs |
| **ContextRAG** | 2026 | Extraction-free hierarchikus konstrukció |
| **LinearRAG** | 2025.10 | Relation-free graph (hatékonyság) |

**Forrás:** [Awesome-GraphRAG GitHub](https://github.com/DEEP-PolyU/Awesome-GraphRAG)

---

## 3. Benchmark Eredmények

### 3.1 Hallucináció Csökkenés

| Módszer | Hallucináció Ráta | Csökkenés |
|---------|-------------------|-----------|
| Traditional RAG | 25-35% | - |
| GraphRAG (Microsoft) | 10-15% | ~60% |
| Enterprise deployments (47 db) | - | 62% átlag |
| DeepSeek-V3.2 + GraphRAG | 0.30% | 61% (vs 0.77%) |

**Forrás:** [RAG vs GraphRAG Evaluation (arXiv)](https://arxiv.org/html/2502.11371v3)

### 3.2 GraphRAG-Bench (ICLR 2026)

- Domain-specific reasoning értékelés
- Több ezer query szisztematikus tesztelése
- Akadémiai elismerés (ICLR acceptance)

---

## 4. Technológiai Stack

### 4.1 Graph Adatbázisok

| Adatbázis | Előny | Hátrány |
|-----------|-------|---------|
| **Neo4j** | Érett, LangChain integráció | Licenc költség (enterprise) |
| **FalkorDB** | Redis-kompatibilis, gyors | Kisebb ökoszisztéma |
| **PostgreSQL + AGE** | Meglévő infra | Kevésbé optimalizált |
| **NetworkX** | Python natív, nincs külső dep | Csak memóriában, nem skálázódik |

### 4.2 Integráció Frameworkök

**LangChain + Neo4j:**
- `llm-graph-transformer` modul (Neo4j kontribúció)
- CypherQAChain természetes nyelvű query-khez
- Hybrid graph + vector RAG támogatás

**Forrás:** [Neo4j LangChain Integration](https://neo4j.com/labs/genai-ecosystem/langchain/)

### 4.3 Entity Extraction

| Módszer | Pontosság | Megjegyzés |
|---------|-----------|------------|
| LLM-based NER | 0.94 (entity), 0.93 (relation) | Felülmúlja a fine-tuned modelleket |
| GPT-4 + Prompt Engineering | Magas | Költséges |
| DeepSeek + Few-shot | Jó | Cost-effective |

**Lépések:**
1. Named Entity Recognition (NER) - atomi entitások
2. Coreference Resolution - ugyanarra az entitásra utaló említések
3. Relation Extraction - entitások közötti kapcsolatok

---

## 5. Előnyök és Hátrányok

### 5.1 Előnyök

| Előny | Leírás |
|-------|--------|
| **Hallucináció csökkenés** | 60%+ csökkenés strukturált kontextussal |
| **Multi-hop reasoning** | Több entitáson átívelő kérdések |
| **Explainability** | Gráf útvonal mint magyarázat |
| **Komplex query** | "Mi függ ettől?" típusú kérdések |
| **Global summarization** | Teljes dokumentumhalmaz áttekintése |

### 5.2 Hátrányok

| Hátrány | Részletek | Mitigáció |
|---------|-----------|-----------|
| **Magasabb költség** | Lineárisan skálázódik gráf mérettel | LightRAG, MiniRAG |
| **Latencia** | 2.5s vs 0.85s/query | Caching, pre-computation |
| **Komplexitás** | Több komponens, nehezebb debug | Fokozatos bevezetés |
| **Adatminőség** | 60% org-nak nincs AI-ready adat | Data governance first |
| **Path explosion** | Ciklikus gráfok problémája | Pruning, depth limit |

### 5.3 Mikor Érdemes GraphRAG-ot Használni?

**IGEN:**
- 1000+ dokumentum / kódfájl
- Cross-reference kérdések gyakoriak
- Impact analysis szükséges
- Hallucináció kritikus probléma
- Multi-hop reasoning kell

**NEM:**
- Egyszerű Q&A elegendő
- Kis dokumentumhalmaz (<100)
- Költségérzékeny, nincs infra budget
- Gyors prototípus kell

---

## 6. Implementációs Terv JoineryTech/Nexus-re

### 6.1 Jelenlegi Állapot

```
Nexus Knowledge Service:
├── ChromaDB (vector store) ✅
├── Xenova embeddings (all-MiniLM-L6-v2) ✅
├── search_knowledge MCP tool ✅
├── EPICS.yaml workflow DAG ✅
└── Knowledge graph ❌ (HIÁNYZIK)
```

### 6.2 Javasolt Fázisok

#### Fázis 1: Pilot (2-3 hét)
- **Cél:** Proof of Concept egy modulra
- **Scope:** JoineryTech Cutting modul (575 C# fájl)
- **Output:** Entity gráf (Class, Service, API Endpoint kapcsolatok)
- **Tech:** NetworkX (memória) vagy Neo4j Community

#### Fázis 2: Entity Extraction Pipeline (2-3 hét)
- **Cél:** Automatikus NER a kódbázisból
- **Input:** C#, TypeScript fájlok
- **Output:** Entitások (Module, Class, Function, API) + Relációk (USES, DEPENDS_ON, CALLS)
- **Tech:** LLM-based extraction (Claude/GPT-4) vagy AST parsing

#### Fázis 3: Hybrid Search (2 hét)
- **Cél:** Graph + Vector kombinált keresés
- **Integráció:** Meglévő `search_knowledge` MCP tool bővítése
- **Query típusok:**
  - "Mi használja az Inventory API-t?" → Graph traversal
  - "Hogyan működik az árazás?" → Vector search
  - "Ha módosítom X-et, mi törik?" → Hybrid

#### Fázis 4: Production (2-3 hét)
- **Cél:** Teljes JoineryTech lefedés
- **Scale:** 4000+ C# + 600+ TS fájl
- **Infra:** Neo4j vagy PostgreSQL+AGE
- **Monitoring:** Query latencia, gráf méret, cache hit rate

### 6.3 Becsült Erőforrás

| Fázis | Idő | Költség (infra) |
|-------|-----|-----------------|
| Pilot | 2-3 hét | Minimális (NetworkX) |
| Entity Pipeline | 2-3 hét | LLM API költség |
| Hybrid Search | 2 hét | - |
| Production | 2-3 hét | Neo4j license vagy PostgreSQL |
| **Összesen** | 8-11 hét | Változó |

---

## 7. Összefoglaló

### Főbb Tanulságok

1. **GraphRAG érett technológia** - Microsoft, EMNLP, ACL, ICLR publikációk
2. **60% hallucináció csökkenés** - többszörösen validált eredmény
3. **Több lightweight alternatíva** - LightRAG, MiniRAG cost-effective
4. **Neo4j + LangChain** - production-ready integráció
5. **Entity extraction automatizálható** - LLM-based NER 0.94 pontosság

### Ajánlás JoineryTech-re

A platform **elérte a komplexitási küszöböt** (5000+ fájl, 20+ modul) ahol GraphRAG valós értéket ad. Javasolt:

1. **Rövid táv:** Pilot a Cutting modulon NetworkX-szel
2. **Közép táv:** LightRAG vagy Neo4j integráció
3. **Hosszú táv:** Teljes hybrid search a knowledge service-ben

---

## 8. Források

### Akadémiai
- [RAG vs GraphRAG Systematic Evaluation (arXiv)](https://arxiv.org/html/2502.11371v3)
- [GraphRAG-Bench (ICLR 2026)](https://arxiv.org/pdf/2506.02404)
- [LightRAG (EMNLP 2025)](https://github.com/hkuds/lightrag)
- [MiniRAG (ACL 2026)](https://github.com/hkuds/minirag)
- [Awesome-GraphRAG Collection](https://github.com/DEEP-PolyU/Awesome-GraphRAG)

### Ipari
- [Microsoft Research GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/)
- [Neo4j LangChain Integration](https://neo4j.com/labs/genai-ecosystem/langchain/)
- [Graph RAG 2026 Practitioner's Guide](https://medium.com/graph-praxis/graph-rag-in-2026-a-practitioners-guide-to-what-actually-works-dca4962e7517)

### Képzés
- [Cubixedu GraphRAG Képzés](https://cubixedu.com/graphrag-kepzes-tudasgraf-alapu-ai-alkalmazasok-fejlesztese/)

---

_Nexus Knowledge Base - GraphRAG Research 2026_
