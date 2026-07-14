/**
 * Knowledge base indexer.
 * Scans docs/knowledge/**\/*.md (all .md, not just .knowledge.md),
 * splits into chunks, embeds with Google Gemini or Voyage AI, stores in ChromaDB.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import { addChunks } from './vectorStore';
import { useVoyage } from './embeddings';

// Default: resolve relative to this file's location in the repo
// src/ → knowledge-service/ → spaceos-nexus/ → spaceos/ → docs/knowledge
const DEFAULT_KNOWLEDGE_PATH = path.resolve(__dirname, '../../..', 'docs', 'knowledge');

const KNOWLEDGE_BASE_PATH =
  process.env.KNOWLEDGE_BASE_PATH || DEFAULT_KNOWLEDGE_PATH;

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

async function findMdFiles(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await findMdFiles(full, acc);
    } else if (entry.name.endsWith('.md')) {
      acc.push(full);
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

export async function buildIndex(): Promise<IndexResult> {
  if (!fs.existsSync(KNOWLEDGE_BASE_PATH)) {
    throw new Error(`Knowledge base not found: ${KNOWLEDGE_BASE_PATH}`);
  }

  const files = await findMdFiles(KNOWLEDGE_BASE_PATH);
  console.log(`📚 Indexing ${files.length} .md files from: ${KNOWLEDGE_BASE_PATH}`);

  const splitter = new MarkdownTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  let totalChunks = 0;
  let chunkCounter = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const file = files[fileIdx];
    const content = await fs.promises.readFile(file, 'utf-8');
    const relativePath = path.relative(KNOWLEDGE_BASE_PATH, file);

    const frontmatter = parseFrontmatter(content);

    // Derive domain from frontmatter or first path segment
    const domain =
      frontmatter.domain ||
      relativePath.split(path.sep)[0] ||
      'general';

    const baseMeta = sanitizeMeta({
      source: relativePath,
      domain,
      name: frontmatter.name || path.basename(file, '.md'),
    });

    const langchainDocs = await splitter.createDocuments([content], [baseMeta]);
    if (langchainDocs.length === 0) continue;

    const chunks = langchainDocs.map(doc => ({
      id: `${relativePath.replace(/[^a-z0-9]/gi, '_')}_chunk_${chunkCounter++}`,
      text: doc.pageContent,
      metadata: sanitizeMeta(doc.metadata as Record<string, unknown>),
    }));

    await addChunks(chunks);
    totalChunks += chunks.length;
    console.log(`   ✓ ${relativePath} [${domain}] → ${chunks.length} chunks`);

    // Voyage AI free tier is 3 RPM — only throttle when actually calling Voyage.
    // Local/Xenova embedding has no such limit and doesn't need this delay.
    if (useVoyage() && fileIdx < files.length - 1) {
      console.log(`   💤 Rate limit delay (40s, Voyage AI free tier)...`);
      await new Promise(resolve => setTimeout(resolve, 40000));
    }
  }

  console.log(`✅ Done: ${files.length} files → ${totalChunks} chunks`);
  return { files: files.length, chunks: totalChunks, knowledgePath: KNOWLEDGE_BASE_PATH };
}

// Standalone run: tsx src/indexer.ts
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initVectorStore } = require('./vectorStore') as typeof import('./vectorStore');
  (async () => {
    await initVectorStore();
    const result = await buildIndex();
    console.log(result);
    process.exit(0);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
