/**
 * teamTrust.ts — Terminal Trust Graph
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Defines trust relationships between terminals for inter-agent messaging.
 * Trusted messages are wrapped with <trusted-peer>, untrusted with <untrusted>.
 *
 * Trust rules:
 * 1. Priority terminals (root, conductor) are trusted by all
 * 2. Terminals in the same domain trust each other
 * 3. Explicit trust overrides in config
 */

// ─── Terminal Domains (7-terminal architecture 2026-06-21) ──────────────────

import * as terminalsConfig from '../config/terminals';

/**
 * Terminal domain groupings - NEW 7-terminal architecture
 * Terminals in the same domain implicitly trust each other
 */
export const TERMINAL_DOMAINS: Record<string, string[]> = {
  // Strategic layer - full trust
  strategic: ['root', 'conductor', 'architect'],

  // Development domain
  development: ['backend', 'frontend', 'designer'],

  // Support domain
  support: ['librarian', 'explorer'],
};

/**
 * Priority terminals - from config
 */
export const PRIORITY_TERMINALS = terminalsConfig.getPriorityTerminals();

/**
 * Explicit trust overrides
 * Format: { terminal: [trusted_by_these_terminals] }
 */
export const EXPLICIT_TRUST: Record<string, string[]> = {
  // Architect is trusted by all technical terminals
  architect: ['backend', 'frontend', 'designer'],

  // Librarian is trusted by all (documentation)
  librarian: ['root', 'conductor', 'architect', 'backend', 'frontend'],

  // Explorer is trusted by all (codebase research)
  explorer: ['root', 'conductor', 'backend', 'frontend'],
};

/**
 * Delegation relationships
 * Format: { terminal: [terminals_it_can_delegate_to] }
 */
export const DELEGATION: Record<string, string[]> = {
  // Root can delegate to everyone
  root: Object.values(TERMINAL_DOMAINS).flat(),

  // Conductor can delegate to all except root
  conductor: Object.values(TERMINAL_DOMAINS).flat().filter(t => t !== 'root'),

  // Architect can delegate technical tasks
  architect: ['backend', 'frontend', 'designer'],
};

// ─── Trust Logic ─────────────────────────────────────────────────────────────

/**
 * Get the domain of a terminal
 */
export function getTerminalDomain(terminal: string): string | null {
  for (const [domain, terminals] of Object.entries(TERMINAL_DOMAINS)) {
    if (terminals.includes(terminal)) {
      return domain;
    }
  }
  return null;
}

/**
 * Check if two terminals are in the same domain
 */
export function sameDomin(terminal1: string, terminal2: string): boolean {
  const domain1 = getTerminalDomain(terminal1);
  const domain2 = getTerminalDomain(terminal2);

  if (!domain1 || !domain2) return false;
  return domain1 === domain2;
}

/**
 * Check if a terminal is a priority terminal
 */
export function isPriorityTerminal(terminal: string): boolean {
  return PRIORITY_TERMINALS.includes(terminal);
}

/**
 * Check if terminal1 has explicit trust from terminal2
 */
export function hasExplicitTrust(from: string, to: string): boolean {
  const trustedBy = EXPLICIT_TRUST[from] || [];
  return trustedBy.includes(to);
}

/**
 * Check if terminal1 can delegate to terminal2
 */
export function canDelegate(from: string, to: string): boolean {
  const delegateTo = DELEGATION[from] || [];
  return delegateTo.includes(to);
}

/**
 * Main trust check: is `from` trusted by `to`?
 *
 * A message from `from` to `to` is trusted if:
 * 1. Self-loop (from === to) → false
 * 2. Empty names → false
 * 3. Either is a priority terminal → true
 * 4. Same domain → true
 * 5. Explicit trust relationship → true
 * 6. Delegation relationship → true
 * 7. Otherwise → false
 */
export function isTrustedTerminal(from: string, to: string): boolean {
  // Self-loop or empty names
  if (!from || !to) return false;
  if (from === to) return false;

  // Priority terminals are always trusted
  if (isPriorityTerminal(from) || isPriorityTerminal(to)) {
    return true;
  }

  // Same domain
  if (sameDomin(from, to)) {
    return true;
  }

  // Explicit trust (symmetric check)
  if (hasExplicitTrust(from, to) || hasExplicitTrust(to, from)) {
    return true;
  }

  // Delegation (asymmetric - only from can delegate to to)
  if (canDelegate(from, to)) {
    return true;
  }

  return false;
}

/**
 * Get all terminals that trust a given terminal
 */
export function getTrustingTerminals(terminal: string): string[] {
  const trusting: Set<string> = new Set();

  // Priority terminals trust everyone
  if (isPriorityTerminal(terminal)) {
    for (const terminals of Object.values(TERMINAL_DOMAINS)) {
      for (const t of terminals) {
        if (t !== terminal) trusting.add(t);
      }
    }
    return Array.from(trusting);
  }

  // Same domain terminals
  const domain = getTerminalDomain(terminal);
  if (domain) {
    for (const t of TERMINAL_DOMAINS[domain]) {
      if (t !== terminal) trusting.add(t);
    }
  }

  // Explicit trust
  const explicitTrusters = EXPLICIT_TRUST[terminal] || [];
  for (const t of explicitTrusters) {
    trusting.add(t);
  }

  // Priority terminals always trust
  for (const p of PRIORITY_TERMINALS) {
    if (p !== terminal) trusting.add(p);
  }

  return Array.from(trusting);
}

/**
 * Get all terminals that a given terminal trusts
 */
export function getTrustedByTerminal(terminal: string): string[] {
  const trusted: Set<string> = new Set();

  // All terminals trust priority terminals
  for (const p of PRIORITY_TERMINALS) {
    if (p !== terminal) trusted.add(p);
  }

  // Same domain terminals
  const domain = getTerminalDomain(terminal);
  if (domain) {
    for (const t of TERMINAL_DOMAINS[domain]) {
      if (t !== terminal) trusted.add(t);
    }
  }

  // Terminals with explicit trust from this terminal
  for (const [t, trusters] of Object.entries(EXPLICIT_TRUST)) {
    if (trusters.includes(terminal)) {
      trusted.add(t);
    }
  }

  // Terminals this one can delegate to
  const canDelegateTo = DELEGATION[terminal] || [];
  for (const t of canDelegateTo) {
    trusted.add(t);
  }

  return Array.from(trusted);
}

/**
 * Debug: print trust matrix
 */
export function printTrustMatrix(): void {
  const allTerminals = Array.from(new Set(Object.values(TERMINAL_DOMAINS).flat()));

  console.log('\n=== Trust Matrix ===');
  console.log('From \\ To'.padEnd(15) + allTerminals.map(t => t.slice(0, 8).padEnd(10)).join(''));

  for (const from of allTerminals) {
    const row = from.padEnd(15);
    const trusts = allTerminals.map(to => {
      if (from === to) return '  -  '.padEnd(10);
      return (isTrustedTerminal(from, to) ? '  ✓  ' : '  ✗  ').padEnd(10);
    }).join('');
    console.log(row + trusts);
  }
  console.log('');
}
