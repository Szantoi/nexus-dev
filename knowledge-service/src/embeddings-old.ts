/**
 * Embedding provider with two backends:
 *
 * 1. GOOGLE GEMINI (default when GOOGLE_API_KEY is set) — gemini-embedding-001
 *    Uses Google Generative AI. Requires GOOGLE_API_KEY.
 *    768 dimensions, good quality, free tier available.
 *
 * 2. VOYAGE AI (optional, higher quality) — voyage-3-lite, 1024 dims
 *    Activated when VOYAGE_API_KEY is set in environment.
 *    Recommended for production semantic search.
 *
 * Switch: set VOYAGE_API_KEY in .env to enable Voyage AI over Gemini.
 */

import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';

// ─── Google Gemini embedding (default) ───────────────────────────────────────

let _geminiEf: GoogleGenerativeAIEmbeddings | null = null;

function getGeminiEf(): GoogleGenerativeAIEmbeddings {
  if (!_geminiEf) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY not set in environment');
    }
    _geminiEf = new GoogleGenerativeAIEmbeddings({
      apiKey,
      modelName: 'gemini-embedding-001',
    });
  }
  return _geminiEf;
}

// ─── Voyage AI (optional) ─────────────────────────────────────────────────────

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite';
const VOYAGE_BATCH = 128;

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

const useVoyage = (): boolean => !!process.env.VOYAGE_API_KEY;

/**
 * Embed an array of texts for indexing (documents).
 */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (useVoyage()) {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
      const batch = texts.slice(i, i + VOYAGE_BATCH);
      results.push(...(await voyageEmbed(batch, 'document')));
    }
    return results;
  }
  // Use Google Gemini embedding
  return await getGeminiEf().embedDocuments(texts);
}

/**
 * Embed a single query string for retrieval.
 * Note: Voyage AI uses a distinct input_type for queries (better retrieval).
 */
export async function embedQuery(text: string): Promise<number[]> {
  if (useVoyage()) {
    const [emb] = await voyageEmbed([text], 'query');
    return emb;
  }
  // Use Google Gemini embedding
  return await getGeminiEf().embedQuery(text);
}

export function embeddingBackend(): string {
  return useVoyage() ? `voyage-ai (${VOYAGE_MODEL})` : 'google-gemini (gemini-embedding-001)';
}

export function getEmbeddingFunction(): GoogleGenerativeAIEmbeddings {
  return getGeminiEf();
}
