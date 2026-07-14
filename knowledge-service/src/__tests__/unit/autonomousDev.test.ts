/**
 * autonomousDev.test.ts — Unit tests for autonomous development token optimization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mock dependencies before importing module
vi.mock('../../pipeline/common', () => ({
  SESSIONS: {},
  SESSION_WORKDIR: {},
  hasSession: vi.fn(() => Promise.resolve(false)),
  killSession: vi.fn(() => Promise.resolve()),
  newSession: vi.fn(() => Promise.resolve()),
  sendKeys: vi.fn(() => Promise.resolve()),
  sendEnter: vi.fn(() => Promise.resolve()),
  log: vi.fn(() => Promise.resolve()),
  telegram: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../pipeline/paneState', () => ({
  detectPaneState: vi.fn(() => Promise.resolve({ state: 'idle' })),
}));

// Import after mocking
import {
  runAutonomousCycle,
  determinePromptContext,
  estimateTokens,
  type AutonomousDevConfig
} from '../../pipeline/autonomousDev';

describe('Autonomous Dev Token Optimization', () => {
  // Prompts are in knowledge-service/prompts/ (project root)
  const TEST_PROMPTS_DIR = path.join(process.cwd(), 'prompts');

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup if needed
  });

  describe('Template Files', () => {
    it('should have base template file', async () => {
      const filePath = path.join(TEST_PROMPTS_DIR, 'autonomous-dev-base.txt');
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should have architect template file', async () => {
      const filePath = path.join(TEST_PROMPTS_DIR, 'autonomous-dev-architect.txt');
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should have MCP template file', async () => {
      const filePath = path.join(TEST_PROMPTS_DIR, 'autonomous-dev-mcp.txt');
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should have queue template file', async () => {
      const filePath = path.join(TEST_PROMPTS_DIR, 'autonomous-dev-queue.txt');
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should read base template correctly', async () => {
      const filePath = path.join(TEST_PROMPTS_DIR, 'autonomous-dev-base.txt');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('Cycle #');
      expect(content).toContain('{{cycleId}}');
      expect(content).toContain('{{focusFile}}');
      expect(content).toContain('MCP tools');
    });
  });

  describe('Token Estimation', () => {
    it('should estimate tokens roughly as 1 token per 4 chars', () => {
      // Simple heuristic check
      const text = 'Hello world this is a test'; // ~7 tokens
      const estimate = estimateTokens(text);

      expect(estimate).toBeGreaterThan(5);
      expect(estimate).toBeLessThan(10);
    });

    it('should estimate base template to be under 200 tokens', async () => {
      const filePath = path.join(TEST_PROMPTS_DIR, 'autonomous-dev-base.txt');
      const content = await fs.readFile(filePath, 'utf-8');
      const estimate = Math.ceil(content.length / 4);

      expect(estimate).toBeLessThan(200); // Base should be compact
    });
  });

  describe('Cycle Execution with Token Tracking', () => {
    it('should track token count in cycle result', async () => {
      const config: AutonomousDevConfig = {
        enabled: true,
        intervalMinutes: 20,
        focusFile: '/test/file.md',
        coldStart: true,
        skipIfBusy: false,
        maxConcurrentTasks: 2,
        conductorModel: 'sonnet',
        tokenBudget: 300,
        includeArchitectGuidance: 'never',
        includeMcpExamples: 'never',
        includeQueueGuidance: 'never',
        promptTemplate: 'base',
      };

      const result = await runAutonomousCycle(config);

      expect(result).toHaveProperty('promptTokenCount');
      expect(result).toHaveProperty('tokenBudget');
      expect(result).toHaveProperty('templatesUsed');

      if (result.promptTokenCount) {
        expect(result.promptTokenCount).toBeGreaterThan(0);
      }
    });

    it('should use only base template when all extras are disabled', async () => {
      const config: AutonomousDevConfig = {
        enabled: true,
        intervalMinutes: 20,
        focusFile: '/test/file.md',
        coldStart: true,
        skipIfBusy: false,
        maxConcurrentTasks: 2,
        conductorModel: 'sonnet',
        tokenBudget: 300,
        includeArchitectGuidance: 'never',
        includeMcpExamples: 'never',
        includeQueueGuidance: 'never',
        promptTemplate: 'base',
      };

      const result = await runAutonomousCycle(config);

      expect(result.templatesUsed).toEqual(['autonomous-dev-base.txt']);
    });

    it('should include architect template when set to always', async () => {
      const config: AutonomousDevConfig = {
        enabled: true,
        intervalMinutes: 20,
        focusFile: '/test/file.md',
        coldStart: true,
        skipIfBusy: false,
        maxConcurrentTasks: 2,
        conductorModel: 'sonnet',
        tokenBudget: 300,
        includeArchitectGuidance: 'always',
        includeMcpExamples: 'never',
        includeQueueGuidance: 'never',
        promptTemplate: 'base',
      };

      const result = await runAutonomousCycle(config);

      expect(result.templatesUsed).toContain('autonomous-dev-base.txt');
      expect(result.templatesUsed).toContain('autonomous-dev-architect.txt');
    });

    it('should include MCP examples only for first 3 cycles', () => {
      const config: AutonomousDevConfig = {
        enabled: true,
        intervalMinutes: 20,
        focusFile: '/test/file.md',
        coldStart: true,
        skipIfBusy: false,
        maxConcurrentTasks: 2,
        conductorModel: 'sonnet',
        tokenBudget: 300,
        includeArchitectGuidance: 'never',
        includeMcpExamples: 'first-3',
        includeQueueGuidance: 'never',
        promptTemplate: 'base',
      };

      // Test directly with determinePromptContext (faster, no cold start)
      const context1 = determinePromptContext(config, 1);
      expect(context1.templatesUsed).toContain('autonomous-dev-mcp.txt');

      const context2 = determinePromptContext(config, 2);
      expect(context2.templatesUsed).toContain('autonomous-dev-mcp.txt');

      const context3 = determinePromptContext(config, 3);
      expect(context3.templatesUsed).toContain('autonomous-dev-mcp.txt');

      const context4 = determinePromptContext(config, 4);
      expect(context4.templatesUsed).not.toContain('autonomous-dev-mcp.txt');
    });
  });

  describe('Token Budget Validation', () => {
    it('should respect token budget configuration', async () => {
      const config: AutonomousDevConfig = {
        enabled: true,
        intervalMinutes: 20,
        focusFile: '/test/file.md',
        coldStart: true,
        skipIfBusy: false,
        maxConcurrentTasks: 2,
        conductorModel: 'sonnet',
        tokenBudget: 100, // Very low budget
        includeArchitectGuidance: 'never',
        includeMcpExamples: 'never',
        includeQueueGuidance: 'never',
        promptTemplate: 'base',
      };

      const result = await runAutonomousCycle(config);

      // Should still generate prompt (base template)
      expect(result.promptTokenCount).toBeDefined();
      expect(result.tokenBudget).toBe(100);
    });
  });

  describe('Auto Context Detection', () => {
    it('should include architect guidance on every 5th cycle when auto', () => {
      const config: AutonomousDevConfig = {
        enabled: true,
        intervalMinutes: 20,
        focusFile: '/test/file.md',
        coldStart: true,
        skipIfBusy: false,
        maxConcurrentTasks: 2,
        conductorModel: 'sonnet',
        tokenBudget: 300,
        includeArchitectGuidance: 'auto',
        includeMcpExamples: 'never',
        includeQueueGuidance: 'never',
        promptTemplate: 'base',
      };

      // Test directly with determinePromptContext (faster, no cold start)
      // Cycle 1-4: no architect
      for (let i = 1; i <= 4; i++) {
        const context = determinePromptContext(config, i);
        expect(context.templatesUsed).not.toContain('autonomous-dev-architect.txt');
      }

      // Cycle 5: should have architect
      const context5 = determinePromptContext(config, 5);
      expect(context5.templatesUsed).toContain('autonomous-dev-architect.txt');

      // Cycle 6-9: no architect
      for (let i = 6; i <= 9; i++) {
        const context = determinePromptContext(config, i);
        expect(context.templatesUsed).not.toContain('autonomous-dev-architect.txt');
      }

      // Cycle 10: should have architect
      const context10 = determinePromptContext(config, 10);
      expect(context10.templatesUsed).toContain('autonomous-dev-architect.txt');
    });

    it('should include queue guidance on every 10th cycle when auto', () => {
      const config: AutonomousDevConfig = {
        enabled: true,
        intervalMinutes: 20,
        focusFile: '/test/file.md',
        coldStart: true,
        skipIfBusy: false,
        maxConcurrentTasks: 2,
        conductorModel: 'sonnet',
        tokenBudget: 300,
        includeArchitectGuidance: 'never',
        includeMcpExamples: 'never',
        includeQueueGuidance: 'auto',
        promptTemplate: 'base',
      };

      // Cycle 1-9: no queue guidance
      for (let i = 1; i <= 9; i++) {
        const context = determinePromptContext(config, i);
        expect(context.templatesUsed).not.toContain('autonomous-dev-queue.txt');
      }

      // Cycle 10: should have queue guidance
      const context10 = determinePromptContext(config, 10);
      expect(context10.templatesUsed).toContain('autonomous-dev-queue.txt');
    });
  });
});
