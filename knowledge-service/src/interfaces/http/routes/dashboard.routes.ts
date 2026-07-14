/**
 * Dashboard Routes
 * Terminal overview, metrics for React dashboard
 */

import { Router, Request, Response } from 'express';
import { getStatus } from '../../../terminalStatus';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';

const router = Router();

// ─── Dashboard Overview ──────────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = SPACEOS_ROOT;
    const terminalsRoot = path.join(projectRoot, 'terminals');

    // Get all terminals status - new role-based architecture
    const terminals: any[] = [];
    const terminalNames = [
      'root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'
    ];

    for (const terminal of terminalNames) {
      const inboxDir = path.join(terminalsRoot, terminal, 'inbox');
      const outboxDir = path.join(terminalsRoot, terminal, 'outbox');

      let inboxCount = 0;
      let outboxCount = 0;
      let unreadInbox = 0;
      let unreadOutbox = 0;

      try {
        const inboxFiles = await fs.readdir(inboxDir);
        inboxCount = inboxFiles.filter(f => f.endsWith('.md')).length;
        for (const file of inboxFiles.filter(f => f.endsWith('.md'))) {
          const content = await fs.readFile(path.join(inboxDir, file), 'utf-8');
          if (content.includes('status: UNREAD')) unreadInbox++;
        }
      } catch (err) { /* dir may not exist */ }

      try {
        const outboxFiles = await fs.readdir(outboxDir);
        outboxCount = outboxFiles.filter(f => f.endsWith('.md')).length;
        for (const file of outboxFiles.filter(f => f.endsWith('.md'))) {
          const content = await fs.readFile(path.join(outboxDir, file), 'utf-8');
          if (content.includes('status: UNREAD')) unreadOutbox++;
        }
      } catch (err) { /* dir may not exist */ }

      const status = getStatus(terminal);

      terminals.push({
        name: terminal,
        inbox: inboxCount,
        outbox: outboxCount,
        unreadInbox,
        unreadOutbox,
        status: status?.state || 'idle',
        lastActivity: status?.lastActivity || null,
      });
    }

    // Global metrics
    const totalInbox = terminals.reduce((sum, t) => sum + t.inbox, 0);
    const totalOutbox = terminals.reduce((sum, t) => sum + t.outbox, 0);
    const totalUnread = terminals.reduce((sum, t) => sum + t.unreadInbox + t.unreadOutbox, 0);
    const activeSessions = terminals.filter(t => t.status === 'working').length;

    res.json({
      timestamp: new Date().toISOString(),
      metrics: {
        totalInbox,
        totalOutbox,
        totalUnread,
        activeSessions,
        terminals: terminals.length,
      },
      terminals,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
