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
  extractor: ExtractorName;
  extract: ExtractorFn;
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
  const file = configPath || getCorpusConfigPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `Graph corpus config not found: ${file}\n` +
        'It declares which trees each island indexes — see docs/plans/GRAPHRAG-PILOT.md.'
    );
  }
  const parsed = GraphCorpusConfigSchema.safeParse(yaml.load(fs.readFileSync(file, 'utf-8')));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid graph corpus config (${file}):\n${issues}`);
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
  if (!ISLAND_ID_RX.test(island)) throw new Error(`Invalid island id: "${island}"`);
  // An empty override would resolve to the process CWD and re-base every
  // entity id on it — refuse instead of guessing.
  if (options.repoRootOverride !== undefined && options.repoRootOverride.trim() === '') {
    throw new Error('repo root override is empty — pass a real path or omit --repo-root');
  }

  const config = loadCorpusConfig(options.configPath);
  // Own keys only, not a bare `config.islands[island]`: an island named after
  // an Object.prototype member ('constructor', 'toString') would otherwise
  // skip the fail-closed branch below and blow up deeper in.
  const configured = Object.keys(config.islands);
  const entry = configured.includes(island) ? config.islands[island] : undefined;
  if (entry === undefined) {
    const known = configured.sort().join(', ') || '(none)';
    throw new Error(
      `No graph corpus configured for island "${island}" — refusing to index. ` +
        `Add it to ${options.configPath || getCorpusConfigPath()} (configured islands: ${known}).`
    );
  }

  const repoRoot = options.repoRootOverride ?? resolveRepoRoot(island, entry.repo_root);

  const sources = entry.sources.map((source) => {
    const root = path.resolve(repoRoot, source.path);
    // Entity ids are repo-relative: a source outside the repo root would
    // produce '../..'-style ids that collide across islands.
    if (!isWithin(repoRoot, root)) {
      throw new Error(
        `Corpus source "${source.path}" of island "${island}" escapes its repo root (${repoRoot}).`
      );
    }
    return { root, extractor: source.extractor, extract: EXTRACTORS[source.extractor] };
  });

  return { island, repoRoot, sources };
}
