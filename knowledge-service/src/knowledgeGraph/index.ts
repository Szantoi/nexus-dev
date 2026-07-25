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
  type IndexMeta,
  readIndexMeta,
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
  IslandNotOnThisHostError,
  type CorpusSource,
  type GraphCorpusConfig,
  type ResolvedCorpus,
  configuredIslands,
  getCorpusConfigPath,
  loadCorpusConfig,
  resolveCorpus,
} from './corpusConfig';
export { corpusFingerprint, runGraphIndex } from './indexCli';
