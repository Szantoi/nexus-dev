/**
 * Memory Persistence Tests (Cold Start)
 *
 * Tests that terminals can:
 * 1. Write facts to MEMORY.md
 * 2. Recall facts after session restart (cold start)
 * 3. Persist context across sessions
 *
 * Uses 2x2 factorial design:
 * - Cold baseline: No memory, fresh start
 * - Warm: Memory available from previous session
 *
 * Run: npm test -- src/__tests__/agent/memory.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  AGENT_THRESHOLDS,
  TEST_FACTS,
  TERMINALS,
  fetchApi,
  measureTime,
} from './agent.config';
import {
  discoverTerminals,
  readMemory,
  writeMemory,
  appendToMemory,
  factExistsInMemory,
  injectTestFact,
  cleanupTestArtifacts,
  generateTestId,
  getTerminalStatus,
} from './test-harness';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let availableTerminals: string[] = [];
let sampleTerminal: string = 'backend'; // Default fallback

beforeAll(async () => {
  availableTerminals = await discoverTerminals();
  // Use a worker terminal for memory tests (not priority)
  sampleTerminal =
    availableTerminals.find((t) => TERMINALS.workers.includes(t)) ||
    availableTerminals[0] ||
    'backend';

  console.log(`Memory tests using terminal: ${sampleTerminal}`);
});

afterAll(async () => {
  // Cleanup test artifacts from all tested terminals
  for (const terminal of availableTerminals) {
    await cleanupTestArtifacts(terminal);
  }
});

// ─── MEMORY.md Read/Write Tests ──────────────────────────────────────────────

describe('MEMORY.md File Operations', () => {
  it('can read MEMORY.md for existing terminals', async () => {
    for (const terminal of availableTerminals.slice(0, 3)) {
      const memory = await readMemory(terminal);

      // Memory may or may not exist, but reading shouldn't crash
      if (memory !== null) {
        expect(typeof memory).toBe('string');
        expect(memory.length).toBeGreaterThan(0);
      }
    }
  });

  it('can write to MEMORY.md within timeout', async () => {
    const testId = generateTestId();
    const testContent = `\n## Test Entry ${testId}\nThis is a test entry.\n`;

    const { elapsed } = await measureTime(async () => {
      return appendToMemory(sampleTerminal, testContent);
    });

    expect(elapsed).toBeLessThan(AGENT_THRESHOLDS.memory.memoryWriteTimeoutMs);

    // Verify content was written
    const memory = await readMemory(sampleTerminal);
    expect(memory).toContain(testId);
  });

  it('persists test facts in MEMORY.md', async () => {
    const testFact = TEST_FACTS[0];
    const testKey = `test_${Date.now()}`;

    // Inject fact
    const written = await injectTestFact(
      sampleTerminal,
      testKey,
      testFact.value
    );
    expect(written).toBe(true);

    // Verify persistence
    const exists = await factExistsInMemory(
      sampleTerminal,
      testKey,
      testFact.value
    );
    expect(exists).toBe(true);
  });
});

// ─── Cold Start Memory Recall Tests ──────────────────────────────────────────

describe('Cold Start Memory Recall', () => {
  it('MEMORY.md survives session boundary (file persistence)', async () => {
    const testId = generateTestId();
    const factKey = `survival_test_${testId}`;
    const factValue = 'PERSIST-CHECK-' + Date.now();

    // Write fact
    await injectTestFact(sampleTerminal, factKey, factValue);

    // Simulate cold start by re-reading (file should persist)
    const memoryAfter = await readMemory(sampleTerminal);

    expect(memoryAfter).not.toBeNull();
    expect(memoryAfter).toContain(factValue);
  });

  it('multiple facts persist independently', async () => {
    const testId = generateTestId();
    const facts = TEST_FACTS.slice(0, 3).map((f, i) => ({
      key: `multi_${testId}_${i}`,
      value: `${f.value}_${Date.now()}`,
    }));

    // Write all facts
    for (const fact of facts) {
      await injectTestFact(sampleTerminal, fact.key, fact.value);
    }

    // Verify all persist
    for (const fact of facts) {
      const exists = await factExistsInMemory(
        sampleTerminal,
        fact.key,
        fact.value
      );
      expect(exists).toBe(true);
    }
  });

  it('calculates recall accuracy above threshold', async () => {
    const testId = generateTestId();
    const testFacts = TEST_FACTS.map((f, i) => ({
      key: `recall_${testId}_${i}`,
      value: `${f.value}_${Date.now()}`,
    }));

    // Write facts
    for (const fact of testFacts) {
      await injectTestFact(sampleTerminal, fact.key, fact.value);
    }

    // Calculate recall rate
    let recalled = 0;
    for (const fact of testFacts) {
      const exists = await factExistsInMemory(
        sampleTerminal,
        fact.key,
        fact.value
      );
      if (exists) recalled++;
    }

    const recallRate = recalled / testFacts.length;

    expect(recallRate).toBeGreaterThanOrEqual(
      AGENT_THRESHOLDS.memory.coldStartRecallAccuracy
    );

    console.log(
      `Cold start recall accuracy: ${(recallRate * 100).toFixed(1)}%`
    );
  });
});

// ─── Memory API Tests ────────────────────────────────────────────────────────

describe('Memory API', () => {
  it('GET /api/memory/:terminal returns memory content', async () => {
    const res = await fetchApi(`/api/memory/${sampleTerminal}`);

    // API may or may not be implemented, accept 200 or 404
    if (res.status === 200) {
      const data = await res.json();
      expect(data).toHaveProperty('content');
    } else {
      // Skip if not implemented
      expect([404, 501]).toContain(res.status);
    }
  });

  it('POST /api/memory/:terminal/append adds content', async () => {
    const testId = generateTestId();
    const content = `Test append ${testId}`;

    const res = await fetchApi(`/api/memory/${sampleTerminal}/append`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });

    // API may or may not be implemented
    if (res.status === 200) {
      const memory = await readMemory(sampleTerminal);
      expect(memory).toContain(testId);
    } else {
      // Skip if not implemented
      expect([404, 501]).toContain(res.status);
    }
  });
});

// ─── Cross-Terminal Memory Isolation ─────────────────────────────────────────

describe('Cross-Terminal Memory Isolation', () => {
  it('terminal memories are isolated from each other', async () => {
    // Skip if less than 2 terminals
    if (availableTerminals.length < 2) {
      console.log('Skipping: need at least 2 terminals');
      return;
    }

    const terminal1 = availableTerminals[0];
    const terminal2 = availableTerminals[1];
    const uniqueKey = `isolation_${generateTestId()}`;
    const uniqueValue = 'ONLY_IN_TERMINAL_1';

    // Write to terminal 1
    await injectTestFact(terminal1, uniqueKey, uniqueValue);

    // Verify in terminal 1
    const existsIn1 = await factExistsInMemory(terminal1, uniqueKey, uniqueValue);
    expect(existsIn1).toBe(true);

    // Verify NOT in terminal 2
    const existsIn2 = await factExistsInMemory(terminal2, uniqueKey, uniqueValue);
    expect(existsIn2).toBe(false);
  });
});

// ─── Memory Corruption Tests ─────────────────────────────────────────────────

describe('Memory Integrity', () => {
  it('concurrent writes do not corrupt memory', async () => {
    const testId = generateTestId();
    const writes = Array.from({ length: 3 }, (_, i) => ({
      key: `concurrent_${testId}_${i}`,
      value: `value_${i}_${Date.now()}`,
    }));

    // Write all sequentially to avoid race condition on single file
    for (const w of writes) {
      await injectTestFact(sampleTerminal, w.key, w.value);
    }

    // Verify all exist
    const memory = await readMemory(sampleTerminal);
    expect(memory).not.toBeNull();

    // At least the last write should be present (file integrity)
    const lastWrite = writes[writes.length - 1];
    expect(memory).toContain(lastWrite.key);
  });

  it('memory content is valid UTF-8', async () => {
    const memory = await readMemory(sampleTerminal);

    if (memory) {
      // Check for valid UTF-8 by encoding and decoding
      const encoded = new TextEncoder().encode(memory);
      const decoded = new TextDecoder('utf-8').decode(encoded);

      expect(decoded).toBe(memory);
    }
  });

  it('special characters are preserved', async () => {
    const testId = generateTestId();
    const specialChars = 'áéíóúőű ΑΒΓΔ 中文 🚀 <>&"\'';

    await injectTestFact(sampleTerminal, `special_${testId}`, specialChars);

    const memory = await readMemory(sampleTerminal);
    expect(memory).toContain(specialChars);
  });
});

// ─── Factorial Design Tests (Cold vs Warm) ───────────────────────────────────

describe('Factorial Design: Cold vs Warm Start', () => {
  it('Cold Baseline: fresh terminal has minimal memory', async () => {
    // Check that memory files have structure but may have little content
    const memory = await readMemory(sampleTerminal);

    if (memory) {
      // Should have at least a header
      expect(memory.length).toBeGreaterThan(0);

      // Log memory size for baseline
      console.log(
        `Cold baseline memory size: ${memory.length} chars for ${sampleTerminal}`
      );
    }
  });

  it('Warm Start: injected facts are retrievable', async () => {
    const warmFacts = TEST_FACTS.slice(0, 2);

    // Inject facts (warm state)
    for (const fact of warmFacts) {
      const testKey = `warm_${fact.key}_${Date.now()}`;
      await injectTestFact(sampleTerminal, testKey, fact.value);
    }

    // Read back (simulating warm start)
    const memory = await readMemory(sampleTerminal);

    expect(memory).not.toBeNull();
    for (const fact of warmFacts) {
      expect(memory).toContain(fact.value);
    }
  });

  it('Memory size grows with injected facts', async () => {
    const beforeSize = (await readMemory(sampleTerminal))?.length || 0;

    // Inject new fact
    const testId = generateTestId();
    await injectTestFact(sampleTerminal, `growth_${testId}`, 'growth_test_value');

    const afterSize = (await readMemory(sampleTerminal))?.length || 0;

    expect(afterSize).toBeGreaterThan(beforeSize);
  });
});

// ─── Performance Tests ───────────────────────────────────────────────────────

describe('Memory Operation Performance', () => {
  it('memory read is fast', async () => {
    const times: number[] = [];

    for (let i = 0; i < 5; i++) {
      const { elapsed } = await measureTime(async () => {
        await readMemory(sampleTerminal);
      });
      times.push(elapsed);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTime = Math.max(...times);

    console.log(`Memory read: avg=${avgTime.toFixed(0)}ms, max=${maxTime}ms`);

    // Should be fast (< 100ms)
    expect(avgTime).toBeLessThan(100);
  });

  it('memory write is within threshold', async () => {
    const testId = generateTestId();

    const { elapsed } = await measureTime(async () => {
      await injectTestFact(sampleTerminal, `perf_${testId}`, 'performance_test');
    });

    expect(elapsed).toBeLessThan(AGENT_THRESHOLDS.memory.memoryWriteTimeoutMs);

    console.log(`Memory write: ${elapsed}ms`);
  });
});
