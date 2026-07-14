/**
 * API Integration Test Configuration
 * Calibratable thresholds for statistical validation
 */

export const API_CONFIG = {
  baseUrl: process.env.TEST_API_URL || 'http://localhost:3456',
  authToken: process.env.TEST_AUTH_TOKEN || 'dev-token-spaceos-dashboard-2026',
  timeout: 5000,
};

/**
 * Statistical thresholds - calibratable per environment
 * These can be adjusted based on expected system state
 */
export const THRESHOLDS = {
  // Health endpoint
  health: {
    minDocuments: 100,       // Minimum expected indexed documents
    maxDocuments: 10000,     // Maximum reasonable documents
    expectedPort: 3456,
    validVectorBackends: ['chroma', 'chromadb', 'in-memory'],
    validEmbeddingBackends: ['voyage', 'gemini', 'chromadb-server', 'local'],
  },

  // Dashboard metrics
  dashboard: {
    minTerminals: 7,         // 7 terminals in current architecture
    maxTerminals: 15,        // Allow some growth
    minInboxMessages: 0,
    maxInboxMessages: 500,   // Reasonable upper bound
    minOutboxMessages: 0,
    maxOutboxMessages: 1000,
    validStatuses: ['idle', 'working', 'blocked'],
  },

  // Mailbox
  mailbox: {
    minMessages: 0,
    maxMessagesPerTerminal: 200,
    validMessageStatuses: ['UNREAD', 'READ'],
    validMessageTypes: ['task', 'done', 'blocked', 'question', 'info', 'escalation'],
    validPriorities: ['critical', 'high', 'medium', 'low'],
  },

  // Kanban
  kanban: {
    minDiscoveryItems: 0,
    maxDiscoveryItems: 100,
    minDeliveryItems: 0,
    maxDeliveryItems: 200,
    validStages: ['ideas', 'selected', 'debate', 'consensus', 'queue'],
  },

  // Response times (ms)
  performance: {
    healthMaxMs: 100,
    dashboardMaxMs: 500,
    mailboxListMaxMs: 300,
    searchMaxMs: 2000,
  },
};

/**
 * Terminal names expected in the system
 */
export const EXPECTED_TERMINALS = [
  'root',
  'conductor',
  'architect',
  'librarian',
  'explorer',
  'backend',
  'frontend',
  'designer',
];

/**
 * Helper to check if value is within range
 */
export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Helper to check if value is in allowed set
 */
export function isValidValue<T>(value: T, allowed: T[]): boolean {
  return allowed.includes(value);
}

/**
 * Helper for approximate equality (for floating point)
 */
export function approxEqual(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) <= tolerance;
}
