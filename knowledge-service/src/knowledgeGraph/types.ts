/**
 * Knowledge-graph domain types (GraphRAG pilot — docs/plans/GRAPHRAG-PILOT.md).
 *
 * NOT the EPICS workflow DAG: that lives in src/graph/. This module models
 * code/doc entities and their relationships for graph-augmented retrieval.
 *
 * Island separation mirrors vectorStore.ts: every node carries an `island`
 * property, and the island always comes from the caller's identity — the
 * store enforces the island filter in every query.
 */

/** Code-derived entity kinds (AST extraction). */
export type CodeEntityType = 'Module' | 'Class' | 'Function' | 'API';

/** Documentation-derived entity kinds (path-based classification). */
export type DocEntityType = 'ADR' | 'Plan' | 'Task' | 'Knowledge' | 'Doc';

export type EntityType = CodeEntityType | DocEntityType;

export const ENTITY_TYPES: readonly EntityType[] = [
  'Module',
  'Class',
  'Function',
  'API',
  'ADR',
  'Plan',
  'Task',
  'Knowledge',
  'Doc',
];

/**
 * Pilot relation vocabulary. Stored as a `type` property on a single
 * relationship kind (Cypher cannot parameterize relationship types, and a
 * closed vocabulary keeps traversal queries simple).
 */
export type RelationType = 'DEPENDS_ON' | 'REFERENCES' | 'PART_OF' | 'COVERS';

export const RELATION_TYPES: readonly RelationType[] = ['DEPENDS_ON', 'REFERENCES', 'PART_OF', 'COVERS'];

export interface GraphEntity {
  /** Stable id, unique within an island — repo-relative path or symbol id. */
  id: string;
  type: EntityType;
  /** Human-readable display name (file stem, class name…). */
  name: string;
  /** Repo-relative source path, when the entity maps to a file. */
  filePath?: string;
  language?: 'typescript' | 'csharp' | 'markdown';
}

export interface GraphRelation {
  /** Source entity id (must exist in the same island). */
  from: string;
  /** Target entity id (must exist in the same island). */
  to: string;
  type: RelationType;
}

/** A traversal hit: the reached entity plus how far it is from the start. */
export interface TraversalHit {
  entity: GraphEntity;
  /** Minimum number of hops from the start entity (1 = direct neighbor). */
  distance: number;
}
