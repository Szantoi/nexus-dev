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
  graphEnabled,
  graphHealth,
  graphStats,
  searchEntities,
  sweepStale,
  traverse,
  upsertEntities,
  upsertRelations,
} from './graphStore';
export { extractDocs } from './extractors/docsExtractor';
export { extractTypeScript } from './extractors/tsExtractor';
