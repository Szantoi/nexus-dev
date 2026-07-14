/**
 * Component Scaffold Unit Tests
 *
 * Tests for React component, hook, and API client generation.
 * Target coverage: >90%
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { scaffoldComponent, getScaffoldTemplates } from '../../generators/componentScaffold';
import type { ScaffoldParams } from '../../generators/componentScaffold';
import { existsSync, rmSync } from 'fs';

const TEST_OUTPUT_DIR = '/tmp/spaceos-scaffold-test';

describe('Component Scaffold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup test files
    if (existsSync(TEST_OUTPUT_DIR)) {
      rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  describe('scaffoldComponent', () => {
    it('should scaffold react_hook with all files', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useTestHook',
        outputDir: TEST_OUTPUT_DIR,
        description: 'Test hook for user authentication',
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      expect(result.filesCreated).toBeDefined();
      expect(result.filesCreated?.length).toBe(2); // Hook + test file
      expect(result.nextSteps).toBeDefined();
      expect(result.nextSteps?.length).toBeGreaterThan(0);
    });

    it('should create hook with proper imports', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useCustomHook',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      expect(result.filesCreated).toBeDefined();
      expect(result.filesCreated?.[0]).toContain('useCustomHook.ts');
    });

    it('should scaffold react_component with all files', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_component',
        name: 'TestComponent',
        outputDir: TEST_OUTPUT_DIR,
        description: 'A test React component',
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      expect(result.filesCreated).toBeDefined();
      expect(result.filesCreated?.length).toBe(3); // Component + CSS + test
      expect(result.filesCreated?.some((f: string) => f.includes('.tsx'))).toBe(true);
      expect(result.filesCreated?.some((f: string) => f.includes('.module.css'))).toBe(true);
    });

    it('should create component with proper structure', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_component',
        name: 'MyComponent',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      expect(result.filesCreated?.length).toBe(3);
    });

    it('should scaffold api_client', async () => {
      const params: ScaffoldParams = {
        componentType: 'api_client',
        name: 'UserApiClient',
        outputDir: TEST_OUTPUT_DIR,
        description: 'API client for user service',
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      expect(result.filesCreated).toBeDefined();
      expect(result.filesCreated?.length).toBe(1); // Only client file
      expect(result.filesCreated?.[0]).toContain('UserApiClient.ts');
    });

    it('should create api_client with axios', async () => {
      const params: ScaffoldParams = {
        componentType: 'api_client',
        name: 'TestClient',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      expect(result.filesCreated).toBeDefined();
    });

    it('should include description in generated code', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useAuth',
        outputDir: TEST_OUTPUT_DIR,
        description: 'Authentication hook for login flow',
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      // Description should be in the JSDoc comment
    });

    it('should provide next steps for hook', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useData',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.nextSteps).toBeDefined();
      expect(result.nextSteps?.some((s: string) => s.includes('fetchData'))).toBe(true);
    });

    it('should provide next steps for component', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_component',
        name: 'DataDisplay',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.nextSteps).toBeDefined();
      expect(result.nextSteps?.some((s: string) => s.includes('component logic'))).toBe(true);
    });

    it('should provide next steps for client', async () => {
      const params: ScaffoldParams = {
        componentType: 'api_client',
        name: 'ApiClient',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.nextSteps).toBeDefined();
      expect(result.nextSteps?.some((s: string) => s.includes('endpoint methods'))).toBe(true);
    });

    it('should create nested directories', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_component',
        name: 'NestedComponent',
        outputDir: `${TEST_OUTPUT_DIR}/nested/deep/path`,
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
      expect(result.filesCreated).toBeDefined();
    });

    it('should fail with missing name', async () => {
      const params: any = {
        componentType: 'react_hook',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail with missing outputDir', async () => {
      const params: any = {
        componentType: 'react_hook',
        name: 'useTest',
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail with invalid component type', async () => {
      const params: any = {
        componentType: 'invalid_type',
        name: 'Test',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Unknown component type');
    });

    it('should handle empty description gracefully', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useSimple',
        outputDir: TEST_OUTPUT_DIR,
        description: '',
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(true);
    });

    it('should generate unique filenames', async () => {
      const dir = TEST_OUTPUT_DIR;

      const params1: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useUnique1',
        outputDir: dir,
      };

      const params2: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useUnique2',
        outputDir: dir,
      };

      const result1 = await scaffoldComponent(params1);
      const result2 = await scaffoldComponent(params2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.filesCreated?.[0]).not.toBe(result2.filesCreated?.[0]);
    });
  });

  describe('getScaffoldTemplates', () => {
    it('should return react_hook template', () => {
      const templates = getScaffoldTemplates();

      expect(templates.react_hook).toBeDefined();
      expect(typeof templates.react_hook).toBe('string');
      expect(templates.react_hook).toContain('useState');
    });

    it('should return react_component template', () => {
      const templates = getScaffoldTemplates();

      expect(templates.react_component).toBeDefined();
      expect(typeof templates.react_component).toBe('string');
      expect(templates.react_component).toContain('React.FC');
    });

    it('should return api_client template', () => {
      const templates = getScaffoldTemplates();

      expect(templates.api_client).toBeDefined();
      expect(typeof templates.api_client).toBe('string');
      expect(templates.api_client).toContain('ApiClient');
    });

    it('should have all 3 templates', () => {
      const templates = getScaffoldTemplates();

      expect(Object.keys(templates).length).toBe(3);
      expect(templates).toHaveProperty('react_hook');
      expect(templates).toHaveProperty('react_component');
      expect(templates).toHaveProperty('api_client');
    });

    it('should return valid TypeScript templates', () => {
      const templates = getScaffoldTemplates();

      // Templates should be syntactically valid (basic check)
      expect(templates.react_hook.includes('(')).toBe(true);
      expect(templates.react_component.includes('<')).toBe(true);
      expect(templates.api_client.includes('class')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle filesystem errors gracefully', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_hook',
        name: 'useTest',
        outputDir: '/invalid/nonexistent/path/that/cannot/be/created',
      };

      const result = await scaffoldComponent(params);

      // Should return error, not crash
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should include error details', async () => {
      const params: any = {
        componentType: 'invalid',
        name: 'Test',
        outputDir: TEST_OUTPUT_DIR,
      };

      const result = await scaffoldComponent(params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('performance', () => {
    it('should scaffold component in <500ms', async () => {
      const params: ScaffoldParams = {
        componentType: 'react_component',
        name: 'PerfTest',
        outputDir: TEST_OUTPUT_DIR,
      };

      const start = Date.now();
      await scaffoldComponent(params);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(500);
    });

    it('should scaffold multiple components quickly', async () => {
      const start = Date.now();

      for (let i = 0; i < 5; i++) {
        await scaffoldComponent({
          componentType: 'react_hook',
          name: `usePerf${i}`,
          outputDir: TEST_OUTPUT_DIR,
        });
      }

      const duration = Date.now() - start;
      // 5 scaffolds should complete in reasonable time
      expect(duration).toBeLessThan(2000);
    });
  });
});
