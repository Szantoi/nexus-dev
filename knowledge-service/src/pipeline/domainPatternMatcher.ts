/**
 * Domain Pattern Matcher
 *
 * Matches descriptions to domain patterns.
 * ROI: 2-3 hours/week
 * Response time: <300ms
 */

export interface PatternMatch {
  pattern: string;
  confidence: number;
  domain: string;
  references: string[];
  recommendations: string[];
  exampleCode?: string;
  adrRefs: string[];
}

export interface MatchResult {
  success: boolean;
  pattern?: PatternMatch;
  alternatives?: PatternMatch[];
  error?: string;
}

const KNOWN_PATTERNS: Record<string, PatternMatch[]> = {
  crm: [
    {
      pattern: 'Lead/Opportunity FSM',
      confidence: 0.95,
      domain: 'crm',
      references: ['docs/knowledge/patterns/CRM_PATTERNS.md'],
      recommendations: ['Use enum-based FSM', 'Validate transitions in domain aggregate'],
      adrRefs: ['ADR-054'],
    },
  ],
  cutting: [
    {
      pattern: 'Quote Estimation',
      confidence: 0.9,
      domain: 'cutting',
      references: ['docs/knowledge/patterns/CUTTING_PATTERNS.md'],
      recommendations: ['Use parametric calculations', 'Cache results'],
      adrRefs: ['ADR-050'],
    },
  ],
  kernel: [
    {
      pattern: 'Row-Level Security (RLS)',
      confidence: 0.92,
      domain: 'kernel',
      references: ['docs/knowledge/patterns/DATABASE_PATTERNS.md'],
      recommendations: ['Use PostgreSQL RLS policies', 'Test multi-tenant isolation'],
      adrRefs: ['ADR-048'],
    },
  ],
};

const DOMAINS = ['crm', 'controlling', 'procurement', 'ehs', 'cutting', 'joinery', 'kernel', 'general'];

export async function matchDomainPattern(description: string, domain?: string): Promise<MatchResult> {
  const validation = validatePatternRequest(description, domain);
  if (!validation.valid) {
    return { success: false, error: validation.errors?.[0] };
  }

  const descLower = description.toLowerCase();

  // Keyword-based pattern matching
  const matches: PatternMatch[] = [];

  for (const [d, patterns] of Object.entries(KNOWN_PATTERNS)) {
    if (domain && d !== domain) continue;

    for (const pattern of patterns) {
      let score = 0;
      const patternLower = pattern.pattern.toLowerCase();

      if (descLower.includes(patternLower)) score += 3;
      if (description.includes('FSM') && pattern.pattern.includes('FSM')) score += 2;
      if (description.includes('cache')) score += 1;
      if (description.includes('RLS') && pattern.pattern.includes('RLS')) score += 2;

      if (score > 0) {
        matches.push({
          ...pattern,
          confidence: Math.min(1, score / 3),
        });
      }
    }
  }

  if (matches.length === 0) {
    return { success: false, error: `No matching patterns found for: ${description}` };
  }

  matches.sort((a, b) => b.confidence - a.confidence);

  return {
    success: true,
    pattern: matches[0],
    alternatives: matches.slice(1),
  };
}

export function getKnownPatterns(): Record<string, PatternMatch[]> {
  return KNOWN_PATTERNS;
}

export function getAvailableDomains(): string[] {
  return DOMAINS;
}

export function validatePatternRequest(
  description: string,
  domain?: string
): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!description || description.trim().length === 0) {
    errors.push('Description is required');
  }

  if (description.length > 500) {
    errors.push('Description too long (max 500 chars)');
  }

  if (domain && !getAvailableDomains().includes(domain)) {
    errors.push(`Invalid domain: ${domain}`);
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}
