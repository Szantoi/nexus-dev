/**
 * ideaScan.ts — UI Prototípus Kutatási Loop
 *
 * "A JoineryTech prototípusból generál implementációs ötleteket"
 *
 * Működés:
 * 1. Minden N percben (alapértelmezett: 30) elemzi a JoineryTech prototípust
 * 2. LLM (Haiku) kinyeri a még nem implementált komponenseket
 * 3. Minden komponensről rövid idea dokumentumot generál
 * 4. Az ötleteket a docs/planning/ideas/ mappába menti
 * 5. Ha elég ötlet van, triggereli a planSelect-et
 *
 * Konfiguráció (.env):
 *   ENABLE_IDEA_SCAN=true
 *   IDEA_SCAN_INTERVAL_MINUTES=30
 *   IDEA_SCAN_PROJECT_PATH=/opt/spaceos/docs/tasks/new/joinerytech
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { SPACEOS_ROOT, log, telegram } from './common';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IdeaScanConfig {
  enabled: boolean;
  intervalMinutes: number;        // Base interval (used when ideas at threshold)
  minIntervalMinutes: number;     // Fastest interval (when 0 ideas)
  maxIntervalMinutes: number;     // Slowest interval (when over threshold)
  projectPath: string;
  ideasDir: string;
  maxIdeasPerRun: number;
  ideasThreshold: number;  // When to trigger planSelect
  model: string;
}

export interface IdeaScanResult {
  timestamp: string;
  cycleId: number;
  ideasCreated: number;
  skipped: boolean;
  skipReason?: string;
  triggeredSelect: boolean;
  filesAnalyzed: string[];
  error?: string;
}

interface IdeaOutput {
  slug: string;
  title: string;
  content: string;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: IdeaScanConfig = {
  enabled: process.env.ENABLE_IDEA_SCAN === 'true',
  intervalMinutes: parseInt(process.env.IDEA_SCAN_INTERVAL_MINUTES || '30', 10),
  minIntervalMinutes: parseInt(process.env.IDEA_SCAN_MIN_INTERVAL || '5', 10),   // Fastest: 5 min when 0 ideas
  maxIntervalMinutes: parseInt(process.env.IDEA_SCAN_MAX_INTERVAL || '120', 10), // Slowest: 2h when over threshold
  projectPath: process.env.IDEA_SCAN_PROJECT_PATH ||
    `${SPACEOS_ROOT}/docs/tasks/new`,
  ideasDir: process.env.IDEAS_DIR || `${SPACEOS_ROOT}/docs/planning/ideas`,
  maxIdeasPerRun: 3,
  ideasThreshold: 5,
  model: 'claude-haiku-4-5',
};

// ─── State ───────────────────────────────────────────────────────────────────

let cycleCount = 0;
let lastCycleAt: string | null = null;
let timeoutId: NodeJS.Timeout | null = null;
let processedComponents: Set<string> = new Set();
let currentIntervalMinutes: number = DEFAULT_CONFIG.intervalMinutes;

// ─── Dynamic Interval Calculator ──────────────────────────────────────────────

/**
 * Calculate next interval based on current idea count:
 * - 0 ideas → minInterval (fast, need ideas!)
 * - threshold ideas → base interval
 * - > threshold → maxInterval (slow, plenty of ideas)
 *
 * Linear interpolation between min and max based on ratio to threshold
 */
function calculateNextInterval(ideaCount: number, config: IdeaScanConfig): number {
  const { ideasThreshold, minIntervalMinutes, maxIntervalMinutes } = config;

  if (ideaCount === 0) {
    return minIntervalMinutes;
  }

  if (ideaCount >= ideasThreshold) {
    return maxIntervalMinutes;
  }

  // Linear interpolation: 0 ideas = min, threshold = max
  const ratio = ideaCount / ideasThreshold;
  const interval = minIntervalMinutes + ratio * (maxIntervalMinutes - minIntervalMinutes);
  return Math.round(interval);
}

// ─── Helper Functions ────────────────────────────────────────────────────────

async function countIdeas(ideasDir: string): Promise<number> {
  try {
    const files = await fs.readdir(ideasDir);
    return files.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

async function getNextIdeaNumber(ideasDir: string): Promise<number> {
  try {
    const files = await fs.readdir(ideasDir);
    const mdFiles = files.filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}_\d{3}/.test(f));
    if (mdFiles.length === 0) return 1;

    const numbers = mdFiles.map(f => {
      const match = f.match(/_(\d{3})_/);
      return match ? parseInt(match[1]) : 0;
    });
    return Math.max(...numbers) + 1;
  } catch {
    return 1;
  }
}

async function loadProjectStatus(projectPath: string): Promise<string> {
  const statusPath = path.join(projectPath, 'PROJECT_STATUS.md');
  try {
    return await fs.readFile(statusPath, 'utf-8');
  } catch {
    return '';
  }
}

async function loadComponentFiles(projectPath: string, limit: number = 5): Promise<string[]> {
  try {
    const files = await fs.readdir(projectPath);
    const jsxFiles = files.filter(f => f.endsWith('.jsx') || f.endsWith('.js'));
    return jsxFiles.slice(0, limit);
  } catch {
    return [];
  }
}

async function getRecentIdeas(ideasDir: string, limit: number = 10): Promise<string[]> {
  try {
    const files = await fs.readdir(ideasDir);
    return files.filter(f => f.endsWith('.md')).sort().slice(-limit);
  } catch {
    return [];
  }
}

function parseIdeasFromResponse(
  response: string,
  date: string,
  startNum: number
): IdeaOutput[] {
  const ideas: IdeaOutput[] = [];

  // Look for structured idea blocks
  // Pattern: ### [Title]\n...\n---
  const ideaRegex = /###\s+(.+?)\n([\s\S]*?)(?=###|$)/g;
  let match;
  let num = startNum;

  while ((match = ideaRegex.exec(response)) !== null) {
    const title = match[1].trim();
    const body = match[2].trim();

    if (title && body && body.length > 50) {
      const slug = title.toLowerCase()
        .replace(/[^a-z0-9áéíóöőúüű]+/gi, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 40);

      const content = `---
id: IDEA-${date.replace(/-/g, '')}-${String(num).padStart(3, '0')}
title: "${title}"
type: idea
source: joinerytech-prototype
priority: medium
status: new
created: ${date}
---

# ${title}

${body}

---
*Automatikusan generálva a JoineryTech prototípusból*
`;

      ideas.push({ slug, title, content });
      num++;
    }
  }

  // Fallback: look for bullet points if no ### headings found
  if (ideas.length === 0) {
    const bulletRegex = /^[-*]\s+\*\*(.+?)\*\*[:\s]+(.+?)(?=\n[-*]|$)/gm;

    while ((match = bulletRegex.exec(response)) !== null) {
      const title = match[1].trim();
      const description = match[2].trim();

      if (title && description) {
        const slug = title.toLowerCase()
          .replace(/[^a-z0-9áéíóöőúüű]+/gi, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 40);

        const content = `---
id: IDEA-${date.replace(/-/g, '')}-${String(num).padStart(3, '0')}
title: "${title}"
type: idea
source: joinerytech-prototype
priority: medium
status: new
created: ${date}
---

# ${title}

${description}

## Kontextus
Ez az ötlet a JoineryTech prototípus elemzéséből származik.

---
*Automatikusan generálva a JoineryTech prototípusból*
`;

        ideas.push({ slug, title, content });
        num++;
      }
    }
  }

  return ideas;
}

// ─── Core Scan Logic ─────────────────────────────────────────────────────────

export async function runIdeaScan(
  config: IdeaScanConfig = DEFAULT_CONFIG
): Promise<IdeaScanResult> {
  const timestamp = new Date().toISOString();
  const date = timestamp.split('T')[0];
  cycleCount++;
  const cycleId = cycleCount;

  await log(`[IdeaScan] Starting cycle ${cycleId}`);

  // Ensure ideas directory exists
  await fs.mkdir(config.ideasDir, { recursive: true });

  // Check current idea count
  const ideaCount = await countIdeas(config.ideasDir);

  // If at threshold, trigger select
  if (ideaCount >= config.ideasThreshold) {
    await log(`[IdeaScan] Skip: ${ideaCount} ötlet van, elég van`);

    // Optionally trigger planSelect
    try {
      const { runPlanSelect } = await import('./planSelect');
      runPlanSelect().catch(e => log(`[IdeaScan] Select hiba: ${e.message}`));
    } catch {
      // planSelect might not be available
    }

    return {
      timestamp,
      cycleId,
      ideasCreated: 0,
      skipped: true,
      skipReason: 'threshold_reached',
      triggeredSelect: true,
      filesAnalyzed: [],
    };
  }

  // Load project status
  const projectStatus = await loadProjectStatus(config.projectPath);
  if (!projectStatus) {
    await log(`[IdeaScan] Skip: PROJECT_STATUS.md not found`);
    return {
      timestamp,
      cycleId,
      ideasCreated: 0,
      skipped: true,
      skipReason: 'no_project_status',
      triggeredSelect: false,
      filesAnalyzed: [],
    };
  }

  // Load component files
  const componentFiles = await loadComponentFiles(config.projectPath);
  const recentIdeas = await getRecentIdeas(config.ideasDir);
  const nextNum = await getNextIdeaNumber(config.ideasDir);

  // Build analysis prompt
  const prompt = `# JoineryTech UI Prototípus Elemzés

## Feladat
Elemezd a JoineryTech portál prototípusát és generálj 2-3 konkrét implementációs ötletet.

## PROJECT_STATUS.md (részlet - első 3000 karakter)
\`\`\`markdown
${projectStatus.substring(0, 3000)}
\`\`\`

## Prototípus komponensek
${componentFiles.map(f => `- ${f}`).join('\n')}

## Már létező ötletek (ne ismételd)
${recentIdeas.length > 0 ? recentIdeas.join(', ') : 'nincs még'}

## Már feldolgozott komponensek (ne ismételd)
${processedComponents.size > 0 ? Array.from(processedComponents).join(', ') : 'nincs még'}

## Kimenet formátum
Generálj 2-3 rövid ötletet ebben a formátumban:

### [Ötlet címe]
**Komponens:** [Melyik UI komponens]
**Típus:** [ui-component | api-integration | state-management | styling]
**Prioritás:** [high | medium | low]

Rövid leírás (2-3 mondat) hogy mit kell csinálni.

**Kapcsolódó fájlok:**
- fájl1.jsx
- fájl2.tsx

---

### [Következő ötlet címe]
...

## Szabályok
- Csak KONKRÉT, kisméretű feladatokat adj meg (max 2 óra munka)
- A UI kinézet FIX - a prototípusban látható design kell
- Fókuszálj: React komponens → API integráció → State
- Ha a komponens már implementálva van, ne generálj róla ötletet
`;

  try {
    // Call Anthropic API
    const anthropic = new Anthropic();

    const message = await anthropic.messages.create({
      model: config.model,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const responseText = message.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('\n');

    // Parse ideas from response
    const ideas = parseIdeasFromResponse(responseText, date, nextNum);

    // Limit ideas per run
    const ideasToWrite = ideas.slice(0, config.maxIdeasPerRun);

    // Write ideas to files
    for (const idea of ideasToWrite) {
      const filename = `${date}_${String(nextNum + ideasToWrite.indexOf(idea)).padStart(3, '0')}_${idea.slug}.md`;
      const filepath = path.join(config.ideasDir, filename);
      await fs.writeFile(filepath, idea.content, 'utf-8');
      await log(`[IdeaScan] Created: ${filename}`);

      // Track processed component
      processedComponents.add(idea.slug);
    }

    lastCycleAt = timestamp;

    if (ideasToWrite.length > 0) {
      await telegram(`💡 IdeaScan #${cycleId}: ${ideasToWrite.length} új ötlet generálva`);
    }

    return {
      timestamp,
      cycleId,
      ideasCreated: ideasToWrite.length,
      skipped: false,
      triggeredSelect: false,
      filesAnalyzed: componentFiles,
    };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await log(`[IdeaScan] Cycle ${cycleId} error: ${error}`);
    return {
      timestamp,
      cycleId,
      ideasCreated: 0,
      skipped: true,
      skipReason: error,
      triggeredSelect: false,
      filesAnalyzed: componentFiles,
      error,
    };
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

async function scheduleNextRun(config: IdeaScanConfig): Promise<void> {
  // Calculate interval based on current idea count
  const ideaCount = await countIdeas(config.ideasDir);
  const nextInterval = calculateNextInterval(ideaCount, config);
  currentIntervalMinutes = nextInterval;

  const intervalMs = nextInterval * 60 * 1000;

  timeoutId = setTimeout(async () => {
    try {
      const result = await runIdeaScan(config);

      if (result.ideasCreated > 0) {
        console.log(`[IdeaScan] Cycle ${result.cycleId}: ${result.ideasCreated} ideas (next in ${currentIntervalMinutes}min)`);
      } else if (result.skipped) {
        console.log(`[IdeaScan] Cycle ${result.cycleId}: skipped - ${result.skipReason}`);
      }
    } catch (err) {
      console.error('[IdeaScan] Cycle error:', err);
    }

    // Schedule next run with updated interval
    if (timeoutId !== null) {
      scheduleNextRun(config);
    }
  }, intervalMs);
}

export async function startIdeaScanScheduler(config: IdeaScanConfig = DEFAULT_CONFIG): Promise<void> {
  if (!config.enabled) {
    console.log('[IdeaScan] Scheduler disabled (set ENABLE_IDEA_SCAN=true)');
    return;
  }

  if (timeoutId) {
    console.log('[IdeaScan] Scheduler already running');
    return;
  }

  // Calculate initial interval
  const ideaCount = await countIdeas(config.ideasDir);
  const initialInterval = calculateNextInterval(ideaCount, config);
  currentIntervalMinutes = initialInterval;

  console.log(`[IdeaScan] Scheduler starting (dynamic: ${config.minIntervalMinutes}-${config.maxIntervalMinutes} min)`);
  console.log(`   📁 Project: ${config.projectPath}`);
  console.log(`   💡 Ideas dir: ${config.ideasDir}`);
  console.log(`   🎯 Threshold: ${config.ideasThreshold} ideas`);
  console.log(`   📊 Current: ${ideaCount} ideas → next in ${initialInterval}min`);

  // Run first scan after initial delay
  setTimeout(async () => {
    try {
      const result = await runIdeaScan(config);
      console.log(`[IdeaScan] Initial cycle: ${result.ideasCreated} ideas created`);

      // Start dynamic scheduling
      scheduleNextRun(config);
    } catch (err) {
      console.error('[IdeaScan] Initial cycle error:', err);
      // Still start scheduler even if initial run fails
      scheduleNextRun(config);
    }
  }, 10000); // 10 sec initial delay

  console.log(`   💡 Idea Scan: ENABLED (dynamic interval)`);
}

export function stopIdeaScanScheduler(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
    console.log('[IdeaScan] Scheduler stopped');
  }
}

// ─── Status & API ────────────────────────────────────────────────────────────

export function getIdeaScanStatus(): {
  enabled: boolean;
  running: boolean;
  cycleCount: number;
  lastCycleAt: string | null;
  currentIntervalMinutes: number;
  processedComponents: string[];
  config: IdeaScanConfig;
} {
  return {
    enabled: DEFAULT_CONFIG.enabled,
    running: timeoutId !== null,
    cycleCount,
    lastCycleAt,
    currentIntervalMinutes,
    processedComponents: Array.from(processedComponents),
    config: DEFAULT_CONFIG,
  };
}

export async function triggerManualIdeaScan(): Promise<IdeaScanResult> {
  return runIdeaScan(DEFAULT_CONFIG);
}

// ─── Express Router ──────────────────────────────────────────────────────────

import { Router } from 'express';

export function createIdeaScanRouter(): Router {
  const router = Router();

  // Get status
  router.get('/status', (_req, res) => {
    res.json(getIdeaScanStatus());
  });

  // Trigger manual scan
  router.post('/scan', async (_req, res) => {
    try {
      const result = await triggerManualIdeaScan();
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Start scheduler
  router.post('/start', (_req, res) => {
    startIdeaScanScheduler();
    res.json({ success: true, message: 'Scheduler started' });
  });

  // Stop scheduler
  router.post('/stop', (_req, res) => {
    stopIdeaScanScheduler();
    res.json({ success: true, message: 'Scheduler stopped' });
  });

  // Clear processed components cache
  router.post('/reset', (_req, res) => {
    processedComponents.clear();
    res.json({ success: true, message: 'Processed components cache cleared' });
  });

  return router;
}

// ─── Run standalone ──────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('=== Idea Scan Module ===');
  console.log(`Enabled: ${DEFAULT_CONFIG.enabled}`);
  console.log(`Interval: ${DEFAULT_CONFIG.intervalMinutes} minutes`);
  console.log(`Project: ${DEFAULT_CONFIG.projectPath}`);
  console.log(`Ideas dir: ${DEFAULT_CONFIG.ideasDir}`);

  if (process.argv.includes('--scan')) {
    console.log('\nRunning manual scan...');
    triggerManualIdeaScan()
      .then(result => {
        console.log('\nResult:', JSON.stringify(result, null, 2));
      })
      .catch(err => {
        console.error('Error:', err);
      });
  }
}
