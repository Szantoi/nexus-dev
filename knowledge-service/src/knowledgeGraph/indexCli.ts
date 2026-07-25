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
 * WHAT each island indexes comes from config/graph-corpus.yaml — this module
 * only executes a resolved corpus, so aiming the graph at another repo or
 * language is configuration, not code.
 *
 * Requires GRAPH_URL + GRAPH_PASSWORD (see docker/neo4j/ and
 * docs/plans/GRAPHRAG-PILOT.md).
 *
 *   npm run graph:index                       # island = ISLAND_ID (env)
 *   npm run graph:index -- --island foo       # explicit island
 *   npm run graph:index -- --config path.yaml # alternative corpus config
 */

import * as fs from 'node:fs';
import { logger } from '../core/logger';
import { DEFAULT_ISLAND } from '../core/island';
import { type ResolvedCorpus, resolveCorpus } from './corpusConfig';
import {
  closeGraphStore,
  graphStats,
  sweepStale,
  upsertEntities,
  upsertRelations,
} from './graphStore';
import type { GraphEntity, GraphRelation } from './types';

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
  corpus: ResolvedCorpus,
  syncTag: string
): Promise<{ nodes: number; relations: number }> {
  const { island, repoRoot } = corpus;
  logger.info(
    `🕸️  [GraphIndex] island=${island} repoRoot=${repoRoot} ` +
      `sources=${corpus.sources.length} tag=${syncTag}`
  );

  const entities: GraphEntity[] = [];
  const relations: GraphRelation[] = [];

  // A sourceless corpus can only arrive through the API (the config schema
  // requires at least one) — and it would go straight to the sweep.
  if (corpus.sources.length === 0) {
    throw new Error(`[GraphIndex] corpus has no sources — refusing to sweep island ${island}`);
  }

  for (const source of corpus.sources) {
    // Fail BEFORE touching the graph: a mistyped path would extract nothing
    // and the sweep would wipe the island — an operator typo must not look
    // like "this repo has no content any more".
    if (fs.statSync(source.root, { throwIfNoEntry: false })?.isDirectory() !== true) {
      throw new Error(
        `[GraphIndex] source root not found (or not a directory): ${source.root} ` +
          `(island ${island}, extractor ${source.extractor}) — check the corpus config`
      );
    }
    const result = source.extract(source.root, repoRoot);
    logger.info(
      `🕸️  [GraphIndex] ${source.extractor}: ${result.entities.length} entities, ` +
        `${result.relations.length} relations (${source.root})`
    );
    // Guard PER SOURCE, not on the total: the sweep deletes everything in the
    // island that this run did not stamp, so a populated sibling source would
    // carry a silently-empty one past an aggregate check — and take its whole
    // subgraph with it, at exit 0. fsWalk degrades an unreadable tree into
    // "no files", so 0 entities is indistinguishable from "this tree is gone".
    if (result.entities.length === 0) {
      throw new Error(
        `[GraphIndex] source ${source.root} (extractor ${source.extractor}) extracted ` +
          `0 entities — refusing to sweep island ${island} on a partial corpus`
      );
    }
    entities.push(...result.entities);
    relations.push(...result.relations);
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
  let exitCode = 0;
  try {
    const corpus = resolveCorpus(island, {
      configPath: argValue('--config', argv),
      repoRootOverride: argValue('--repo-root', argv),
    });
    await runGraphIndex(corpus, new Date().toISOString());
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
