import { logger } from './core/logger';
/**
 * Server-side embedding approach: let ChromaDB handle all embeddings.
 * No client-side embedding library needed → no sharp dependency → no CPU arch issues.
 *
 * ChromaDB server has built-in all-MiniLM-L6-v2 model (sentence-transformers).
 * We just send text, ChromaDB calculates embeddings server-side.
 */

// ─── Voyage AI (optional upgrade) ────────────────────────────────────────────

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite';
const VOYAGE_BATCH = 50; // Reduced for rate limiting
const VOYAGE_DELAY_MS = 40000; // 40 seconds delay (3 RPM free tier, conservative)

async function voyageEmbed(
  texts: string[],
  inputType: 'document' | 'query'
): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY not set');

  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage API ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  return data.data
    .sort((a, b) => a.index - b.index)
    .map(item => item.embedding);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const useVoyage = (): boolean => !!process.env.VOYAGE_API_KEY;

/**
 * Embed documents. Returns undefined for server-side (ChromaDB handles it).
 */
export async function embedDocuments(texts: string[]): Promise<number[][] | undefined> {
  if (useVoyage()) {
    const results: number[][] = [];
    const totalBatches = Math.ceil(texts.length / VOYAGE_BATCH);
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
      const batchNum = Math.floor(i / VOYAGE_BATCH) + 1;
      const batch = texts.slice(i, i + VOYAGE_BATCH);
      logger.info(`⏳ Embedding batch ${batchNum}/${totalBatches} (${batch.length} texts)...`);
      results.push(...(await voyageEmbed(batch, 'document')));

      // Rate limiting: wait before next batch (except for last batch)
      if (i + VOYAGE_BATCH < texts.length) {
        logger.info(`   Waiting ${VOYAGE_DELAY_MS / 1000}s (rate limit)...`);
        await new Promise(resolve => setTimeout(resolve, VOYAGE_DELAY_MS));
      }
    }
    return results;
  }
  // Return undefined → ChromaDB server will embed using its built-in model
  return undefined;
}

/**
 * Embed query. Returns undefined for server-side (ChromaDB handles it).
 */
export async function embedQuery(text: string): Promise<number[] | undefined> {
  if (useVoyage()) {
    const [emb] = await voyageEmbed([text], 'query');
    return emb;
  }
  // Return undefined → ChromaDB server will embed using its built-in model
  return undefined;
}

export function embeddingBackend(): string {
  return useVoyage() ? `voyage-ai (${VOYAGE_MODEL})` : 'chromadb-server (all-MiniLM-L6-v2)';
}
