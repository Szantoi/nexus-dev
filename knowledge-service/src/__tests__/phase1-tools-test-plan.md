# Phase 1 MCP Tools — Test Plan

**Author:** Architect (MSG-ARCHITECT-068)
**Date:** 2026-07-07
**For:** Backend (MSG-BACKEND-173)

---

## Test Coverage Goals

| Tool | Unit Tests | Integration Tests | Benchmark Tests |
|------|-----------|-------------------|-----------------|
| Terminal Status Aggregator | 6 tests | 1 scenario | 1 benchmark |
| Dependency Resolver | 5 tests | 1 scenario | 1 benchmark |
| Session Context Transfer | 4 tests | 2 scenarios | 1 benchmark |
| Component Scaffold | 5 tests | 1 scenario | 1 benchmark |
| Domain Pattern Matcher | 5 tests | 1 scenario | 1 benchmark |
| **Total** | **25 tests** | **6 scenarios** | **5 benchmarks** |

**Target Coverage:** >90% code coverage

---

## Unit Tests

### 1. Terminal Status Aggregator

**File:** `src/__tests__/unit/terminalStatusAggregator.test.ts`

```typescript
import { getTerminalStatusAggregate } from '../../pipeline/terminalStatusAggregator';
import * as terminalStatus from '../../terminalStatus';
import * as contextPersistence from '../../contextPersistence';

describe('Terminal Status Aggregator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('all terminals idle', async () => {
    jest.spyOn(terminalStatus, 'getAllStatus').mockResolvedValue([
      { terminal: 'conductor', status: 'idle', turnCount: 0 },
      { terminal: 'backend', status: 'idle', turnCount: 0 },
    ]);

    const result = await getTerminalStatusAggregate('summary');

    expect(result.summary.working).toEqual([]);
    expect(result.summary.idle).toEqual(['conductor', 'backend']);
  });

  test('1 terminal working', async () => {
    jest.spyOn(terminalStatus, 'getAllStatus').mockResolvedValue([
      { terminal: 'conductor', status: 'working', turnCount: 15 },
      { terminal: 'backend', status: 'idle', turnCount: 0 },
    ]);

    const result = await getTerminalStatusAggregate('summary');

    expect(result.summary.working).toContain('conductor');
    expect(result.summary.idle).toContain('backend');
  });

  test('context saturation WARNING', async () => {
    jest.spyOn(contextPersistence, 'getContextSaturation').mockResolvedValue({
      terminal: 'conductor',
      turnCount: 35,
      status: 'warning',
      thresholds: { warning: 30, critical: 50 }
    });

    const result = await getTerminalStatusAggregate('alerts_only');

    expect(result.summary.warnings).toContain('conductor: turn count >30');
  });

  test('context saturation CRITICAL', async () => {
    jest.spyOn(contextPersistence, 'getContextSaturation').mockResolvedValue({
      terminal: 'backend',
      turnCount: 52,
      status: 'critical',
      thresholds: { warning: 30, critical: 50 }
    });

    const result = await getTerminalStatusAggregate('alerts_only');

    expect(result.summary.warnings).toContain('backend: turn count >50 (CRITICAL)');
  });

  test('service down graceful degradation', async () => {
    jest.spyOn(terminalStatus, 'getStatus').mockRejectedValue(new Error('Service unavailable'));

    const result = await getTerminalStatusAggregate('summary');

    expect(result.success).toBe(true); // Gracefully skip
    expect(result.warnings).toContain('Failed to fetch status for some terminals');
  });

  test('format: detailed returns full terminal objects', async () => {
    jest.spyOn(terminalStatus, 'getAllStatus').mockResolvedValue([
      { terminal: 'conductor', status: 'working', turnCount: 15, currentTask: 'MSG-CONDUCTOR-065' },
    ]);

    const result = await getTerminalStatusAggregate('detailed');

    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].currentTask).toBe('MSG-CONDUCTOR-065');
  });
});
```

---

### 2. Dependency Resolver

**File:** `src/__tests__/unit/dependencyResolver.test.ts`

```typescript
import { resolveDependencies } from '../../pipeline/dependencyResolver';
import { readFileSync } from 'fs';

// Mock EPICS.yaml
const mockEpicsYaml = `
epics:
  - id: EPIC-READY
    depends_on: []
    status: active
  - id: EPIC-BLOCKED
    depends_on: ["EPIC-KERNEL-STABLE"]
    status: pending
  - id: EPIC-KERNEL-STABLE
    depends_on: []
    status: done
  - id: EPIC-CYCLE-A
    depends_on: ["EPIC-CYCLE-B"]
  - id: EPIC-CYCLE-B
    depends_on: ["EPIC-CYCLE-A"]
`;

describe('Dependency Resolver', () => {
  beforeEach(() => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(mockEpicsYaml);
  });

  test('epic with 0 blockers is ready', async () => {
    const result = await resolveDependencies('EPIC-READY', true);

    expect(result.blockedBy).toEqual([]);
    expect(result.status).toBe('active');
  });

  test('epic with 1 blocker (not done) is blocked', async () => {
    const result = await resolveDependencies('EPIC-BLOCKED', true);

    expect(result.blockedBy).toContain('EPIC-KERNEL-STABLE');
    expect(result.status).toBe('pending');
  });

  test('epic with 1 blocker (done) is ready', async () => {
    const result = await resolveDependencies('EPIC-BLOCKED', true);

    // EPIC-KERNEL-STABLE is done, so EPIC-BLOCKED should be unblocked
    expect(result.blockedBy).toEqual([]);
    expect(result.status).toBe('active');
  });

  test('circular dependency detected', async () => {
    const result = await resolveDependencies('EPIC-CYCLE-A', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Circular dependencies detected');
    expect(result.error).toContain('EPIC-CYCLE-A -> EPIC-CYCLE-B -> EPIC-CYCLE-A');
  });

  test('invalid epic ID returns error', async () => {
    const result = await resolveDependencies('EPIC-NONEXISTENT', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Epic not found');
  });
});
```

---

### 3. Session Context Transfer

**File:** `src/__tests__/unit/sessionContextTransfer.test.ts`

```typescript
import { transferSessionContext } from '../../pipeline/sessionContextTransfer';
import * as mailbox from '../../mailbox';
import * as contextPersistence from '../../contextPersistence';

describe('Session Context Transfer', () => {
  test('valid transfer creates inbox message', async () => {
    jest.spyOn(mailbox, 'createTask').mockResolvedValue({
      success: true,
      messageId: 'MSG-LIBRARIAN-004',
      inboxFile: 'terminals/librarian/inbox/2026-07-07_004_context-transfer.md'
    });

    const result = await transferSessionContext({
      from_terminal: 'explorer',
      to_terminal: 'librarian',
      context_type: 'research_summary',
      include_files: ['findings.md']
    });

    expect(result.success).toBe(true);
    expect(result.message_id).toBe('MSG-LIBRARIAN-004');
    expect(mailbox.createTask).toHaveBeenCalledWith(expect.objectContaining({
      from: 'explorer',
      to: 'librarian',
      type: 'task'
    }));
  });

  test('invalid from_terminal returns error', async () => {
    const result = await transferSessionContext({
      from_terminal: 'invalid-terminal',
      to_terminal: 'librarian',
      context_type: 'research_summary'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown terminal');
  });

  test('self-transfer returns error', async () => {
    const result = await transferSessionContext({
      from_terminal: 'librarian',
      to_terminal: 'librarian',
      context_type: 'research_summary'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot transfer to self');
  });

  test('missing STATUS.md proceeds with warning', async () => {
    jest.spyOn(contextPersistence, 'readStatusMd').mockResolvedValue(null);
    jest.spyOn(mailbox, 'createTask').mockResolvedValue({
      success: true,
      messageId: 'MSG-LIBRARIAN-005',
      inboxFile: 'terminals/librarian/inbox/2026-07-07_005_context-transfer.md'
    });

    const result = await transferSessionContext({
      from_terminal: 'explorer',
      to_terminal: 'librarian',
      context_type: 'research_summary'
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toContain('STATUS.md not found for explorer');
  });
});
```

---

### 4. Component Scaffold

**File:** `src/__tests__/unit/componentScaffold.test.ts`

```typescript
import { scaffoldComponent } from '../../generators/componentScaffold';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Component Scaffold', () => {
  test('valid React hook generates 2 files', async () => {
    jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'access').mockRejectedValue(new Error('File not found')); // File doesn't exist

    const result = await scaffoldComponent({
      component_type: 'react_hook',
      name: 'useCostBudget',
      output_dir: '/opt/spaceos/datahaven-web/client/src/hooks/'
    });

    expect(result.success).toBe(true);
    expect(result.files_created).toHaveLength(2);
    expect(result.files_created[0]).toContain('useCostBudget.ts');
    expect(result.files_created[1]).toContain('__tests__/useCostBudget.test.ts');
  });

  test('path traversal attack rejected', async () => {
    const result = await scaffoldComponent({
      component_type: 'react_hook',
      name: 'useMalicious',
      output_dir: '../../../../../../etc/'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid output directory');
  });

  test('file already exists returns error', async () => {
    jest.spyOn(fs, 'access').mockResolvedValue(undefined); // File exists

    const result = await scaffoldComponent({
      component_type: 'react_hook',
      name: 'useExisting',
      output_dir: '/opt/spaceos/datahaven-web/client/src/hooks/'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  test('invalid component_type returns error', async () => {
    const result = await scaffoldComponent({
      component_type: 'invalid_type' as any,
      name: 'useInvalid',
      output_dir: '/opt/spaceos/datahaven-web/client/src/hooks/'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid component_type');
  });

  test('OpenAPI spec reference resolves correctly', async () => {
    jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'access').mockRejectedValue(new Error('File not found'));

    const result = await scaffoldComponent({
      component_type: 'react_hook',
      name: 'useCostBudget',
      api_spec: 'openapi.yaml#/components/schemas/CostBudget',
      output_dir: '/opt/spaceos/datahaven-web/client/src/hooks/'
    });

    expect(result.success).toBe(true);
    expect(result.files_created[0]).toContain('CostBudget'); // Type ref in generated file
  });
});
```

---

### 5. Domain Pattern Matcher

**File:** `src/__tests__/unit/domainPatternMatcher.test.ts`

```typescript
import { matchDomainPattern } from '../../pipeline/domainPatternMatcher';
import * as vectorStore from '../../vectorStore';

describe('Domain Pattern Matcher', () => {
  test('known pattern returns high confidence', async () => {
    jest.spyOn(vectorStore, 'searchKnowledge').mockResolvedValue([
      { id: '1', content: 'Cost Breakdown Widget pattern', score: 0.92 }
    ]);

    const result = await matchDomainPattern({
      description: 'Track cost breakdown by project phase',
      domain: 'kontrolling'
    });

    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.pattern).toContain('Cost Breakdown');
  });

  test('unknown pattern returns low confidence', async () => {
    jest.spyOn(vectorStore, 'searchKnowledge').mockResolvedValue([
      { id: '1', content: 'Unrelated pattern', score: 0.3 }
    ]);

    const result = await matchDomainPattern({
      description: 'Alien technology integration',
      domain: 'crm'
    });

    expect(result.confidence).toBeLessThan(0.5);
    expect(result.recommendations).toContain('Low confidence - consider manual review');
  });

  test('empty query returns error', async () => {
    const result = await matchDomainPattern({
      description: '',
      domain: 'kontrolling'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Description cannot be empty');
  });

  test('cache hit improves response time', async () => {
    jest.spyOn(vectorStore, 'searchKnowledge').mockResolvedValue([
      { id: '1', content: 'Cost pattern', score: 0.85 }
    ]);

    // First call (cache miss)
    await matchDomainPattern({
      description: 'cost breakdown',
      domain: 'kontrolling'
    });

    // Second call (cache hit)
    const start = Date.now();
    const result = await matchDomainPattern({
      description: 'cost breakdown',
      domain: 'kontrolling'
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50); // Cache hit <50ms
    expect(vectorStore.searchKnowledge).toHaveBeenCalledTimes(1); // Only first call
  });

  test('ChromaDB connection failure returns error', async () => {
    jest.spyOn(vectorStore, 'searchKnowledge').mockRejectedValue(new Error('Connection refused'));

    const result = await matchDomainPattern({
      description: 'cost breakdown',
      domain: 'kontrolling'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Vector search failed');
  });
});
```

---

## Integration Tests

### Scenario 1: Conductor Workflow

**File:** `src/__tests__/integration/conductorWorkflow.test.ts`

```typescript
describe('Conductor Session Workflow', () => {
  test('Conductor checks status → resolves dependencies → spawns workers', async () => {
    // Step 1: Conductor checks terminal status
    const status = await getTerminalStatusAggregate('summary');
    expect(status.summary.idle).toContain('backend');

    // Step 2: Conductor resolves epic dependencies
    const deps = await resolveDependencies('EPIC-CUTTING-Q3', true);
    expect(deps.readyTasks).toHaveLength(3);
    expect(deps.blockedTasks).toHaveLength(0);

    // Step 3: Conductor transfers context to backend
    const transfer = await transferSessionContext({
      from_terminal: 'conductor',
      to_terminal: 'backend',
      context_type: 'code_audit',
      include_files: ['audit-findings.md']
    });
    expect(transfer.success).toBe(true);
    expect(transfer.message_id).toMatch(/MSG-BACKEND-\d+/);

    // Verify: Backend inbox created
    const inboxFile = await fs.readFile(transfer.inbox_file, 'utf-8');
    expect(inboxFile).toContain('code_audit');
  });
});
```

### Scenario 2: Frontend Component Development

**File:** `src/__tests__/integration/frontendComponentDev.test.ts`

```typescript
describe('Frontend Component Development Workflow', () => {
  test('Frontend searches pattern → scaffolds component', async () => {
    // Step 1: Frontend searches for pattern
    const pattern = await matchDomainPattern({
      description: 'EAC calculation widget with variance analysis',
      domain: 'kontrolling'
    });
    expect(pattern.confidence).toBeGreaterThan(0.8);
    expect(pattern.recommendations).toContain('Use EACCalculationWidget pattern');

    // Step 2: Frontend scaffolds component based on pattern
    const scaffold = await scaffoldComponent({
      component_type: 'react_component',
      name: 'EACCalculationWidget',
      output_dir: '/opt/spaceos/datahaven-web/client/src/components/kontrolling/'
    });
    expect(scaffold.success).toBe(true);
    expect(scaffold.files_created).toHaveLength(3); // .tsx, .module.css, test

    // Verify: Generated files exist
    for (const file of scaffold.files_created) {
      await expect(fs.access(file)).resolves.not.toThrow();
    }
  });
});
```

---

## Performance Benchmarks

**File:** `src/__tests__/benchmark/phase1-tools.bench.ts`

```typescript
import { performance } from 'perf_hooks';

describe('Phase 1 Tools Performance Benchmarks', () => {
  const RESPONSE_TIME_TARGET = 200; // ms

  test('Terminal Status Aggregator <200ms', async () => {
    const start = performance.now();
    await getTerminalStatusAggregate('summary');
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(RESPONSE_TIME_TARGET);
    console.log(`Terminal Status Aggregator: ${elapsed.toFixed(2)}ms`);
  });

  test('Dependency Resolver <200ms', async () => {
    const start = performance.now();
    await resolveDependencies('EPIC-CUTTING-Q3', true);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(RESPONSE_TIME_TARGET);
    console.log(`Dependency Resolver: ${elapsed.toFixed(2)}ms`);
  });

  test('Session Context Transfer <200ms', async () => {
    const start = performance.now();
    await transferSessionContext({
      from_terminal: 'conductor',
      to_terminal: 'backend',
      context_type: 'code_audit'
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(RESPONSE_TIME_TARGET);
    console.log(`Session Context Transfer: ${elapsed.toFixed(2)}ms`);
  });

  test('Component Scaffold <200ms', async () => {
    const start = performance.now();
    await scaffoldComponent({
      component_type: 'react_hook',
      name: 'useBenchmarkHook',
      output_dir: '/tmp/benchmark/'
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(RESPONSE_TIME_TARGET);
    console.log(`Component Scaffold: ${elapsed.toFixed(2)}ms`);
  });

  test('Domain Pattern Matcher <200ms (cached)', async () => {
    // Warm up cache
    await matchDomainPattern({
      description: 'cost breakdown',
      domain: 'kontrolling'
    });

    // Benchmark cached request
    const start = performance.now();
    await matchDomainPattern({
      description: 'cost breakdown',
      domain: 'kontrolling'
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(RESPONSE_TIME_TARGET);
    console.log(`Domain Pattern Matcher (cached): ${elapsed.toFixed(2)}ms`);
  });
});
```

---

## Test Execution

### Run All Tests
```bash
npm test src/__tests__/unit/
npm test src/__tests__/integration/
npm test src/__tests__/benchmark/
```

### Run Specific Tool Tests
```bash
npm test terminalStatusAggregator.test.ts
npm test dependencyResolver.test.ts
npm test sessionContextTransfer.test.ts
npm test componentScaffold.test.ts
npm test domainPatternMatcher.test.ts
```

### Coverage Report
```bash
npm run test:coverage
```

**Target:** >90% code coverage for all 5 tools

---

## Acceptance Criteria

- [ ] All 25 unit tests pass
- [ ] All 6 integration tests pass
- [ ] All 5 benchmark tests <200ms
- [ ] Code coverage >90%
- [ ] No critical security vulnerabilities (npm audit)
- [ ] All tools documented in `docs/knowledge/patterns/MCP_TOOLS_CATALOGUE.md`

---

## References

- Architecture Review: `docs/architecture/decisions/PHASE1_MCP_TOOLS_REVIEW.md`
- Backend Task: `terminals/backend/inbox/2026-07-07_173_phase1-mcp-tools-implementation.md`
- MCP Pattern Reference: `src/contextPersistence.ts`
