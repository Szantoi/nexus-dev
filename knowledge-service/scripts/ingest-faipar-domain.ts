/**
 * Faipar Domain RAG Indexing Script
 *
 * Indexes 3 large domain documents to ChromaDB for semantic search:
 * - faipari_gyartasszervezes_rag.md (377 KB - gyártásszervezés)
 * - faipari_muszaki_dokumentacio_rag.md (131 KB - műszaki dokumentáció)
 * - woodwork_domain.md (74 KB - központi faipar domain)
 *
 * Usage:
 *   cd /opt/spaceos/spaceos-nexus/knowledge-service
 *   npx ts-node scripts/ingest-faipar-domain.ts
 *
 * Requirements:
 * - ChromaDB running (docker compose up -d)
 * - XenovaEmbeddingFunction (all-MiniLM-L6-v2, 384 dim)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import { initVectorStore, addChunks, searchKnowledge, getDocumentCount, usingChroma } from '../src/vectorStore';

const FAIPAR_DOCS = [
  '/opt/spaceos/docs/faipari_gyartasszervezes_rag.md',
  '/opt/spaceos/docs/faipari_muszaki_dokumentacio_rag.md',
  '/opt/spaceos/docs/woodwork_domain.md'
];

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const CATEGORY = 'faipar-domain';

interface IndexStats {
  filesProcessed: number;
  totalChunks: number;
  documentsInDB: number;
  usingChromaDB: boolean;
}

/**
 * Calculate SHA-256 hash of file content for incremental updates
 */
function calculateFileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Sanitize metadata for ChromaDB (string | number | boolean only)
 */
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

/**
 * Index a single faipar document to ChromaDB
 */
async function indexDocument(
  filePath: string,
  splitter: MarkdownTextSplitter,
  chunkCounterStart: number
): Promise<number> {
  console.log(`\n📄 Processing: ${path.basename(filePath)}`);

  // Check file exists
  if (!fs.existsSync(filePath)) {
    console.error(`   ❌ File not found: ${filePath}`);
    return 0;
  }

  // Read file content
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileHash = calculateFileHash(content);
  const fileName = path.basename(filePath, '.md');

  console.log(`   📊 Size: ${(content.length / 1024).toFixed(1)} KB`);
  console.log(`   🔑 Hash: ${fileHash.substring(0, 12)}...`);

  // Split content into chunks
  const baseMeta = {
    source: filePath,
    category: CATEGORY,
    fileName: fileName,
    fileHash: fileHash,
  };

  const langchainDocs = await splitter.createDocuments([content], [baseMeta]);

  if (langchainDocs.length === 0) {
    console.log(`   ⚠️  No chunks generated (empty content)`);
    return 0;
  }

  // Create chunks with unique IDs
  let chunkCounter = chunkCounterStart;
  const chunks = langchainDocs.map(doc => ({
    id: `faipar_${fileName}_chunk_${chunkCounter++}`,
    text: doc.pageContent,
    metadata: sanitizeMeta(doc.metadata as Record<string, unknown>),
  }));

  // Add to ChromaDB
  await addChunks(chunks);

  console.log(`   ✅ Indexed: ${chunks.length} chunks`);
  return chunks.length;
}

/**
 * Run semantic search tests to verify indexing
 */
async function runSemanticSearchTests(): Promise<void> {
  console.log(`\n🧪 Running Semantic Search Tests...\n`);

  const tests = [
    {
      query: "Hogyan működik az ajtógyártás workflow?",
      expectedSource: "faipari_gyartasszervezes_rag.md"
    },
    {
      query: "CAD/CAM integráció faiparban",
      expectedSource: "faipari_muszaki_dokumentacio_rag.md"
    },
    {
      query: "Miért fontos a faipari digitalizáció?",
      expectedSource: "woodwork_domain.md"
    }
  ];

  for (const test of tests) {
    console.log(`🔍 Query: "${test.query}"`);

    const results = await searchKnowledge(test.query, 3);

    if (results.length === 0) {
      console.log(`   ❌ No results found\n`);
      continue;
    }

    console.log(`   📊 Found ${results.length} results:`);
    results.forEach((result, idx) => {
      const fileName = result.metadata.fileName || 'unknown';
      const score = result.score?.toFixed(4) || 'N/A';
      const preview = result.text.substring(0, 80).replace(/\n/g, ' ');
      console.log(`   ${idx + 1}. ${fileName} (score: ${score})`);
      console.log(`      "${preview}..."`);
    });

    // Check if expected source is in top 3
    const hasExpected = results.some(r =>
      typeof r.metadata.fileName === 'string' &&
      r.metadata.fileName.includes(test.expectedSource.replace('.md', ''))
    );

    if (hasExpected) {
      console.log(`   ✅ Expected source found in results\n`);
    } else {
      console.log(`   ⚠️  Expected source "${test.expectedSource}" not in top 3\n`);
    }
  }
}

/**
 * Main ingestion function
 */
async function ingestFaiparDomain(): Promise<IndexStats> {
  console.log('🚀 Faipar Domain RAG Indexing\n');
  console.log('=' .repeat(60));

  // Initialize vector store
  await initVectorStore();

  const beforeCount = await getDocumentCount();
  console.log(`📊 Documents in DB before: ${beforeCount}`);

  // Create text splitter
  const splitter = new MarkdownTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  // Index all 3 documents
  let totalChunks = 0;
  let chunkCounter = 0;

  for (const filePath of FAIPAR_DOCS) {
    const chunksAdded = await indexDocument(filePath, splitter, chunkCounter);
    totalChunks += chunksAdded;
    chunkCounter += chunksAdded;
  }

  const afterCount = await getDocumentCount();

  console.log('\n' + '='.repeat(60));
  console.log('✅ Indexing Complete\n');
  console.log(`📁 Files processed: ${FAIPAR_DOCS.length}`);
  console.log(`📦 Total chunks added: ${totalChunks}`);
  console.log(`📊 Documents in DB after: ${afterCount}`);
  console.log(`📈 New documents: ${afterCount - beforeCount}`);
  console.log(`🔮 Using ChromaDB: ${usingChroma() ? 'Yes' : 'No (in-memory fallback)'}`);

  // Run semantic search tests
  await runSemanticSearchTests();

  return {
    filesProcessed: FAIPAR_DOCS.length,
    totalChunks,
    documentsInDB: afterCount,
    usingChromaDB: usingChroma()
  };
}

// Standalone execution
if (require.main === module) {
  (async () => {
    try {
      const stats = await ingestFaiparDomain();

      console.log('\n📋 Final Stats:');
      console.log(JSON.stringify(stats, null, 2));

      process.exit(0);
    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  })();
}

export { ingestFaiparDomain };
