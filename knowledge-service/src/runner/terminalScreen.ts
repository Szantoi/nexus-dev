/**
 * terminalScreen.ts — incremental ANSI/alternate-screen tracking and
 * fail-closed prompt classification for attached PTY output.
 *
 * The tracker consumes raw PTY chunks (already decoded to UTF-16 by node-pty;
 * chunk-boundary decoding artifacts appear as U+FFFD and are treated as
 * noise). The parser STATE persists across chunks, so escape sequences split
 * at any boundary — including inside OSC/DCS strings and the ST terminator —
 * never leak content into the visible tail and never lose an alternate-screen
 * switch. Anything the classifier does not positively recognise is NOT a
 * prompt: unknown screens, alternate-screen content and partial sequences all
 * classify as false.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const REPLACEMENT_CHAR = '�';

const MAX_TAIL_CHARS = 4_096;
const MAX_CSI_BODY_CHARS = 64;
const MAX_PATTERN_SOURCE_LENGTH = 200;

/** Alternate-screen private modes: DECSET/DECRST 47, 1047, 1049. */
const ALT_SCREEN_MODES = new Set(['47', '1047', '1049']);

type ParserState = 'text' | 'esc' | 'csi' | 'osc' | 'dcs';

/**
 * Compile a user-supplied prompt pattern with bounded length and no flags.
 * Patterns are matched against the LAST non-empty stripped line only, so
 * anchors refer to that line.
 */
export function compilePromptPattern(source: string, context: string): RegExp {
  if (!source || source.length > MAX_PATTERN_SOURCE_LENGTH) {
    throw new Error(
      `${context} prompt pattern must be 1..${MAX_PATTERN_SOURCE_LENGTH} characters`,
    );
  }
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(
      `${context} prompt pattern is not a valid regular expression: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Incremental screen-state tracker for one PTY session. Reset it whenever a
 * new PTY generation starts; a stale alternate-screen flag from a dead
 * session must never leak into the replacement session's classification.
 */
export class TerminalScreenTracker {
  private tail = '';
  private parserState: ParserState = 'text';
  private csiBody = '';
  private csiOverflow = false;
  private stringEscPending = false;
  private alternateScreen = false;

  reset(): void {
    this.tail = '';
    this.parserState = 'text';
    this.csiBody = '';
    this.csiOverflow = false;
    this.stringEscPending = false;
    this.alternateScreen = false;
  }

  get isAlternateScreen(): boolean {
    return this.alternateScreen;
  }

  /** Stripped, bounded scrollback tail of the primary screen. */
  get strippedTail(): string {
    return this.tail;
  }

  /** Last non-empty stripped line; empty string when none exists. */
  lastNonEmptyLine(): string {
    const lines = this.tail.split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index].trim();
      if (line.length > 0) return line;
    }
    return '';
  }

  /**
   * Consume one PTY chunk: track alternate-screen switches and append the
   * visible text (alternate-screen output is intentionally discarded — TUI
   * frames must not look like prompts).
   */
  observe(chunk: string): void {
    let visible = '';
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];
      switch (this.parserState) {
        case 'text':
          if (char === ESC) {
            this.parserState = 'esc';
          } else if (char === '\r') {
            // Fold bare \r into a line break; \r\n keeps its single \n.
            if (chunk[index + 1] !== '\n') visible += '\n';
          } else if (char === '\n' || char === '\t' || char >= ' ') {
            visible += char;
          }
          // Other C0 controls (BEL, BS, ...) are dropped.
          break;
        case 'esc':
          if (char === '[') {
            this.parserState = 'csi';
            this.csiBody = '';
            this.csiOverflow = false;
          } else if (char === ']') {
            this.parserState = 'osc';
            this.stringEscPending = false;
          } else if (char === 'P' || char === '_' || char === '^' || char === 'X') {
            this.parserState = 'dcs'; // DCS/APC/PM/SOS: consumed until ST
            this.stringEscPending = false;
          } else if (char >= ' ' && char <= '/') {
            // ECMA-35 intermediate byte (e.g. ESC ( B charset designation):
            // stay in the escape state until the final byte arrives.
          } else {
            this.parserState = 'text'; // Final byte of a short escape.
          }
          break;
        case 'csi':
          if (char >= '@' && char <= '~') {
            const screenSwitch = this.csiOverflow
              ? undefined
              : evaluateAltScreenSwitch(this.csiBody, char);
            this.parserState = 'text';
            if (screenSwitch === 'enter') {
              // Flush primary-screen text produced earlier in this chunk.
              if (!this.alternateScreen && visible.length > 0) this.appendVisible(visible);
              visible = '';
              this.alternateScreen = true;
            } else if (screenSwitch === 'exit') {
              // Leaving the TUI: classification restarts from fresh output.
              this.alternateScreen = false;
              this.tail = '';
              visible = '';
            }
          } else if (this.csiBody.length < MAX_CSI_BODY_CHARS) {
            this.csiBody += char;
          } else {
            // Keep consuming to the final byte, but never evaluate a body
            // this malformed — and never lose the parser state doing so.
            this.csiOverflow = true;
          }
          break;
        case 'osc':
          // OSC ends at BEL or ST (ESC \); its content is never visible.
          if (char === BEL || (char === '\\' && this.stringEscPending)) {
            this.parserState = 'text';
          }
          this.stringEscPending = char === ESC;
          break;
        case 'dcs':
          // DCS/APC/PM/SOS end at ST only; BEL may legitimately occur inside.
          if (char === '\\' && this.stringEscPending) {
            this.parserState = 'text';
          }
          this.stringEscPending = char === ESC;
          break;
      }
    }
    if (!this.alternateScreen && visible.length > 0) {
      this.appendVisible(visible);
    }
  }

  private appendVisible(visible: string): void {
    this.tail += visible;
    if (this.tail.length > MAX_TAIL_CHARS) {
      const cut = this.tail.length - MAX_TAIL_CHARS;
      const newline = this.tail.indexOf('\n', cut);
      this.tail = this.tail.slice(newline >= 0 && newline < cut + 200 ? newline + 1 : cut);
    }
  }
}

function evaluateAltScreenSwitch(
  body: string,
  final: string,
): 'enter' | 'exit' | undefined {
  // Alternate-screen switches use the private '?' marker with modes
  // 47/1047/1049 and final 'h' (set) / 'l' (reset).
  if ((final !== 'h' && final !== 'l') || !body.startsWith('?')) return undefined;
  const modes = body.slice(1).split(';');
  if (!modes.some((mode) => ALT_SCREEN_MODES.has(mode))) return undefined;
  return final === 'h' ? 'enter' : 'exit';
}

/**
 * Classify the tracker's CURRENT screen without feeding new data. Fail
 * closed: alternate screens, empty screens and replacement-character noise
 * never classify true.
 */
export function classifyTrackedPrompt(
  tracker: TerminalScreenTracker,
  promptPattern: RegExp,
): boolean {
  if (tracker.isAlternateScreen) return false;
  const line = tracker.lastNonEmptyLine();
  if (!line || line.includes(REPLACEMENT_CHAR)) return false;
  return promptPattern.test(line);
}

/** Observe one chunk, then classify — for callers that own the data feed. */
export function classifyPromptSample(
  tracker: TerminalScreenTracker,
  chunk: string,
  promptPattern: RegExp,
): boolean {
  tracker.observe(chunk);
  return classifyTrackedPrompt(tracker, promptPattern);
}
