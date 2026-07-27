import { describe, it, expect, beforeEach } from 'vitest';
import { addChunks, searchKnowledge } from '../../vectorStore';
import { toolRegistry } from '../../interfaces/mcp/tools/base-tool';
import { registerKnowledgeTools } from '../../interfaces/mcp/tools/knowledge.tools';

describe('searchKnowledge domain filter', () => {
  beforeEach(async () => {
    registerKnowledgeTools();
    await addChunks([
      {
        id: 'chunk-doc-1',
        text: 'Architecture design pattern for knowledge service indexing.',
        metadata: { domain: 'architecture', source: 'docs/arch.md' },
      },
      {
        id: 'chunk-code-1',
        text: 'Function searchKnowledge performs vector search over code chunks.',
        metadata: { domain: 'code', source: 'src/vectorStore.ts' },
      },
    ]);
  });

  it('filters results by domain in vectorStore.searchKnowledge', async () => {
    const codeResults = await searchKnowledge('searchKnowledge', 5, undefined, 'code');
    expect(codeResults.length).toBeGreaterThan(0);
    expect(codeResults.every(r => r.metadata.domain === 'code')).toBe(true);

    const archResults = await searchKnowledge('Architecture', 5, undefined, 'architecture');
    expect(archResults.length).toBeGreaterThan(0);
    expect(archResults.every(r => r.metadata.domain === 'architecture')).toBe(true);
  });

  it('filters results by domain in search_knowledge MCP tool call', async () => {
    const response = await toolRegistry.call(
      'search_knowledge',
      { query: 'knowledge', limit: 5, domain: 'code' },
      { island: 'nexus-dev' }
    );
    expect(response.isError).toBeFalsy();
    const content = JSON.parse(response.content[0].text);
    expect(content.domain).toBe('code');
    expect(content.results.every((r: { metadata: { domain: string } }) => r.metadata.domain === 'code')).toBe(true);
  });
});
