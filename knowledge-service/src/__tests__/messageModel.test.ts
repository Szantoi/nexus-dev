/**
 * Canonical message-model tests — the config-driven domain vocabulary.
 * Proves the state machine and every legacy→canonical mapping load from
 * config/message-model.yaml and behave as declared.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalTypes, canonicalStatuses,
  isCanonicalStatus, isCanonicalType,
  isValidTransition,
  mapLegacyStatus, mapCentralStatus, mapLegacyType,
} from '../task-message-box/message-model';

describe('canonical vocabulary (from config)', () => {
  it('exposes the 4 canonical types', () => {
    expect(canonicalTypes().sort()).toEqual(['info', 'question', 'response', 'task']);
    expect(isCanonicalType('task')).toBe(true);
    expect(isCanonicalType('done')).toBe(false); // done is no longer a type
  });

  it('exposes the 6 canonical statuses', () => {
    expect(canonicalStatuses().sort()).toEqual(
      ['archived', 'blocked', 'completed', 'in_progress', 'read', 'unread']);
    expect(isCanonicalStatus('unread')).toBe(true);
    expect(isCanonicalStatus('DONE')).toBe(false);
  });
});

describe('lifecycle state machine (isValidTransition)', () => {
  it('allows declared transitions', () => {
    expect(isValidTransition('unread', 'read')).toBe(true);
    expect(isValidTransition('read', 'in_progress')).toBe(true);
    expect(isValidTransition('in_progress', 'completed')).toBe(true);
    expect(isValidTransition('blocked', 'in_progress')).toBe(true);
    expect(isValidTransition('completed', 'archived')).toBe(true);
  });
  it('rejects undeclared transitions', () => {
    expect(isValidTransition('completed', 'unread')).toBe(false); // no going back
    expect(isValidTransition('archived', 'read')).toBe(false);    // terminal
    expect(isValidTransition('unread', 'completed')).toBe(false); // must be read/in_progress first
  });
  it('treats a no-op transition as valid (idempotent)', () => {
    expect(isValidTransition('read', 'read')).toBe(true);
  });
});

describe('legacy → canonical status mapping (all 12 messageRegistry statuses)', () => {
  const cases: Array<[string, string]> = [
    ['UNREAD', 'unread'], ['INJECTED', 'unread'], ['PENDING', 'unread'],
    ['READ', 'read'],
    ['PROCESSING', 'in_progress'], ['DELEGATED', 'in_progress'],
    ['PROCESSED', 'completed'], ['COMPLETED', 'completed'], ['DONE', 'completed'],
    ['ARCHIVED', 'archived'], ['SKIPPED', 'archived'], ['SUPERSEDED', 'archived'],
  ];
  it.each(cases)('%s → %s', (legacy, canonical) => {
    expect(mapLegacyStatus(legacy)).toBe(canonical);
  });
  it('passes through an already-canonical status', () => {
    expect(mapLegacyStatus('unread')).toBe('unread');
  });
});

describe('central Postgres ↔ canonical status mapping', () => {
  it('maps the agreed transport statuses', () => {
    expect(mapCentralStatus('pending')).toBe('unread');
    expect(mapCentralStatus('delivered')).toBe('read');
    expect(mapCentralStatus('ack')).toBe('completed');
  });
});

describe('legacy → canonical type mapping', () => {
  it('demotes done/blocked from types to responses', () => {
    expect(mapLegacyType('done')).toBe('response');
    expect(mapLegacyType('blocked')).toBe('response');
  });
  it('maps informational variants to info', () => {
    expect(mapLegacyType('escalation')).toBe('info');
    expect(mapLegacyType('freeform')).toBe('info');
  });
  it('passes through canonical types', () => {
    expect(mapLegacyType('task')).toBe('task');
    expect(mapLegacyType('question')).toBe('question');
  });
});
