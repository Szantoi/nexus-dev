/**
 * Graph corpus configuration (`config/graph-corpus.yaml`).
 *
 * WHAT gets indexed into WHICH island lives here, not in the code. The graph
 * layer itself is island- and project-agnostic (the store, the MCP tools and
 * the extractors know nothing about any particular repo), so pointing it at
 * another codebase — or adding a language to an existing island — must be a
 * config change, never a code change.
 *
 * Fail-closed: an island with no corpus entry is an error, not an empty index
 * (an empty run would sweep that island's graph away).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { ISLAND_ID_RX } from '../core/island';
import {
  EXTRACTOR_NAMES,
  EXTRACTORS,
  type ExtractorFn,
  type ExtractorName,
} from './extractors/registry';
import { GraphCorpusError, ValidationError } from '../core/errors';

/** src/knowledgeGraph → knowledge-service → repo root (same shape from dist/). */
const NEXUS_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Both object schemas are STRICT: a mistyped key must fail loudly. This file
// decides which tree lands in which island, so a silently ignored key is
// silently wrong data — the one failure mode this module exists to prevent.
const SourceSchema = z.strictObject({
  /** Relative to the island's repo_root; may not escape it. */
  path: z.string().min(1),
  extractor: z.enum(EXTRACTOR_NAMES),
});

const IslandCorpusSchema = z.strictObject({
  /**
   * Absolute path, or relative to the nexus-dev repo root. Required on
   * purpose: a defaulted repo_root would turn a typo (`repo-root:`, a
   * mis-indent) into a successful run that indexes THIS checkout into that
   * island's graph.
   */
  repo_root: z.string().min(1),
  sources: z.array(SourceSchema).min(1),
});

export const GraphCorpusConfigSchema = z.object({
  islands: z.record(z.string().regex(ISLAND_ID_RX), IslandCorpusSchema),
});

export type GraphCorpusConfig = z.infer<typeof GraphCorpusConfigSchema>;

export interface CorpusSource {
  /** Absolute path of the tree this source covers. */
  root: string;
  /** The path as DECLARED in the config — machine-independent, so it can key
   *  per-source index metadata shared between machines. */
  declaredPath: string;
  /**
   * True when the path came through a `${VAR}` env gate — i.e. the source
   * does not run on every machine. Such a source may only ATTACH to entities
   * the unconditional sources own: an entity only IT produces would be swept
   * by the next machine's run (the entity sweep is island-wide), taking the
   * gated source's edges with it — quiet decay instead of durable data.
   */
  envGated: boolean;
  extractor: ExtractorName;
  extract: ExtractorFn;
}

/**
 * A source whose path names an environment variable that is unset on this
 * host. Not an error — the config is shared, the source's input is not (the
 * coverage tree only exists where tests run) — but the skip must be EXPLICIT:
 * the indexer logs it and excludes the source's relation types from the
 * sweep, so this run can never delete what it could not produce.
 */
export interface SkippedCorpusSource {
  declaredPath: string;
  extractor: ExtractorName;
  variable: string;
}

/**
 * An island whose corpus lives on a specific machine (its repo_root names an
 * environment variable that is not set here). Not a misconfiguration — the
 * config is shared, the checkout is not — so bulk runs skip it and say so,
 * while an explicit request for that island still fails loudly.
 */
export class IslandNotOnThisHostError extends Error {
  constructor(island: string, variable: string) {
    super(
      `Island "${island}" is not configured on this host: ${variable} is unset ` +
        '(its corpus lives on another machine — see config/graph-corpus.yaml).'
    );
    this.name = 'IslandNotOnThisHostError';
  }
}

export interface ResolvedCorpus {
  island: string;
  /** Absolute; every entity id is relative to this. */
  repoRoot: string;
  sources: CorpusSource[];
  /** Env-gated sources whose variable is unset on this host (explicit, logged). */
  skippedSources: SkippedCorpusSource[];
}

/** Island ids declared in the config, sorted — the bulk-index work list. */
export function configuredIslands(configPath?: string): string[] {
  return Object.keys(loadCorpusConfig(configPath).islands).sort();
}

export function getCorpusConfigPath(): string {
  return (
    process.env.GRAPH_CORPUS_CONFIG_PATH ||
    path.join(__dirname, '..', '..', 'config', 'graph-corpus.yaml')
  );
}

export function loadCorpusConfig(configPath?: string): GraphCorpusConfig {
  // An empty --config (e.g. an unset shell variable expanding to '') must not
  // silently fall back to the default config — refuse instead of guessing,
  // exactly like the repo-root override.
  if (configPath !== undefined && configPath.trim() === '') {
    throw new ValidationError('corpus config path is empty — pass a real path or omit --config', {
      configPath: 'must not be empty',
    });
  }
  const file = configPath || getCorpusConfigPath();
  if (!fs.existsSync(file)) {
    throw new GraphCorpusError(
      `Graph corpus config not found: ${file}\n` +
        'It declares which trees each island indexes — see docs/plans/GRAPHRAG-PILOT.md.'
    );
  }
  const parsed = GraphCorpusConfigSchema.safeParse(yaml.load(fs.readFileSync(file, 'utf-8')));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new GraphCorpusError(`Invalid graph corpus config (${file}):\n${issues}`);
  }
  return parsed.data;
}

/**
 * Expand a repo_root. `${VAR}` lets one shared config declare a corpus that
 * only exists on one machine (the VPS checkout of another product), without
 * baking that machine's paths into every clone.
 */
function resolveRepoRoot(island: string, declared: string): string {
  const envRef = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(declared.trim());
  if (envRef !== null) {
    const value = process.env[envRef[1]]?.trim();
    if (value === undefined || value === '') throw new IslandNotOnThisHostError(island, envRef[1]);
    return path.isAbsolute(value) ? value : path.resolve(NEXUS_REPO_ROOT, value);
  }
  return path.isAbsolute(declared) ? declared : path.resolve(NEXUS_REPO_ROOT, declared);
}

/** True when `child` is `parent` itself or lives underneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Turn the island's config entry into absolute roots + extractor functions.
 * `repoRootOverride` exists for tests and one-off runs against a checkout in
 * a different location; it does not change WHICH trees are indexed.
 */
export function resolveCorpus(
  island: string,
  options: { configPath?: string; repoRootOverride?: string } = {}
): ResolvedCorpus {
  if (!ISLAND_ID_RX.test(island)) throw new ValidationError(`Invalid island id: "${island}"`, { island: 'invalid format' });
  // An empty override would resolve to the process CWD and re-base every
  // entity id on it — refuse instead of guessing.
  if (options.repoRootOverride !== undefined && options.repoRootOverride.trim() === '') {
    throw new ValidationError('repo root override is empty — pass a real path or omit --repo-root', { repoRootOverride: 'must not be empty' });
  }

  const config = loadCorpusConfig(options.configPath);
  // Own keys only, not a bare `config.islands[island]`: an island named after
  // an Object.prototype member ('constructor', 'toString') would otherwise
  // skip the fail-closed branch below and blow up deeper in.
  const configured = Object.keys(config.islands);
  const entry = configured.includes(island) ? config.islands[island] : undefined;
  if (entry === undefined) {
    const known = configured.sort().join(', ') || '(none)';
    throw new GraphCorpusError(
      `No graph corpus configured for island "${island}" — refusing to index. ` +
        `Add it to ${options.configPath || getCorpusConfigPath()} (configured islands: ${known}).`
    );
  }

  const repoRoot = options.repoRootOverride ?? resolveRepoRoot(island, entry.repo_root);

  // Duplicate (extractor, path) entries would double the extraction work and
  // register the same physical tree twice in the per-source freshness map —
  // a copy-paste mistake, not a meaning. Refuse loudly.
  const seenKeys = new Set<string>();
  for (const source of entry.sources) {
    const key = `${source.extractor}:${source.path}`;
    if (seenKeys.has(key)) {
      throw new GraphCorpusError(
        `Island "${island}" declares source (${key}) more than once — remove the duplicate.`
      );
    }
    seenKeys.add(key);
  }

  const sources: CorpusSource[] = [];
  const skippedSources: SkippedCorpusSource[] = [];
  for (const source of entry.sources) {
    // `${VAR}` in a source path declares a MACHINE-LOCAL source (its input
    // only exists where the variable is set — e.g. the coverage tree, which
    // only exists where tests run). Unset variable = the source is skipped
    // EXPLICITLY (returned, logged, excluded from the sweep's relation-type
    // scope) — never an error and never a silent hole.
    const envRef = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(source.path.trim());
    let declaredValue = source.path;
    if (envRef !== null) {
      const value = process.env[envRef[1]]?.trim();
      if (value === undefined || value === '') {
        skippedSources.push({
          declaredPath: source.path,
          extractor: source.extractor,
          variable: envRef[1],
        });
        continue;
      }
      declaredValue = value;
    }
    const root = path.resolve(repoRoot, declaredValue);
    // Entity ids are repo-relative: a source outside the repo root would
    // produce '../..'-style ids that collide across islands.
    if (!isWithin(repoRoot, root)) {
      throw new GraphCorpusError(
        `Corpus source "${source.path}" of island "${island}" escapes its repo root (${repoRoot}).`
      );
    }
    sources.push({
      root,
      // The DECLARED form (the `${VAR}` literal for env-gated sources): the
      // metadata key must be identical on every machine, or one host's
      // freshness record would be invisible to the next.
      declaredPath: source.path,
      envGated: envRef !== null,
      extractor: source.extractor,
      extract: EXTRACTORS[source.extractor],
    });
  }

  // Every source env-gated away is indistinguishable from a corpus-less
  // island for THIS run — and a sourceless run would go straight to a
  // full-island sweep. Refuse loudly instead.
  if (sources.length === 0) {
    throw new GraphCorpusError(
      `Island "${island}" has no active corpus source on this host ` +
        `(${skippedSources.length} env-gated source(s) skipped) — refusing to index.`
    );
  }

  return { island, repoRoot, sources, skippedSources };
}
