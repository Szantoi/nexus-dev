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
const MAX_SCREEN_ROWS = 80;
const MAX_SCREEN_COLUMNS = 512;

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
  /**
   * A deliberately small primary-screen model. The scrollback tail is useful
   * for diagnostics, but cannot safely identify an inline TUI prompt: Codex
   * redraws the same rows with CSI cursor/erase commands. Prompt detection
   * therefore reads this cursor-aware model instead of the append-only tail.
   */
  private screen = [''];
  private cursorRow = 0;
  private cursorColumn = 0;
  private savedCursorRow = 0;
  private savedCursorColumn = 0;
  private parserState: ParserState = 'text';
  private csiBody = '';
  private csiOverflow = false;
  private stringEscPending = false;
  private alternateScreen = false;

  reset(): void {
    this.tail = '';
    this.screen = [''];
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.savedCursorRow = 0;
    this.savedCursorColumn = 0;
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
      if (line) return line;
    }
    return '';
  }

  /** Visible row at the terminal's current cursor position. */
  cursorLine(): string {
    return this.currentLine().trim();
  }

  /** Bounded current primary screen, exposed only for safe local diagnostics. */
  get strippedScreen(): string {
    return this.screen.join('\n');
  }

  private currentLine(): string {
    return this.screen[this.cursorRow] ?? '';
  }

  private setCurrentLine(line: string): void {
    this.screen[this.cursorRow] = line.slice(0, MAX_SCREEN_COLUMNS);
  }

  private ensureCursorRow(): void {
    while (this.cursorRow >= this.screen.length) this.screen.push('');
    if (this.screen.length <= MAX_SCREEN_ROWS) return;
    const removed = this.screen.length - MAX_SCREEN_ROWS;
    this.screen.splice(0, removed);
    this.cursorRow = Math.max(0, this.cursorRow - removed);
  }

  private writeVisible(char: string): void {
    const line = this.currentLine();
    // Preserve a complete bounded audit tail even after the small screen model
    // reaches its column cap. The model is only for prompt classification.
    this.appendVisible(char);
    if (this.cursorColumn >= MAX_SCREEN_COLUMNS) return;
    const padded = line.padEnd(this.cursorColumn, ' ');
    this.setCurrentLine(`${padded.slice(0, this.cursorColumn)}${char}${padded.slice(this.cursorColumn + 1)}`);
    this.cursorColumn++;
  }

  private lineFeed(): void {
    this.cursorRow++;
    this.ensureCursorRow();
    this.appendVisible('\n');
  }

  private eraseLine(mode: number): void {
    const line = this.currentLine();
    if (mode === 1) this.setCurrentLine(line.slice(this.cursorColumn));
    else if (mode === 2) this.setCurrentLine('');
    else this.setCurrentLine(line.slice(0, this.cursorColumn));
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.screen = [''];
      this.cursorRow = 0;
      this.cursorColumn = 0;
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row++) this.screen[row] = '';
      this.eraseLine(1);
      return;
    }
    this.eraseLine(0);
    for (let row = this.cursorRow + 1; row < this.screen.length; row++) this.screen[row] = '';
  }

  /**
   * Consume one PTY chunk: track alternate-screen switches and append the
   * visible text (alternate-screen output is intentionally discarded — TUI
   * frames must not look like prompts).
   */
  observe(chunk: string): void {
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];
      switch (this.parserState) {
        case 'text':
          if (char === ESC) {
            this.parserState = 'esc';
          } else if (char === '\r') {
            if (!this.alternateScreen) {
              this.cursorColumn = 0;
              // Treat a bare carriage return as the start of a replacement
              // status line. This is conservative for prompt recognition: a
              // stale suffix must not make a busy redraw look idle.
              this.setCurrentLine('');
              // Retain historic stripped-tail behaviour for non-CRLF output.
              if (chunk[index + 1] !== '\n') this.appendVisible('\n');
            }
          } else if (char === '\n') {
            if (!this.alternateScreen) this.lineFeed();
          } else if (char === '\t') {
            const spaces = 8 - (this.cursorColumn % 8);
            if (!this.alternateScreen) {
              for (let column = 0; column < spaces; column++) this.writeVisible(' ');
            }
          } else if (char >= ' ') {
            if (!this.alternateScreen) this.writeVisible(char);
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
            const body = this.csiBody;
            const screenSwitch = this.csiOverflow ? undefined : evaluateAltScreenSwitch(body, char);
            this.parserState = 'text';
            if (screenSwitch === 'enter') {
              this.alternateScreen = true;
            } else if (screenSwitch === 'exit') {
              // Leaving the TUI: classification restarts from fresh output.
              this.alternateScreen = false;
              this.tail = '';
              this.screen = [''];
              this.cursorRow = 0;
              this.cursorColumn = 0;
            } else if (!this.alternateScreen && !this.csiOverflow) {
              this.applyCsi(body, char);
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
  }

  private applyCsi(body: string, final: string): void {
    const params = body.replace(/^[?>!]/, '').split(';').map((part) => Number(part || '0'));
    const count = (index = 0, fallback = 1): number => Math.max(1, params[index] || fallback);
    switch (final) {
      case 'A': this.cursorRow = Math.max(0, this.cursorRow - count()); break;
      case 'B': this.cursorRow += count(); this.ensureCursorRow(); break;
      case 'C': this.cursorColumn = Math.min(MAX_SCREEN_COLUMNS, this.cursorColumn + count()); break;
      case 'D': this.cursorColumn = Math.max(0, this.cursorColumn - count()); break;
      case 'G': this.cursorColumn = Math.min(MAX_SCREEN_COLUMNS, count() - 1); break;
      case 'H':
      case 'f':
        this.cursorRow = Math.min(MAX_SCREEN_ROWS - 1, count(0, 1) - 1);
        this.cursorColumn = Math.min(MAX_SCREEN_COLUMNS, count(1, 1) - 1);
        this.ensureCursorRow();
        break;
      case 'J': this.eraseDisplay(params[0] || 0); break;
      case 'K': this.eraseLine(params[0] || 0); break;
      case 's': this.savedCursorRow = this.cursorRow; this.savedCursorColumn = this.cursorColumn; break;
      case 'u':
        this.cursorRow = this.savedCursorRow;
        this.cursorColumn = this.savedCursorColumn;
        this.ensureCursorRow();
        break;
      default: break; // Rendering/style commands have no semantic effect here.
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
  // A prompt must be on the row where the terminal left its cursor. Falling
  // back to a prior non-empty row would let a stale, redrawn prompt prove a
  // still-busy inline TUI is ready.
  const line = tracker.cursorLine();
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
