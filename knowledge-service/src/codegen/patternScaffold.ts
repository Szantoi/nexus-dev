/**
 * patternScaffold.ts - Pattern-Based Component Scaffolding
 * Part of MSG-NEXUS-002: Frontend MCP Tools Implementation
 *
 * Generates components from documented UI patterns.
 * Patterns source: docs/knowledge/patterns/DATAHAVEN_UI_PATTERNS.md
 */

import * as path from 'path';
import * as fs from 'fs/promises';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const DATAHAVEN_CLIENT = path.join(SPACEOS_ROOT, 'datahaven-web/client');
const PATTERNS_DOC = path.join(
  SPACEOS_ROOT,
  'docs/knowledge/patterns/DATAHAVEN_UI_PATTERNS.md'
);

// ─── Type Definitions ─────────────────────────────────────────────────────────

export interface ScaffoldFromPatternParams {
  pattern: string; // e.g., "dashboard-with-kpi-strip"
  module: string; // e.g., "safety", "ehs", "maintenance"
  entity: string; // e.g., "Audit", "Incident", "WorkOrder"
}

export interface ScaffoldFromPatternResult {
  success: boolean;
  filesCreated: string[];
  componentPath: string;
  error?: string;
}

interface PatternTemplate {
  name: string;
  description: string;
  files: Array<{
    path: string;
    content: string;
  }>;
}

// ─── Pattern Registry ─────────────────────────────────────────────────────────

/**
 * Registry of known UI patterns and their templates
 */
const PATTERN_REGISTRY: Record<string, PatternTemplate> = {
  'dashboard-with-kpi-strip': {
    name: 'Dashboard with KPI Strip',
    description: 'KPI card header + data grid (Grafana-style)',
    files: [
      {
        path: 'src/pages/{{Module}}{{Entity}}Page.tsx',
        content: `import React from 'react';
import { KPIStrip } from '../components/KPIStrip';
import { {{Entity}}Grid } from '../components/{{module}}/{{Entity}}Grid';
import { use{{Entity}}Metrics } from '../hooks/use{{Module}}';
import './{{Module}}{{Entity}}Page.module.css';

export function {{Module}}{{Entity}}Page() {
  const { metrics, loading } = use{{Entity}}Metrics();

  return (
    <div className="{{module}}-{{entity}}-page">
      <h1>{{Entity}} Dashboard</h1>

      {/* KPI Strip */}
      <KPIStrip
        metrics={[
          { label: 'Total {{Entity}}s', value: metrics?.total || 0 },
          { label: 'Active', value: metrics?.active || 0, status: 'healthy' },
          { label: 'Pending', value: metrics?.pending || 0, status: 'warning' },
          { label: 'Avg Time', value: metrics?.avgTime || '0m', trend: metrics?.trend },
        ]}
        loading={loading}
      />

      {/* Data Grid */}
      <{{Entity}}Grid />
    </div>
  );
}
`,
      },
      {
        path: 'src/pages/{{Module}}{{Entity}}Page.module.css',
        content: `.{{module}}-{{entity}}-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
  min-height: 100vh;
  background: var(--bg-primary);
}

.{{module}}-{{entity}}-page h1 {
  font-size: 2rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}
`,
      },
      {
        path: 'src/hooks/use{{Module}}.ts',
        content: `import { useQuery } from '@tanstack/react-query';
import { {{module}}Api } from '../api/generated/{{module}}';

export function use{{Entity}}Metrics() {
  const { data, isLoading } = useQuery({
    queryKey: ['{{module}}', '{{entity}}-metrics'],
    queryFn: () => {{module}}Api.get{{Entity}}Metrics(),
    refetchInterval: 3000, // Real-time updates every 3s
  });

  return {
    metrics: data,
    loading: isLoading,
  };
}
`,
      },
    ],
  },

  'data-table-with-actions': {
    name: 'Data Table with Row Actions',
    description: 'Sortable table + inline actions (Edit, Delete, View)',
    files: [
      {
        path: 'src/components/{{module}}/{{Entity}}Table.tsx',
        content: `import React from 'react';
import { DataDenseTable } from '../DataDenseTable';
import { use{{Entity}}List } from '../../hooks/use{{Module}}';
import type { {{Entity}} } from '../../api/generated/{{module}}';

export function {{Entity}}Table() {
  const { data, loading } = use{{Entity}}List();

  const columns = [
    { key: 'id', label: 'ID', sortable: true },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'status', label: 'Status', sortable: true },
    { key: 'createdAt', label: 'Created', sortable: true },
  ];

  const handleEdit = (row: {{Entity}}) => {
    console.log('Edit:', row);
    // TODO: Navigate to edit page
  };

  const handleDelete = (row: {{Entity}}) => {
    console.log('Delete:', row);
    // TODO: Confirm and delete
  };

  return (
    <DataDenseTable
      columns={columns}
      data={data || []}
      loading={loading}
      actions={[
        { label: 'Edit', onClick: handleEdit },
        { label: 'Delete', onClick: handleDelete, variant: 'danger' },
      ]}
    />
  );
}
`,
      },
    ],
  },

  'form-wizard-offline-first': {
    name: 'Multi-Step Form Wizard (Offline-First)',
    description: 'Step indicator + localStorage backup + validation',
    files: [
      {
        path: 'src/components/{{module}}/{{Entity}}FormWizard.tsx',
        content: `import React, { useState, useEffect } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import './{{Entity}}FormWizard.module.css';

interface {{Entity}}FormData {
  // TODO: Define your form fields
  name: string;
  description: string;
}

export function {{Entity}}FormWizard() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useLocalStorage<Partial<{{Entity}}FormData>>(
    '{{module}}-{{entity}}-draft',
    {}
  );

  const steps = [
    { id: 1, label: 'Basic Info' },
    { id: 2, label: 'Details' },
    { id: 3, label: 'Review' },
  ];

  const handleNext = () => setStep((s) => Math.min(s + 1, steps.length));
  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  const handleSubmit = () => {
    console.log('Submit:', formData);
    // TODO: Submit to API
  };

  return (
    <div className="{{entity}}-wizard">
      {/* Step Indicator */}
      <div className="wizard-steps">
        {steps.map((s) => (
          <div key={s.id} className={step >= s.id ? 'active' : ''}>
            {s.label}
          </div>
        ))}
      </div>

      {/* Step Content */}
      <div className="wizard-content">
        {step === 1 && <div>Step 1: Basic Info</div>}
        {step === 2 && <div>Step 2: Details</div>}
        {step === 3 && <div>Step 3: Review</div>}
      </div>

      {/* Navigation */}
      <div className="wizard-nav">
        {step > 1 && <button onClick={handleBack}>Back</button>}
        {step < steps.length && <button onClick={handleNext}>Next</button>}
        {step === steps.length && <button onClick={handleSubmit}>Submit</button>}
      </div>
    </div>
  );
}
`,
      },
    ],
  },
};

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Replace template placeholders with actual values
 */
function replaceTemplateVars(
  content: string,
  vars: Record<string, string>
): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, value);
  }
  return result;
}

/**
 * Capitalize first letter
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert to lowercase
 */
function lowercase(str: string): string {
  return str.toLowerCase();
}

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch {
    // Directory exists, ignore
  }
}

// ─── Main Tool: Scaffold From Pattern ─────────────────────────────────────────

/**
 * Scaffold component from a documented UI pattern
 *
 * Supported patterns:
 * - dashboard-with-kpi-strip
 * - data-table-with-actions
 * - form-wizard-offline-first
 */
export async function scaffoldFromPattern(
  params: ScaffoldFromPatternParams
): Promise<ScaffoldFromPatternResult> {
  const { pattern, module, entity } = params;

  const result: ScaffoldFromPatternResult = {
    success: false,
    filesCreated: [],
    componentPath: '',
  };

  // Validate pattern exists
  const patternTemplate = PATTERN_REGISTRY[pattern];
  if (!patternTemplate) {
    result.error = `Unknown pattern: ${pattern}. Available: ${Object.keys(PATTERN_REGISTRY).join(', ')}`;
    return result;
  }

  // Template variables
  const vars = {
    Module: capitalizeFirst(module),
    module: lowercase(module),
    Entity: capitalizeFirst(entity),
    entity: lowercase(entity),
  };

  // Generate files
  try {
    for (const file of patternTemplate.files) {
      // Replace vars in path
      const filePath = replaceTemplateVars(file.path, vars);
      const fullPath = path.join(DATAHAVEN_CLIENT, filePath);

      // Replace vars in content
      const content = replaceTemplateVars(file.content, vars);

      // Ensure directory exists
      const dir = path.dirname(fullPath);
      await ensureDir(dir);

      // Write file
      await fs.writeFile(fullPath, content, 'utf-8');

      result.filesCreated.push(filePath);
    }

    result.success = true;
    result.componentPath = path.dirname(result.filesCreated[0]);
  } catch (error) {
    result.error = `Failed to scaffold: ${error}`;
    result.success = false;
  }

  return result;
}

/**
 * List available patterns
 */
export function listAvailablePatterns(): Array<{ name: string; description: string }> {
  return Object.entries(PATTERN_REGISTRY).map(([key, template]) => ({
    name: key,
    description: template.description,
  }));
}
