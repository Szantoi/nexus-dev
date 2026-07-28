/**
 * Index-run bookkeeping: per-source freshness metadata (`--if-changed`) and
 * the index-run write lease (upsert-clobber guard). Split from graphStore.ts
 * (800-line gate) — this is the "when may a run skip, and who may write"
 * responsibility, while graphStore remains the entity/traversal store.
 *
 * Raw Cypher stays inside the knowledgeGraph layer: this module reaches the
 * database through graphStore's internal seam (internalRun), which nothing
 * outside src/knowledgeGraph may import (module-boundary test guards it).
 */

import neo4j from 'neo4j-driver-lite';
import { env } from '../config/env';
import {
  GraphUnavailableError,
  internalResolveIsland as resolveIsland,
  internalRun as run,
} from './graphStore';

/**
 * Bookkeeping for one island's index run. Stored on its OWN label so the
 * entity sweep (which only touches :KnowledgeEntity) can never delete it.
 */
/** One source's freshness record: content hash + the run that wrote it. */
export interface SourceIndexEntry {
  /** sha256 of the source's (filtered) extraction result. */
  h: string;
  /** The syncTag of the run that wrote this entry. A skip is only honest if
   *  the entry comes from the island's LATEST run (t === meta.indexedAt) —
   *  a later run by another machine may have swept entities this source's
   *  edges hang on (checkout drift), so an older entry's matching hash says
   *  nothing about what the graph still holds. */
  t: string;
}

export interface IndexMeta {
  /**
   * Per-source freshness, keyed by the source's machine-independent key
   * (`extractor:declaredPath`). Per SOURCE, not per corpus: two machines
   * index the same island with different source subsets (the coverage source
   * only exists where tests run), so a whole-corpus hash would mismatch on
   * every host switch and re-write the graph in a loop. Each run compares and
   * refreshes only ITS OWN sources' entries and must preserve the rest.
   */
  sourceHashes: Record<string, SourceIndexEntry>;
  /** Commit the corpus was at, when the repo root is a git checkout. */
  commit?: string;
  indexedAt: string;
  nodes: number;
  relations: number;
}

function parseSourceHashes(raw: unknown): Record<string, SourceIndexEntry> {
  // Unparseable/legacy metadata (the pre-source-hash `corpusHash` format)
  // degrades to "nothing recorded" — the next run does one full index and
  // writes the new format. Never a crash, never a false "up to date".
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, SourceIndexEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { h?: unknown }).h === 'string' &&
        typeof (value as { t?: unknown }).t === 'string'
      ) {
        out[key] = { h: (value as { h: string }).h, t: (value as { t: string }).t };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function readIndexMeta(island?: string): Promise<IndexMeta | null> {
  const islandId = resolveIsland(island);
  const { records } = await run('MATCH (m:KnowledgeIndexMeta {island: $island}) RETURN m', {
    island: islandId,
  });
  const props = (records[0]?.get('m') as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (props === undefined) return null;
  const meta: IndexMeta = {
    sourceHashes: parseSourceHashes(props.sourceHashesJson),
    indexedAt: String(props.indexedAt ?? ''),
    nodes: Number(props.nodes ?? 0),
    relations: Number(props.relations ?? 0),
  };
  if (typeof props.commit === 'string' && props.commit !== '') meta.commit = props.commit;
  return meta;
}

/**
 * Invalidate an island's freshness record BEFORE a write pass, so a
 * fingerprint exists only for sources whose last run COMPLETED: a run that
 * died mid-write must not leave a hash that lets `--if-changed` skip over the
 * damage while reporting "up to date".
 *
 * With `sourceKeys`, only those entries are dropped — the other machines'
 * sources (which this run does not touch and cannot damage) keep their
 * freshness. Without it, the whole meta node goes (full reset).
 */
export async function clearIndexMeta(island?: string, sourceKeys?: readonly string[]): Promise<void> {
  const islandId = resolveIsland(island);
  if (sourceKeys === undefined) {
    await run('MATCH (m:KnowledgeIndexMeta {island: $island}) DELETE m', { island: islandId });
    return;
  }
  const existing = await readIndexMeta(islandId);
  if (existing === null) return;
  const remaining = { ...existing.sourceHashes };
  for (const key of sourceKeys) delete remaining[key];
  // Unconditional SET (no monotonic guard): an invalidation must always win —
  // it can only cause an extra full index, never a false "up to date".
  await run(
    'MATCH (m:KnowledgeIndexMeta {island: $island}) SET m.sourceHashesJson = $json',
    { island: islandId, json: JSON.stringify(remaining) }
  );
}

export async function writeIndexMeta(
  meta: IndexMeta,
  island?: string,
  options: { retainOnlyKeys?: readonly string[] } = {}
): Promise<void> {
  const islandId = resolveIsland(island);
  // MERGE semantics for the hash map: this run refreshes its own sources'
  // entries and must not drop entries owned by sources it did not run (the
  // read-merge-write is not atomic; a concurrent run's lost entry costs one
  // extra re-index, never a false skip).
  const current = await readIndexMeta(islandId);
  let merged = { ...(current?.sourceHashes ?? {}), ...meta.sourceHashes };
  // Prune GHOST entries: a stored key outside the corpus's declared sources
  // (active AND env-gated) belongs to a source REMOVED from the config. This
  // run's island-wide entity sweep has already deleted that source's nodes,
  // so keeping its hash would make a later re-added, unchanged source skip
  // over a graph that no longer holds its data — a false "up to date".
  // Pruning errs the safe way: at worst one extra full index.
  if (options.retainOnlyKeys !== undefined) {
    const retain = new Set(options.retainOnlyKeys);
    merged = Object.fromEntries(Object.entries(merged).filter(([key]) => retain.has(key)));
  }
  await run(
    'MERGE (m:KnowledgeIndexMeta {island: $island}) ' +
      // Monotonic: two overlapping runs must not let the older one demote the
      // newer one's fingerprint (indexedAt is an ISO timestamp, so string
      // comparison is chronological).
      "WITH m WHERE $indexedAt >= coalesce(m.indexedAt, '') " +
      'SET m.sourceHashesJson = $sourceHashesJson, m.commit = $commit, m.indexedAt = $indexedAt, ' +
      'm.nodes = $nodes, m.relations = $relations',
    {
      island: islandId,
      sourceHashesJson: JSON.stringify(merged),
      commit: meta.commit ?? null,
      indexedAt: meta.indexedAt,
      nodes: neo4j.int(meta.nodes),
      relations: neo4j.int(meta.relations),
    }
  );
}

// ─── Index-run lease (upsert-clobber guard) ─────────────────────────────────
//
// Two overlapping index runs on one island corrupt each other: the slower,
// older-tag run's unconditional SETs overwrite the newer run's fresh data and
// resurrect nodes its sweep already deleted, while the meta stays the newer
// run's — a durable false "up to date" (COVERAGE-GRAPH-WIRING.md follow-up).
// The lease serializes the WRITE section. Atomicity comes from the uniqueness
// constraint: acquiring is a bare CREATE, so of two concurrent acquirers
// exactly one succeeds and the other gets a constraint violation ("busy").
// A TTL lets the island recover from a crashed holder without manual surgery.

/** An index-run write lease is held by another live run (upsert-clobber guard). */
export class GraphLeaseHeldError extends Error {
  constructor(island: string, holder: string, expiresAt: string) {
    super(
      `Index-run lease for island '${island}' is held by '${holder}' (expires ${expiresAt}) — ` +
        'refusing to write concurrently. Retry after the running index finishes or the lease expires.'
    );
    this.name = 'GraphLeaseHeldError';
  }
}

export interface IndexLeaseInfo {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export async function readIndexLease(island?: string): Promise<IndexLeaseInfo | null> {
  const islandId = resolveIsland(island);
  const { records } = await run('MATCH (l:KnowledgeIndexLease {island: $island}) RETURN l', {
    island: islandId,
  });
  const props = (records[0]?.get('l') as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (props === undefined) return null;
  return {
    holder: String(props.holder ?? ''),
    acquiredAt: String(props.acquiredAt ?? ''),
    expiresAt: String(props.expiresAt ?? ''),
  };
}

function isConstraintViolation(err: unknown): boolean {
  const cause = err instanceof GraphUnavailableError ? err.cause : err;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === 'string' && code.includes('ConstraintValidationFailed');
}

/**
 * Acquire the island's index-write lease or throw GraphLeaseHeldError.
 * An expired lease (crashed holder) is reaped first; if two runs race for a
 * reaped lease, the CREATE's uniqueness constraint picks exactly one winner.
 */
export async function acquireIndexLease(
  holder: string,
  island?: string,
  ttlMs: number = env.GRAPH_INDEX_LEASE_TTL_MS
): Promise<void> {
  const islandId = resolveIsland(island);
  const now = new Date();
  const nowIso = now.toISOString();
  // Reap a stale lease (idempotent; ISO strings compare chronologically).
  await run('MATCH (l:KnowledgeIndexLease {island: $island}) WHERE l.expiresAt < $now DELETE l', {
    island: islandId,
    now: nowIso,
  });
  try {
    await run(
      'CREATE (l:KnowledgeIndexLease {island: $island, holder: $holder, ' +
        'acquiredAt: $acquiredAt, expiresAt: $expiresAt})',
      {
        island: islandId,
        holder,
        acquiredAt: nowIso,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      }
    );
  } catch (err) {
    if (!isConstraintViolation(err)) throw err;
    const current = await readIndexLease(islandId);
    // Driver-level retry can replay a CREATE whose first attempt committed but
    // lost its response: colliding with OUR OWN lease is acquisition, not
    // contention (review P3 — without this the run would block itself for a
    // full TTL).
    if (current?.holder === holder) return;
    throw new GraphLeaseHeldError(
      islandId,
      current?.holder ?? '<unknown>',
      current?.expiresAt ?? '<unknown>'
    );
  }
}

/**
 * Release the lease — but ONLY the caller's own: a slow run whose lease
 * expired and was taken over must not delete the new holder's lease.
 */
export async function releaseIndexLease(holder: string, island?: string): Promise<void> {
  const islandId = resolveIsland(island);
  await run('MATCH (l:KnowledgeIndexLease {island: $island, holder: $holder}) DELETE l', {
    island: islandId,
    holder,
  });
}
