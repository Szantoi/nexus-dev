/**
 * Graph store: Neo4j-backed knowledge graph (GraphRAG pilot).
 *
 * Deployment: one shared Neo4j Community instance (docker/neo4j/ in the repo
 * root, loopback+tailnet bind). Community edition has no multi-database, so
 * island separation is logical: every node carries an `island` property and a
 * composite `key` (`<island>|<id>`), and EVERY query in this module filters on
 * the island. Callers never pass a raw Cypher fragment.
 *
 * Availability model (mirrors vectorStore's spirit, but stricter): when
 * GRAPH_URL or the password is missing, the store is DISABLED and calls throw
 * GraphDisabledError; when Neo4j is unreachable, calls throw
 * GraphUnavailableError. There is no in-memory fallback — a partial graph
 * would silently produce wrong impact-analysis answers, which is worse than
 * an honest error (fail-closed).
 */

import neo4j, { type Driver } from 'neo4j-driver-lite';
import { env, secrets } from '../config/env';
import { logger } from '../core/logger';
import { DEFAULT_ISLAND, ISLAND_ID_RX, UnknownIslandError } from '../vectorStore';
import type { EntityType, GraphEntity, GraphRelation, TraversalHit } from './types';
import { ENTITY_TYPES, RELATION_TYPES, type RelationType } from './types';

/** Traversal depth is interpolated into the Cypher pattern — clamp hard. */
export const MAX_TRAVERSAL_DEPTH = 5;
const MAX_TRAVERSAL_RESULTS = 200;
const MAX_SEARCH_RESULTS = 50;

export class GraphDisabledError extends Error {
  constructor() {
    super(
      'Knowledge graph is disabled: set GRAPH_URL and GRAPH_PASSWORD ' +
        '(see docs/plans/GRAPHRAG-PILOT.md and docker/neo4j/).'
    );
    this.name = 'GraphDisabledError';
  }
}

export class GraphUnavailableError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Knowledge graph store unavailable: ${msg}`);
    this.name = 'GraphUnavailableError';
  }
}

let driver: Driver | null = null;
/** Shared bootstrap promise: concurrent first queries wait on ONE constraint
 * creation instead of racing past a boolean; a failed bootstrap resets it so
 * the next call retries. */
let constraintReady: Promise<void> | null = null;

/** Test seam: inject a fake driver (and mark the store enabled). */
export function setGraphDriverForTests(
  fake: Driver | null,
  options: { needsBootstrap?: boolean } = {}
): void {
  driver = fake;
  constraintReady =
    fake !== null && options.needsBootstrap !== true ? Promise.resolve() : null;
}

export function resetGraphStoreForTests(): void {
  driver = null;
  constraintReady = null;
}

/**
 * Integer sanitizer for caller-supplied numbers. NaN (e.g. Number('abc') from
 * unvalidated tool args) falls back to the default instead of leaking into
 * Cypher text or neo4j.int() — Math.min/max would happily propagate it.
 * ±Infinity (reachable as JSON `1e999`) is NOT garbage: it clamps to the
 * bound, so an absurdly large limit still means "as many as allowed".
 */
function clampInt(value: number | undefined, def: number, min: number, max: number): number {
  const n = Math.floor(value ?? def);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** Whether graph features are configured at all (not a liveness check). */
export function graphEnabled(): boolean {
  return driver !== null || (env.GRAPH_URL !== undefined && secrets.graphPassword !== undefined);
}

function getDriver(): Driver {
  if (driver) return driver;
  const url = env.GRAPH_URL;
  const password = secrets.graphPassword;
  if (url === undefined || password === undefined) throw new GraphDisabledError();
  // disableLosslessIntegers: read-side INTEGERs arrive as plain JS numbers
  // (graph sizes here are nowhere near 2^53). Write-side integer params must
  // still be wrapped with neo4j.int() — see the LIMIT parameters below.
  driver = neo4j.driver(url, neo4j.auth.basic(env.GRAPH_USER, password), {
    disableLosslessIntegers: true,
  });
  // Log host:port only — a URL can carry userinfo, and this line lands in the
  // log file (env validation also rejects credentials in GRAPH_URL).
  logger.info(`🕸️  [Graph] Neo4j driver created for ${safeUrlLabel(url)}`);
  return driver;
}

/** `bolt://host:7687` → `host:7687`; never echoes userinfo or query strings. */
function safeUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
  } catch {
    return '<graph host>';
  }
}

export async function closeGraphStore(): Promise<void> {
  if (!driver) return;
  const d = driver;
  driver = null;
  constraintReady = null;
  await d.close();
}

function resolveIsland(island?: string): string {
  const id = island ?? DEFAULT_ISLAND;
  if (!ISLAND_ID_RX.test(id)) throw new UnknownIslandError(id);
  return id;
}

function keyFor(island: string, id: string): string {
  return `${island}|${id}`;
}

type CypherParams = Record<string, unknown>;

/**
 * Schema bootstrap. The uniqueness constraint is the correctness half (one
 * node per `<island>|<id>`); the island index is the scalability half — every
 * query in this module opens with an island filter, and without the index
 * Neo4j label-scans EVERY island's nodes on a shared instance.
 */
const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT knowledge_entity_key IF NOT EXISTS ' +
    'FOR (n:KnowledgeEntity) REQUIRE n.key IS UNIQUE',
  'CREATE INDEX knowledge_entity_island IF NOT EXISTS ' +
    'FOR (n:KnowledgeEntity) ON (n.island)',
];

function queryConfig(): { database: string; transactionConfig: { timeout: number } } {
  // Server-side timeout: variable-length traversals enumerate paths before the
  // row cap applies, so an unbounded query could pin the shared instance.
  return {
    database: env.GRAPH_DATABASE,
    transactionConfig: { timeout: env.GRAPH_QUERY_TIMEOUT_MS },
  };
}

async function run(
  cypher: string,
  params: CypherParams
): Promise<{ records: Array<{ get(field: string): unknown }>; counters?: unknown }> {
  const d = getDriver();
  if (constraintReady === null) {
    constraintReady = (async () => {
      for (const statement of SCHEMA_STATEMENTS) {
        await d.executeQuery(statement, {}, queryConfig());
      }
    })();
  }
  try {
    await constraintReady;
  } catch (err) {
    constraintReady = null; // retried by the next call
    throw new GraphUnavailableError(err);
  }
  try {
    const result = await d.executeQuery(cypher, params, queryConfig());
    return { records: result.records, counters: result.summary?.counters };
  } catch (err) {
    throw new GraphUnavailableError(err);
  }
}

function toEntity(value: unknown): GraphEntity {
  const props = (value as { properties?: Record<string, unknown> })?.properties ?? {};
  const entity: GraphEntity = {
    id: String(props.id ?? ''),
    type: (props.type as EntityType) ?? 'Doc',
    name: String(props.name ?? ''),
  };
  if (typeof props.filePath === 'string') entity.filePath = props.filePath;
  if (typeof props.language === 'string')
    entity.language = props.language as GraphEntity['language'];
  return entity;
}

function assertEntityType(type: string): asserts type is EntityType {
  if (!(ENTITY_TYPES as readonly string[]).includes(type))
    throw new Error(`Unknown entity type: ${type}`);
}

function assertRelationType(type: string): asserts type is RelationType {
  if (!(RELATION_TYPES as readonly string[]).includes(type))
    throw new Error(`Unknown relation type: ${type}`);
}

/**
 * Idempotent bulk upsert of entities into an island's graph. When `syncTag`
 * is given, upserted nodes are stamped with it so sweepStale() can later
 * remove everything the current index run did NOT touch.
 */
export async function upsertEntities(
  entities: GraphEntity[],
  island?: string,
  syncTag?: string
): Promise<number> {
  const islandId = resolveIsland(island);
  if (entities.length === 0) return 0;
  for (const e of entities) assertEntityType(e.type);
  const rows = entities.map((e) => ({
    key: keyFor(islandId, e.id),
    island: islandId,
    id: e.id,
    type: e.type,
    name: e.name,
    filePath: e.filePath ?? null,
    language: e.language ?? null,
  }));
  await run(
    'UNWIND $rows AS row ' +
      'MERGE (n:KnowledgeEntity {key: row.key}) ' +
      'SET n.island = row.island, n.id = row.id, n.type = row.type, ' +
      'n.name = row.name, n.filePath = row.filePath, n.language = row.language' +
      (syncTag === undefined ? '' : ', n.syncedAt = $syncTag'),
    syncTag === undefined ? { rows } : { rows, syncTag }
  );
  return rows.length;
}

/**
 * Idempotent bulk upsert of relations. Rows whose endpoints are missing in
 * the island are silently skipped by the MATCH — the returned count is the
 * number of rows submitted, callers needing strictness compare stats().
 */
export async function upsertRelations(
  relations: GraphRelation[],
  island?: string,
  syncTag?: string
): Promise<number> {
  const islandId = resolveIsland(island);
  if (relations.length === 0) return 0;
  for (const r of relations) assertRelationType(r.type);
  const rows = relations.map((r) => ({
    fromKey: keyFor(islandId, r.from),
    toKey: keyFor(islandId, r.to),
    type: r.type,
  }));
  await run(
    'UNWIND $rows AS row ' +
      'MATCH (a:KnowledgeEntity {key: row.fromKey}) ' +
      'MATCH (b:KnowledgeEntity {key: row.toKey}) ' +
      'MERGE (a)-[r:RELATES {type: row.type}]->(b)' +
      (syncTag === undefined ? '' : ' SET r.syncedAt = $syncTag'),
    syncTag === undefined ? { rows } : { rows, syncTag }
  );
  return rows.length;
}

/**
 * Remove everything in an island stamped BEFORE `syncTag` — the second half of
 * the upsert-then-sweep re-index. Ordering matters for crash safety: the
 * indexer upserts first (the previous graph keeps serving during the run and
 * after a mid-run failure) and sweeps ONLY after a fully successful upsert
 * pass, so the island is never empty or half-built.
 *
 * The comparison is `<`, not `<>`, and `syncTag` MUST be monotonically
 * increasing (an ISO timestamp): two overlapping index runs then converge on
 * the newer graph, instead of each sweeping away the other's freshly written
 * nodes and leaving the island empty.
 */
export async function sweepStale(syncTag: string, island?: string): Promise<void> {
  const islandId = resolveIsland(island);
  // An empty tag would make the comparison delete nothing (or, with `<>`,
  // exactly the fresh elements) — refuse rather than silently no-op.
  if (syncTag.trim() === '') throw new Error('sweepStale requires a non-empty sync tag');
  await run(
    'MATCH (:KnowledgeEntity {island: $island})-[r:RELATES]->' +
      '(:KnowledgeEntity {island: $island}) ' +
      "WHERE coalesce(r.syncedAt, '') < $syncTag DELETE r",
    { island: islandId, syncTag }
  );
  await run(
    'MATCH (n:KnowledgeEntity {island: $island}) ' +
      "WHERE coalesce(n.syncedAt, '') < $syncTag DETACH DELETE n",
    { island: islandId, syncTag }
  );
}

/** Remove an island's entire graph (destructive reset; re-index uses sweepStale). */
export async function clearIsland(island?: string): Promise<void> {
  const islandId = resolveIsland(island);
  await run('MATCH (n:KnowledgeEntity {island: $island}) DETACH DELETE n', { island: islandId });
}

/** Case-insensitive substring search over entity names and ids. */
export async function searchEntities(
  query: string,
  options: { island?: string; type?: string; limit?: number } = {}
): Promise<GraphEntity[]> {
  const islandId = resolveIsland(options.island);
  const limit = clampInt(options.limit, 10, 1, MAX_SEARCH_RESULTS);
  if (options.type !== undefined) assertEntityType(options.type);
  const q = query.toLowerCase();
  const typeFilter = options.type === undefined ? '' : 'AND n.type = $type ';
  const { records } = await run(
    'MATCH (n:KnowledgeEntity {island: $island}) ' +
      'WHERE (toLower(n.name) CONTAINS $q OR toLower(n.id) CONTAINS $q) ' +
      typeFilter +
      // neo4j-driver-lite maps integer params to INTEGER; LIMIT accepts it.
      'RETURN n ORDER BY n.type, n.id LIMIT $limit',
    { island: islandId, q, type: options.type ?? null, limit: neo4j.int(limit) }
  );
  return records.map((r) => toEntity(r.get('n')));
}

export interface TraversalResult {
  hits: TraversalHit[];
  /**
   * True when the result was cut at MAX_TRAVERSAL_RESULTS — the real set is
   * larger, and callers (impact analysis!) must present counts as "at least",
   * never as the complete answer.
   */
  truncated: boolean;
  /**
   * False when the start entity does not exist in this island. Without it an
   * empty result is indistinguishable from "nothing depends on this" — the
   * dangerous direction for an impact tool (a typo would read as "safe").
   */
  found: boolean;
  /** Effective (clamped) depth — the hit set is bounded by this many hops. */
  depth: number;
}

/**
 * Bounded traversal from an entity.
 * - 'dependencies': entities this one points AT (outgoing RELATES).
 * - 'dependents': entities pointing at this one (incoming) — the impact set.
 */
export async function traverse(
  entityId: string,
  options: {
    island?: string;
    direction: 'dependencies' | 'dependents';
    depth?: number;
    relationTypes?: string[];
  }
): Promise<TraversalResult> {
  const islandId = resolveIsland(options.island);
  const depth = clampInt(options.depth, 2, 1, MAX_TRAVERSAL_DEPTH);
  for (const t of options.relationTypes ?? []) assertRelationType(t);
  // Depth cannot be a Cypher parameter — it is a clamped finite integer,
  // safe to inline (clampInt maps NaN/Infinity to the default).
  const pattern =
    options.direction === 'dependencies'
      ? `(start)-[rels:RELATES*1..${depth}]->(m:KnowledgeEntity)`
      : `(start)<-[rels:RELATES*1..${depth}]-(m:KnowledgeEntity)`;
  const relFilter =
    options.relationTypes && options.relationTypes.length > 0
      ? 'AND all(rel IN rels WHERE rel.type IN $relTypes) '
      : '';
  const { records } = await run(
    // The start MATCH is separate and mandatory, the traversal OPTIONAL: a
    // missing start entity yields zero rows (found === false), while an
    // existing entity with no neighbours yields one row with a null `m`.
    'MATCH (start:KnowledgeEntity {key: $key}) ' +
      `OPTIONAL MATCH p = ${pattern} ` +
      'WHERE all(x IN nodes(p) WHERE x.island = $island) ' +
      'AND m.key <> start.key ' +
      relFilter +
      'RETURN m, min(length(p)) AS distance ' +
      // one row beyond the cap so truncation is detectable
      'ORDER BY distance, m.id LIMIT $limit',
    {
      key: keyFor(islandId, entityId),
      island: islandId,
      relTypes: options.relationTypes ?? null,
      limit: neo4j.int(MAX_TRAVERSAL_RESULTS + 1),
    }
  );
  const hitRecords = records.filter((r) => {
    const m = r.get('m');
    return m !== null && m !== undefined;
  });
  return {
    found: records.length > 0,
    depth,
    hits: hitRecords.slice(0, MAX_TRAVERSAL_RESULTS).map((r) => ({
      entity: toEntity(r.get('m')),
      distance: Number(r.get('distance')),
    })),
    truncated: hitRecords.length > MAX_TRAVERSAL_RESULTS,
  };
}

/** Node/relationship counts for an island (index verification, monitoring). */
export async function graphStats(island?: string): Promise<{ nodes: number; relations: number }> {
  const islandId = resolveIsland(island);
  const { records } = await run(
    'MATCH (n:KnowledgeEntity {island: $island}) ' +
      'OPTIONAL MATCH (n)-[r:RELATES]->(:KnowledgeEntity {island: $island}) ' +
      'RETURN count(DISTINCT n) AS nodes, count(r) AS relations',
    { island: islandId }
  );
  const first = records[0];
  return {
    nodes: first ? Number(first.get('nodes')) : 0,
    relations: first ? Number(first.get('relations')) : 0,
  };
}

/** Liveness probe: configured + reachable. Never throws. */
export async function graphHealth(): Promise<{ enabled: boolean; connected: boolean }> {
  if (!graphEnabled()) return { enabled: false, connected: false };
  try {
    await getDriver().getServerInfo();
    return { enabled: true, connected: true };
  } catch {
    return { enabled: true, connected: false };
  }
}
