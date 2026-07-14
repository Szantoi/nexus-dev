/**
 * Task Audit — Authentication Module
 *
 * Token-based authentication for task creation API.
 * Implements:
 * - SHA-256 hashed token storage
 * - Scope-based authorization (wildcards supported)
 * - LRU cache for token permissions
 *
 * Security: Raw tokens are NEVER stored or logged.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ── Configuration ───────────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TOKEN_CONFIG_PATH = path.join(SPACEOS_ROOT, 'config/tokens.yaml');

// LRU Cache settings
const CACHE_MAX_KEYS = 100;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Types ───────────────────────────────────────────────────────────────────

interface TokenConfig {
  holder: string;
  hash: string;          // sha256:... (NEVER raw token)
  scopes: string[];
  created: string;
  expires?: string | null;
}

interface TokensFile {
  version: string;
  tokens: TokenConfig[];
}

interface CachedPermission {
  holder: string;
  scopes: string[];
  cachedAt: number;
}

interface AuthResult {
  authenticated: boolean;
  holder?: string;
  scopes?: string[];
  error?: string;
}

// ── LRU Cache Implementation ────────────────────────────────────────────────

class LRUCache<K, V> {
  private cache: Map<K, { value: V; insertedAt: number }>;
  private maxKeys: number;
  private ttlMs: number;

  constructor(maxKeys: number, ttlMs: number) {
    this.cache = new Map();
    this.maxKeys = maxKeys;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.insertedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxKeys) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, { value, insertedAt: Date.now() });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }
}

// ── Module State ────────────────────────────────────────────────────────────

let tokensConfig: TokensFile | null = null;
const permissionCache = new LRUCache<string, CachedPermission>(CACHE_MAX_KEYS, CACHE_TTL_MS);

// ── Token Config Loading ────────────────────────────────────────────────────

function loadTokensConfig(): TokensFile {
  if (tokensConfig) return tokensConfig;

  try {
    const content = fs.readFileSync(TOKEN_CONFIG_PATH, 'utf-8');
    tokensConfig = yaml.load(content) as TokensFile;
    return tokensConfig;
  } catch (error) {
    // Return empty config if file doesn't exist
    console.warn(`[Auth] Token config not found at ${TOKEN_CONFIG_PATH}, using defaults`);
    return {
      version: '1.0',
      tokens: [
        {
          holder: 'root',
          hash: hashToken('dev-token-root-2026'),
          scopes: ['task:create:*', 'session:*', 'review:*'],
          created: '2026-06-23',
        },
        {
          holder: 'conductor',
          hash: hashToken('dev-token-conductor-2026'),
          scopes: ['task:create:worker'],
          created: '2026-06-23',
        }
      ]
    };
  }
}

// ── Hash Functions ──────────────────────────────────────────────────────────

export function hashToken(token: string): string {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return `sha256:${hash}`;
}

// ── Token Verification ──────────────────────────────────────────────────────

export function verifyToken(token: string): AuthResult {
  // Hash the incoming token (NEVER log the raw token!)
  const tokenHash = hashToken(token);

  // Check cache first
  const cached = permissionCache.get(tokenHash);
  if (cached) {
    return {
      authenticated: true,
      holder: cached.holder,
      scopes: cached.scopes,
    };
  }

  // Load config and find token
  const config = loadTokensConfig();
  const tokenConfig = config.tokens.find(t => t.hash === tokenHash);

  if (!tokenConfig) {
    return {
      authenticated: false,
      error: 'Invalid token',  // Generic error, no token info
    };
  }

  // Check expiration
  if (tokenConfig.expires) {
    const expiresDate = new Date(tokenConfig.expires);
    if (expiresDate < new Date()) {
      return {
        authenticated: false,
        error: 'Token expired',
      };
    }
  }

  // Cache the permissions
  permissionCache.set(tokenHash, {
    holder: tokenConfig.holder,
    scopes: tokenConfig.scopes,
    cachedAt: Date.now(),
  });

  return {
    authenticated: true,
    holder: tokenConfig.holder,
    scopes: tokenConfig.scopes,
  };
}

// ── Scope Checking ──────────────────────────────────────────────────────────

/**
 * Check if scopes include the required scope.
 * Supports wildcards: 'task:create:*' matches 'task:create:backend'
 */
export function hasScope(scopes: string[], requiredScope: string): boolean {
  for (const scope of scopes) {
    // Exact match
    if (scope === requiredScope) return true;

    // Wildcard match
    if (scope.endsWith(':*')) {
      const prefix = scope.slice(0, -1); // Remove '*'
      if (requiredScope.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Verify token and check for required scope
 */
export function authorizeScope(token: string, requiredScope: string): AuthResult {
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    return authResult;
  }

  if (!hasScope(authResult.scopes!, requiredScope)) {
    return {
      authenticated: false,
      error: 'Insufficient scope',
    };
  }

  return authResult;
}

// ── Exports for Testing ─────────────────────────────────────────────────────

export function clearCache(): void {
  permissionCache.clear();
}

export function reloadConfig(): void {
  tokensConfig = null;
  clearCache();
}

// ── Valid Terminals ─────────────────────────────────────────────────────────

export const VALID_TERMINALS = [
  'backend',
  'frontend',
  'designer',
  'architect',
  'librarian',
  'explorer',
  'conductor',
] as const;

export type Terminal = typeof VALID_TERMINALS[number];

export function isValidTerminal(terminal: string): terminal is Terminal {
  return VALID_TERMINALS.includes(terminal as Terminal);
}
