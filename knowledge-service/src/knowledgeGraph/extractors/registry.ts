/**
 * Extractor registry — the bridge between a corpus source's `extractor` name
 * (config/graph-corpus.yaml) and the code that reads that kind of source.
 *
 * Every extractor has the same shape: (sourceRoot, repoRoot) => entities +
 * relations, with ids relative to repoRoot. Supporting a new language is
 * therefore ONE entry here plus its module — the config schema, the CLI and
 * the indexer need no change.
 */

import { extractCoverage } from './coverageExtractor';
import { extractCSharp } from './csharpExtractor';
import { extractDocs, type ExtractionResult } from './docsExtractor';
import { extractTypeScript } from './tsExtractor';
import type { RelationType } from '../types';

export type ExtractorFn = (sourceRoot: string, repoRoot: string) => ExtractionResult;

export const EXTRACTORS = {
  markdown: extractDocs,
  typescript: extractTypeScript,
  csharp: extractCSharp,
  coverage: extractCoverage,
} as const satisfies Record<string, ExtractorFn>;

export type ExtractorName = keyof typeof EXTRACTORS;

/** Non-empty tuple form, so it can drive a zod enum in the corpus schema. */
export const EXTRACTOR_NAMES = Object.keys(EXTRACTORS) as [ExtractorName, ...ExtractorName[]];

/**
 * The relation types each extractor may emit — the OWNERSHIP declaration the
 * type-scoped sweep is built on. A re-index run only sweeps the relation
 * types its corpus's extractors declare, so a machine that cannot run a
 * source (e.g. the coverage source, whose input is machine-local) does not
 * sweep away that source's edges. The indexer enforces the declaration
 * fail-closed: an extractor emitting an UNDECLARED type is an error, because
 * such an edge would never be swept and would go silently stale — the exact
 * "confidently outdated answer" failure class this layer must not have.
 */
export const EXTRACTOR_RELATION_TYPES = {
  markdown: ['REFERENCES'],
  typescript: ['DEPENDS_ON', 'PART_OF'],
  csharp: ['DEPENDS_ON', 'PART_OF'],
  coverage: ['COVERS'],
} as const satisfies Record<ExtractorName, readonly RelationType[]>;
