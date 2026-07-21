#!/usr/bin/env node
/** Restore files recorded by configure.mjs. */

import fs from 'node:fs';
import path from 'node:path';

const backupRoot = process.argv[2];
if (!backupRoot) throw new Error('usage: node rollback.mjs <backup-directory>');
const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
for (const entry of [...manifest.files].reverse()) {
  if (entry.existed) {
    const source = path.join(backupRoot, entry.relative);
    fs.mkdirSync(path.dirname(entry.target), { recursive: true });
    fs.copyFileSync(source, entry.target);
  } else if (fs.existsSync(entry.target)) {
    fs.rmSync(entry.target);
  }
}
console.log(`[CodexAutonomy] restored ${manifest.files.length} file(s) from ${backupRoot}`);
