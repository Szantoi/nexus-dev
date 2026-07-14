/**
 * Kanban Routes
 * Discovery & Delivery board data
 */

import { Router, Request, Response } from 'express';
import { getStatus, getAllStatus } from '../../../terminalStatus';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';

const router = Router();

// ─── Kanban Snapshot ─────────────────────────────────────────────────────────

router.get('/snapshot', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = SPACEOS_ROOT;
    const planningRoot = path.join(projectRoot, 'docs/planning');
    const terminalsRoot = path.join(projectRoot, 'terminals');

    // Helper to parse planning items
    const parsePlanningItem = async (filePath: string, stage: string) => {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let title = path.basename(filePath, '.md');
        let priority = 'medium';

        if (lines[0] === '---') {
          for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') break;
            if (lines[i].startsWith('title:')) {
              title = lines[i].replace('title:', '').trim().replace(/^["']|["']$/g, '');
            }
            if (lines[i].startsWith('priority:')) {
              priority = lines[i].replace('priority:', '').trim();
            }
          }
        }

        if (title === path.basename(filePath, '.md')) {
          const h1 = lines.find(l => l.startsWith('# '));
          if (h1) title = h1.replace('# ', '').trim();
        }

        const stat = await fs.stat(filePath);
        return {
          id: path.basename(filePath),
          title,
          status: stage,
          priority,
          createdAt: stat.birthtime.toISOString(),
        };
      } catch (err) {
        return null;
      }
    };

    // Discovery Track
    const discovery: {
      ideas: any[];
      selected: any[];
      debate: any[];
      consensus: any[];
      queue: any[];
      totals: { ideas: number; selected: number; debate: number; consensus: number; queue: number };
    } = {
      ideas: [],
      selected: [],
      debate: [],
      consensus: [],
      queue: [],
      totals: { ideas: 0, selected: 0, debate: 0, consensus: 0, queue: 0 },
    };

    const stages = ['ideas', 'selected', 'debate', 'consensus', 'queue'] as const;
    for (const stage of stages) {
      try {
        const stageDir = path.join(planningRoot, stage === 'debate' ? 'consensus' : stage);
        const files = await fs.readdir(stageDir);
        const mdFiles = files.filter(f => f.endsWith('.md') && !f.includes('archive'));

        const items = [];
        for (const file of mdFiles.slice(0, 10)) {
          const item = await parsePlanningItem(path.join(stageDir, file), stage);
          if (item) items.push(item);
        }

        discovery[stage] = items;
        discovery.totals[stage] = mdFiles.length;
      } catch (err) { /* dir may not exist */ }
    }

    // Helper to parse mailbox messages
    const parseMailboxMessage = async (filePath: string) => {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let title = path.basename(filePath, '.md');
        let status = 'UNREAD';
        let priority = 'medium';
        let from = '';
        let type = 'task';

        if (lines[0] === '---') {
          for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') break;
            if (lines[i].startsWith('title:')) {
              title = lines[i].replace('title:', '').trim().replace(/^["']|["']$/g, '');
            }
            if (lines[i].startsWith('status:')) {
              status = lines[i].replace('status:', '').trim();
            }
            if (lines[i].startsWith('priority:')) {
              priority = lines[i].replace('priority:', '').trim();
            }
            if (lines[i].startsWith('from:')) {
              from = lines[i].replace('from:', '').trim();
            }
            if (lines[i].startsWith('type:')) {
              type = lines[i].replace('type:', '').trim();
            }
          }
        }

        if (title === path.basename(filePath, '.md')) {
          const h1 = lines.find(l => l.startsWith('# '));
          if (h1) title = h1.replace('# ', '').trim();
        }

        const stat = await fs.stat(filePath);
        return {
          id: path.basename(filePath),
          title,
          status,
          priority,
          from,
          type,
          createdAt: stat.birthtime.toISOString(),
        };
      } catch (err) {
        return null;
      }
    };

    // Delivery Track - New 7-terminal architecture
    const terminals = [
      'root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'
    ];

    const swimlanes: any[] = [];

    for (const terminal of terminals) {
      const inboxDir = path.join(terminalsRoot, terminal, 'inbox');
      const outboxDir = path.join(terminalsRoot, terminal, 'outbox');

      let inboxCount = 0;
      let doneCount = 0;
      const inboxMessages: any[] = [];
      const doneMessages: any[] = [];

      try {
        const inboxFiles = await fs.readdir(inboxDir);
        const mdFiles = inboxFiles.filter(f => f.endsWith('.md')).sort().reverse();
        inboxCount = mdFiles.length;

        for (const file of mdFiles.slice(0, 5)) {
          const msg = await parseMailboxMessage(path.join(inboxDir, file));
          if (msg) inboxMessages.push(msg);
        }
      } catch (err) { /* dir may not exist */ }

      try {
        const outboxFiles = await fs.readdir(outboxDir);
        const mdFiles = outboxFiles.filter(f => f.endsWith('.md')).sort().reverse();
        doneCount = mdFiles.length;

        for (const file of mdFiles.slice(0, 5)) {
          const msg = await parseMailboxMessage(path.join(outboxDir, file));
          if (msg) doneMessages.push(msg);
        }
      } catch (err) { /* dir may not exist */ }

      const status = getStatus(terminal);

      swimlanes.push({
        terminal,
        sessionActive: status?.state === 'working',
        totals: { inbox: inboxCount, working: 0, review: 0, done: doneCount },
        columns: {
          inbox: inboxMessages,
          active: [],
          review: [],
          done: doneMessages,
        },
      });
    }

    const delivery = {
      swimlanes,
      activeSessions: swimlanes.filter(s => s.sessionActive).map(s => s.terminal),
      totals: {
        inbox: swimlanes.reduce((sum, s) => sum + s.totals.inbox, 0),
        working: swimlanes.reduce((sum, s) => sum + s.totals.working, 0),
        review: swimlanes.reduce((sum, s) => sum + s.totals.review, 0),
        done: swimlanes.reduce((sum, s) => sum + s.totals.done, 0),
      },
    };

    res.json({ discovery, delivery });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Kanban Metrics ──────────────────────────────────────────────────────────

router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = SPACEOS_ROOT;
    const planningRoot = path.join(projectRoot, 'docs/planning');

    let discoveryWip = 0;
    let deliveryWip = 0;

    try {
      const ideaFiles = await fs.readdir(path.join(planningRoot, 'ideas'));
      discoveryWip += ideaFiles.filter(f => f.endsWith('.md')).length;
    } catch (err) { /* ignore */ }

    try {
      const queueFiles = await fs.readdir(path.join(planningRoot, 'queue'));
      discoveryWip += queueFiles.filter(f => f.endsWith('.md')).length;
    } catch (err) { /* ignore */ }

    const allStatus = getAllStatus();
    const activeSessions = Object.values(allStatus).filter((s: any) => s.state === 'working').length;

    res.json({
      discoveryWip,
      deliveryWip,
      activeSessions,
      throughput: 0,
      cycleTime: 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
