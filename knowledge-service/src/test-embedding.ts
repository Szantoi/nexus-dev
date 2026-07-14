import 'dotenv/config';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';

async function test() {
  console.log('GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'SET (' + process.env.GOOGLE_API_KEY.substring(0, 10) + '...)' : 'NOT SET');
  
  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GOOGLE_API_KEY!,
    modelName: 'gemini-embedding-001',
  });
  
  const testTexts = ['Hello world'];
  console.log('\nEmbedding test texts:', testTexts);
  
  try {
    const result = await embeddings.embedDocuments(testTexts);
    console.log('\nResult length:', result.length);
    console.log('First embedding length:', result[0]?.length || 0);
    console.log('First few values:', result[0]?.slice(0, 5));
  } catch (err: any) {
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
  }
}

test();
