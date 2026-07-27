/**
 * hybridSearch.ts — Unified search combining FTS5 + ChromaDB
 *
 * Provides a single search interface that:
 * 1. FTS5 (memoryStore) for fast keyword matching on memories
 * 2. ChromaDB (vectorStore) for semantic similarity on knowledge docs
 *
 * The hybrid approach gives best of both worlds:
 * - Exact matches via FTS5 (fast, precise)
 * - Semantic matches via vectors (understands meaning)
 */

import { hybridSearch as memoryHybridSearch, SearchResult as MemorySearchResult, Memory } from './ftsMemoryStore';
import { log as pipelineLog } from './common';
import { COLLECTION_NAME } from '../config/paths';
import { CHROMA_EFFECTIVE_URL, secrets } from '../config/env';

const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnowledgeResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface UnifiedSearchResult {
  type: 'memory' | 'knowledge';
  content: string;
  score: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  terminal?: string;
  includeMemory?: boolean;
  includeKnowledge?: boolean;
  memoryWeight?: number;
  knowledgeWeight?: number;
}

// ─── ChromaDB Integration ────────────────────────────────────────────────────

// Effective ChromaDB URL (legacy CHROMADB_URL alias handled centrally).
const CHROMADB_URL = CHROMA_EFFECTIVE_URL;

async function searchChromaDB(query: string, limit: number = 5): Promise<KnowledgeResult[]> {
  try {
    // First, get embeddings for the query
    const embeddings = await getQueryEmbedding(query);
    if (!embeddings) {
      log('hybridSearch', 'Failed to get query embeddings');
      return [];
    }

    // Query ChromaDB
    const response = await fetch(`${CHROMADB_URL}/api/v1/collections/${COLLECTION_NAME}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_embeddings: [embeddings],
        n_results: limit,
        include: ['documents', 'metadatas', 'distances'],
      }),
    });

    if (!response.ok) {
      log('hybridSearch', `ChromaDB query failed: ${response.status}`);
      return [];
    }

    const data = await response.json() as {
      documents?: string[][];
      metadatas?: Array<Array<Record<string, unknown>>>;
      distances?: number[][];
      ids?: string[][];
    };

    // Parse results
    const results: KnowledgeResult[] = [];
    const documents = data.documents?.[0] || [];
    const metadatas = data.metadatas?.[0] || [];
    const distances = data.distances?.[0] || [];
    const ids = data.ids?.[0] || [];

    for (let i = 0; i < documents.length; i++) {
      results.push({
        id: ids[i],
        content: documents[i],
        metadata: metadatas[i] || {},
        similarity: 1 - (distances[i] || 0), // Convert distance to similarity
      });
    }

    return results;
  } catch (err) {
    log('hybridSearch', `ChromaDB error: ${err}`);
    return [];
  }
}

async function getQueryEmbedding(query: string): Promise<number[] | null> {
  // Try Voyage AI first (same as knowledge-service)
  const voyageKey = secrets.voyageApiKey;
  if (voyageKey) {
    try {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${voyageKey}`,
        },
        body: JSON.stringify({
          model: 'voyage-3-lite',
          input: [query],
        }),
      });

      if (response.ok) {
        const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
        return data.data?.[0]?.embedding || null;
      }
    } catch {
      // Fall through to next provider
    }
  }

  // Try Google Gemini
  const geminiKey = secrets.googleApiKey;
  if (geminiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { parts: [{ text: query }] },
          }),
        }
      );

      if (response.ok) {
        const data = await response.json() as { embedding?: { values?: number[] } };
        return data.embedding?.values || null;
      }
    } catch {
      // Fall through
    }
  }

  log('hybridSearch', 'No embedding provider available');
  return null;
}

// ─── Unified Search ──────────────────────────────────────────────────────────

/**
 * Unified search across memory (FTS5) and knowledge (ChromaDB)
 */
export async function unifiedSearch(
  query: string,
  options: SearchOptions = {}
): Promise<UnifiedSearchResult[]> {
  const {
    limit = 10,
    terminal,
    includeMemory = true,
    includeKnowledge = true,
    memoryWeight = 0.4,
    knowledgeWeight = 0.6,
  } = options;

  const results: UnifiedSearchResult[] = [];

  // Search memories (FTS5)
  if (includeMemory) {
    try {
      const memoryResults = memoryHybridSearch(query, { limit, terminal });

      for (const { memory, score } of memoryResults) {
        results.push({
          type: 'memory',
          content: memory.content,
          score: score * memoryWeight,
          source: `${memory.type}/${memory.source}`,
          metadata: {
            id: memory.id,
            terminal: memory.terminal,
            salience: memory.salience,
            accessCount: memory.accessCount,
          },
        });
      }
    } catch (err) {
      log('hybridSearch', `Memory search error: ${err}`);
    }
  }

  // Search knowledge (ChromaDB)
  if (includeKnowledge) {
    try {
      const knowledgeResults = await searchChromaDB(query, limit);

      for (const result of knowledgeResults) {
        results.push({
          type: 'knowledge',
          content: result.content.slice(0, 500), // Truncate long docs
          score: result.similarity * knowledgeWeight,
          source: (result.metadata.source as string) || 'knowledge',
          metadata: result.metadata,
        });
      }
    } catch (err) {
      log('hybridSearch', `Knowledge search error: ${err}`);
    }
  }

  // Sort by score and limit
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Search with automatic source selection based on query
 */
export async function smartSearch(
  query: string,
  options: Omit<SearchOptions, 'includeMemory' | 'includeKnowledge'> = {}
): Promise<UnifiedSearchResult[]> {
  // Determine what to search based on query patterns
  const memoryPatterns = /remember|korábban|előtt|mondtam|preferál|emlék/i;
  const knowledgePatterns = /hogyan|how to|dokumentáció|docs|pattern|minta|architektúra/i;

  const isMemoryQuery = memoryPatterns.test(query);
  const isKnowledgeQuery = knowledgePatterns.test(query);

  // Default: search both, but weight based on query type
  let memoryWeight = 0.4;
  let knowledgeWeight = 0.6;

  if (isMemoryQuery && !isKnowledgeQuery) {
    memoryWeight = 0.8;
    knowledgeWeight = 0.2;
  } else if (isKnowledgeQuery && !isMemoryQuery) {
    memoryWeight = 0.2;
    knowledgeWeight = 0.8;
  }

  return unifiedSearch(query, {
    ...options,
    memoryWeight,
    knowledgeWeight,
  });
}

// ─── Context Building ────────────────────────────────────────────────────────

/**
 * Build a context block for LLM prompts
 */
export async function buildSearchContext(
  query: string,
  options: SearchOptions & { maxLength?: number } = {}
): Promise<string> {
  const { maxLength = 2000, ...searchOptions } = options;
  const results = await unifiedSearch(query, searchOptions);

  if (results.length === 0) {
    return '';
  }

  const lines: string[] = ['## Relevant Context\n'];
  let totalLength = lines[0].length;

  for (const result of results) {
    const emoji = result.type === 'memory' ? '💭' : '📚';
    const line = `${emoji} [${result.source}] ${result.content}\n`;

    if (totalLength + line.length > maxLength) {
      lines.push('\n_...additional results truncated_');
      break;
    }

    lines.push(line);
    totalLength += line.length;
  }

  return lines.join('\n');
}

// ─── Index Management ────────────────────────────────────────────────────────

/**
 * Get search system status
 */
export async function getSearchStatus(): Promise<{
  memory: { available: boolean; stats?: Record<string, unknown> };
  knowledge: { available: boolean; documentCount?: number };
}> {
  const status = {
    memory: { available: false } as { available: boolean; stats?: Record<string, unknown> },
    knowledge: { available: false } as { available: boolean; documentCount?: number },
  };

  // Check memory store
  try {
    const { getMemoryStats } = await import('./memoryStore');
    const stats = getMemoryStats();
    status.memory = { available: true, stats };
  } catch {
    // Memory store not available
  }

  // Check ChromaDB
  try {
    const response = await fetch(`${CHROMADB_URL}/api/v1/collections/${COLLECTION_NAME}`, {
      method: 'GET',
    });

    if (response.ok) {
      const data = await response.json() as { count?: number };
      status.knowledge = { available: true, documentCount: data.count || 0 };
    }
  } catch {
    // ChromaDB not available
  }

  return status;
}
