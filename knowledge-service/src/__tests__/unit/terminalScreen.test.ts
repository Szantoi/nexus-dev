import { describe, expect, it } from 'vitest';
import {
  classifyTrackedPrompt,
  classifyPromptSample,
  compilePromptPattern,
  TerminalScreenTracker,
} from '../../runner/terminalScreen';

const ESC = '\u001b';
const BEL = '\u0007';

describe('TerminalScreenTracker', () => {
  it('strips CSI/OSC sequences and folds carriage returns', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`${ESC}[31mred${ESC}[0m text\r\nsecond`);
    tracker.observe(`${ESC}]0;window title${BEL}third\rfourth`);

    expect(tracker.strippedTail).toBe('red text\nsecondthird\nfourth');
    expect(tracker.lastNonEmptyLine()).toBe('fourth');
  });

  it('discards alternate-screen output and resumes on the primary screen', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe('before>');
    tracker.observe(`${ESC}[?1049h`);
    expect(tracker.isAlternateScreen).toBe(true);
    tracker.observe('TUI FRAME CONTENT > looks like prompt');
    expect(tracker.strippedTail).toBe('before>');

    tracker.observe(`${ESC}[?1049l`);
    expect(tracker.isAlternateScreen).toBe(false);
    // Leaving the TUI restarts classification from fresh primary output.
    expect(tracker.strippedTail).toBe('');
    tracker.observe('fresh prompt >');
    expect(tracker.lastNonEmptyLine()).toBe('fresh prompt >');
  });

  it.each(['47', '1047', '1049'])('tracks alternate-screen mode %s', (mode) => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`${ESC}[?${mode}h`);
    expect(tracker.isAlternateScreen).toBe(true);
    tracker.observe(`${ESC}[?${mode};4l`);
    expect(tracker.isAlternateScreen).toBe(false);
  });

  it('carries an escape sequence split across chunk boundaries', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`${ESC}[?104`);
    expect(tracker.isAlternateScreen).toBe(false);
    tracker.observe('9h');
    expect(tracker.isAlternateScreen).toBe(true);
    // The split sequence must not leak visible characters.
    expect(tracker.strippedTail).toBe('');
  });

  it('consumes an oversized CSI without evaluating it or losing parser state', () => {
    const tracker = new TerminalScreenTracker();
    // A >64-char CSI body split across chunks: consumed to its final byte,
    // never evaluated, nothing leaks into the visible tail.
    tracker.observe(`${ESC}[${'9'.repeat(50)}`);
    tracker.observe(`${'9'.repeat(50)}m`);
    tracker.observe('plain text after malformed sequence');

    expect(tracker.strippedTail).toBe('plain text after malformed sequence');
    expect(tracker.isAlternateScreen).toBe(false);
    // Later well-formed switches still work: the state machine is intact.
    tracker.observe(`${ESC}[?1049h`);
    expect(tracker.isAlternateScreen).toBe(true);
    tracker.observe(`${ESC}[?1049l`);
    expect(tracker.isAlternateScreen).toBe(false);
  });

  it('never evaluates an oversized alt-screen-looking CSI body', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`${ESC}[?${'1;'.repeat(40)}1049h`);
    expect(tracker.isAlternateScreen).toBe(false);
  });

  it('does not leak a long OSC title split across chunks', () => {
    const tracker = new TerminalScreenTracker();
    const title = 'T'.repeat(80);
    tracker.observe(`${ESC}]0;${title.slice(0, 40)}`);
    tracker.observe(`${title.slice(40)}${BEL}after-title>`);

    expect(tracker.strippedTail).toBe('after-title>');
  });

  it('consumes ECMA-35 intermediate escapes like the terminfo sgr0 charset reset', () => {
    const tracker = new TerminalScreenTracker();
    // xterm sgr0 is ESC ( B ESC [ m — the 'B' must not leak into the tail.
    tracker.observe(`hello${ESC}(B${ESC}[m world`);
    expect(tracker.strippedTail).toBe('hello world');

    tracker.observe(`\n> ${ESC}(B${ESC}[m`);
    expect(tracker.lastNonEmptyLine()).toBe('>');
  });

  it('keeps DCS content invisible even when it contains BEL, until ST', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`${ESC}Psixel-ish ${BEL} payload${ESC}\\visible after ST`);
    expect(tracker.strippedTail).toBe('visible after ST');
  });

  it('handles an ST terminator split across chunks', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`${ESC}]0;title${ESC}`);
    tracker.observe('\\after');
    expect(tracker.strippedTail).toBe('after');
  });

  it('flushes primary text preceding an alt-screen enter within the same chunk', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`prompt> ${ESC}[?1049hTUI CONTENT`);
    expect(tracker.isAlternateScreen).toBe(true);
    expect(tracker.strippedTail).toBe('prompt> ');
  });

  it('uses the cursor-aware rendered row instead of stale append-only output', () => {
    const tracker = new TerminalScreenTracker();
    const pattern = compilePromptPattern(String.raw`[>›❯]\s*$`, 'test');
    tracker.observe(`loading${ESC}[2K\r› `);
    expect(classifyTrackedPrompt(tracker, pattern)).toBe(true);

    // Codex redraws inline status text with cursor-left and erase commands.
    // The old append-only tracker kept the old prompt suffix and accepted it.
    tracker.observe(`${ESC}[2DWorking${ESC}[K`);
    expect(tracker.cursorLine()).toBe('Working');
    expect(classifyTrackedPrompt(tracker, pattern)).toBe(false);
  });

  it('bounds the stripped tail', () => {
    const tracker = new TerminalScreenTracker();
    for (let index = 0; index < 100; index++) {
      tracker.observe(`${'x'.repeat(100)}\n`);
    }
    expect(tracker.strippedTail.length).toBeLessThanOrEqual(4_096);
    expect(tracker.lastNonEmptyLine()).toBe('x'.repeat(100));
  });

  it('resets all state for a new PTY generation', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`old output${ESC}[?1049h`);
    expect(tracker.isAlternateScreen).toBe(true);

    tracker.reset();

    expect(tracker.isAlternateScreen).toBe(false);
    expect(tracker.strippedTail).toBe('');
    tracker.observe('new session >');
    expect(tracker.lastNonEmptyLine()).toBe('new session >');
  });
});

describe('classifyPromptSample', () => {
  const pattern = compilePromptPattern(String.raw`[>›❯]\s*$`, 'test');

  it('recognises a prompt on the last non-empty primary-screen line', () => {
    const tracker = new TerminalScreenTracker();
    expect(classifyPromptSample(tracker, 'codex ready\n> ', pattern)).toBe(true);
  });

  it('fails closed inside an alternate screen even for prompt-like text', () => {
    const tracker = new TerminalScreenTracker();
    tracker.observe(`${ESC}[?1049h`);
    expect(classifyPromptSample(tracker, 'menu > ', pattern)).toBe(false);
  });

  it('fails closed on an empty screen and on unknown output', () => {
    const tracker = new TerminalScreenTracker();
    expect(classifyPromptSample(tracker, `${ESC}[2J`, pattern)).toBe(false);
    expect(classifyPromptSample(tracker, 'Working on the task...', pattern)).toBe(false);
  });

  it('treats replacement-character noise as non-prompt (partial UTF-8)', () => {
    const tracker = new TerminalScreenTracker();
    expect(classifyPromptSample(tracker, 'árvíztűrő �> ', pattern)).toBe(false);
  });
});

describe('compilePromptPattern', () => {
  it('rejects empty, oversized and invalid patterns', () => {
    expect(() => compilePromptPattern('', 'x')).toThrow(/1\.\.200/);
    expect(() => compilePromptPattern('a'.repeat(201), 'x')).toThrow(/1\.\.200/);
    expect(() => compilePromptPattern('[unclosed', 'x')).toThrow(/not a valid regular expression/);
  });
});
