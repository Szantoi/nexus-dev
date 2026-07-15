/**
 * tokenAuth.ts — Bearer-token authentication for the MCP and REST surfaces.
 *
 * Terminal identity is always derived from the presented token — never from
 * a client-supplied claim. Token sources (env overrides YAML):
 *   config/agents.yaml       master_token + agents map (token -> agent name)
 *   MCP_AUTH_TOKEN=xxx       master token (grants 'root')
 *   MCP_TOKEN_<NAME>=xxx     per-agent token (MCP_TOKEN_CONDUCTOR -> conductor)
 *
 * AUTH_MODE (env, default 'open'):
 *   open     — local-dev behavior: with no tokens configured every caller is
 *              'root'; default_agent fallback applies when no header is sent.
 *   required — fail closed (VPS/exposed deployments): a valid Bearer token is
 *              mandatory on every guarded surface. No tokens configured means
 *              every request is denied (503), and default_agent is disabled.
 *
 * The agents.yaml file auto-reloads every 30 seconds without restart.
 */

import { Request, Response } from 'express';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { AGENTS_CONFIG_PATH } from '../config/paths';
import { env } from '../config/env';
import { logger } from '../core/logger';

// Middleware state: resolved terminal identity for downstream handlers
declare global {
  namespace Express {
    interface Request {
      mcpTerminal?: string;
    }
  }
}

interface AgentsConfig {
  version?: string;
  updated?: string;
  master_token?: string;
  agents: Record<string, string>; // token -> agent_name
  groups?: Record<string, string[]>;
  default_agent?: string | null;
}

// ─── State ────────────────────────────────────────────────────────────────────

let authMode: 'open' | 'required' = env.AUTH_MODE;
let masterToken: string = process.env.MCP_AUTH_TOKEN || '';
let agentTokens: Record<string, string> = {}; // token -> agent_name
let defaultAgent: string | null = null;
let lastAgentsConfigMtime: number = 0;

// ─── Token Loading ────────────────────────────────────────────────────────────

/**
 * Load agent tokens from YAML config and environment variables.
 * Env tokens always win over YAML entries.
 */
export function loadAgentTokens(): void {
  const envTokens: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MCP_TOKEN_')) {
      const agentName = key.substring(10).toLowerCase(); // MCP_TOKEN_CONDUCTOR -> conductor
      const token = process.env[key] || '';
      if (token) {
        envTokens[token] = agentName; // Reverse mapping: token -> agent
      }
    }
  }

  // Load master token from env (only if set, don't clear existing)
  const envMasterToken = process.env.MCP_AUTH_TOKEN;
  if (envMasterToken) {
    masterToken = envMasterToken;
  }

  try {
    const stat = fs.statSync(AGENTS_CONFIG_PATH);
    const mtime = stat.mtimeMs;

    // Skip if file hasn't changed and we already loaded
    if (mtime === lastAgentsConfigMtime && Object.keys(agentTokens).length > 0) {
      return;
    }

    const content = fs.readFileSync(AGENTS_CONFIG_PATH, 'utf-8');
    const config = yaml.load(content) as AgentsConfig;

    if (config) {
      // Use YAML master token if env not set
      if (!envMasterToken && config.master_token) {
        masterToken = config.master_token;
      }

      const yamlTokens: Record<string, string> = {};
      if (config.agents) {
        for (const [token, agentName] of Object.entries(config.agents)) {
          if (token && agentName) {
            yamlTokens[token] = agentName;
          }
        }
      }

      // Merge: env tokens override YAML tokens
      agentTokens = { ...yamlTokens, ...envTokens };

      defaultAgent = config.default_agent || null;
      lastAgentsConfigMtime = mtime;

      const tokenCount = Object.keys(agentTokens).length;
      logger.info(`[Auth] 🔑 Agent tokens loaded (${tokenCount} agents, master: ${masterToken ? 'set' : 'not set'}, mode: ${authMode})`);
    }
  } catch {
    // If YAML fails, use env vars only
    if (Object.keys(agentTokens).length === 0) {
      agentTokens = envTokens;
      if (authMode === 'required') {
        logger.warn(`[Auth] ⚠️ Could not load agents.yaml, using env vars only (${Object.keys(envTokens).length} agents)`);
      }
    }
  }
}

/**
 * Get agent name from token.
 * Returns 'root' for the master token, the agent name for a known token, null otherwise.
 */
export function getAgentFromToken(token: string): string | null {
  if (masterToken && token === masterToken) {
    return 'root';
  }
  return agentTokens[token] || null;
}

export function hasTokensConfigured(): boolean {
  return Boolean(masterToken) || Object.keys(agentTokens).length > 0;
}

export function getAuthMode(): 'open' | 'required' {
  return authMode;
}

/** Runtime override — used by tests and by deployments that flip mode without env restart. */
export function setAuthMode(mode: 'open' | 'required'): void {
  authMode = mode;
}

/** Reset module state so tests can start from a clean slate. */
export function resetAuthStateForTests(): void {
  authMode = env.AUTH_MODE;
  masterToken = process.env.MCP_AUTH_TOKEN || '';
  agentTokens = {};
  defaultAgent = null;
  lastAgentsConfigMtime = 0;
}

// ─── Identity Resolution ──────────────────────────────────────────────────────

interface Denial {
  status: 401 | 403 | 503;
  message: string;
}

function resolveAgent(authHeader: string | undefined): { agent: string } | { denial: Denial } {
  if (!hasTokensConfigured()) {
    if (authMode === 'required') {
      // Fail closed: an exposed deployment must never fall back to open access
      return { denial: { status: 503, message: 'Authentication required but no tokens are configured' } };
    }
    return { agent: 'root' }; // dev mode
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (authMode === 'open' && defaultAgent) {
      return { agent: defaultAgent };
    }
    return { denial: { status: 401, message: 'Unauthorized: Bearer token required' } };
  }

  const agent = getAgentFromToken(authHeader.substring(7));
  if (!agent) {
    return { denial: { status: 403, message: 'Forbidden: Invalid token' } };
  }

  return { agent };
}

function logDeny(req: Request, denial: Denial): void {
  const ip = (req.headers['x-real-ip'] as string) ||
             (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
             req.ip || 'unknown';
  logger.warn(`[Auth] DENY ${denial.status} ${req.method} ${req.originalUrl} (from: ${ip})`);
}

// ─── Middlewares ──────────────────────────────────────────────────────────────

/** MCP endpoint authentication — JSON-RPC error shapes. */
export function authenticateMcp(req: Request, res: Response, next: () => void): void {
  const result = resolveAgent(req.headers.authorization);
  if ('denial' in result) {
    logDeny(req, result.denial);
    const code = result.denial.status === 403 ? -32002 : result.denial.status === 401 ? -32001 : -32000;
    res.status(result.denial.status).json({
      jsonrpc: '2.0',
      error: { code, message: result.denial.message },
      id: null,
    });
    return;
  }
  req.mcpTerminal = result.agent;
  next();
}

/** REST endpoint authentication — plain JSON error shapes. */
export function authenticateRest(req: Request, res: Response, next: () => void): void {
  const result = resolveAgent(req.headers.authorization);
  if ('denial' in result) {
    logDeny(req, result.denial);
    res.status(result.denial.status).json({ error: result.denial.message });
    return;
  }
  req.mcpTerminal = result.agent;
  next();
}

/**
 * Global /api gate: in 'required' mode every /api route needs a valid token;
 * in 'open' mode it is a no-op (per-route auth like /api/mailbox still applies).
 */
export function apiAuthGate(req: Request, res: Response, next: () => void): void {
  if (authMode === 'required') {
    authenticateRest(req, res, next);
    return;
  }
  next();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadAgentTokens();

if (authMode === 'required' && !process.env.TERMINAL_TOKEN_SECRET) {
  logger.warn('[Auth] ⚠️ AUTH_MODE=required but TERMINAL_TOKEN_SECRET is unset — epic-router tokens use a hardcoded default secret');
}

// Auto-reload every 30 seconds; unref so the timer never keeps a test runner alive
setInterval(loadAgentTokens, 30_000).unref();
