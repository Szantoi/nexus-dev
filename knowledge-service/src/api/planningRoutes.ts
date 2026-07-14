/**
 * planningRoutes.ts — Planning Focus Area API
 *
 * Enables Datahaven UI Focus Area Panel to read/update planning domain and criteria
 *
 * Endpoints:
 *   GET  /api/planning/domain-focus  - Read current domain + criteria
 *   PUT  /api/planning/domain-focus  - Update domain and/or criteria
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import DOMPurify from 'isomorphic-dompurify';
import { verifyToken } from '../task-audit/auth';

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_DOMAINS = [
  'manufacturing',
  'sales',
  'logistics',
  'finance',
  'quality',
  'hr',
  'all',
] as const;

type Domain = typeof VALID_DOMAINS[number];

// ─── Rate Limiting ───────────────────────────────────────────────────────────

interface RateLimitState {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateLimitState>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();

  const state = rateLimitMap.get(ip) || { timestamps: [] };
  const recentTimestamps = state.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  if (recentTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // Rate limit exceeded
  }

  recentTimestamps.push(now);
  rateLimitMap.set(ip, { timestamps: recentTimestamps });
  return true;
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of rateLimitMap.entries()) {
    const recentTimestamps = state.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recentTimestamps.length === 0) {
      rateLimitMap.delete(ip);
    } else {
      state.timestamps = recentTimestamps;
    }
  }
}, 5 * 60 * 1000);

// ─── Authentication Middleware ───────────────────────────────────────────────

/**
 * Middleware to verify Bearer token authentication
 * Used for write operations (PUT endpoints)
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header'
    });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({
      error: 'Unauthorized',
      message: authResult.error || 'Invalid token'
    });
    return;
  }

  // Attach authenticated user info to request (optional)
  (req as any).auth = {
    holder: authResult.holder,
    scopes: authResult.scopes,
  };

  next();
}

// ─── Validation & Sanitization ───────────────────────────────────────────────

function validateDomain(domain: string): domain is Domain {
  return VALID_DOMAINS.includes(domain as Domain);
}

/**
 * Sanitize criteria markdown using DOMPurify
 * Removes all HTML tags and dangerous content while preserving markdown
 */
function sanitizeCriteria(criteria: string): string {
  // Use DOMPurify to strip all HTML tags
  // Config: ALLOWED_TAGS: [] means strip all tags, keep text content only
  const sanitized = DOMPurify.sanitize(criteria, {
    ALLOWED_TAGS: [],        // No HTML tags allowed
    ALLOWED_ATTR: [],        // No attributes allowed
    KEEP_CONTENT: true,      // Preserve text content inside removed tags
  });

  return sanitized.trim();
}

// ─── File Operations ─────────────────────────────────────────────────────────

function getDomainFocusPath(): string {
  // Navigate from knowledge-service/ to docs/planning/
  return path.join(process.cwd(), '../../docs/planning/domain-focus.md');
}

interface FocusData {
  domain: Domain;
  criteria: string;
  updated_at: string;
}

// ─── Cache Layer ─────────────────────────────────────────────────────────────

interface CacheEntry {
  data: FocusData;
  lastModified: Date;
  cachedAt: Date;
}

let focusCache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Clear focus file cache (for testing or manual reload)
 */
export function clearFocusCache(): void {
  focusCache = null;
}

/**
 * Read focus file with caching
 *
 * Caches based on:
 * 1. File modification time (mtime)
 * 2. TTL (5 minutes from cache time)
 *
 * @param forceReload Force reload even if cached
 * @returns FocusData (cached or freshly loaded)
 */
async function readFocusFileCached(forceReload: boolean = false): Promise<FocusData> {
  const filePath = getDomainFocusPath();

  try {
    // Check file stats
    const stats = await fs.stat(filePath);
    const fileModified = stats.mtime;
    const now = new Date();

    // Check cache validity
    if (
      !forceReload &&
      focusCache &&
      focusCache.lastModified.getTime() === fileModified.getTime() &&
      now.getTime() - focusCache.cachedAt.getTime() < CACHE_TTL_MS
    ) {
      // Return cached data
      return focusCache.data;
    }

    // Cache miss or expired → reload
    const data = await readFocusFile();

    // Update cache
    focusCache = {
      data,
      lastModified: fileModified,
      cachedAt: now,
    };

    return data;
  } catch (error) {
    throw error;
  }
}

async function readFocusFile(): Promise<FocusData> {
  const filePath = getDomainFocusPath();

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Try parsing as YAML frontmatter first
    try {
      const { data, content: criteriaContent } = matter(content);
      return {
        domain: (data.domain as Domain) || 'manufacturing',
        criteria: criteriaContent.trim(),
        updated_at: data.updated_at || new Date().toISOString(),
      };
    } catch {
      // Fallback: parse legacy format (```domain: manufacturing```)
      const domainMatch = content.match(/```\s*domain:\s*(\w+)\s*```/);
      const domain = (domainMatch?.[1] as Domain) || 'manufacturing';

      // Extract criteria section
      const criteriaMatch = content.match(/## Szempont lista\s*\n([\s\S]*?)(?:\n##|$)/);
      const criteria = criteriaMatch?.[1]?.trim() || '(No criteria defined)';

      return {
        domain,
        criteria,
        updated_at: new Date().toISOString(),
      };
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // File doesn't exist - return defaults
      return {
        domain: 'manufacturing',
        criteria: '# Planning Focus\n\n(No criteria defined)',
        updated_at: new Date().toISOString(),
      };
    }
    throw err;
  }
}

async function writeFocusFile(data: Partial<FocusData>): Promise<FocusData> {
  const filePath = getDomainFocusPath();

  // Read current state
  const current = await readFocusFile().catch(() => ({
    domain: 'manufacturing' as Domain,
    criteria: '# Planning Focus\n\n(No criteria defined)',
    updated_at: new Date().toISOString(),
  }));

  // Merge updates
  const updated: FocusData = {
    domain: data.domain || current.domain,
    criteria: data.criteria !== undefined ? sanitizeCriteria(data.criteria) : current.criteria,
    updated_at: new Date().toISOString(),
  };

  // Format as YAML frontmatter
  const newContent = matter.stringify(updated.criteria, {
    domain: updated.domain,
    updated_at: updated.updated_at,
  });

  // Atomic write: write to temp file, then rename
  const tempPath = filePath + '.tmp';
  await fs.writeFile(tempPath, newContent, 'utf-8');
  await fs.rename(tempPath, filePath);

  return updated;
}

// ─── Domain Metadata ─────────────────────────────────────────────────────────

interface DomainMetadata {
  value: Domain;
  label: string;
  description: string;
}

const DOMAIN_METADATA: Record<Domain, { label: string; description: string }> = {
  manufacturing: {
    label: 'Manufacturing',
    description: 'Gyártási folyamatok, termelés, ütemezés',
  },
  sales: {
    label: 'Sales',
    description: 'Értékesítési pipeline, ajánlatok, megrendelések',
  },
  logistics: {
    label: 'Logistics',
    description: 'Szállítás, raktárzás, készletkezelés',
  },
  finance: {
    label: 'Finance',
    description: 'Számlázás, fizetések, áralkalmazás',
  },
  quality: {
    label: 'Quality',
    description: 'Minőségbiztosítás, tesztelés, ellenőrzés',
  },
  hr: {
    label: 'HR',
    description: 'Emberi erőforrások, szerepkörök, jogosultságok',
  },
  all: {
    label: 'All Domains',
    description: 'Komplex funkciók minden területre',
  },
};

interface PlanningFocusResponse {
  currentDomain: Domain;
  domains: DomainMetadata[];
  criteria: Array<{ name: string; description: string }>;
  updated_at: string;
}

function parseCriteria(criteriaMarkdown: string): Array<{ name: string; description: string }> {
  const lines = criteriaMarkdown.split('\n').filter(l => l.trim());
  return lines
    .filter(line => line.startsWith('- ') || line.startsWith('* '))
    .map(line => {
      const cleaned = line.replace(/^[-*]\s+/, '').trim();
      const match = cleaned.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
      if (match) {
        return { name: match[1], description: match[2] };
      }
      return { name: cleaned.substring(0, 30), description: cleaned };
    });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function createPlanningRouter(): Router {
  const router = Router();

  /**
   * GET /api/planning/focus
   * Returns aggregated focus data for UI (domains list + current domain + criteria)
   * This is the primary endpoint used by the Datahaven Planning UI
   */
  router.get('/focus', async (_req: Request, res: Response) => {
    try {
      const focusData = await readFocusFileCached();
      const domains: DomainMetadata[] = VALID_DOMAINS.map(d => ({
        value: d,
        ...DOMAIN_METADATA[d],
      }));
      const criteria = parseCriteria(focusData.criteria);

      const response: PlanningFocusResponse = {
        currentDomain: focusData.domain,
        domains,
        criteria,
        updated_at: focusData.updated_at,
      };

      res.json(response);
    } catch (err) {
      console.error('[PlanningAPI] Failed to load focus:', err);
      res.status(500).json({ error: 'Failed to load focus data' });
    }
  });

  /**
   * GET /api/planning/domain-focus
   * Returns current domain and criteria (raw format)
   */
  router.get('/domain-focus', async (_req: Request, res: Response) => {
    try {
      const data = await readFocusFileCached();
      res.json(data);
    } catch (err) {
      console.error('[PlanningAPI] Failed to read focus file:', err);
      res.status(500).json({ error: 'Failed to read focus file' });
    }
  });

  /**
   * PUT /api/planning/focus
   * Updates domain (primary endpoint used by Datahaven Planning UI)
   *
   * Request body:
   *   { domain: string }
   *
   * Authentication: Required (Bearer token)
   */
  router.put('/focus', requireAuth, async (req: Request, res: Response) => {
    const clientIp = req.ip || 'unknown';

    // Rate limiting
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: 'Max 10 updates per minute',
      });
    }

    const { domain } = req.body;

    // Validation
    if (!domain || !validateDomain(domain)) {
      return res.status(400).json({
        error: 'Invalid domain',
        message: `Domain must be one of: ${VALID_DOMAINS.join(', ')}`,
      });
    }

    try {
      const updated = await writeFocusFile({ domain });

      // Clear cache to ensure next GET returns fresh data
      clearFocusCache();

      // Return aggregated response matching frontend expectations
      const domains: DomainMetadata[] = VALID_DOMAINS.map(d => ({
        value: d,
        ...DOMAIN_METADATA[d],
      }));
      const criteria = parseCriteria(updated.criteria);

      res.json({
        success: true,
        currentDomain: updated.domain,
        domains,
        criteria,
        updated_at: updated.updated_at,
      });
    } catch (err) {
      console.error('[PlanningAPI] Failed to update focus:', err);
      res.status(500).json({ error: 'Failed to update focus' });
    }
  });

  /**
   * PUT /api/planning/domain-focus
   * Updates domain and/or criteria
   *
   * Request body:
   *   { domain?: string, criteria?: string }
   *
   * Authentication: Required (Bearer token)
   */
  router.put('/domain-focus', requireAuth, async (req: Request, res: Response) => {
    const clientIp = req.ip || 'unknown';

    // Rate limiting
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: 'Max 10 updates per minute',
      });
    }

    const { domain, criteria } = req.body;

    // Validation
    if (domain && !validateDomain(domain)) {
      return res.status(400).json({
        error: 'Invalid domain',
        message: `Domain must be one of: ${VALID_DOMAINS.join(', ')}`,
      });
    }

    if (criteria !== undefined && typeof criteria !== 'string') {
      return res.status(400).json({
        error: 'Invalid criteria',
        message: 'Criteria must be a string',
      });
    }

    try {
      const updated = await writeFocusFile({ domain, criteria });

      // Clear cache to ensure next GET returns fresh data
      clearFocusCache();

      res.json({
        success: true,
        ...updated,
      });
    } catch (err) {
      console.error('[PlanningAPI] Failed to update focus file:', err);
      res.status(500).json({ error: 'Failed to update focus file' });
    }
  });

  return router;
}
