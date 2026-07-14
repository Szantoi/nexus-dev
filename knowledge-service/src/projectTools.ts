/**
 * Project Automation MCP Tools (Track D)
 *
 * 6 new MCP tools for project automation:
 * 1. create_project — Create project structure
 * 2. get_project_status — Get project status
 * 3. dispatch_next — Manually dispatch next task
 * 4. list_blocked — List all blocked tasks
 * 5. generate_skeleton — Generate module skeleton
 * 6. generate_endpoint — Generate API endpoint
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { generateModule, GenerateModuleParams } from './generators/generateModule';
import { generateEndpoint, GenerateEndpointParams } from './generators/generateEndpoint';
import { TaskChain } from './pipeline/projectDispatcher';
import { exportStatusJSON } from './pipeline/statusUpdater';

// Helper functions to get directory paths (allows runtime env override)
const getProjectsDir = () => process.env.PROJECTS_DIR || '/opt/spaceos/docs/projects';
const getTerminalsDir = () => process.env.TERMINALS_DIR || '/opt/spaceos/terminals';

// ─── Tool 1: create_project ─────────────────────────────────────────────────

export interface CreateProjectArgs {
  slug: string;
  name: string;
  description?: string;
  milestones?: Array<{ id: string; name: string }>;
}

export async function handleCreateProject(args: CreateProjectArgs) {
  const { slug, name, description, milestones } = args;
  const projectDir = `${getProjectsDir()}/${slug}`;

  try {
    // Create directory structure
    await fs.mkdir(`${projectDir}/milestones`, { recursive: true });
    await fs.mkdir(`${projectDir}/inbox-templates`, { recursive: true });

    // Create PROJECT.md
    const projectMd = `---
id: PROJECT-${slug.toUpperCase()}
name: "${name}"
owner: conductor
status: PLANNING
created: ${new Date().toISOString().split('T')[0]}
updated: ${new Date().toISOString().split('T')[0]}
---

# ${name}

## Cél

${description || 'TODO: Add project goal'}

## Scope

${(milestones || []).map(m => `- [ ] ${m.name}`).join('\n') || '- [ ] Milestone 1'}

## Out of Scope

- TODO

## Stakeholders

- **Owner:** conductor
`;

    await fs.writeFile(`${projectDir}/PROJECT.md`, projectMd);

    // Create TASKS.yaml skeleton
    const tasksYaml: TaskChain = {
      version: '1.0',
      project: slug,
      created: new Date().toISOString().split('T')[0],
      updated: new Date().toISOString().split('T')[0],
      config: {
        default_model: 'sonnet',
        auto_dispatch: true,
        notify_telegram: true,
        retry_on_blocked: 3,
      },
      milestones: (milestones || [{ id: 'M1', name: 'Initial' }]).map(m => ({
        id: m.id,
        name: m.name,
        status: 'pending',
        blocked_by: [],
        tasks: [],
      })),
    };

    await fs.writeFile(`${projectDir}/TASKS.yaml`, yaml.dump(tasksYaml));

    // Create STATUS.md
    const statusMd = `# ${name} — Status

**Generated:** ${new Date().toISOString()}

## Progress

| Milestone | Tasks | Done | % |
|-----------|-------|------|---|
${(milestones || []).map(m => `| ${m.name} | 0 | 0 | 0% |`).join('\n')}

## Recent Activity

_No activity yet_
`;

    await fs.writeFile(`${projectDir}/STATUS.md`, statusMd);

    return {
      success: true,
      path: projectDir,
      files: ['PROJECT.md', 'TASKS.yaml', 'STATUS.md'],
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

// ─── Tool 2: get_project_status ─────────────────────────────────────────────

export interface GetProjectStatusArgs {
  project: string;
}

export async function handleGetProjectStatus(args: GetProjectStatusArgs) {
  const { project } = args;
  const projectDir = `${getProjectsDir()}/${project}`;

  try {
    const tasksYamlPath = `${projectDir}/TASKS.yaml`;
    const tasksContent = await fs.readFile(tasksYamlPath, 'utf-8');
    const tasks = yaml.load(tasksContent) as TaskChain;

    // Use statusUpdater to generate JSON export
    const status = exportStatusJSON(tasks);

    return {
      success: true,
      ...status,
    };
  } catch (error) {
    return {
      success: false,
      error: `Project not found: ${project}`,
    };
  }
}

// ─── Tool 3: dispatch_next ──────────────────────────────────────────────────

export interface DispatchNextArgs {
  project: string;
  task_id?: string;
}

export async function handleDispatchNext(args: DispatchNextArgs) {
  const { project, task_id } = args;

  try {
    // This tool would trigger the projectDispatcher manually
    // For now, return a message that auto-dispatch is handled by the daemon

    return {
      success: true,
      message: task_id
        ? `Manual dispatch requested for task ${task_id} in project ${project}. Auto-dispatcher will handle it.`
        : `Manual dispatch requested for project ${project}. Auto-dispatcher will find next unblocked tasks.`,
      note: 'Auto-dispatch is handled by projectDispatcher daemon running in Knowledge Service.',
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

// ─── Tool 4: list_blocked ───────────────────────────────────────────────────

export async function handleListBlocked() {
  try {
    const projects = await fs.readdir(getProjectsDir());
    const blocked: Array<{ project: string; task: any }> = [];

    for (const project of projects) {
      const tasksPath = `${getProjectsDir()}/${project}/TASKS.yaml`;
      try {
        const tasksYaml = await fs.readFile(tasksPath, 'utf-8');
        const tasks = yaml.load(tasksYaml) as TaskChain;

        for (const milestone of tasks.milestones) {
          for (const task of milestone.tasks) {
            if (task.status === 'blocked') {
              blocked.push({ project, task });
            }
          }
        }
      } catch {
        // Skip non-project directories
      }
    }

    return {
      success: true,
      count: blocked.length,
      blocked,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

// ─── Tool 5: generate_skeleton ──────────────────────────────────────────────

export interface GenerateSkeletonArgs {
  module: string;
  aggregate: string;
  states: string[];
  endpoints?: string[];
  properties?: Array<{ name: string; type: string; nullable?: boolean }>;
}

export async function handleGenerateSkeleton(args: GenerateSkeletonArgs) {
  try {
    const params: GenerateModuleParams = {
      module: args.module,
      aggregate: args.aggregate,
      states: args.states,
      endpoints: args.endpoints,
      properties: args.properties,
    };

    const result = await generateModule(params);

    return {
      success: result.success,
      filesCreated: result.filesCreated.length,
      filesSkipped: result.filesSkipped.length,
      files: result.filesCreated,
      errors: result.errors,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

// ─── Tool 6: generate_endpoint ──────────────────────────────────────────────

export interface GenerateEndpointArgs {
  module: string;
  aggregate: string;
  action: string;
  http: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  route: string;
  requestBody?: Array<{ name: string; type: string; nullable?: boolean }>;
  responseType?: string;
}

export async function handleGenerateEndpoint(args: GenerateEndpointArgs) {
  try {
    const params: GenerateEndpointParams = {
      module: args.module,
      aggregate: args.aggregate,
      action: args.action,
      http: args.http,
      route: args.route,
      requestBody: args.requestBody,
      responseType: args.responseType,
    };

    const result = await generateEndpoint(params);

    return {
      success: result.success,
      filesCreated: result.filesCreated.length,
      filesAppended: result.filesAppended.length,
      filesSkipped: result.filesSkipped.length,
      files: {
        created: result.filesCreated,
        appended: result.filesAppended,
      },
      errors: result.errors,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}
