/**
 * Directory containment shared by every language extractor: each file is
 * PART_OF its directory, and each directory PART_OF its parent, up to (and
 * including) the source root. Module-level impact questions ("what is under
 * this folder") work out of the box because of these edges.
 */

import * as path from 'node:path';
import type { GraphEntity, GraphRelation } from '../types';

export interface DirChain {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/**
 * Build directory entities and PART_OF edges for a set of repo-relative file
 * ids. The walk stops at `srcRootId` so a chain never escapes the corpus root.
 */
export function buildDirChain(fileIds: readonly string[], srcRootId: string): DirChain {
  const entities: GraphEntity[] = [];
  const relations: GraphRelation[] = [];
  const seenDirs = new Set<string>();
  const seenEdges = new Set<string>();

  const addEdge = (from: string, to: string): void => {
    const key = `${from}→${to}`;
    if (from === to || seenEdges.has(key)) return;
    seenEdges.add(key);
    relations.push({ from, to, type: 'PART_OF' });
  };

  const ensureDir = (dirId: string): void => {
    let current = dirId;
    while (true) {
      if (!seenDirs.has(current)) {
        seenDirs.add(current);
        entities.push({ id: current, type: 'Module', name: path.posix.basename(current) });
      }
      if (current === srcRootId) break;
      const parent = path.posix.dirname(current);
      if (parent === current || !parent.startsWith(srcRootId)) break;
      addEdge(current, parent);
      current = parent;
    }
  };

  for (const fileId of fileIds) {
    const dirId = path.posix.dirname(fileId);
    ensureDir(dirId);
    addEdge(fileId, dirId);
  }

  return { entities, relations };
}
