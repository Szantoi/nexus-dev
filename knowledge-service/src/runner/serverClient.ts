/**
 * serverClient.ts — Outbound-only HTTP client for the central
 * knowledge-service mailbox API. Bearer token on every request; the
 * server derives the caller identity from it (see auth/tokenAuth.ts).
 */

import { createHash } from 'node:crypto';

export interface UnreadTask {
  id: string;
  terminal: string;
  model?: string;
  priority?: string;
  type?: string;
  created?: string;
}

export interface RunnerCompletionReceipt {
  sequence: number;
  islandId: string;
  terminalId: string;
  messageId: string;
  completedAt: string;
  source: 'mcp_complete_task';
}

export interface CompletionReceiptPage {
  islandId: string;
  receipts: RunnerCompletionReceipt[];
  nextCursor: number;
  hasMore: boolean;
}

export class ServerApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

interface InboxResponseMessage {
  frontmatter?: {
    id?: string;
    model?: string;
    priority?: string;
    type?: string;
    created?: string;
  };
}

export class ServerClient {
  private readonly baseUrl: string;

  constructor(
    serverUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = serverUrl.replace(/\/+$/, '');
  }

  /** GET /api/mailbox/:terminal/inbox?status=UNREAD */
  async fetchUnread(terminal: string): Promise<UnreadTask[]> {
    const url = `${this.baseUrl}/api/mailbox/${encodeURIComponent(terminal)}/inbox?status=UNREAD&metadata=true`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!res.ok) {
      throw new ServerApiError(res.status, `fetchUnread(${terminal}) -> HTTP ${res.status}`);
    }

    const body = (await res.json()) as { messages?: InboxResponseMessage[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const tasks: UnreadTask[] = [];
    for (const m of messages) {
      const id = m.frontmatter?.id;
      if (!id) continue; // Malformed message — the server logs it, we skip it
      tasks.push({
        id,
        terminal,
        model: m.frontmatter?.model,
        priority: m.frontmatter?.priority,
        type: m.frontmatter?.type,
        created: m.frontmatter?.created,
      });
    }
    return tasks;
  }

  async claimTask(terminal: string, messageId: string): Promise<void> {
    await this.postTaskTransition(terminal, messageId, 'claim');
  }

  /** Durable completion replay; SSE may wake this query but is never truth. */
  async fetchCompletionReceipts(
    terminal: string,
    expectedIslandId: string,
    after: number,
    limit = 100,
  ): Promise<CompletionReceiptPage> {
    if (!expectedIslandId) {
      throw new Error('expectedIslandId must be non-empty');
    }
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError('after must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('limit must be an integer between 1 and 500');
    }

    const url = `${this.baseUrl}/api/mailbox/${encodeURIComponent(terminal)}/completions?after=${after}&limit=${limit}`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new ServerApiError(
        res.status,
        `fetchCompletionReceipts(${terminal}, after=${after}) -> HTTP ${res.status}`,
      );
    }

    const body = (await res.json()) as Partial<CompletionReceiptPage>;
    if (
      !Array.isArray(body.receipts) ||
      body.islandId !== expectedIslandId ||
      !Number.isSafeInteger(body.nextCursor) ||
      (body.nextCursor as number) < after ||
      typeof body.hasMore !== 'boolean'
    ) {
      throw new ServerApiError(502, 'Malformed completion receipt page');
    }

    const receipts: RunnerCompletionReceipt[] = [];
    let previousSequence = after;
    for (const value of body.receipts) {
      const receipt = value as Partial<RunnerCompletionReceipt>;
      if (
        !Number.isSafeInteger(receipt.sequence) ||
        (receipt.sequence as number) <= previousSequence ||
        receipt.terminalId !== terminal ||
        receipt.islandId !== expectedIslandId ||
        typeof receipt.messageId !== 'string' ||
        !receipt.messageId ||
        typeof receipt.completedAt !== 'string' ||
        receipt.source !== 'mcp_complete_task'
      ) {
        throw new ServerApiError(502, 'Malformed or out-of-scope completion receipt');
      }
      previousSequence = receipt.sequence as number;
      receipts.push(receipt as RunnerCompletionReceipt);
    }

    const expectedCursor = receipts.length > 0 ? receipts[receipts.length - 1].sequence : after;
    if ((body.nextCursor as number) !== expectedCursor) {
      throw new ServerApiError(502, 'Completion receipt cursor does not match page contents');
    }
    return {
      islandId: expectedIslandId,
      receipts,
      nextCursor: body.nextCursor as number,
      hasMore: body.hasMore,
    };
  }

  /**
   * Cursor namespace bound to endpoint, expected island, terminal and a
   * non-reversible credential fingerprint. Token or island rotation therefore
   * starts from a separate cursor instead of skipping the new scope's rows.
   */
  completionStreamKey(terminal: string, expectedIslandId: string): string {
    if (!terminal || !expectedIslandId) {
      throw new Error('Completion stream terminal and island must be non-empty');
    }
    const credentialFingerprint = createHash('sha256')
      .update(this.token)
      .digest('hex')
      .slice(0, 24);
    return JSON.stringify([
      this.baseUrl,
      expectedIslandId,
      terminal,
      credentialFingerprint,
    ]);
  }

  async releaseTask(terminal: string, messageId: string): Promise<void> {
    await this.postTaskTransition(terminal, messageId, 'release');
  }

  private async postTaskTransition(
    terminal: string,
    messageId: string,
    action: 'claim' | 'release',
  ): Promise<void> {
    const url = `${this.baseUrl}/api/mailbox/${encodeURIComponent(terminal)}/inbox/${encodeURIComponent(messageId)}/${action}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new ServerApiError(res.status, `${action}Task(${terminal}/${messageId}) -> HTTP ${res.status}`);
    }
  }
}
