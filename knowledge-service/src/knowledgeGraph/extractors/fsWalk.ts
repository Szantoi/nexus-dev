/**
 * Minimal recursive file walker for the graph extractors. Deterministic
 * (sorted) order so extraction output — and therefore the graph — is stable
 * across runs and platforms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Build output and VCS noise, skipped for every language. */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
]);

/**
 * Collect files under `root` whose name passes `accept`, sorted, absolute.
 * `skipDirs` is per-language on purpose: 'bin' is build output in C# but a
 * real source directory in plenty of JS repos, so the default set stays small
 * and each extractor adds what its toolchain generates.
 */
export function walkFiles(
  root: string,
  accept: (fileName: string) => boolean,
  options: { skipDirs?: ReadonlySet<string> } = {}
): string[] {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
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
        if (!skipDirs.has(entry.name)) stack.push(path.join(dir, entry.name));
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
