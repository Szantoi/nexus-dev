/**
 * serverClient.ts — Outbound-only HTTP client for the central
 * knowledge-service mailbox API. Bearer token on every request; the
 * server derives the caller identity from it (see auth/tokenAuth.ts).
 */

export interface UnreadTask {
  id: string;
  terminal: string;
  model?: string;
  priority?: string;
  type?: string;
  created?: string;
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
