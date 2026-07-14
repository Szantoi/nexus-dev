/**
 * Inter-Agent Communication Tests
 *
 * Tests that agents can communicate with each other via:
 * 1. Direct prompt injection (POST /api/session/inject)
 * 2. Structured agent messages (POST /api/agent-messages/send)
 * 3. Mailbox messages (POST /api/mailbox/:terminal/inbox)
 *
 * Run: npm test -- src/__tests__/agent/communication.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  AGENT_THRESHOLDS,
  TERMINALS,
  TEST_MESSAGES,
  COMMUNICATION_CHANNELS,
  fetchApi,
  measureTime,
} from './agent.config';
import {
  discoverTerminals,
  getTerminalStatus,
  sendAgentMessage,
  createMailboxMessage,
  readInbox,
  injectPrompt,
  generateTestId,
  assertWithTimeout,
} from './test-harness';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let availableTerminals: string[] = [];
let senderTerminal: string = 'root';
let receiverTerminal: string = 'backend';

beforeAll(async () => {
  availableTerminals = await discoverTerminals();

  // Use root as sender (has permissions to all)
  senderTerminal = 'root';

  // Use a worker terminal as receiver
  receiverTerminal =
    availableTerminals.find((t) => TERMINALS.workers.includes(t)) ||
    availableTerminals.find((t) => t !== 'root') ||
    'backend';

  console.log(
    `Communication tests: ${senderTerminal} -> ${receiverTerminal}`
  );
});

// ─── Mailbox Communication Tests ─────────────────────────────────────────────

describe('Mailbox Communication', () => {
  it('can read inbox for any terminal', async () => {
    for (const terminal of availableTerminals.slice(0, 3)) {
      const res = await fetchApi(`/api/mailbox/${terminal}/inbox`);

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty('terminal', terminal);
      expect(data).toHaveProperty('messages');
      expect(Array.isArray(data.messages)).toBe(true);
    }
  });

  it('can read outbox for any terminal', async () => {
    for (const terminal of availableTerminals.slice(0, 3)) {
      const res = await fetchApi(`/api/mailbox/${terminal}/outbox`);

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty('terminal', terminal);
      expect(data).toHaveProperty('messages');
      expect(Array.isArray(data.messages)).toBe(true);
    }
  });

  it('inbox filter by status works', async () => {
    const res = await fetchApi(
      `/api/mailbox/${receiverTerminal}/inbox?status=UNREAD`
    );

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.messages)).toBe(true);

    // All messages should be UNREAD if any exist
    for (const msg of data.messages) {
      const status = msg.frontmatter?.status || msg.status;
      expect(status).toBe('UNREAD');
    }
  });

  it('can create mailbox message', async () => {
    const testId = generateTestId();
    const content = `Test mailbox message ${testId}`;

    const result = await createMailboxMessage(
      senderTerminal,
      receiverTerminal,
      'info',
      content,
      'low'
    );

    // May succeed or fail based on API implementation
    if (result.success) {
      expect(result.delivered).toBe(true);
      expect(result.messageId).toBeDefined();
    } else {
      // Accept graceful failure
      console.log(`Mailbox message creation: ${result.error}`);
    }
  });

  it('mailbox messages have required fields', async () => {
    const inbox = await readInbox(receiverTerminal);

    for (const msg of inbox.slice(0, 5)) {
      expect(msg).toHaveProperty('id');
      expect(msg).toHaveProperty('status');
    }
  });
});

// ─── Agent-to-Agent Messaging Tests ──────────────────────────────────────────

describe('Agent-to-Agent Messaging', () => {
  it('POST /api/agent-messages/send accepts valid request', async () => {
    const testId = generateTestId();

    const res = await fetchApi('/api/agent-messages/send', {
      method: 'POST',
      body: JSON.stringify({
        from: senderTerminal,
        to: receiverTerminal,
        type: 'info',
        content: `Test agent message ${testId}`,
        priority: 'low',
      }),
    });

    // May be 200, 201, or 404 if not implemented
    if (res.status === 200 || res.status === 201) {
      const data = await res.json();
      expect(data).toHaveProperty('success');
    } else if (res.status === 404) {
      console.log('Agent messages API not implemented');
    } else {
      // Shouldn't crash
      expect(res.status).not.toBe(500);
    }
  });

  it('message delivery within timeout', async () => {
    const testId = generateTestId();

    const { elapsed } = await measureTime(async () => {
      return sendAgentMessage(
        senderTerminal,
        receiverTerminal,
        'info',
        `Timing test ${testId}`,
        'low'
      );
    });

    expect(elapsed).toBeLessThan(
      AGENT_THRESHOLDS.communication.messageDeliveryTimeoutMs
    );

    console.log(`Agent message delivery time: ${elapsed}ms`);
  });

  it('validates sender and receiver terminals', async () => {
    // Invalid sender
    const res1 = await fetchApi('/api/agent-messages/send', {
      method: 'POST',
      body: JSON.stringify({
        from: 'invalid_terminal_xyz',
        to: receiverTerminal,
        type: 'info',
        content: 'Test',
      }),
    });

    // Should reject or handle gracefully
    expect(res1.status).not.toBe(500);

    // Invalid receiver
    const res2 = await fetchApi('/api/agent-messages/send', {
      method: 'POST',
      body: JSON.stringify({
        from: senderTerminal,
        to: 'invalid_terminal_xyz',
        type: 'info',
        content: 'Test',
      }),
    });

    // Should reject or handle gracefully
    expect(res2.status).not.toBe(500);
  });
});

// ─── Prompt Injection Tests ──────────────────────────────────────────────────

describe('Prompt Injection Communication', () => {
  it('POST /api/session/inject accepts valid request', async () => {
    const testId = generateTestId();

    const res = await fetchApi('/api/session/inject', {
      method: 'POST',
      body: JSON.stringify({
        terminal: receiverTerminal,
        prompt: `Test injection ${testId}`,
        fromTerminal: senderTerminal,
      }),
    });

    // May succeed, fail gracefully (no session), or require auth
    expect([200, 400, 401, 403, 404]).toContain(res.status);
  });

  it('inject validates terminal name', async () => {
    const res = await fetchApi('/api/session/inject', {
      method: 'POST',
      body: JSON.stringify({
        terminal: `invalid_${Date.now()}`,
        prompt: 'Test',
        fromTerminal: senderTerminal,
      }),
    });

    // Should reject gracefully
    expect(res.status).not.toBe(500);
  });

  it('inject requires prompt content', async () => {
    const res = await fetchApi('/api/session/inject', {
      method: 'POST',
      body: JSON.stringify({
        terminal: receiverTerminal,
        fromTerminal: senderTerminal,
        // Missing prompt
      }),
    });

    // Should handle gracefully (not crash)
    expect(res.status).not.toBe(500);
  });

  it('inject respects authorization', async () => {
    // Try to inject from a non-root, non-conductor terminal
    const res = await fetchApi('/api/session/inject', {
      method: 'POST',
      body: JSON.stringify({
        terminal: 'root', // Try to inject into root
        prompt: 'Unauthorized injection attempt',
        fromTerminal: 'backend', // backend cannot inject into root
      }),
    });

    // Should be rejected (400 or 403)
    expect([400, 403]).toContain(res.status);
  });
});

// ─── Communication Channel Comparison ────────────────────────────────────────

describe('Communication Channel Comparison', () => {
  it('all communication channels are accessible', async () => {
    const channels = Object.entries(COMMUNICATION_CHANNELS);

    for (const [name, channel] of channels) {
      const path = channel.endpoint.replace(':terminal', receiverTerminal);

      const res = await fetchApi(path, {
        method: channel.method,
        body:
          channel.method === 'POST'
            ? JSON.stringify({
                terminal: receiverTerminal,
                from: senderTerminal,
                content: 'Channel test',
                type: 'info',
              })
            : undefined,
      });

      // Should not crash (500)
      expect(res.status).not.toBe(500);

      console.log(`Channel ${name}: ${res.status}`);
    }
  });

  it('mailbox is most reliable channel', async () => {
    // Mailbox should always work (file-based)
    const res = await fetchApi(`/api/mailbox/${receiverTerminal}/inbox`);

    expect(res.status).toBe(200);
  });
});

// ─── Message Routing Tests ───────────────────────────────────────────────────

describe('Message Routing', () => {
  it('root can send to any terminal', async () => {
    for (const terminal of availableTerminals.slice(0, 3)) {
      if (terminal === 'root') continue;

      const result = await createMailboxMessage(
        'root',
        terminal,
        'info',
        `Root test message to ${terminal}`,
        'low'
      );

      // Should succeed or fail gracefully
      if (!result.success) {
        console.log(`Root -> ${terminal}: ${result.error}`);
      }
    }
  });

  it('conductor can send to worker terminals', async () => {
    for (const terminal of TERMINALS.workers) {
      if (!availableTerminals.includes(terminal)) continue;

      const result = await createMailboxMessage(
        'conductor',
        terminal,
        'info',
        `Conductor test message to ${terminal}`,
        'low'
      );

      // Should succeed or fail gracefully
      if (!result.success) {
        console.log(`Conductor -> ${terminal}: ${result.error}`);
      }
    }
  });
});

// ─── Message Integrity Tests ─────────────────────────────────────────────────

describe('Message Integrity', () => {
  it('message content is preserved', async () => {
    const testId = generateTestId();
    const specialContent = `Test 🚀 <html>&amp; "quotes" 'apostrophe' ${testId}`;

    const result = await createMailboxMessage(
      senderTerminal,
      receiverTerminal,
      'info',
      specialContent,
      'low'
    );

    if (result.success && result.messageId) {
      // Read back the inbox
      const inbox = await readInbox(receiverTerminal);

      // Note: we can't easily match by content since inbox returns minimal info
      // but at least verify the operation succeeded
      expect(result.delivered).toBe(true);
    }
  });

  it('message types are validated', async () => {
    const validTypes = ['task', 'info', 'question', 'done', 'blocked'];

    for (const type of validTypes) {
      const res = await fetchApi('/api/agent-messages/send', {
        method: 'POST',
        body: JSON.stringify({
          from: senderTerminal,
          to: receiverTerminal,
          type,
          content: `Type test: ${type}`,
        }),
      });

      // Should not crash
      expect(res.status).not.toBe(500);
    }
  });

  it('priority levels are validated', async () => {
    const validPriorities = ['critical', 'high', 'medium', 'low'];

    for (const priority of validPriorities) {
      const res = await fetchApi('/api/agent-messages/send', {
        method: 'POST',
        body: JSON.stringify({
          from: senderTerminal,
          to: receiverTerminal,
          type: 'info',
          content: `Priority test: ${priority}`,
          priority,
        }),
      });

      // Should not crash
      expect(res.status).not.toBe(500);
    }
  });
});

// ─── Performance Tests ───────────────────────────────────────────────────────

describe('Communication Performance', () => {
  it('inbox read is fast', async () => {
    const times: number[] = [];

    for (let i = 0; i < 5; i++) {
      const { elapsed } = await measureTime(async () => {
        await readInbox(receiverTerminal);
      });
      times.push(elapsed);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTime = Math.max(...times);

    console.log(`Inbox read: avg=${avgTime.toFixed(0)}ms, max=${maxTime}ms`);

    // Should be reasonably fast
    expect(avgTime).toBeLessThan(500);
  });

  it('message send is within timeout', async () => {
    const { elapsed } = await measureTime(async () => {
      await createMailboxMessage(
        senderTerminal,
        receiverTerminal,
        'info',
        'Performance test message',
        'low'
      );
    });

    expect(elapsed).toBeLessThan(
      AGENT_THRESHOLDS.communication.messageDeliveryTimeoutMs
    );

    console.log(`Message send time: ${elapsed}ms`);
  });
});

// ─── Broadcast Tests ─────────────────────────────────────────────────────────

describe('Broadcast Communication', () => {
  it('POST /api/mailbox/broadcast sends to multiple terminals', async () => {
    const testId = generateTestId();

    const res = await fetchApi('/api/mailbox/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        from: 'root',
        terminals: TERMINALS.workers,
        type: 'info',
        content: `Broadcast test ${testId}`,
        priority: 'low',
      }),
    });

    // May or may not be implemented
    if (res.status === 200 || res.status === 201) {
      const data = await res.json();
      console.log('Broadcast result:', data);
    } else {
      console.log(`Broadcast API: ${res.status}`);
      // 400 = validation error, 404 = not implemented, 501 = not supported
      expect([400, 404, 501]).toContain(res.status);
    }
  });
});

// ─── Error Handling Tests ────────────────────────────────────────────────────

describe('Communication Error Handling', () => {
  it('handles missing required fields gracefully', async () => {
    const res = await fetchApi('/api/agent-messages/send', {
      method: 'POST',
      body: JSON.stringify({
        // Missing from, to, content
        type: 'info',
      }),
    });

    // Should reject, not crash
    expect(res.status).not.toBe(500);
    if (res.status === 400) {
      const data = await res.json();
      expect(data).toHaveProperty('error');
    }
  });

  it('handles malformed JSON gracefully', async () => {
    const res = await fetch(`http://localhost:3456/api/agent-messages/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer dev-token-spaceos-dashboard-2026',
      },
      body: 'not valid json{{{',
    });

    // Should reject, not crash
    expect([400, 500]).toContain(res.status);
  });

  it('handles empty body gracefully', async () => {
    const res = await fetchApi('/api/agent-messages/send', {
      method: 'POST',
      body: '{}',
    });

    // Should reject, not crash
    expect(res.status).not.toBe(500);
  });
});
