// cronLibrarian.ts - TypeScript equivalent of cron-librarian.sh
// Creates periodic inbox messages for the Librarian terminal

import { promises as fs } from 'fs';
import * as path from 'path';
import { SPACEOS_ROOT, log, telegram } from './common';
import { loadPipelineConfig, getNextMessageNum } from './pipelineConfig';

// ── Types ───────────────────────────────────────────────────────────────────

interface LibrarianResult {
  created: boolean;
  filename?: string;
  skipped: boolean;
  skipReason?: string;
}

// ── Check for existing UNREAD ───────────────────────────────────────────────

async function hasUnreadInbox(inboxDir: string): Promise<boolean> {
  try {
    const files = await fs.readdir(inboxDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(inboxDir, file), 'utf-8');
      if (content.includes('status: UNREAD')) {
        return true;
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return false;
}

// ── Build inbox message content ─────────────────────────────────────────────

function buildLibrarianInbox(date: string, nextNum: string): string {
  const claudeProj = '/home/gabor/.claude/projects';

  return `---
id: MSG-LIBRARIAN-${nextNum}
from: cron
to: librarian
type: task
priority: low
status: UNREAD
model: haiku
created: ${date}
---

# Librarian — 5 óránkénti memória szinkron

Olvasd el a CLAUDE.md-edet a részletes szabályokért.

## 1. Memória tisztítás

Menj végig ezeken a memória mappákon:

**Aktív terminálok (új útvonalak):**
- \`${claudeProj}/-opt-spaceos-frontend-joinerytech-portal/memory/\`
- \`${claudeProj}/-opt-spaceos-backend-spaceos-kernel/memory/\`
- \`${claudeProj}/-opt-spaceos-backend-spaceos-orchestrator/memory/\`
- \`${claudeProj}/-opt-spaceos-backend-spaceos-modules-joinery/memory/\`
- \`${claudeProj}/-opt-spaceos-infra/memory/\`
- \`${claudeProj}/-opt-spaceos-e2e/memory/\`
- \`${claudeProj}/-opt-spaceos-spaceos-architect/memory/\`

**Régi útvonalak (valószínűleg stale tartalom):**
- \`${claudeProj}/-opt-spaceos-SpaceOS-Kerner/memory/\`
- \`${claudeProj}/-opt-spaceos-spaceos-orchestrator/memory/\`
- \`${claudeProj}/-opt-spaceos-spaceos-modules-joinery/memory/\`
- \`${claudeProj}/-opt-spaceos-spaceos-doorstar-portal/memory/\`
- \`${claudeProj}/-opt-spaceos-design-portal/memory/\`

**Minden mappában:**
- Olvasd el a MEMORY.md indexet
- Minden \`project_*.md\` fájlnál: ha CLOSED_DONE vagy régi sprint → töröld
- Értékes tartalmat (VPS gotcha, arch döntés, security pattern) előbb mentsd
- \`user_*.md\` és \`feedback_*.md\` → NE töröld, ezek kellenek a terminálnak
- Törlés után: frissítsd a MEMORY.md indexet

## 2. Szintetizálás → docs/knowledge/

Ha törlés előtt értékes tartalmat találtál:
- VPS / deploy csapda → \`${SPACEOS_ROOT}/docs/knowledge/deployment/KNOWN_GOTCHAS.md\`
- Arch döntés → \`${SPACEOS_ROOT}/docs/knowledge/architecture/ADR_CATALOGUE.md\`
- Security minta → \`${SPACEOS_ROOT}/docs/knowledge/security/SECURITY_PATTERNS.md\`
- DB / migration minta → \`${SPACEOS_ROOT}/docs/knowledge/patterns/DATABASE_PATTERNS.md\`
- Terminál összefoglaló → \`${SPACEOS_ROOT}/docs/knowledge/context/<TERMINÁL>_CONTEXT.md\`

Ha a knowledge fájl még nem létezik → hozd létre.
Frissítsd \`${SPACEOS_ROOT}/docs/knowledge/INDEX.md\`-t ha új doc született.

## 3. DONE outbox

Amikor kész vagy, küldj DONE outbox üzenetet:
\`${SPACEOS_ROOT}/docs/mailbox/librarian/outbox/${date}_${nextNum}_librarian-done.md\`

Frontmatter: id: MSG-LIBRARIAN-${nextNum}-DONE, from: librarian, to: root,
type: done, priority: low, status: UNREAD, ref: MSG-LIBRARIAN-${nextNum}, created: ${date}

Tartalom: mit töröltél, mit szintetizáltál, hány fájl maradt.
`;
}

// ── Main function ───────────────────────────────────────────────────────────

export async function runCronLibrarian(): Promise<LibrarianResult> {
  const config = await loadPipelineConfig();
  const librarianInbox = path.join(SPACEOS_ROOT, 'docs/mailbox/librarian/inbox');

  await fs.mkdir(librarianInbox, { recursive: true });

  // Check for existing UNREAD
  if (await hasUnreadInbox(librarianInbox)) {
    await log('[CronLibrarian] Skip — already has UNREAD inbox');
    return {
      created: false,
      skipped: true,
      skipReason: 'unread_exists'
    };
  }

  // Create new inbox
  const date = new Date().toISOString().split('T')[0];
  const nextNum = await getNextMessageNum(librarianInbox);
  const numStr = String(nextNum).padStart(3, '0');

  const filename = `${date}_${numStr}_memory-sync.md`;
  const filePath = path.join(librarianInbox, filename);

  const content = buildLibrarianInbox(date, numStr);
  await fs.writeFile(filePath, content);

  await log(`[CronLibrarian] Inbox created: ${filename}`);

  // Telegram notification
  if (config.notifications.on_librarian_start) {
    await telegram('📚 *Librarian — memória szinkron indul* (5 óránkénti cron)');
  }

  return {
    created: true,
    filename,
    skipped: false
  };
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  runCronLibrarian().then(result => {
    console.log('Librarian result:', JSON.stringify(result, null, 2));
    process.exit(result.created || result.skipped ? 0 : 1);
  });
}
