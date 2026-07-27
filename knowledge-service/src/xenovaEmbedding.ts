/**
 * Xenova Transformers embedding function for chromadb
 * Uses @xenova/transformers (ONNX runtime) - NO Sharp dependency!
 *
 * Model: all-MiniLM-L6-v2 (384 dimensions, same as ChromaDB default)
 * Performance: ~100-200ms per batch locally on VPS CPU
 *
 * Lazy dynamic import prevents loading @xenova/transformers (and any sharp/onnx
 * native module checks) at top-level module load time.
 */

import { logger } from './core/logger';

let extractorPromise: Promise<any> | null = null;

async function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    logger.info('[XenovaEmbedding] Loading all-MiniLM-L6-v2 model...');
    const { pipeline } = await import('@xenova/transformers');
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractorPromise;
}

export class XenovaEmbeddingFunction {
  dimension: number;

  constructor() {
    this.dimension = 384; // all-MiniLM-L6-v2 output dimension
  }

  async generate(texts: string[]): Promise<number[][]> {
    const extractor = await getExtractor();
    const embeddings: number[][] = [];

    for (const text of texts) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      embeddings.push(Array.from(output.data as Float32Array));
    }

    return embeddings;
  }
}
