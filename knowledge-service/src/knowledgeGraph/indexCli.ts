/**
 * Knowledge-graph indexer CLI (npm run graph:index).
 *
 * Full, idempotent re-index of ONE island with UPSERT-THEN-SWEEP semantics:
 * every extracted entity/relation is upserted stamped with a fresh sync tag,
 * and stale elements (not stamped in this run) are swept ONLY after the whole
 * upsert pass succeeded. A mid-run failure therefore leaves the previous
 * graph intact and fully queryable — the island is never empty or half-built
 * (matching graphStore's fail-closed philosophy: a partial graph silently
 * produces wrong impact answers).
 *
 * Requires GRAPH_URL + GRAPH_PASSWORD (see docker/neo4j/ and
 * docs/plans/GRAPHRAG-PILOT.md).
 *
 *   npm run graph:index                  # island = ISLAND_ID (env)
 *   npm run graph:index -- --island foo  # explicit island
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../core/logger';
import { DEFAULT_ISLAND } from '../vectorStore';
import { extractDocs } from './extractors/docsExtractor';
import { extractTypeScript } from './extractors/tsExtractor';
import {
  closeGraphStore,
  graphStats,
  sweepStale,
  upsertEntities,
  upsertRelations,
} from './graphStore';
import type { GraphEntity, GraphRelation } from './types';

// src/knowledgeGraph → knowledge-service → repo root (same shape from dist/).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const UPSERT_BATCH = 500;

function argValue(flag: string, argv: string[]): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

async function upsertInBatches(
  entities: GraphEntity[],
  relations: GraphRelation[],
  island: string,
  syncTag: string
): Promise<void> {
  for (let i = 0; i < entities.length; i += UPSERT_BATCH) {
    await upsertEntities(entities.slice(i, i + UPSERT_BATCH), island, syncTag);
  }
  for (let i = 0; i < relations.length; i += UPSERT_BATCH) {
    await upsertRelations(relations.slice(i, i + UPSERT_BATCH), island, syncTag);
  }
}

export async function runGraphIndex(
  island: string,
  repoRoot: string,
  syncTag: string
): Promise<{ nodes: number; relations: number }> {
  logger.info(`🕸️  [GraphIndex] island=${island} repoRoot=${repoRoot} tag=${syncTag}`);

  const docsRoot = path.join(repoRoot, 'docs');
  const srcRoot = path.join(repoRoot, 'knowledge-service', 'src');
  // Fail BEFORE touching the graph: with a mistyped --repo-root both extractors
  // would return an empty corpus and the sweep would wipe the island — an
  // operator typo must not look like "the repo has no content any more".
  for (const root of [docsRoot, srcRoot]) {
    if (!fs.existsSync(root)) {
      throw new Error(`[GraphIndex] source root not found: ${root} (check --repo-root)`);
    }
  }

  const docs = extractDocs(docsRoot, repoRoot);
  logger.info(
    `🕸️  [GraphIndex] docs: ${docs.entities.length} entities, ${docs.relations.length} relations`
  );

  const code = extractTypeScript(srcRoot, repoRoot);
  logger.info(
    `🕸️  [GraphIndex] code: ${code.entities.length} entities, ${code.relations.length} relations`
  );

  const entities = [...docs.entities, ...code.entities];
  const relations = [...docs.relations, ...code.relations];
  // Second guard, for the corpus the walker could not read: fsWalk degrades a
  // permission/IO error into "no files", and an empty upsert pass followed by
  // a sweep deletes the island silently (exit 0).
  if (entities.length === 0) {
    throw new Error('[GraphIndex] extracted 0 entities — refusing to sweep the island empty');
  }

  await upsertInBatches(entities, relations, island, syncTag);
  // Sweep ONLY after every upsert batch landed — see the module header.
  await sweepStale(syncTag, island);

  const stats = await graphStats(island);
  logger.info(`🟢 [GraphIndex] done: ${stats.nodes} nodes, ${stats.relations} relations in graph`);
  return stats;
}

/**
 * CLI entry point as a plain function so the exit-code contract is testable:
 * an index failure yields 1, while a driver-close failure only warns — a
 * bookkeeping problem on the way out must never turn a good index into a
 * failed run (nor a failed one into a silent success).
 */
export async function runIndexCli(argv: string[]): Promise<number> {
  const island = argValue('--island', argv) ?? DEFAULT_ISLAND;
  const repoRoot = argValue('--repo-root', argv) ?? REPO_ROOT;
  let exitCode = 0;
  try {
    await runGraphIndex(island, repoRoot, new Date().toISOString());
  } catch (err) {
    logger.error(`❌ [GraphIndex] failed: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  }
  try {
    await closeGraphStore();
  } catch (err) {
    logger.warn(
      `⚠️  [GraphIndex] driver close failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return exitCode;
}

/* c8 ignore start — process wiring only; runIndexCli has its own unit tests */
if (require.main === module) {
  void runIndexCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
/* c8 ignore stop */
