/**
 * Vector store: ChromaDB primary, in-memory fallback.
 *
 * ChromaDB runs via Docker at CHROMA_URL (default: http://localhost:8001).
 * Embedding is handled by embeddings.ts (Voyage AI or local).
 * If ChromaDB is unavailable, falls back to an in-memory store (no persistence).
 */

import { ChromaClient, Collection } from 'chromadb';
import { embedDocuments, embedQuery, embeddingBackend } from './embeddings';
import { XenovaEmbeddingFunction } from './xenovaEmbedding';
import { ISLAND_ID, COLLECTION_NAME } from './config/paths';
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

let collection: Collection | null = null;
let memoryDocs: MemoryDoc[] = [];
let isChromaConnected = false;
let initialized = false;

const CHROMA_URL = env.CHROMA_URL;

export async function initVectorStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  logger.info(`🔮 Embedding backend: ${embeddingBackend()}`);

  try {
    const chromaUrl = new URL(CHROMA_URL);
    const client = new ChromaClient({
      host: chromaUrl.hostname,
      port: parseInt(chromaUrl.port || '8001', 10),
      ssl: chromaUrl.protocol === 'https:',
    });
    await client.heartbeat();

    // Use XenovaEmbeddingFunction (@xenova/transformers all-MiniLM-L6-v2, 384 dim)
    // Client-side ONNX embedding, NO Sharp dependency, same model as ChromaDB server default
    const embeddingFunction = new XenovaEmbeddingFunction();

    collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
      metadata: { description: 'SpaceOS Knowledge Base — docs/knowledge/**/*.md' },
      embeddingFunction: embeddingFunction as any, // chromadb types are incomplete
    });

    isChromaConnected = true;
    logger.info(`🟢 [VDB] ChromaDB connected: ${CHROMA_URL} (collection: ${COLLECTION_NAME})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`⚠️  [VDB] ChromaDB unavailable: ${msg}`);
    logger.warn('    Falling back to in-memory store (data lost on restart).');
    logger.warn('    Start ChromaDB: cd /opt/spaceos/spaceos-nexus && docker compose up -d');
    isChromaConnected = false;
  }
}

export async function addChunks(
  chunks: Array<{ id: string; text: string; metadata: Record<string, string | number | boolean> }>
): Promise<void> {
  const valid = chunks.filter(c => c.text.trim().length > 10);
  if (valid.length === 0) return;

  const embeddings = await embedDocuments(valid.map(c => c.text));

  if (isChromaConnected && collection) {
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
    for (let i = 0; i < valid.length; i++) {
      memoryDocs.push({
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
  topK = 5
): Promise<SearchResult[]> {
  const qEmbedding = await embedQuery(query);

  if (isChromaConnected && collection) {
    const count = await collection.count();
    if (count === 0) return [];

    // If qEmbedding is undefined, use queryTexts (ChromaDB server-side embedding)
    const queryParams: any = {
      nResults: Math.min(topK, count),
    };
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

  // Memory fallback
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

export async function getDocumentCount(): Promise<number> {
  if (isChromaConnected && collection) {
    return await collection.count();
  }
  return memoryDocs.length;
}

export function usingChroma(): boolean {
  return isChromaConnected;
}
