/**
 * Island identity primitives, shared by every store.
 *
 * These live in `core` rather than in `vectorStore` so that using an island id
 * does not drag in a storage backend: importing `vectorStore` pulls in the
 * ChromaDB client and the embedding stack (which in turn loads native
 * libraries), and the knowledge graph — including the indexer CLI — needs
 * none of that. Same shape for every store: an island id is also a ChromaDB
 * collection name and part of the graph's composite key, so it stays strict
 * and boring ('|' is intentionally illegal).
 */

import { ISLAND_ID } from '../config/paths';

/** Island used when a caller does not specify one. */
export const DEFAULT_ISLAND = ISLAND_ID;

export const ISLAND_ID_RX = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class UnknownIslandError extends Error {
  constructor(island: string) {
    super(`Invalid island id: ${island}`);
    this.name = 'UnknownIslandError';
  }
}

/** Validate an optional island id, falling back to the default. */
export function resolveIslandId(island?: string): string {
  const id = island ?? DEFAULT_ISLAND;
  if (!ISLAND_ID_RX.test(id)) throw new UnknownIslandError(id);
  return id;
}
