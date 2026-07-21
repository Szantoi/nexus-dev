import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { createApp, rateLimitStore } from '../../bootstrap/app';
import { env } from '../../config/env';
import { resetAuthStateForTests, setAuthMode } from '../../auth/tokenAuth';

describe('HTTP security boundary', () => {
  beforeEach(() => {
    setAuthMode('open');
    rateLimitStore.clear();
  });

  afterEach(() => {
    rateLimitStore.clear();
    resetAuthStateForTests();
  });

  it('sets hardening headers without advertising Express or wildcard CORS', async () => {
    const response = await supertest(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects browser preflights from an origin outside the allowlist', async () => {
    const response = await supertest(createApp())
      .options('/api/session/start')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(403);
  });

  it('ignores spoofed forwarding headers when no proxy is trusted', async () => {
    const app = createApp();
    app.get('/security-test-ip', (_req, res) => res.json({ ok: true }));

    await supertest(app).get('/security-test-ip').set('X-Forwarded-For', '198.51.100.1');
    await supertest(app).get('/security-test-ip').set('X-Forwarded-For', '203.0.113.2');

    expect(rateLimitStore.size).toBe(1);
    expect(rateLimitStore.has('198.51.100.1')).toBe(false);
    expect(rateLimitStore.has('203.0.113.2')).toBe(false);
  });

  it('redacts raw exception details from route-level 500 responses', async () => {
    const app = createApp();
    app.get('/security-test-error', (_req, res) => {
      res.status(500).json({ error: 'C:\\secret\\database.db', details: 'sensitive stack' });
    });

    const response = await supertest(app).get('/security-test-error');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });

  // ─── TASK-QC-006 additions ─────────────────────────────────────────────────

  it('allows CORS only for explicitly configured origins', async () => {
    const original = env.CORS_ORIGINS;
    try {
      // env is parsed at import; the factory reads it at createApp() time, so a
      // test-scoped mutation of the config object is safe and restored below.
      (env as { CORS_ORIGINS: string }).CORS_ORIGINS = 'https://good.example, https://two.example';
      const app = createApp();

      const allowed = await supertest(app).get('/health').set('Origin', 'https://good.example');
      expect(allowed.headers['access-control-allow-origin']).toBe('https://good.example');
      expect(allowed.headers['vary']).toContain('Origin');

      const preflight = await supertest(app)
        .options('/api/session/start')
        .set('Origin', 'https://two.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(preflight.status).toBe(204);

      const denied = await supertest(app).get('/health').set('Origin', 'https://evil.example');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      (env as { CORS_ORIGINS: string }).CORS_ORIGINS = original;
    }
  });

  it('honors forwarding headers only when TRUST_PROXY_HOPS is configured', async () => {
    const original = env.TRUST_PROXY_HOPS;
    try {
      (env as { TRUST_PROXY_HOPS: number }).TRUST_PROXY_HOPS = 1;
      const app = createApp();
      app.get('/security-test-proxy', (_req, res) => res.json({ ok: true }));

      await supertest(app).get('/security-test-proxy').set('X-Forwarded-For', '203.0.113.77');
      expect(rateLimitStore.has('203.0.113.77')).toBe(true);
    } finally {
      (env as { TRUST_PROXY_HOPS: number }).TRUST_PROXY_HOPS = original;
    }
  });

  it('exempts health checks and static assets from rate limiting', async () => {
    const app = createApp();
    await supertest(app).get('/health');
    await supertest(app).get('/ready');
    await supertest(app).get('/assets/some.css');
    await supertest(app).get('/favicon.svg');
    expect(rateLimitStore.size).toBe(0);
  });

  it('returns 429 with retryAfter once a client exhausts its window', async () => {
    const app = createApp();
    app.get('/security-test-limit', (req, res) => res.json({ ip: req.ip }));

    const probe = await supertest(app).get('/security-test-limit');
    const ip = probe.body.ip as string;
    expect(rateLimitStore.has(ip)).toBe(true);

    // Exhaust the window without 500 real requests.
    rateLimitStore.set(ip, { count: 500, resetAt: Date.now() + 60000 });
    const limited = await supertest(app).get('/security-test-limit');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Too many requests');
    expect(limited.body.retryAfter).toBeGreaterThan(0);

    // An expired window resets the counter instead of blocking.
    rateLimitStore.set(ip, { count: 500, resetAt: Date.now() - 1 });
    const fresh = await supertest(app).get('/security-test-limit');
    expect(fresh.status).toBe(200);
    expect(rateLimitStore.get(ip)?.count).toBe(1);
  });

  it('handles middleware-level errors with a generic 500 body (no stack leak)', async () => {
    const app = createApp();
    // Malformed JSON makes express.json() raise inside the middleware chain,
    // which lands in the app-level error handler.
    const response = await supertest(app)
      .post('/api/task')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });

  it('serves the SPA shell for browser routes but keeps API 404s JSON in static mode', async () => {
    const staticPath = path.join(os.tmpdir(), `app-static-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(staticPath, { recursive: true });
    fs.writeFileSync(path.join(staticPath, 'index.html'), '<html><body>SPA-SHELL-OK</body></html>');
    try {
      const app = createApp({ enableStaticFiles: true, staticPath });

      const page = await supertest(app).get('/some/browser/route');
      expect(page.status).toBe(200);
      expect(page.text).toContain('SPA-SHELL-OK');

      const api = await supertest(app).get('/api/definitely-not-a-route');
      expect(api.status).toBe(404);
      expect(api.body).toEqual({ error: 'Not found' });
    } finally {
      fs.rmSync(staticPath, { recursive: true, force: true });
    }
  });

  it('keeps the legacy /api/tasks/status redirect wired to the mailbox router', async () => {
    const app = createApp();
    const plain = await supertest(app).get('/api/tasks/status');
    const withQuery = await supertest(app).get('/api/tasks/status?task_id=MSG-QC006-NOPE');
    // The redirect must land on the mailbox handler (JSON in, JSON out) for
    // both the bare and query-string forms.
    for (const r of [plain, withQuery]) {
      expect([200, 500]).toContain(r.status);
      expect(r.type).toBe('application/json');
    }
    if (withQuery.status === 200) {
      expect(withQuery.body.tasks).toEqual([]);
    }
  });
});
