/**
 * Test semantic search on faipar domain documents
 */

import { ChromaClient } from 'chromadb';
import { XenovaEmbeddingFunction } from '../src/xenovaEmbedding';

async function testFaiparSearch() {
  const client = new ChromaClient({ host: 'localhost', port: 8001, ssl: false });
  const embeddingFunction = new XenovaEmbeddingFunction();
  const collection = await client.getCollection({
    name: 'spaceos-knowledge',
    embeddingFunction: embeddingFunction as any
  });

  console.log('🧪 Faipar Domain Semantic Search Tests\n');
  console.log('='.repeat(60));

  const tests = [
    'Hogyan működik az ajtógyártás workflow?',
    'CAD/CAM integráció faiparban',
    'Miért fontos a faipari digitalizáció?',
    'Lapszabászat optimalizálás',
    'Gyártásszervezés faipari vállalkozásnál'
  ];

  for (const query of tests) {
    console.log(`\n🔍 Query: "${query}"`);

    const results = await collection.query({
      queryTexts: [query],
      nResults: 3,
      where: { category: 'faipar-domain' }
    });

    if (!results.documents?.[0] || results.documents[0].length === 0) {
      console.log('   ❌ No results found');
      continue;
    }

    console.log(`   📊 Found ${results.documents[0].length} results:`);
    results.documents[0].forEach((doc, idx) => {
      const meta = results.metadatas?.[0]?.[idx] as any;
      const fileName = meta?.fileName || 'unknown';
      const distance = results.distances?.[0]?.[idx];
      const score = distance != null ? (1 / (1 + distance)).toFixed(4) : 'N/A';
      const preview = (doc as string).substring(0, 80).replace(/\n/g, ' ');
      console.log(`   ${idx + 1}. ${fileName} (score: ${score}, dist: ${distance?.toFixed(4) || 'N/A'})`);
      console.log(`      "${preview}..."`);
    });
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Semantic search tests completed');
}

testFaiparSearch().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
