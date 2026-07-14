/**
 * Agent Testing Configuration
 * Calibratable thresholds for agent behavior validation
 *
 * These tests validate:
 * - Identity understanding (CLAUDE.md comprehension)
 * - Memory persistence (cold start recall)
 * - Graceful shutdown (context saving)
 * - Inter-agent communication
 * - MCP tool usage
 */

export const API_CONFIG = {
  baseUrl: process.env.TEST_API_URL || 'http://localhost:3456',
  authToken: process.env.TEST_AUTH_TOKEN || 'dev-token-spaceos-dashboard-2026',
  timeout: 30000, // Agent operations can be slow
};

/**
 * Terminal definitions - dynamically discovered but with fallback
 */
export const TERMINALS = {
  priority: ['root', 'conductor'],
  workers: ['backend', 'frontend', 'designer'],
  support: ['architect', 'librarian', 'explorer'],
  all: ['root', 'conductor', 'backend', 'frontend', 'designer', 'architect', 'librarian', 'explorer'],
};

/**
 * Agent behavior thresholds - calibratable per environment
 */
export const AGENT_THRESHOLDS = {
  // Identity verification
  identity: {
    minSimilarityScore: 0.7,        // Semantic similarity to CLAUDE.md
    maxResponseTimeMs: 15000,       // Identity question response time
    requiredFields: ['role', 'responsibilities', 'boundaries'],
  },

  // Memory persistence (cold start)
  memory: {
    coldStartRecallAccuracy: 0.85,  // % of facts recalled after restart
    memoryWriteTimeoutMs: 5000,     // Max time to write MEMORY.md
    minPersistenceRate: 0.90,       // % of writes that survive restart
    factRecallTimeoutMs: 10000,     // Max time to recall a fact
  },

  // Graceful shutdown
  shutdown: {
    maxGracefulShutdownMs: 30000,   // Max time for graceful shutdown
    contextSaveSuccessRate: 0.95,   // % of shutdowns with context saved
    statusPropagationMaxMs: 5000,   // Max time to update Datahaven
  },

  // Inter-agent communication
  communication: {
    messageDeliveryTimeoutMs: 10000,  // Max time for message delivery
    roundTripTimeoutMs: 30000,        // Max time for send + response
    deliverySuccessRate: 0.98,        // % of messages delivered
    ackTimeoutMs: 5000,               // Max time for acknowledgement
  },

  // MCP tool usage
  mcpTools: {
    toolSelectionAccuracy: 0.95,    // Correct tool selected
    parameterAccuracy: 0.98,        // Correct parameters
    resultParsingSuccess: 0.99,     // Result correctly parsed
    toolCallTimeoutMs: 10000,       // Max time for tool execution
  },

  // Session state machine
  stateMachine: {
    validTransitions: [
      ['idle', 'working'],
      ['working', 'idle'],
      ['working', 'blocked'],
      ['blocked', 'working'],
      ['blocked', 'idle'],
    ] as const,
    statusUpdateMaxMs: 3000,        // Max time for status update
  },
};

/**
 * Test facts for memory persistence testing
 * These facts are injected and then recalled after restart
 */
export const TEST_FACTS = [
  { key: 'kernel_port', value: '5001', question: 'Mi a Kernel portja?' },
  { key: 'db_name', value: 'spaceos_prod', question: 'Mi az adatbázis neve?' },
  { key: 'api_version', value: 'v2.3.1', question: 'Mi az API verzió?' },
  { key: 'secret_code', value: 'ALPHA-7742', question: 'Mi a titkos kód?' },
  { key: 'deploy_date', value: '2026-06-15', question: 'Mikor volt az utolsó deploy?' },
];

/**
 * Identity questions for different languages
 */
export const IDENTITY_QUESTIONS = {
  hu: ['Ki vagy te?', 'Mi a szereped?', 'Mit csinálsz?'],
  en: ['Who are you?', 'What is your role?', 'What do you do?'],
};

/**
 * Inter-agent test messages
 */
export const TEST_MESSAGES = {
  ping: {
    type: 'test',
    content: 'PING-TEST-' + Date.now(),
    expectResponse: true,
  },
  task: {
    type: 'task',
    content: 'Test task for agent communication validation',
    expectResponse: true,
  },
  info: {
    type: 'info',
    content: 'Informational message - no response expected',
    expectResponse: false,
  },
};

/**
 * Communication channels available for inter-agent messaging
 */
export const COMMUNICATION_CHANNELS = {
  inject: {
    endpoint: '/api/session/inject',
    method: 'POST',
    description: 'Direct prompt injection into running session',
  },
  agentMessage: {
    endpoint: '/api/agent-messages/send',
    method: 'POST',
    description: 'Structured agent-to-agent message',
  },
  mailbox: {
    endpoint: '/api/mailbox/:terminal/inbox',
    method: 'POST',
    description: 'Async file-based mailbox message',
  },
};

/**
 * File paths for terminal resources
 */
export const TERMINAL_PATHS = {
  base: '/opt/spaceos/terminals',
  getClaudeMd: (terminal: string) => `/opt/spaceos/terminals/${terminal}/CLAUDE.md`,
  getMemoryMd: (terminal: string) => `/opt/spaceos/terminals/${terminal}/MEMORY.md`,
  getInbox: (terminal: string) => `/opt/spaceos/terminals/${terminal}/inbox`,
  getOutbox: (terminal: string) => `/opt/spaceos/terminals/${terminal}/outbox`,
};

/**
 * Helper to make authenticated API requests
 */
export async function fetchApi(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${API_CONFIG.baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (API_CONFIG.authToken) {
    headers['Authorization'] = `Bearer ${API_CONFIG.authToken}`;
  }

  return fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(API_CONFIG.timeout),
  });
}

/**
 * Helper to check if a value is within expected range
 */
export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Helper to measure execution time
 */
export async function measureTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; elapsed: number }> {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  return { result, elapsed };
}

/**
 * Helper to retry an operation with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }

  throw lastError;
}
