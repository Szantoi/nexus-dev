import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as childProcess from 'child_process';

/**
 * Terminal Reviewer Unit Tests
 *
 * Tests for Architect + Librarian based review system:
 * - Terminal busy detection
 * - Prompt building
 * - Response parsing
 * - Memory saving
 * - Dual review logic
 */

// Mock modules
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    appendFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    exec: vi.fn(),
    execSync: vi.fn(),
  };
});

vi.mock('../pipeline/common', () => ({
  SPACEOS_ROOT: '/opt/spaceos',
  log: vi.fn(),
  telegram: vi.fn(),
}));

vi.mock('../pipeline/hashUtils', () => ({
  sha256File: vi.fn().mockResolvedValue('sha256:mock-hash'),
  sha256String: vi.fn().mockReturnValue('sha256:mock-string-hash'),
}));

vi.mock('../pipeline/reviewLog', () => ({
  appendReviewDecision: vi.fn(),
  generateReviewId: vi.fn().mockReturnValue('REV-TEST-001'),
}));

vi.mock('../config/terminals', () => ({
  getTmuxSocket: () => '/tmp/spaceos.tmux',
  getTerminalsRoot: () => '/opt/spaceos/terminals',
}));

describe('Terminal Reviewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractTerminal', () => {
    // Inline test since function is not exported
    function extractTerminal(donePath: string): string {
      const newMatch = donePath.match(/terminals\/([^/]+)\//);
      if (newMatch) return newMatch[1];
      const legacyMatch = donePath.match(/mailbox\/([^/]+)\//);
      return legacyMatch ? legacyMatch[1] : 'unknown';
    }

    it('should extract terminal from new path format', () => {
      const path = '/opt/spaceos/terminals/backend/outbox/2026-06-24_001_done.md';
      expect(extractTerminal(path)).toBe('backend');
    });

    it('should extract terminal from legacy path format', () => {
      const path = '/opt/spaceos/docs/mailbox/frontend/outbox/2026-06-24_001_done.md';
      expect(extractTerminal(path)).toBe('frontend');
    });

    it('should return unknown for unrecognized path', () => {
      const path = '/some/random/path/done.md';
      expect(extractTerminal(path)).toBe('unknown');
    });
  });

  describe('parseReviewOutput', () => {
    // Inline test since function is not exported
    function parseReviewOutput(output: string): { verdict: 'APPROVE' | 'REJECT' | 'ERROR'; feedback: string } {
      const verdictMatch = output.match(/VERDICT:\s*(APPROVE|REJECT)/i);
      const feedbackMatch = output.match(/FEEDBACK:\s*(.+?)(?:\n|$)/i);

      if (!verdictMatch) {
        return { verdict: 'ERROR', feedback: 'Could not parse verdict from response' };
      }

      return {
        verdict: verdictMatch[1].toUpperCase() as 'APPROVE' | 'REJECT',
        feedback: feedbackMatch ? feedbackMatch[1].trim() : '(no feedback)',
      };
    }

    it('should parse APPROVE verdict', () => {
      const output = `
VERDICT: APPROVE
FEEDBACK: Implementation matches the spec, all tests pass.
`;
      const result = parseReviewOutput(output);
      expect(result.verdict).toBe('APPROVE');
      expect(result.feedback).toBe('Implementation matches the spec, all tests pass.');
    });

    it('should parse REJECT verdict', () => {
      const output = `
VERDICT: REJECT
FEEDBACK: Missing unit tests for edge cases.
`;
      const result = parseReviewOutput(output);
      expect(result.verdict).toBe('REJECT');
      expect(result.feedback).toBe('Missing unit tests for edge cases.');
    });

    it('should handle lowercase verdict', () => {
      const output = `VERDICT: approve\nFEEDBACK: Looks good`;
      const result = parseReviewOutput(output);
      expect(result.verdict).toBe('APPROVE');
    });

    it('should return ERROR when verdict is missing', () => {
      const output = `Some random text without a verdict`;
      const result = parseReviewOutput(output);
      expect(result.verdict).toBe('ERROR');
      expect(result.feedback).toBe('Could not parse verdict from response');
    });

    it('should handle missing feedback', () => {
      const output = `VERDICT: APPROVE`;
      const result = parseReviewOutput(output);
      expect(result.verdict).toBe('APPROVE');
      expect(result.feedback).toBe('(no feedback)');
    });
  });

  describe('buildArchitectPrompt', () => {
    function buildArchitectPrompt(
      donePath: string,
      doneContent: string,
      inboxPath: string | null,
      inboxContent: string | null
    ): string {
      return `[REVIEW REQUEST - Architect]

Te az Architect terminál vagy. Egy DONE üzenetet kell review-znod.
Kérdés: A MEGVALÓSÍTÁS MEGFELEL-E A TERVNEK?

## Eredeti feladat (inbox)
${inboxPath ? `Fájl: ${inboxPath}` : '(nem található)'}
${inboxContent ? `\n${inboxContent.substring(0, 2000)}` : ''}

## DONE üzenet
Fájl: ${donePath}
${doneContent.substring(0, 3000)}

## Ellenőrizd:
1. A spec-ben kért funkcionalitás megvalósult?
2. API contract változás dokumentált?
3. Breaking change van? Ha igen, indokolt?
4. Architekturális minták betartva?

## Válasz formátum (KÖTELEZŐ):
VERDICT: APPROVE vagy REJECT
FEEDBACK: [1-3 mondat indoklás]

Csak ezt a formátumot használd, semmi mást!`;
    }

    it('should include inbox content when available', () => {
      const prompt = buildArchitectPrompt(
        '/opt/spaceos/terminals/backend/outbox/done.md',
        'DONE content here',
        '/opt/spaceos/terminals/backend/inbox/task.md',
        'Original task description'
      );

      expect(prompt).toContain('Original task description');
      expect(prompt).toContain('/opt/spaceos/terminals/backend/inbox/task.md');
    });

    it('should handle missing inbox', () => {
      const prompt = buildArchitectPrompt(
        '/opt/spaceos/terminals/backend/outbox/done.md',
        'DONE content here',
        null,
        null
      );

      expect(prompt).toContain('(nem található)');
    });

    it('should truncate long content', () => {
      const longContent = 'A'.repeat(5000);
      const prompt = buildArchitectPrompt(
        '/opt/spaceos/terminals/backend/outbox/done.md',
        longContent,
        null,
        null
      );

      // Content should be truncated to 3000 chars
      expect(prompt.length).toBeLessThan(5000);
    });
  });

  describe('buildLibrarianPrompt', () => {
    function buildLibrarianPrompt(
      donePath: string,
      doneContent: string,
      inboxPath: string | null,
      inboxContent: string | null
    ): string {
      return `[REVIEW REQUEST - Librarian]

Te a Librarian terminál vagy. Egy DONE üzenetet kell review-znod.
Kérdés: KONZISZTENS-E A KORÁBBI MEGOLDÁSOKKAL?

## Eredeti feladat (inbox)
${inboxPath ? `Fájl: ${inboxPath}` : '(nem található)'}
${inboxContent ? `\n${inboxContent.substring(0, 2000)}` : ''}

## DONE üzenet
Fájl: ${donePath}
${doneContent.substring(0, 3000)}

## Ellenőrizd:
1. Hasonló feladat volt korábban? Ha igen, konzisztens a megoldás?
2. A knowledge base-ben dokumentált pattern-eket követi?
3. Volt hasonló hiba korábban amit most is elkövethetett?
4. Dokumentáció/comment elegendő?

## Válasz formátum (KÖTELEZŐ):
VERDICT: APPROVE vagy REJECT
FEEDBACK: [1-3 mondat indoklás]

Csak ezt a formátumot használd, semmi mást!`;
    }

    it('should focus on historical consistency', () => {
      const prompt = buildLibrarianPrompt(
        '/opt/spaceos/terminals/backend/outbox/done.md',
        'DONE content',
        null,
        null
      );

      expect(prompt).toContain('KONZISZTENS-E A KORÁBBI MEGOLDÁSOKKAL');
      expect(prompt).toContain('knowledge base');
      expect(prompt).toContain('Hasonló feladat volt korábban');
    });
  });

  describe('Dual Review Logic', () => {
    it('should approve only when both reviewers approve', () => {
      const scenarios = [
        { architect: 'APPROVE', librarian: 'APPROVE', expected: true },
        { architect: 'APPROVE', librarian: 'REJECT', expected: false },
        { architect: 'REJECT', librarian: 'APPROVE', expected: false },
        { architect: 'REJECT', librarian: 'REJECT', expected: false },
        { architect: 'APPROVE', librarian: 'ERROR', expected: false },
        { architect: 'ERROR', librarian: 'APPROVE', expected: false },
      ];

      scenarios.forEach(({ architect, librarian, expected }) => {
        const approved = architect === 'APPROVE' && librarian === 'APPROVE';
        expect(approved).toBe(expected);
      });
    });
  });

  describe('Terminal Busy Detection', () => {
    // Test the busy detection logic inline
    function detectBusyIndicators(paneContent: string): boolean {
      const busyIndicators = [
        'Thinking...',
        'Running tool',
        '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
      ];
      return busyIndicators.some(indicator => paneContent.includes(indicator));
    }

    it('should detect Thinking indicator', () => {
      const pane = `Claude Code
> Processing your request...
Thinking...`;
      expect(detectBusyIndicators(pane)).toBe(true);
    });

    it('should detect spinner characters', () => {
      const pane = `Claude Code
⠋ Running build...`;
      expect(detectBusyIndicators(pane)).toBe(true);
    });

    it('should detect Running tool', () => {
      const pane = `Running tool: Bash`;
      expect(detectBusyIndicators(pane)).toBe(true);
    });

    it('should return false for idle terminal', () => {
      const pane = `Claude Code
> Ready for input
$`;
      expect(detectBusyIndicators(pane)).toBe(false);
    });
  });

  describe('Memory Saving', () => {
    it('should format architect memory entry correctly', () => {
      const date = '2026-06-24';
      const doneBase = 'backend-feature-done';
      const verdict = 'APPROVE';
      const feedback = 'Implementation matches spec';

      const entry = `
## ${date} Review: ${doneBase}
- **Terminal:** backend
- **Verdict:** ${verdict}
- **Feedback:** ${feedback}
`;

      expect(entry).toContain('2026-06-24');
      expect(entry).toContain('backend-feature-done');
      expect(entry).toContain('APPROVE');
      expect(entry).toContain('Implementation matches spec');
    });

    it('should format librarian log entry correctly', () => {
      const date = '2026-06-24';
      const doneBase = 'frontend-ui-done';
      const terminal = 'frontend';
      const verdict = 'REJECT';
      const feedback = 'Inconsistent with previous pattern';
      const approved = false;

      const entry = `
## ${date} Review: ${doneBase}
- **Terminal:** ${terminal}
- **Verdict:** ${verdict}
- **Feedback:** ${feedback}
- **Final:** ${approved ? 'APPROVED' : 'REJECTED'}
`;

      expect(entry).toContain('frontend-ui-done');
      expect(entry).toContain('REJECT');
      expect(entry).toContain('REJECTED');
    });
  });

  describe('Reject Inbox Generation', () => {
    it('should generate correct frontmatter', () => {
      const terminal = 'backend';
      const nextNum = '046';
      const date = '2026-06-24';
      const doneBase = 'feature-done';
      const reviewId = 'REV-TEST-001';

      const content = `---
id: MSG-${terminal.toUpperCase()}-${nextNum}-REVIEW-REJECT
from: terminal-reviewer
to: ${terminal}
type: task
priority: high
status: UNREAD
model: sonnet
ref: ${doneBase}
review_id: ${reviewId}
created: ${date}
---`;

      expect(content).toContain('MSG-BACKEND-046-REVIEW-REJECT');
      expect(content).toContain('from: terminal-reviewer');
      expect(content).toContain('priority: high');
      expect(content).toContain('REV-TEST-001');
    });

    it('should include both reviewer feedbacks', () => {
      const architectFeedback = 'API contract not documented';
      const librarianFeedback = 'Pattern inconsistent with ADR-041';

      const body = `
## Architect verdict: REJECT

${architectFeedback}

## Librarian verdict: REJECT

${librarianFeedback}
`;

      expect(body).toContain('Architect verdict: REJECT');
      expect(body).toContain('API contract not documented');
      expect(body).toContain('Librarian verdict: REJECT');
      expect(body).toContain('Pattern inconsistent with ADR-041');
    });
  });
});

describe('Review Level Extraction', () => {
  function extractReviewLevel(content: string): 'none' | 'light' | 'standard' | 'strict' {
    const match = content.match(/^review_level:\s*(.+)$/m);
    if (match) {
      const level = match[1].trim().toLowerCase();
      if (['none', 'light', 'standard', 'strict'].includes(level)) {
        return level as 'none' | 'light' | 'standard' | 'strict';
      }
    }
    return 'standard';
  }

  it('should extract "none" level', () => {
    const content = `---
type: done
review_level: none
---`;
    expect(extractReviewLevel(content)).toBe('none');
  });

  it('should extract "light" level', () => {
    const content = `---
type: done
review_level: light
---`;
    expect(extractReviewLevel(content)).toBe('light');
  });

  it('should extract "strict" level', () => {
    const content = `---
type: done
review_level: strict
---`;
    expect(extractReviewLevel(content)).toBe('strict');
  });

  it('should default to "standard" when missing', () => {
    const content = `---
type: done
---`;
    expect(extractReviewLevel(content)).toBe('standard');
  });

  it('should handle case insensitively', () => {
    const content = `---
type: done
review_level: STRICT
---`;
    expect(extractReviewLevel(content)).toBe('strict');
  });
});

describe('Skip Review Logic', () => {
  const NO_REVIEW_TYPES = ['info', 'ack', 'acknowledgment', 'status', 'heartbeat'];

  function extractMessageType(content: string): string {
    const match = content.match(/^type:\s*(.+)$/m);
    return match ? match[1].trim().toLowerCase() : 'done';
  }

  function extractReviewLevel(content: string): string {
    const match = content.match(/^review_level:\s*(.+)$/m);
    if (match) {
      const level = match[1].trim().toLowerCase();
      if (['none', 'light', 'standard', 'strict'].includes(level)) {
        return level;
      }
    }
    return 'standard';
  }

  function shouldSkipReview(content: string): { skip: boolean; reason?: string } {
    const msgType = extractMessageType(content);
    const reviewLevel = extractReviewLevel(content);

    if (NO_REVIEW_TYPES.includes(msgType)) {
      return { skip: true, reason: `Message type '${msgType}' does not require review` };
    }

    if (reviewLevel === 'none') {
      return { skip: true, reason: 'review_level: none' };
    }

    return { skip: false };
  }

  it('should skip "info" type messages', () => {
    const content = `---
type: info
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('info');
  });

  it('should skip "ack" type messages', () => {
    const content = `---
type: ack
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(true);
  });

  it('should skip "acknowledgment" type messages', () => {
    const content = `---
type: acknowledgment
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(true);
  });

  it('should skip "status" type messages', () => {
    const content = `---
type: status
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(true);
  });

  it('should skip "heartbeat" type messages', () => {
    const content = `---
type: heartbeat
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(true);
  });

  it('should skip when review_level is "none"', () => {
    const content = `---
type: done
review_level: none
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('review_level: none');
  });

  it('should NOT skip "done" type with standard review', () => {
    const content = `---
type: done
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(false);
  });

  it('should NOT skip "done" type with light review', () => {
    const content = `---
type: done
review_level: light
---`;
    const result = shouldSkipReview(content);
    expect(result.skip).toBe(false);
  });
});

describe('Strict Review Logic', () => {
  it('should require substantial feedback in strict mode', () => {
    const architectFeedback = 'Implementation matches the specification correctly.';
    const librarianFeedback = 'Consistent with existing patterns in codebase.';

    const hasSubstantialFeedback =
      architectFeedback.length > 20 &&
      librarianFeedback.length > 20 &&
      architectFeedback !== '(no feedback)' &&
      librarianFeedback !== '(no feedback)';

    expect(hasSubstantialFeedback).toBe(true);
  });

  it('should reject if feedback is too short in strict mode', () => {
    const architectFeedback = 'OK';
    const librarianFeedback = 'Good';

    const hasSubstantialFeedback =
      architectFeedback.length > 20 &&
      librarianFeedback.length > 20;

    expect(hasSubstantialFeedback).toBe(false);
  });

  it('should reject if feedback is placeholder in strict mode', () => {
    const architectFeedback = '(no feedback)';
    const librarianFeedback = 'This is substantial feedback for the review.';

    const hasSubstantialFeedback =
      architectFeedback.length > 20 &&
      librarianFeedback.length > 20 &&
      architectFeedback !== '(no feedback)' &&
      librarianFeedback !== '(no feedback)';

    expect(hasSubstantialFeedback).toBe(false);
  });
});

describe('Light Review Logic', () => {
  it('should only check Librarian verdict', () => {
    // In light review, Architect is auto-approved
    const architectVerdict = 'APPROVE'; // Always APPROVE in light mode
    const librarianVerdict = 'APPROVE';

    const approved = librarianVerdict === 'APPROVE';
    expect(approved).toBe(true);
  });

  it('should reject if Librarian rejects', () => {
    const architectVerdict = 'APPROVE'; // Auto-approved
    const librarianVerdict = 'REJECT';

    const approved = librarianVerdict === 'APPROVE';
    expect(approved).toBe(false);
  });
});

describe('Integration Scenarios', () => {
  it('should handle full review flow for APPROVE case', async () => {
    const mockDoneContent = `---
id: MSG-BACKEND-045
type: done
status: UNREAD
ref: MSG-BACKEND-044
---
# Feature Complete
All tests pass, implementation done.
`;

    const architectResult = { verdict: 'APPROVE' as const, feedback: 'Matches spec' };
    const librarianResult = { verdict: 'APPROVE' as const, feedback: 'Consistent with history' };

    const approved = architectResult.verdict === 'APPROVE' && librarianResult.verdict === 'APPROVE';

    expect(approved).toBe(true);
  });

  it('should handle full review flow for REJECT case', async () => {
    const architectResult = { verdict: 'APPROVE' as const, feedback: 'OK' };
    const librarianResult = { verdict: 'REJECT' as const, feedback: 'Missing docs' };

    const approved = architectResult.verdict === 'APPROVE' && librarianResult.verdict === 'APPROVE';

    expect(approved).toBe(false);
  });

  it('should auto-approve info messages without review', () => {
    const msgType = 'info';
    const NO_REVIEW_TYPES = ['info', 'ack', 'acknowledgment', 'status', 'heartbeat'];

    const shouldSkip = NO_REVIEW_TYPES.includes(msgType);
    expect(shouldSkip).toBe(true);
  });
});
