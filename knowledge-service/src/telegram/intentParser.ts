/**
 * Intent Parser for Telegram Messages
 *
 * Parses free-form text messages to extract:
 * - Target terminal(s) for routing
 * - Priority level
 * - Message type (task, question, freeform)
 * - Clean content without routing prefixes
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type IntentType = 'command' | 'task' | 'question' | 'freeform';

export interface ParsedIntent {
  type: IntentType;
  targets: string[];           // Resolved terminal names (can be multiple)
  priority: Priority;
  content: string;             // Message without routing prefixes
  rawContent: string;          // Original message
  conversationId?: number;
  isGroupMessage: boolean;     // True if multiple targets
  isBroadcast: boolean;        // True if "all:" prefix
}

// ─── Terminal Aliases ────────────────────────────────────────────────────────

const TERMINAL_ALIASES: Record<string, string> = {
  // Backend (választott: motor, api)
  backend: 'backend',
  be: 'backend',
  kernel: 'backend',
  orch: 'backend',
  orchestrator: 'backend',
  joinery: 'backend',
  cutting: 'backend',
  motor: 'backend',
  api: 'backend',

  // Frontend (TODO: válasz pending)
  frontend: 'frontend',
  fe: 'frontend',
  portal: 'frontend',
  ui: 'frontend',
  felület: 'frontend',
  felulet: 'frontend',

  // Conductor (választott: karmester, maestro)
  conductor: 'conductor',
  cond: 'conductor',
  coord: 'conductor',
  koordinator: 'conductor',
  karmester: 'conductor',
  maestro: 'conductor',

  // Architect (választott: tervező, planner)
  architect: 'architect',
  arch: 'architect',
  tervezo: 'architect',
  tervező: 'architect',
  planner: 'architect',

  // Librarian (választott: könyvtáros, knowledge)
  librarian: 'librarian',
  lib: 'librarian',
  konyvtaros: 'librarian',
  könyvtáros: 'librarian',
  knowledge: 'librarian',
  tudás: 'librarian',
  tudas: 'librarian',

  // Explorer (választott: felfedező, scout)
  explorer: 'explorer',
  exp: 'explorer',
  kutato: 'explorer',
  felfedező: 'explorer',
  felfedezo: 'explorer',
  scout: 'explorer',

  // Designer (választott: dizájner, ux)
  designer: 'designer',
  design: 'designer',
  ux: 'designer',
  dizájner: 'designer',
  dizajner: 'designer',

  // Root (választott: sárkány, admin)
  root: 'root',
  admin: 'root',
  sárkány: 'root',
  sarkany: 'root',
};

const ALL_TERMINALS = ['root', 'conductor', 'backend', 'frontend', 'architect', 'librarian', 'explorer', 'designer'];

// ─── Priority Keywords ───────────────────────────────────────────────────────

const PRIORITY_KEYWORDS: Record<Priority, string[]> = {
  critical: ['sürgős', 'surgos', 'urgent', 'critical', 'azonnal', 'asap', 'now', 'most', 'fontos!', 'kritikus'],
  high: ['fontos', 'important', 'high', 'priority', 'magas', 'kiemelt'],
  medium: ['közepes', 'medium', 'normal'],
  low: ['alacsony', 'low', 'minor', 'később', 'kesobb', 'later'],
};

// ─── Question Indicators ─────────────────────────────────────────────────────

const QUESTION_INDICATORS = [
  /\?$/,                       // Ends with ?
  /^mi\s/i,                    // Mi a...
  /^mit\s/i,                   // Mit csinál...
  /^hogyan\s/i,                // Hogyan működik...
  /^miért\s/i,                 // Miért...
  /^mikor\s/i,                 // Mikor...
  /^hol\s/i,                   // Hol van...
  /^mennyi\s/i,                // Mennyi...
  /^melyik\s/i,                // Melyik...
  /^what\s/i,
  /^how\s/i,
  /^why\s/i,
  /^when\s/i,
  /^where\s/i,
  /^which\s/i,
  /^can\s/i,
  /^is\s/i,
  /^are\s/i,
  /^does\s/i,
  /^do\s/i,
];

// ─── Parsing Functions ───────────────────────────────────────────────────────

/**
 * Resolve a terminal name or alias to the canonical terminal name
 */
export function resolveTerminal(name: string): string | null {
  const normalized = name.toLowerCase().trim();
  return TERMINAL_ALIASES[normalized] || null;
}

/**
 * Extract targets from @mentions
 * Example: "@backend @frontend fix this" → ['backend', 'frontend']
 */
function extractMentionTargets(text: string): { targets: string[]; cleanText: string } {
  const mentions: string[] = [];
  let cleanText = text;

  // Find all @mentions
  const mentionPattern = /@(\w+)/g;
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    const resolved = resolveTerminal(match[1]);
    if (resolved && !mentions.includes(resolved)) {
      mentions.push(resolved);
    }
  }

  // Remove @mentions from text
  cleanText = text.replace(/@\w+\s*/g, '').trim();

  return { targets: mentions, cleanText };
}

/**
 * Extract targets from prefix patterns
 * Example: "backend: fix this" → ['backend']
 * Example: "backend+frontend: fix this" → ['backend', 'frontend']
 */
function extractPrefixTargets(text: string): { targets: string[]; cleanText: string; isBroadcast: boolean } {
  let isBroadcast = false;

  // Check for "all:" broadcast
  if (/^all\s*[:!]/i.test(text)) {
    return {
      targets: [...ALL_TERMINALS],
      cleanText: text.replace(/^all\s*[:!]\s*/i, '').trim(),
      isBroadcast: true,
    };
  }

  // Check for "terminal+terminal:" pattern
  const multiMatch = text.match(/^(\w+)\s*\+\s*(\w+)\s*[:!]\s*/);
  if (multiMatch) {
    const targets: string[] = [];
    const t1 = resolveTerminal(multiMatch[1]);
    const t2 = resolveTerminal(multiMatch[2]);
    if (t1) targets.push(t1);
    if (t2 && t2 !== t1) targets.push(t2);

    if (targets.length > 0) {
      return {
        targets,
        cleanText: text.slice(multiMatch[0].length).trim(),
        isBroadcast: false,
      };
    }
  }

  // Check for "terminal:" or "terminal," pattern
  const singleMatch = text.match(/^(\w+)\s*[:!,]\s*/);
  if (singleMatch) {
    const resolved = resolveTerminal(singleMatch[1]);
    if (resolved) {
      return {
        targets: [resolved],
        cleanText: text.slice(singleMatch[0].length).trim(),
        isBroadcast: false,
      };
    }
  }

  return { targets: [], cleanText: text, isBroadcast: false };
}

/**
 * Detect priority from text content
 */
function detectPriority(text: string): Priority {
  const lowerText = text.toLowerCase();

  for (const [priority, keywords] of Object.entries(PRIORITY_KEYWORDS) as [Priority, string[]][]) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return priority;
      }
    }
  }

  return 'medium';
}

/**
 * Detect if message is a question
 */
function isQuestion(text: string): boolean {
  return QUESTION_INDICATORS.some(pattern => pattern.test(text));
}

/**
 * Remove priority keywords from text for cleaner content
 */
function removePriorityKeywords(text: string): string {
  let cleanText = text;
  for (const keywords of Object.values(PRIORITY_KEYWORDS)) {
    for (const keyword of keywords) {
      // Only remove if it's at the start followed by : or space
      const pattern = new RegExp(`^${keyword}\\s*[:!]?\\s*`, 'i');
      cleanText = cleanText.replace(pattern, '');
    }
  }
  return cleanText.trim();
}

// ─── Main Parse Function ─────────────────────────────────────────────────────

/**
 * Parse a Telegram message into a structured intent
 */
export function parseIntent(text: string): ParsedIntent {
  const rawContent = text.trim();
  let content = rawContent;
  let targets: string[] = [];
  let isBroadcast = false;

  // Check if it's a command (starts with /)
  if (content.startsWith('/')) {
    return {
      type: 'command',
      targets: [],
      priority: 'medium',
      content: content,
      rawContent,
      isGroupMessage: false,
      isBroadcast: false,
    };
  }

  // 1. Try to extract @mention targets first
  const mentionResult = extractMentionTargets(content);
  if (mentionResult.targets.length > 0) {
    targets = mentionResult.targets;
    content = mentionResult.cleanText;
  }

  // 2. If no mentions, try prefix patterns
  if (targets.length === 0) {
    const prefixResult = extractPrefixTargets(content);
    targets = prefixResult.targets;
    content = prefixResult.cleanText;
    isBroadcast = prefixResult.isBroadcast;
  }

  // 3. Detect priority
  const priority = detectPriority(rawContent);

  // 4. Remove priority keywords from content
  content = removePriorityKeywords(content);

  // 5. Determine message type
  let type: IntentType = 'freeform';
  if (isQuestion(content)) {
    type = 'question';
  } else if (targets.length > 0) {
    // If there's a target, assume it's a task
    type = 'task';
  }

  // 6. Default to root if no target specified
  if (targets.length === 0) {
    targets = ['root'];
  }

  return {
    type,
    targets,
    priority,
    content,
    rawContent,
    isGroupMessage: targets.length > 1,
    isBroadcast,
  };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Format targets for display
 */
export function formatTargets(targets: string[]): string {
  if (targets.length === 0) return 'root';
  if (targets.length === 1) return targets[0];
  if (targets.length === ALL_TERMINALS.length) return 'all';
  return targets.join(', ');
}

/**
 * Get emoji for priority
 */
export function getPriorityEmoji(priority: Priority): string {
  switch (priority) {
    case 'critical': return '🔴';
    case 'high': return '🟠';
    case 'medium': return '🟡';
    case 'low': return '🟢';
  }
}

/**
 * Check if a terminal name is valid
 */
export function isValidTerminal(name: string): boolean {
  return resolveTerminal(name) !== null;
}
