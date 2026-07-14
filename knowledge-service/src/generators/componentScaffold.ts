/**
 * Component Scaffold Generator
 *
 * Generates React hooks, components, and API clients.
 * ROI: 2-3 hours/week
 * Response time: <500ms
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export type ComponentType = 'react_hook' | 'react_component' | 'api_client';

export interface ScaffoldParams {
  componentType: ComponentType;
  name: string;
  apiSpec?: string;
  outputDir: string;
  description?: string;
}

export interface ScaffoldResult {
  success: boolean;
  filesCreated?: string[];
  nextSteps?: string[];
  error?: string;
}

async function scaffoldReactHook(name: string, description: string, outputDir: string): Promise<ScaffoldResult> {
  try {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const hookFile = `${outputDir}/${name}.ts`;
    const testFile = `${outputDir}/__tests__/${name}.test.ts`;

    const hookCode = `import { useState, useCallback, useEffect } from 'react';

/**
 * ${name} Hook
 * ${description || 'Custom React hook'}
 */
export function ${name}() {
  const [state, setState] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // TODO: Implement data fetching
      setState(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { state, loading, error, refetch: fetchData };
}
`;

    const testCode = `import { renderHook, act } from '@testing-library/react';
import { ${name} } from '../${name}';

describe('${name}', () => {
  it('should initialize with loading state', () => {
    const { result } = renderHook(() => ${name}());
    expect(result.current.loading).toBe(true);
  });
});
`;

    writeFileSync(hookFile, hookCode);
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, testCode);

    return {
      success: true,
      filesCreated: [hookFile, testFile],
      nextSteps: ['Review generated hook structure', 'Implement API call in fetchData()', `Run tests: npm test ${name}`, 'Export from hooks/index.ts'],
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function scaffoldReactComponent(name: string, description: string, outputDir: string): Promise<ScaffoldResult> {
  try {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const componentFile = `${outputDir}/${name}.tsx`;
    const moduleFile = `${outputDir}/${name}.module.css`;
    const testFile = `${outputDir}/__tests__/${name}.test.tsx`;

    const componentCode = `import React from 'react';
import styles from './${name}.module.css';

/**
 * ${name} Component
 * ${description || 'React component'}
 */
export interface ${name}Props {
  // TODO: Define props
}

export const ${name}: React.FC<${name}Props> = (props) => {
  return (
    <div className={styles.container}>
      <h2>${name}</h2>
      {/* TODO: Add component content */}
    </div>
  );
};

${name}.displayName = '${name}';
`;

    const cssCode = `.container {
  padding: 1rem;
  border-radius: 8px;
  background-color: var(--color-background);
}
`;

    const testCode = `import React from 'react';
import { render, screen } from '@testing-library/react';
import { ${name} } from '../${name}';

describe('${name}', () => {
  it('should render', () => {
    render(<${name} />);
    expect(screen.getByText('${name}')).toBeInTheDocument();
  });
});
`;

    writeFileSync(componentFile, componentCode);
    writeFileSync(moduleFile, cssCode);
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, testCode);

    return {
      success: true,
      filesCreated: [componentFile, moduleFile, testFile],
      nextSteps: ['Review generated component structure', 'Add component logic and UI', `Run tests: npm test ${name}`, 'Import and use in parent component'],
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function scaffoldApiClient(name: string, description: string, outputDir: string): Promise<ScaffoldResult> {
  try {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const clientFile = `${outputDir}/${name}.ts`;

    const clientCode = `import axios, { AxiosInstance } from 'axios';

/**
 * ${name} API Client
 * ${description || 'API client'}
 */
export class ${name} {
  private client: AxiosInstance;

  constructor(baseURL: string = process.env.REACT_APP_API_URL) {
    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // TODO: Add API methods
  // Example:
  // async fetchData(id: string) {
  //   const { data } = await this.client.get(\`/endpoint/\${id}\`);
  //   return data;
  // }
}

export const ${name.toLowerCase()}Client = new ${name}();
`;

    writeFileSync(clientFile, clientCode);

    return {
      success: true,
      filesCreated: [clientFile],
      nextSteps: ['Review generated client structure', 'Add API endpoint methods', 'Export from api/index.ts', 'Use in components/hooks'],
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function scaffoldComponent(params: ScaffoldParams): Promise<ScaffoldResult> {
  if (!params.name || !params.outputDir) {
    return { success: false, error: 'name and outputDir are required' };
  }

  switch (params.componentType) {
    case 'react_hook':
      return scaffoldReactHook(params.name, params.description || '', params.outputDir);
    case 'react_component':
      return scaffoldReactComponent(params.name, params.description || '', params.outputDir);
    case 'api_client':
      return scaffoldApiClient(params.name, params.description || '', params.outputDir);
    default:
      return { success: false, error: `Unknown component type: ${params.componentType}` };
  }
}

export function getScaffoldTemplates(): Record<string, string> {
  return {
    react_hook: `export function useMyHook() {
  const [state, setState] = useState(null);
  return { state };
}`,
    react_component: `export const MyComponent = (props) => {
  return <div>{props.children}</div>;
};`,
    api_client: `export class ApiClient {
  async get(endpoint: string) {
    return fetch(endpoint).then(r => r.json());
  }
}`,
  };
}
