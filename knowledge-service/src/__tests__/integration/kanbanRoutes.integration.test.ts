/**
 * kanban.routes integration tests — hermetic, temp SPACEOS_ROOT tree.
 *
 * PINS the kanban board API contract:
 *  - GET /snapshot: discovery track from docs/planning/* (frontmatter title/
 *    priority, H1 fallback, archive files excluded, debate mirrors the
 *    consensus dir) + delivery track swimlanes from terminals/<t>/inbox|outbox
 *    (message frontmatter parsed, missing dirs tolerated, sessionActive from
 *    the in-memory terminalStatus tracker)
 *  - GET /metrics: discoveryWip = ideas+queue .md counts (archive NOT
 *    excluded here), activeSessions from the status tracker, fixed zeros for
 *    throughput/cycleTime
 *
 * SPACEOS_ROOT is read from env at import time by config/paths, so env is set
 * at module top level BEFORE the dynamic imports in beforeAll. The router is
 * mounted directly on a bare express app (no auth middleware — route logic
 * only).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const runId = crypto.randomBytes(6).toString('hex');
const ROOT = path.join(os.tmpdir(), `kanban-root-${runId}`);
process.env.SPACEOS_ROOT = ROOT;
process.env.TERMINALS_PATH = path.join(ROOT, 'terminals');
process.env.DATA_DIR = path.join(ROOT, 'data');

let request: typeof import('supertest').default;
let app: import('express').Express;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

const PLANNING = path.join(ROOT, 'docs', 'planning');
const TERMINALS = path.join(ROOT, 'terminals');

beforeAll(async () => {
  // Discovery fixtures
  write(path.join(PLANNING, 'ideas', 'idea-frontmatter.md'), [
    '---',
    'title: "Great Idea"',
    'priority: high',
    '---',
    '',
    'body of the idea',
  ].join('\n'));
  write(path.join(PLANNING, 'ideas', 'idea-h1.md'), '# Heading Idea\n\nno frontmatter here');
  write(path.join(PLANNING, 'ideas', 'note-archive.md'), '# Archived\nexcluded from snapshot');
  write(path.join(PLANNING, 'queue', 'q1.md'), '# Queued Item\nqueued');
  write(path.join(PLANNING, 'consensus', 'c1.md'), '# Consensus Item\nagreed');
  fs.mkdirSync(path.join(PLANNING, 'selected'), { recursive: true });
  // no 'debate' dir on disk: the route reads the consensus dir for that stage

  // Delivery fixtures
  write(path.join(TERMINALS, 'root', 'inbox', '2026-07-18_001_task.md'), [
    '---',
    'id: MSG-ROOT-001',
    'from: conductor',
    'to: root',
    'type: task',
    'priority: critical',
    'status: UNREAD',
    'title: "Fix the flux capacitor"',
    '---',
    '',
    '# Fix the flux capacitor',
    'details',
  ].join('\n'));
  write(path.join(TERMINALS, 'root', 'inbox', '2026-07-18_002_no-fm.md'), '# Untitled Task Body\nplain message, H1 title fallback');
  write(path.join(TERMINALS, 'backend', 'outbox', '2026-07-18_001_done.md'), [
    '---',
    'id: MSG-BACKEND-001-DONE',
    'from: backend',
    'to: root',
    'type: done',
    'priority: high',
    'status: READ',
    '---',
    '',
    '# Task complete',
  ].join('\n'));
  // conductor & the rest have no dirs at all -> missing-dir branches

  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;
  const kanbanRoutes = (await import('../../interfaces/http/routes/kanban.routes')).default;
  const terminalStatus = await import('../../terminalStatus');
  terminalStatus.registerWorking('backend', 'MSG-BACKEND-002'); // in-memory only

  const server = express();
  server.use(express.json());
  server.use('/api/kanban', kanbanRoutes);
  app = server;
  request = supertest;
});

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* sqlite may hold locks */ }
});

describe('GET /api/kanban/snapshot', () => {
  it('builds the discovery track from planning dirs with title/priority parsing', async () => {
    const res = await request(app).get('/api/kanban/snapshot');
    expect(res.status).toBe(200);

    interface Item { id: string; title: string; status: string; priority: string; createdAt: string }
    const discovery = res.body.discovery as {
      ideas: Item[]; debate: Item[];
      totals: Record<'ideas' | 'selected' | 'debate' | 'consensus' | 'queue', number>;
    };
    // archive file excluded from items AND totals
    expect(discovery.totals.ideas).toBe(2);
    const ideaTitles = discovery.ideas.map(i => i.title).sort();
    expect(ideaTitles).toEqual(['Great Idea', 'Heading Idea']);

    const great = discovery.ideas.find(i => i.title === 'Great Idea')!;
    expect(great.priority).toBe('high'); // from frontmatter
    expect(great.id).toBe('idea-frontmatter.md');
    expect(great.status).toBe('ideas');
    expect(great.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const h1 = discovery.ideas.find(i => i.title === 'Heading Idea')!;
    expect(h1.priority).toBe('medium'); // default when no frontmatter

    // debate stage reads the consensus dir; both report the same item
    expect(discovery.totals.debate).toBe(1);
    expect(discovery.totals.consensus).toBe(1);
    expect(discovery.debate[0].title).toBe('Consensus Item');
    expect(discovery.totals.queue).toBe(1);
    expect(discovery.totals.selected).toBe(0);
  });

  it('builds delivery swimlanes from terminal mailboxes and the status tracker', async () => {
    const res = await request(app).get('/api/kanban/snapshot');
    expect(res.status).toBe(200);

    interface Msg { id: string; title: string; status: string; priority: string; from: string; type: string }
    interface Lane {
      terminal: string;
      sessionActive: boolean;
      totals: { inbox: number; working: number; review: number; done: number };
      columns: { inbox: Msg[]; active: Msg[]; review: Msg[]; done: Msg[] };
    }
    const delivery = res.body.delivery as {
      swimlanes: Lane[];
      activeSessions: string[];
      totals: { inbox: number; working: number; review: number; done: number };
    };
    const lanes: Record<string, Lane> = Object.fromEntries(delivery.swimlanes.map(s => [s.terminal, s]));

    // All 8 hardcoded terminals get a lane even without dirs on disk
    expect(Object.keys(lanes).sort()).toEqual(
      ['architect', 'backend', 'conductor', 'designer', 'explorer', 'frontend', 'librarian', 'root'].sort()
    );

    expect(lanes.root.totals.inbox).toBe(2);
    const rootInboxTitles = lanes.root.columns.inbox.map(m => m.title).sort();
    expect(rootInboxTitles).toEqual(['Fix the flux capacitor', 'Untitled Task Body']);
    const fm = lanes.root.columns.inbox.find(m => m.title === 'Fix the flux capacitor');
    expect(fm).toMatchObject({ status: 'UNREAD', priority: 'critical', from: 'conductor', type: 'task' });
    const fallback = lanes.root.columns.inbox.find(m => m.title === 'Untitled Task Body');
    expect(fallback).toMatchObject({ status: 'UNREAD', priority: 'medium', from: '', type: 'task' }); // defaults

    expect(lanes.backend.totals.done).toBe(1);
    expect(lanes.backend.columns.done[0].id).toBe('2026-07-18_001_done.md');
    expect(lanes.backend.columns.done[0].status).toBe('READ');

    // terminalStatus tracker drives sessionActive
    expect(lanes.backend.sessionActive).toBe(true);
    expect(lanes.root.sessionActive).toBe(false);
    expect(delivery.activeSessions).toEqual(['backend']);

    // Missing dirs -> empty lane, no error
    expect(lanes.conductor.totals).toEqual({ inbox: 0, working: 0, review: 0, done: 0 });

    // Totals are the sum over lanes
    expect(delivery.totals.inbox).toBe(2);
    expect(delivery.totals.done).toBe(1);
    expect(delivery.totals.working).toBe(0);
  });
});

describe('GET /api/kanban/metrics', () => {
  it('counts discovery WIP (ideas incl. archive-named + queue) and active sessions', async () => {
    const res = await request(app).get('/api/kanban/metrics');
    expect(res.status).toBe(200);
    // metrics does NOT filter archive-named files: 3 idea .md files + 1 queue
    expect(res.body.discoveryWip).toBe(4);
    expect(res.body.deliveryWip).toBe(0);
    expect(res.body.activeSessions).toBe(1); // only backend registered working
    expect(res.body.throughput).toBe(0);
    expect(res.body.cycleTime).toBe(0);
  });
});
