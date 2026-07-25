/**
 * Knowledge graph (GraphRAG pilot) — public surface.
 * NOT the EPICS workflow DAG (that is src/graph/).
 */

export * from './types';
export {
  GraphDisabledError,
  GraphUnavailableError,
  MAX_TRAVERSAL_DEPTH,
  type TraversalResult,
  clearIsland,
  closeGraphStore,
  findEntitiesByPathSuffix,
  graphEnabled,
  graphHealth,
  graphStats,
  searchEntities,
  searchEntitiesByTerms,
  sweepStale,
  traverse,
  upsertEntities,
  upsertRelations,
} from './graphStore';
export {
  type HybridHit,
  type HybridSearchResult,
  type SubsystemState,
  queryTerms,
  searchHybrid,
} from './hybridSearch';
export { extractDocs } from './extractors/docsExtractor';
export { extractTypeScript } from './extractors/tsExtractor';
export {
  EXTRACTORS,
  EXTRACTOR_NAMES,
  type ExtractorFn,
  type ExtractorName,
} from './extractors/registry';
export {
  type CorpusSource,
  type GraphCorpusConfig,
  type ResolvedCorpus,
  getCorpusConfigPath,
  loadCorpusConfig,
  resolveCorpus,
} from './corpusConfig';
export { runGraphIndex } from './indexCli';
