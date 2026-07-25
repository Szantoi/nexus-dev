/**
 * Docs extractor: markdown corpus → Doc entities + REFERENCES relations.
 *
 * Deterministic, parser-based (NO LLM): entities come from the file tree,
 * relations from relative markdown links and ADR-number mentions — the same
 * signals scripts/check-doc-links.mjs already validates in CI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocEntityType, GraphEntity, GraphRelation } from '../types';
import { repoRelativeId, walkFiles } from './fsWalk';

export interface ExtractionResult {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/** Path-based classification (repo conventions). */
export function classifyDocPath(relPath: string): DocEntityType {
  const base = path.posix.basename(relPath);
  if (/^ADR-\d+/i.test(base) || relPath.includes('/decisions/')) return 'ADR';
  if (relPath.includes('/plans/')) return 'Plan';
  if (relPath.includes('/tasks/')) return 'Task';
  if (relPath.includes('/knowledge/')) return 'Knowledge';
  return 'Doc';
}

/**
 * Markdown inline links: [text](target), [text](<target>), and
 * [text](target "title") — the target is the first non-space run (or the
 * angle-bracketed span), an optional title is tolerated before the ')'.
 */
const MD_LINK_RX = /\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^)]*)?\)/g;
const ADR_MENTION_RX = /\bADR-(\d{2,4})\b/g;

/** '081' and '81' must address the same ADR — key on the numeric value. */
const normalizeAdrNumber = (raw: string): string => String(Number.parseInt(raw, 10));

/**
 * Extract entities + relations from every .md file under `docsRoot`.
 * Only links resolving to another scanned .md file become relations —
 * external URLs and broken paths are ignored (link hygiene is CI's job).
 */
export function extractDocs(docsRoot: string, repoRoot: string): ExtractionResult {
  const files = walkFiles(docsRoot, (name) => name.toLowerCase().endsWith('.md'));

  const entities: GraphEntity[] = [];
  const byId = new Set<string>();
  /** ADR number → entity id (first wins; numbering is unique by convention). */
  const adrByNumber = new Map<string, string>();

  for (const abs of files) {
    const id = repoRelativeId(repoRoot, abs);
    const type = classifyDocPath(id);
    entities.push({
      id,
      type,
      name: path.posix.basename(id, '.md'),
      filePath: id,
      language: 'markdown',
    });
    byId.add(id);
    if (type === 'ADR') {
      const m = /^ADR-(\d+)/i.exec(path.posix.basename(id));
      if (m) {
        const num = normalizeAdrNumber(m[1]);
        if (!adrByNumber.has(num)) adrByNumber.set(num, id);
      }
    }
  }

  const relations: GraphRelation[] = [];
  const seen = new Set<string>();
  const addRelation = (from: string, to: string): void => {
    if (from === to) return;
    const dedupKey = `${from}→${to}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    relations.push({ from, to, type: 'REFERENCES' });
  };

  for (const abs of files) {
    const fromId = repoRelativeId(repoRoot, abs);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    for (const match of content.matchAll(MD_LINK_RX)) {
      const rawTarget = (match[1] ?? match[2]).split('#')[0];
      if (rawTarget === '' || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue; // URL schemes
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(fromId), rawTarget)
      );
      if (byId.has(resolved)) addRelation(fromId, resolved);
    }

    for (const match of content.matchAll(ADR_MENTION_RX)) {
      const target = adrByNumber.get(normalizeAdrNumber(match[1]));
      if (target !== undefined) addRelation(fromId, target);
    }
  }

  return { entities, relations };
}
