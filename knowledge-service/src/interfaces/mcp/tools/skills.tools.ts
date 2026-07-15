/**
 * Skills MCP tools — skills, workflow, and terminal documentation.
 *
 * Tools: list_skills, get_skill, get_workflow, get_terminal_setup,
 *        get_project_context, list_terminal_docs, get_terminal_docs, get_terminals_index
 */

import { toolRegistry, success, error } from './base-tool';
import { TERMINALS } from '../../../identity';
import {
  listSkills,
  getSkill,
  getWorkflow,
  getTerminalSetup,
  getProjectContext,
  listTerminalDocs,
  getTerminalDocs,
  getTerminalsIndex,
} from '../../../skills';

export function registerSkillsTools(): void {
  // ─── list_skills ─────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_skills',
      description:
        'List all SpaceOS skills with their descriptions. Skills define terminal behaviors and workflows.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const skills = await listSkills();
      return success({ count: skills.length, skills });
    }
  );

  // ─── get_skill ───────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_skill',
      description:
        'Get the full content of a specific skill including SKILL.md and reference files.',
      inputSchema: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description:
              'Skill name (e.g., spaceos-terminal, spaceos-root, spaceos-conductor)',
          },
        },
        required: ['skill_name'],
      },
    },
    async (args) => {
      const skillName = String(args.skill_name || '');
      const skill = await getSkill(skillName);
      if (!skill) {
        return error(`Skill not found: ${skillName}`);
      }
      return success(skill);
    }
  );

  // ─── get_workflow ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_workflow',
      description:
        'Get the full SpaceOS WORKFLOW.md - defines the pipeline, mailbox system, and terminal architecture.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const workflow = await getWorkflow();
      return success({ hasWorkflow: workflow !== null, workflow });
    }
  );

  // ─── get_terminal_setup ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_terminal_setup',
      description:
        'Get complete setup instructions for a terminal: CLAUDE.md, relevant skill, workflow excerpt, and MCP config.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const setup = await getTerminalSetup(terminal);
      return success({
        terminal,
        hasClaudeMd: setup.claudeMd !== null,
        hasSkill: setup.skill !== null,
        ...setup,
      });
    }
  );

  // ─── get_project_context ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_project_context',
      description:
        'Get SpaceOS project context: vision, knowledge index, and codebase status.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const context = await getProjectContext();
      return success({
        hasVision: context.vision !== null,
        hasKnowledgeIndex: context.knowledgeIndex !== null,
        hasCodebaseStatus: context.codebaseStatus !== null,
        ...context,
      });
    }
  );

  // ─── list_terminal_docs ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_terminal_docs',
      description:
        'List all terminal documentation folders with their README status, port, and type.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const docs = await listTerminalDocs();
      return success({ count: docs.length, terminals: docs });
    }
  );

  // ─── get_terminal_docs ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_terminal_docs',
      description:
        'Get terminal documentation README - quick reference for session startup, commands, and workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const docs = await getTerminalDocs(terminal);
      return success({
        terminal: docs.name,
        hasReadme: docs.readme !== null,
        ...docs,
      });
    }
  );

  // ─── get_terminals_index ─────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_terminals_index',
      description:
        'Get the main terminals INDEX.md - architecture overview, terminal list, MCP config.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const index = await getTerminalsIndex();
      return success({ hasIndex: index !== null, index });
    }
  );
}
