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
