/**
 * Vector store: ChromaDB primary, in-memory fallback.
 *
 * ChromaDB runs via Docker at CHROMA_URL (default: http://localhost:8001).
 * Embedding is handled by embeddings.ts (Voyage AI or local).
 * If ChromaDB is unavailable, falls back to an in-memory store (no persistence).
 *
 * MULTI-ISLAND: one service instance serves several islands, each backed by
 * its own collection (`<island>-knowledge`). Collections are opened lazily
 * and cached per island, so the island can be chosen PER REQUEST (from the
 * caller's identity) instead of being fixed at startup. Callers that pass no
 * island get DEFAULT_ISLAND (env ISLAND_ID) — existing behavior unchanged.
 */

import { ChromaClient, Collection } from 'chromadb';
import { embedDocuments, embedQuery, embeddingBackend } from './embeddings';
import { XenovaEmbeddingFunction } from './xenovaEmbedding';
import { COLLECTION_NAME } from './config/paths';
import { DEFAULT_ISLAND, resolveIslandId } from './core/island';
import { env } from './config/env';
import { logger } from './core/logger';

export interface SearchResult {
  text: string;
  metadata: Record<string, string | number | boolean>;
  score?: number;
}

interface MemoryDoc {
  id: string;
  text: string;
  metadata: Record<string, string | number | boolean>;
  embedding: number[];
}

// Island identity lives in core/island.ts so that other stores can use it
// without importing this module (and with it the whole Chroma/embedding
// stack). Re-exported here because callers have always imported it from the
// vector store.
export { DEFAULT_ISLAND, ISLAND_ID_RX, UnknownIslandError } from './core/island';

/**
 * Collection name for an island. The default island honors an explicit
 * COLLECTION_NAME override so existing single-island deployments keep
 * pointing at their current collection.
 */
export function collectionNameForIsland(island: string): string {
  return island === DEFAULT_ISLAND ? COLLECTION_NAME : `${island}-knowledge`;
}

const resolveIsland = resolveIslandId;

let client: ChromaClient | null = null;
let embeddingFunction: XenovaEmbeddingFunction | null = null;
/** island -> ChromaDB collection (lazily opened). */
const collections = new Map<string, Collection>();
/** island -> in-memory docs (fallback when ChromaDB is unavailable). */
const memoryDocsByIsland = new Map<string, MemoryDoc[]>();
let isChromaConnected = false;
let initialized = false;

const CHROMA_URL = env.CHROMA_URL;

function memoryDocsFor(island: string): MemoryDoc[] {
  let docs = memoryDocsByIsland.get(island);
  if (!docs) {
    docs = [];
    memoryDocsByIsland.set(island, docs);
  }
  return docs;
}

/**
 * Open (and cache) the collection for an island. Returns null when ChromaDB
 * is unavailable — callers then use the in-memory fallback.
 */
async function getCollection(island: string): Promise<Collection | null> {
  if (!isChromaConnected || !client) return null;

  const cached = collections.get(island);
  if (cached) return cached;

  const name = collectionNameForIsland(island);
  const created = await client.getOrCreateCollection({
    name,
    metadata: { description: `SpaceOS Knowledge Base — island: ${island}` },
    embeddingFunction: embeddingFunction as any, // chromadb types are incomplete
  });
  collections.set(island, created);
  logger.info(`🟢 [VDB] Collection ready: ${name} (island: ${island})`);
  return created;
}

/** Test seam: drop cached client/collections so a fresh init can run. */
export function resetVectorStoreForTests(): void {
  client = null;
  embeddingFunction = null;
  collections.clear();
  memoryDocsByIsland.clear();
  isChromaConnected = false;
  initialized = false;
}

export async function initVectorStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  logger.info(`🔮 Embedding backend: ${embeddingBackend()}`);

  try {
    const chromaUrl = new URL(CHROMA_URL);
    client = new ChromaClient({
      host: chromaUrl.hostname,
      port: parseInt(chromaUrl.port || '8001', 10),
      ssl: chromaUrl.protocol === 'https:',
    });
    await client.heartbeat();

    // Use XenovaEmbeddingFunction (@xenova/transformers all-MiniLM-L6-v2, 384 dim)
    // Client-side ONNX embedding, NO Sharp dependency, same model as ChromaDB server default
    embeddingFunction = new XenovaEmbeddingFunction();

    isChromaConnected = true;

    // Open the default island eagerly so startup still surfaces a bad
    // ChromaDB/collection immediately; other islands open on first use.
    await getCollection(DEFAULT_ISLAND);
    logger.info(
      `🟢 [VDB] ChromaDB connected: ${CHROMA_URL} (default island: ${DEFAULT_ISLAND})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`⚠️  [VDB] ChromaDB unavailable: ${msg}`);
    logger.warn('    Falling back to in-memory store (data lost on restart).');
    logger.warn('    Start ChromaDB: docker compose up -d (from the knowledge-service repo root)');
    isChromaConnected = false;
  }
}

export async function addChunks(
  chunks: Array<{ id: string; text: string; metadata: Record<string, string | number | boolean> }>,
  island?: string
): Promise<void> {
  const islandId = resolveIsland(island);
  const valid = chunks.filter(c => c.text.trim().length > 10);
  if (valid.length === 0) return;

  const embeddings = await embedDocuments(valid.map(c => c.text));
  const collection = await getCollection(islandId);

  if (collection) {
    // If embeddings is undefined, ChromaDB server will calculate them
    const upsertParams: any = {
      ids: valid.map(c => c.id),
      documents: valid.map(c => c.text),
      metadatas: valid.map(c => c.metadata),
    };
    if (embeddings !== undefined) {
      upsertParams.embeddings = embeddings;
    }
    await collection.upsert(upsertParams);
  } else {
    // In-memory fallback uses embeddings if available, otherwise placeholders
    const placeholderEmbedding = [0];
    const docs = memoryDocsFor(islandId);
    for (let i = 0; i < valid.length; i++) {
      docs.push({
        id: valid[i].id,
        text: valid[i].text,
        metadata: valid[i].metadata,
        embedding: embeddings ? embeddings[i] : placeholderEmbedding,
      });
    }
  }
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  return dot / (Math.sqrt(mA) * Math.sqrt(mB));
}

export async function searchKnowledge(
  query: string,
  topK = 5,
  island?: string,
  domain?: string
): Promise<SearchResult[]> {
  const islandId = resolveIsland(island);
  const qEmbedding = await embedQuery(query);
  const collection = await getCollection(islandId);

  if (collection) {
    const count = await collection.count();
    if (count === 0) return [];

    // If qEmbedding is undefined, use queryTexts (ChromaDB server-side embedding)
    const queryParams: any = {
      nResults: Math.min(topK, count),
    };
    if (domain) {
      queryParams.where = { domain: { $eq: domain } };
    }
    if (qEmbedding !== undefined) {
      queryParams.queryEmbeddings = [qEmbedding];
    } else {
      queryParams.queryTexts = [query];
    }

    const results = await collection.query(queryParams);

    if (!results.documents?.[0]) return [];

    return results.documents[0]
      .filter((doc): doc is string => doc !== null)
      .map((doc, i) => ({
        text: doc,
        metadata: (results.metadatas?.[0]?.[i] ?? {}) as Record<string, string | number | boolean>,
        // ChromaDB returns L2 distance; lower = better.
        score: results.distances?.[0]?.[i] != null
          ? parseFloat((1 / (1 + (results.distances[0][i] as number))).toFixed(4))
          : undefined,
      }));
  }

  // Memory fallback (per island)
  const memoryDocs = memoryDocsFor(islandId).filter(
    (doc) => !domain || doc.metadata.domain === domain
  );
  if (qEmbedding === undefined) {
    // Keyword-matching search fallback
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    if (terms.length === 0) return [];

    return memoryDocs
      .map(doc => {
        let matches = 0;
        const textLower = doc.text.toLowerCase();
        for (const term of terms) {
          if (textLower.includes(term)) {
            matches++;
          }
        }
        const score = matches / terms.length;
        return { text: doc.text, metadata: doc.metadata, score };
      })
      .filter(doc => doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  return memoryDocs
    .map(doc => ({ ...doc, score: cosineSim(qEmbedding, doc.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ text, metadata, score }) => ({ text, metadata, score }));
}

export async function getDocumentCount(island?: string): Promise<number> {
  const islandId = resolveIsland(island);
  const collection = await getCollection(islandId);
  if (collection) {
    return await collection.count();
  }
  return memoryDocsFor(islandId).length;
}

export function usingChroma(): boolean {
  return isChromaConnected;
}
