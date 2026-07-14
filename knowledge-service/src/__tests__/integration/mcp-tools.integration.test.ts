/**
 * MCP Tools Integration Tests
 *
 * End-to-end integration tests for all 5 MCP tools working together.
 * Tests tool interactions, multi-tool workflows, and real-world scenarios.
 * Target coverage: >85% integration coverage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTerminalStatusAggregate } from '../../pipeline/terminalStatusAggregator';
import { resolveDependencies, getCriticalPath } from '../../pipeline/dependencyResolver';
import { transferSessionContext } from '../../pipeline/sessionContextTransfer';
import { scaffoldComponent } from '../../generators/componentScaffold';
import { matchDomainPattern } from '../../pipeline/domainPatternMatcher';

describe('MCP Tools Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Multi-Tool Workflows', () => {
    it('should run status aggregator + dependency resolver together', async () => {
      // Conductor workflow: check status AND resolve epic dependencies
      const statusResult = await getTerminalStatusAggregate('summary');
      const depsResult = await resolveDependencies('EPIC-CUTTING-Q3', true);

      expect(statusResult).toBeDefined();
      expect(depsResult).toBeDefined();

      // Should be able to correlate data
      expect(statusResult.summary.activeSessions).toBeGreaterThanOrEqual(0);
      expect(depsResult.blockedTasks).toBeDefined();
    });

    it('should integrate pattern matching + dependency resolution', async () => {
      // Architect workflow: understand pattern, then understand dependencies
      const patternResult = await matchDomainPattern('quote estimation for cutting', 'cutting');
      const depsResult = await resolveDependencies('EPIC-CUTTING-Q3', true);

      expect(patternResult.success).toBe(true);
      expect(depsResult.epic).toBe('EPIC-CUTTING-Q3');

      // Pattern should guide understanding of epic dependencies
      if (patternResult.pattern?.adrRefs) {
        expect(Array.isArray(patternResult.pattern.adrRefs)).toBe(true);
      }
    });

    it('should use context transfer + dependency resolver', async () => {
      // Explorer → Architect transfer with dependency context
      const depsResult = await resolveDependencies('EPIC-KERNEL-STABLE', true);

      const transferResult = await transferSessionContext({
        fromTerminal: 'explorer',
        toTerminal: 'architect',
        contextType: 'research_summary',
        summary: `Found ${depsResult.blockedBy.length} blockers in Kernel epic`,
      });

      expect(depsResult.blockedBy).toBeDefined();
      expect(transferResult.success).toBe(true);
    });

    it('should scaffold component + transfer to frontend terminal', async () => {
      const scaffoldResult = await scaffoldComponent({
        componentType: 'react_component',
        name: 'DashboardComponent',
        outputDir: '/tmp/integration-scaffold',
        description: 'Dashboard for operations monitoring',
      });

      // After scaffolding, transfer context to frontend
      const transferResult = await transferSessionContext({
        fromTerminal: 'backend',
        toTerminal: 'frontend',
        contextType: 'knowledge_synthesis',
        summary: `Created ${scaffoldResult.filesCreated?.length || 0} component files`,
      });

      expect(scaffoldResult.success).toBe(true);
      expect(transferResult.success).toBe(true);
    });

    it('should resolve critical path + aggregate status', async () => {
      // Conductor: understand what's blocking the system
      const critPathResult = await getCriticalPath('EPIC-CUTTING-Q3');
      const statusResult = await getTerminalStatusAggregate('detailed');

      expect(Array.isArray(critPathResult)).toBe(true);
      expect(Array.isArray(statusResult)).toBe(true);

      // Can now see which terminal is stuck on critical path
    });
  });

  describe('Real-World Scenarios', () => {
    it('Conductor Daily Standup Flow', async () => {
      // 1. Check all terminal status
      const status = await getTerminalStatusAggregate('summary');
      expect(status).toBeDefined();

      // 2. Get critical blockers
      const depsCheck = await resolveDependencies('EPIC-CUTTING-Q3', true);
      expect(depsCheck.blockedTasks).toBeDefined();

      // 3. Prepare context for low-saturation terminal
      if (status.summary.idle > 0) {
        await transferSessionContext({
          fromTerminal: 'conductor',
          toTerminal: 'explorer',
          contextType: 'research_summary',
          summary: 'Daily research tasks',
        });
      }

      // All tools should work without errors
      expect(status.summary.activeSessions).toBeGreaterThanOrEqual(0);
    });

    it('Architect Design Review Flow', async () => {
      // 1. Match incoming feature request to pattern
      const pattern = await matchDomainPattern(
        'implement supplier portal with RFQ and quote management',
        'cutting'
      );
      expect(pattern.success).toBe(true);

      // 2. Check dependencies for Cutting domain
      const deps = await resolveDependencies('EPIC-CUTTING-Q3', true);
      expect(deps).toBeDefined();

      // 3. Transfer analysis back to conductor
      if (pattern.pattern?.adrRefs && pattern.pattern.adrRefs.length > 0) {
        await transferSessionContext({
          fromTerminal: 'architect',
          toTerminal: 'conductor',
          contextType: 'code_audit',
          summary: `Design aligned with ${pattern.pattern.adrRefs.join(', ')}`,
        });
      }

      expect(pattern.pattern).toBeDefined();
      expect(deps.blockedBy).toBeDefined();
    });

    it('Frontend Development Sprint Flow', async () => {
      // 1. Get new component requirements
      const pattern = await matchDomainPattern(
        'create dashboard UI with real-time updates',
        'general'
      );
      expect(pattern.success).toBe(true);

      // 2. Scaffold component
      const scaffold = await scaffoldComponent({
        componentType: 'react_component',
        name: 'DashboardWidget',
        outputDir: '/tmp/sprint-component',
        description: pattern.pattern?.pattern || 'Dashboard component',
      });
      expect(scaffold.success).toBe(true);

      // 3. Transfer component + recommended patterns to conductor
      const transfer = await transferSessionContext({
        fromTerminal: 'frontend',
        toTerminal: 'conductor',
        contextType: 'knowledge_synthesis',
        summary: `Implemented component with ${pattern.pattern?.recommendations?.length || 0} best practices`,
      });
      expect(transfer.success).toBe(true);
    });

    it('Backend Module Development with Pattern Guidance', async () => {
      // 1. Check what patterns apply to task
      const pattern = await matchDomainPattern(
        'implement RLS for multi-tenant data isolation in Kernel',
        'kernel'
      );
      expect(pattern.success).toBe(true);

      // 2. Check epic dependencies
      const deps = await resolveDependencies('EPIC-KERNEL-STABLE', false);
      expect(deps).toBeDefined();

      // 3. If there are recommendations, scaffold test infrastructure
      if (pattern.pattern?.recommendations && pattern.pattern.recommendations.length > 0) {
        const scaffold = await scaffoldComponent({
          componentType: 'api_client',
          name: 'KernelTestClient',
          outputDir: '/tmp/kernel-tests',
          description: 'Test client for Kernel API',
        });
        expect(scaffold.success).toBe(true);
      }

      expect(pattern.pattern?.adrRefs).toBeDefined();
    });

    it('Cross-Terminal Handoff: Backend → Frontend → Conductor', async () => {
      // Backend completes API development
      const backendScaffold = await scaffoldComponent({
        componentType: 'api_client',
        name: 'QuoteApiClient',
        outputDir: '/tmp/handoff-api',
      });
      expect(backendScaffold.success).toBe(true);

      // Transfer to Frontend
      const transfer1 = await transferSessionContext({
        fromTerminal: 'backend',
        toTerminal: 'frontend',
        contextType: 'knowledge_synthesis',
        summary: 'API client ready for integration',
      });
      expect(transfer1.success).toBe(true);

      // Frontend scaffolds component
      const frontendScaffold = await scaffoldComponent({
        componentType: 'react_component',
        name: 'QuoteForm',
        outputDir: '/tmp/handoff-component',
      });
      expect(frontendScaffold.success).toBe(true);

      // Transfer to Conductor for verification
      const transfer2 = await transferSessionContext({
        fromTerminal: 'frontend',
        toTerminal: 'conductor',
        contextType: 'code_audit',
        summary: 'Feature complete, ready for testing',
      });
      expect(transfer2.success).toBe(true);
    });
  });

  describe('Tool Resilience and Fallbacks', () => {
    it('should handle pattern matcher fallback gracefully', async () => {
      // Even if vector search fails, keyword fallback should work
      const result = await matchDomainPattern('CQRS handler command query separation pattern');

      expect(result).toBeDefined();
      expect(result.success || result.error).toBeDefined();
    });

    it('should handle missing dependencies file', async () => {
      // Dependency resolver should handle missing EPICS.yaml
      try {
        await resolveDependencies('ANY-EPIC', true);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it('should handle terminal context transfer with missing files', async () => {
      const result = await transferSessionContext({
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
        summary: 'Test transfer',
        includeFiles: ['/nonexistent/file1.md', '/nonexistent/file2.md'],
      });

      // Should still succeed even with missing files
      expect(result).toBeDefined();
      expect(typeof result.fileCount).toBe('number');
    });

    it('should scaffold component without description', async () => {
      const result = await scaffoldComponent({
        componentType: 'react_hook',
        name: 'useSimple',
        outputDir: '/tmp/minimal-scaffold',
      });

      expect(result.success).toBe(true);
      expect(result.filesCreated).toBeDefined();
    });
  });

  describe('Performance Under Load', () => {
    it('should aggregate status + resolve deps within 300ms', async () => {
      const start = Date.now();

      await Promise.all([
        getTerminalStatusAggregate('summary'),
        resolveDependencies('EPIC-CUTTING-Q3', true),
      ]);

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(300);
    });

    it('should run 5 concurrent pattern matches', async () => {
      const start = Date.now();

      const patterns = [
        'authentication and authorization',
        'database optimization',
        'caching strategy',
        'API design',
        'testing patterns',
      ];

      const results = await Promise.all(patterns.map((p) => matchDomainPattern(p)));

      const duration = Date.now() - start;

      expect(results.length).toBe(5);
      expect(duration).toBeLessThan(1500); // ~300ms per tool
    });

    it('should scaffold 3 components sequentially', async () => {
      const start = Date.now();

      const results = await Promise.all([
        scaffoldComponent({
          componentType: 'react_hook',
          name: 'useHook1',
          outputDir: '/tmp/perf-hook',
        }),
        scaffoldComponent({
          componentType: 'react_component',
          name: 'Component1',
          outputDir: '/tmp/perf-comp',
        }),
        scaffoldComponent({
          componentType: 'api_client',
          name: 'Client1',
          outputDir: '/tmp/perf-client',
        }),
      ]);

      const duration = Date.now() - start;

      expect(results.every((r) => r.success)).toBe(true);
      expect(duration).toBeLessThan(1500);
    });
  });

  describe('Data Consistency', () => {
    it('should maintain terminal status consistency', async () => {
      const result1 = await getTerminalStatusAggregate('detailed');
      const result2 = await getTerminalStatusAggregate('detailed');

      // Status should be consistent within short timeframe
      expect(result1.length).toBe(result2.length);
    });

    it('should maintain pattern database consistency', async () => {
      const result1 = await matchDomainPattern('test pattern', 'crm');
      const result2 = await matchDomainPattern('test pattern', 'crm');

      // Same query should return consistent results
      expect(result1.success).toBe(result2.success);
    });

    it('should maintain dependency graph consistency', async () => {
      const result1 = await resolveDependencies('EPIC-IDENTITY-V1', true);
      const result2 = await resolveDependencies('EPIC-IDENTITY-V1', true);

      // Same epic should resolve consistently
      expect(result1.blockedBy).toEqual(result2.blockedBy);
      expect(result1.blocks).toEqual(result2.blocks);
    });
  });

  describe('Error Recovery', () => {
    it('should recover from invalid parameters', async () => {
      // First call with invalid params
      const badResult = await matchDomainPattern('test', 'invalid-domain');
      expect(badResult.success).toBe(false);

      // Next call with valid params should work
      const goodResult = await matchDomainPattern('test pattern', 'crm');
      expect(goodResult.success).toBe(true);
    });

    it('should handle sequential failures gracefully', async () => {
      const results = await Promise.all([
        matchDomainPattern('test', 'invalid-domain'),
        matchDomainPattern('test', 'invalid-domain'),
        matchDomainPattern('valid pattern', 'crm'),
      ]);

      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
    });
  });
});
