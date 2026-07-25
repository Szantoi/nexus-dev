/**
 * Minimal recursive file walker for the graph extractors. Deterministic
 * (sorted) order so extraction output — and therefore the graph — is stable
 * across runs and platforms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/** Collect files under `root` whose name passes `accept`, sorted, absolute. */
export function walkFiles(root: string, accept: (fileName: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip, extraction stays best-effort
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && accept(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out.sort();
}

/** Repo-relative id with forward slashes (stable across platforms). */
export function repoRelativeId(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}
