/**
 * Knowledge base indexer.
 * Scans documentation (.md) and source code (.ts, .tsx, .cs) files,
 * splits into chunks, embeds locally (or Voyage/Gemini), and stores in ChromaDB.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { logger } from './core/logger';
import { ConfigurationError } from './core/errors';
import { useVoyage } from './embeddings';
import { addChunks } from './vectorStore';
import { KNOWLEDGE_BASE_PATH } from './config/paths';

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

export interface FileItem {
  absPath: string;
  isCode: boolean;
  baseDir: string;
}

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'data',
  '.tmp',
  '.cache',
]);

async function findFiles(dir: string, isCodeDir: boolean, baseDir: string, acc: FileItem[] = []): Promise<FileItem[]> {
  if (!fs.existsSync(dir)) return acc;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!DEFAULT_SKIP_DIRS.has(entry.name)) {
        await findFiles(full, isCodeDir, baseDir, acc);
      }
    } else if (entry.isFile()) {
      if (!isCodeDir && entry.name.endsWith('.md')) {
        acc.push({ absPath: full, isCode: false, baseDir });
      } else if (
        isCodeDir &&
        /\.(tsx?|cs|jsx?)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        acc.push({ absPath: full, isCode: true, baseDir });
      }
    }
  }
  return acc;
}

/** Extract YAML frontmatter key:value pairs (simple, no dependency on js-yaml). */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*['"]?(.+?)['"]?\s*$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

/** Sanitize metadata so ChromaDB only gets string | number | boolean values. */
function sanitizeMeta(
  meta: Record<string, unknown>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (v != null) {
      out[k] = String(v);
    }
  }
  return out;
}

export interface IndexResult {
  files: number;
  chunks: number;
  knowledgePath: string;
}

export interface BuildIndexOptions {
  includeCode?: boolean;
  codeDirs?: string[];
  docsDir?: string;
}

export async function buildIndex(options: BuildIndexOptions = {}): Promise<IndexResult> {
  const docsDir = options.docsDir ?? KNOWLEDGE_BASE_PATH;
  const includeCode = options.includeCode ?? true;

  if (!fs.existsSync(docsDir)) {
    throw new ConfigurationError(`Knowledge base not found: ${docsDir}`);
  }

  const items: FileItem[] = [];
  await findFiles(docsDir, false, docsDir, items);

  if (includeCode) {
    const defaultCodeDir = path.resolve(__dirname, '..');
    const codeDirs = options.codeDirs ?? [path.join(defaultCodeDir, 'src')];
    for (const codeDir of codeDirs) {
      await findFiles(codeDir, true, defaultCodeDir, items);
    }
  }

  logger.info(`📚 Indexing ${items.length} file(s) (docs + code)...`);

  const mdSplitter = new MarkdownTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const codeSplitter = RecursiveCharacterTextSplitter.fromLanguage('js', {
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  let totalChunks = 0;
  let chunkCounter = 0;

  for (let fileIdx = 0; fileIdx < items.length; fileIdx++) {
    const item = items[fileIdx];
    let content: string;
    try {
      content = await fs.promises.readFile(item.absPath, 'utf-8');
    } catch {
      continue;
    }

    const relativePath = path.relative(item.baseDir, item.absPath).replace(/\\/g, '/');
    const ext = path.extname(item.absPath).toLowerCase();

    if (item.isCode) {
      const lang = ext === '.cs' ? 'csharp' : 'typescript';
      const domain = relativePath.split('/')[0] || 'src';
      const baseMeta = sanitizeMeta({
        source: relativePath,
        domain,
        name: path.basename(item.absPath, ext),
        type: 'code',
        language: lang,
      });

      const langchainDocs = await codeSplitter.createDocuments([content], [baseMeta]);
      if (langchainDocs.length === 0) continue;

      const chunks = langchainDocs.map((doc) => ({
        id: `${relativePath.replace(/[^a-z0-9]/gi, '_')}_chunk_${chunkCounter++}`,
        text: doc.pageContent,
        metadata: sanitizeMeta(doc.metadata as Record<string, unknown>),
      }));

      await addChunks(chunks);
      totalChunks += chunks.length;
    } else {
      const frontmatter = parseFrontmatter(content);
      const domain = frontmatter.domain || relativePath.split('/')[0] || 'general';

      const baseMeta = sanitizeMeta({
        source: relativePath,
        domain,
        name: frontmatter.name || path.basename(item.absPath, '.md'),
        type: 'doc',
        language: 'markdown',
      });

      const langchainDocs = await mdSplitter.createDocuments([content], [baseMeta]);
      if (langchainDocs.length === 0) continue;

      const chunks = langchainDocs.map((doc) => ({
        id: `${relativePath.replace(/[^a-z0-9]/gi, '_')}_chunk_${chunkCounter++}`,
        text: doc.pageContent,
        metadata: sanitizeMeta(doc.metadata as Record<string, unknown>),
      }));

      await addChunks(chunks);
      totalChunks += chunks.length;
    }

    // Voyage AI free tier is 3 RPM — only throttle when actually calling Voyage.
    if (useVoyage() && fileIdx < items.length - 1) {
      logger.info(`   💤 Rate limit delay (40s, Voyage AI free tier)...`);
      await new Promise((resolve) => setTimeout(resolve, 40000));
    }
  }

  logger.info(`✅ Done: ${items.length} files → ${totalChunks} chunks`);
  return { files: items.length, chunks: totalChunks, knowledgePath: docsDir };
}

// Standalone run: tsx src/indexer.ts
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initVectorStore } = require('./vectorStore') as typeof import('./vectorStore');
  (async () => {
    await initVectorStore();
    const result = await buildIndex();
    logger.info(result);
    process.exit(0);
  })().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}
