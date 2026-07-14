import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Scheduled Windows Tests — Phase 5 Time-Based Dispatch
 *
 * Tests the time window configuration for autonomous sessions.
 */

// In-memory test database
let testDb: Database.Database;

// Mock the common module
vi.mock('../../pipeline/common', () => ({
  telegram: vi.fn().mockResolvedValue(undefined),
  log: vi.fn(),
}));

// Mock current time for testing
let mockNow = new Date('2026-06-23T10:30:00'); // Tuesday 10:30 (2026-06-23 is a Tuesday)

function resetTestDb() {
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS window_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      timezone TEXT NOT NULL DEFAULT 'Europe/Budapest',
      default_mode TEXT NOT NULL DEFAULT 'manual',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO window_config (id, timezone, default_mode)
    VALUES (1, 'Europe/Budapest', 'manual');

    CREATE TABLE IF NOT EXISTS dispatch_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      days TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      allowed_terminals TEXT NOT NULL,
      max_sessions INTEGER DEFAULT 3,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS window_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal TEXT NOT NULL,
      window_name TEXT NOT NULL,
      session_id TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    );
  `);
}

// Test helpers
type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

interface DispatchWindow {
  name: string;
  days: DayOfWeek[];
  startTime: string;
  endTime: string;
  allowedTerminals: string[];
  maxSessions: number;
}

const DAY_MAP: Record<number, DayOfWeek> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};

function getCurrentDay(): DayOfWeek {
  return DAY_MAP[mockNow.getDay()];
}

function getCurrentTime(): string {
  return `${mockNow.getHours().toString().padStart(2, '0')}:${mockNow.getMinutes().toString().padStart(2, '0')}`;
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function isTimeInRange(current: string, start: string, end: string): boolean {
  const currentMin = timeToMinutes(current);
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);

  if (endMin < startMin) {
    return currentMin >= startMin || currentMin < endMin;
  }

  return currentMin >= startMin && currentMin < endMin;
}

function addWindow(window: DispatchWindow): void {
  testDb.prepare(`
    INSERT OR REPLACE INTO dispatch_windows (name, days, start_time, end_time, allowed_terminals, max_sessions)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    window.name,
    JSON.stringify(window.days),
    window.startTime,
    window.endTime,
    JSON.stringify(window.allowedTerminals),
    window.maxSessions
  );
}

function removeWindow(name: string): boolean {
  const result = testDb.prepare('DELETE FROM dispatch_windows WHERE name = ?').run(name);
  return result.changes > 0;
}

function getWindows(): DispatchWindow[] {
  const rows = testDb.prepare(`
    SELECT name, days, start_time, end_time, allowed_terminals, max_sessions
    FROM dispatch_windows
    WHERE enabled = 1
  `).all() as Array<{
    name: string;
    days: string;
    start_time: string;
    end_time: string;
    allowed_terminals: string;
    max_sessions: number;
  }>;

  return rows.map(row => ({
    name: row.name,
    days: JSON.parse(row.days) as DayOfWeek[],
    startTime: row.start_time,
    endTime: row.end_time,
    allowedTerminals: JSON.parse(row.allowed_terminals) as string[],
    maxSessions: row.max_sessions,
  }));
}

function setDefaultMode(mode: 'manual' | 'auto'): void {
  testDb.prepare('UPDATE window_config SET default_mode = ? WHERE id = 1').run(mode);
}

function getDefaultMode(): 'manual' | 'auto' {
  const row = testDb.prepare('SELECT default_mode FROM window_config WHERE id = 1').get() as { default_mode: string };
  return (row?.default_mode as 'manual' | 'auto') || 'manual';
}

function getCurrentWindow(): DispatchWindow | null {
  const currentDay = getCurrentDay();
  const currentTime = getCurrentTime();
  const windows = getWindows();

  for (const window of windows) {
    if (window.days.includes(currentDay) && isTimeInRange(currentTime, window.startTime, window.endTime)) {
      return window;
    }
  }

  return null;
}

function registerWindowSession(terminal: string, windowName: string, sessionId?: string): void {
  testDb.prepare(`
    INSERT INTO window_sessions (terminal, window_name, session_id)
    VALUES (?, ?, ?)
  `).run(terminal, windowName, sessionId);
}

function endWindowSession(terminal: string): void {
  testDb.prepare(`
    UPDATE window_sessions
    SET ended_at = datetime('now')
    WHERE terminal = ? AND ended_at IS NULL
  `).run(terminal);
}

function getActiveSessionsInWindow(windowName: string) {
  return testDb.prepare(`
    SELECT terminal, window_name, started_at
    FROM window_sessions
    WHERE window_name = ? AND ended_at IS NULL
  `).all(windowName);
}

function checkWindowForTerminal(terminal: string) {
  const currentTime = getCurrentTime();
  const currentWindow = getCurrentWindow();

  if (!currentWindow) {
    const defaultMode = getDefaultMode();

    return {
      inWindow: false,
      terminalAllowed: defaultMode === 'auto',
      reason: defaultMode === 'auto'
        ? 'Outside scheduled windows - default mode is auto'
        : 'Outside scheduled windows - manual dispatch only',
      currentTime,
    };
  }

  const terminalAllowed = currentWindow.allowedTerminals.includes(terminal) ||
    currentWindow.allowedTerminals.length === 0;

  // Check max sessions
  if (terminalAllowed) {
    const activeSessions = getActiveSessionsInWindow(currentWindow.name);
    if (activeSessions.length >= currentWindow.maxSessions) {
      return {
        inWindow: true,
        windowName: currentWindow.name,
        terminalAllowed: false,
        reason: `Window "${currentWindow.name}" has reached max sessions (${currentWindow.maxSessions})`,
        currentTime,
      };
    }
  }

  return {
    inWindow: true,
    windowName: currentWindow.name,
    terminalAllowed,
    reason: terminalAllowed
      ? `Terminal ${terminal} allowed in window "${currentWindow.name}"`
      : `Terminal ${terminal} not allowed in window "${currentWindow.name}"`,
    currentTime,
  };
}

describe('ScheduledWindows', () => {
  beforeEach(() => {
    resetTestDb();
    mockNow = new Date('2026-06-23T10:30:00'); // Reset to Tuesday 10:30
  });

  describe('Window Management', () => {
    it('should add a new window', () => {
      addWindow({
        name: 'Dev Session 1',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend', 'frontend'],
        maxSessions: 2,
      });

      const windows = getWindows();
      expect(windows.length).toBe(1);
      expect(windows[0].name).toBe('Dev Session 1');
      expect(windows[0].days).toContain('mon');
      expect(windows[0].allowedTerminals).toContain('backend');
    });

    it('should remove a window', () => {
      addWindow({
        name: 'Test Window',
        days: ['mon'],
        startTime: '09:00',
        endTime: '10:00',
        allowedTerminals: ['backend'],
        maxSessions: 1,
      });

      const removed = removeWindow('Test Window');
      expect(removed).toBe(true);

      const windows = getWindows();
      expect(windows.length).toBe(0);
    });

    it('should return false when removing non-existent window', () => {
      const removed = removeWindow('Non-Existent');
      expect(removed).toBe(false);
    });

    it('should update existing window', () => {
      addWindow({
        name: 'Test Window',
        days: ['mon'],
        startTime: '09:00',
        endTime: '10:00',
        allowedTerminals: ['backend'],
        maxSessions: 1,
      });

      addWindow({
        name: 'Test Window',
        days: ['mon', 'tue'],
        startTime: '09:00',
        endTime: '11:00',
        allowedTerminals: ['backend', 'frontend'],
        maxSessions: 3,
      });

      const windows = getWindows();
      expect(windows.length).toBe(1);
      expect(windows[0].days).toContain('tue');
      expect(windows[0].maxSessions).toBe(3);
    });
  });

  describe('Default Mode', () => {
    it('should default to manual mode', () => {
      expect(getDefaultMode()).toBe('manual');
    });

    it('should set default mode', () => {
      setDefaultMode('auto');
      expect(getDefaultMode()).toBe('auto');

      setDefaultMode('manual');
      expect(getDefaultMode()).toBe('manual');
    });
  });

  describe('Window Detection', () => {
    it('should detect current window', () => {
      // Mock time: Monday 10:30
      addWindow({
        name: 'Dev Session 1',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend', 'frontend'],
        maxSessions: 2,
      });

      const currentWindow = getCurrentWindow();
      expect(currentWindow).not.toBeNull();
      expect(currentWindow?.name).toBe('Dev Session 1');
    });

    it('should return null when outside all windows', () => {
      // Mock time: Monday 10:30, but window is 14:00-18:00
      addWindow({
        name: 'Afternoon Session',
        days: ['mon'],
        startTime: '14:00',
        endTime: '18:00',
        allowedTerminals: ['backend'],
        maxSessions: 2,
      });

      const currentWindow = getCurrentWindow();
      expect(currentWindow).toBeNull();
    });

    it('should handle multiple windows', () => {
      addWindow({
        name: 'Morning',
        days: ['tue'],
        startTime: '08:00',
        endTime: '10:00',
        allowedTerminals: ['conductor'],
        maxSessions: 1,
      });

      addWindow({
        name: 'Dev Time',
        days: ['tue'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend'],
        maxSessions: 2,
      });

      // 10:30 should match 'Dev Time'
      const currentWindow = getCurrentWindow();
      expect(currentWindow?.name).toBe('Dev Time');
    });

    it('should respect day of week', () => {
      addWindow({
        name: 'Weekend Only',
        days: ['sat', 'sun'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['librarian'],
        maxSessions: 1,
      });

      // Monday should not match
      const currentWindow = getCurrentWindow();
      expect(currentWindow).toBeNull();
    });
  });

  describe('Terminal Permission Check', () => {
    it('should allow terminal in window', () => {
      addWindow({
        name: 'Dev Session',
        days: ['tue'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend', 'frontend'],
        maxSessions: 2,
      });

      const check = checkWindowForTerminal('backend');
      expect(check.inWindow).toBe(true);
      expect(check.terminalAllowed).toBe(true);
      expect(check.windowName).toBe('Dev Session');
    });

    it('should reject terminal not in allowed list', () => {
      addWindow({
        name: 'Dev Session',
        days: ['tue'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend', 'frontend'],
        maxSessions: 2,
      });

      const check = checkWindowForTerminal('conductor');
      expect(check.inWindow).toBe(true);
      expect(check.terminalAllowed).toBe(false);
      expect(check.reason).toContain('not allowed');
    });

    it('should use default mode outside windows', () => {
      // No windows configured
      setDefaultMode('manual');
      let check = checkWindowForTerminal('backend');
      expect(check.inWindow).toBe(false);
      expect(check.terminalAllowed).toBe(false);
      expect(check.reason).toContain('manual dispatch only');

      setDefaultMode('auto');
      check = checkWindowForTerminal('backend');
      expect(check.inWindow).toBe(false);
      expect(check.terminalAllowed).toBe(true);
      expect(check.reason).toContain('default mode is auto');
    });

    it('should enforce max sessions', () => {
      addWindow({
        name: 'Limited Session',
        days: ['tue'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend'],
        maxSessions: 2,
      });

      // Register 2 sessions
      registerWindowSession('backend', 'Limited Session', 'session-1');
      registerWindowSession('backend', 'Limited Session', 'session-2');

      const check = checkWindowForTerminal('backend');
      expect(check.inWindow).toBe(true);
      expect(check.terminalAllowed).toBe(false);
      expect(check.reason).toContain('max sessions');
    });
  });

  describe('Session Tracking', () => {
    it('should register and track sessions', () => {
      addWindow({
        name: 'Test Window',
        days: ['mon'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend'],
        maxSessions: 3,
      });

      registerWindowSession('backend', 'Test Window', 'session-abc');

      const sessions = getActiveSessionsInWindow('Test Window');
      expect(sessions.length).toBe(1);
      expect((sessions[0] as any).terminal).toBe('backend');
    });

    it('should end sessions', () => {
      registerWindowSession('backend', 'Test Window', 'session-abc');

      let sessions = getActiveSessionsInWindow('Test Window');
      expect(sessions.length).toBe(1);

      endWindowSession('backend');

      sessions = getActiveSessionsInWindow('Test Window');
      expect(sessions.length).toBe(0);
    });

    it('should track multiple terminals', () => {
      registerWindowSession('backend', 'Test Window', 'session-1');
      registerWindowSession('frontend', 'Test Window', 'session-2');

      const sessions = getActiveSessionsInWindow('Test Window');
      expect(sessions.length).toBe(2);

      endWindowSession('backend');

      const remaining = getActiveSessionsInWindow('Test Window');
      expect(remaining.length).toBe(1);
      expect((remaining[0] as any).terminal).toBe('frontend');
    });
  });

  describe('Time Edge Cases', () => {
    it('should handle window boundaries', () => {
      addWindow({
        name: 'Morning',
        days: ['tue'],
        startTime: '10:00',
        endTime: '12:00',
        allowedTerminals: ['backend'],
        maxSessions: 2,
      });

      // Exactly at start
      mockNow = new Date('2026-06-23T10:00:00');
      expect(getCurrentWindow()?.name).toBe('Morning');

      // Just before end
      mockNow = new Date('2026-06-23T11:59:00');
      expect(getCurrentWindow()?.name).toBe('Morning');

      // At end (should be outside)
      mockNow = new Date('2026-06-23T12:00:00');
      expect(getCurrentWindow()).toBeNull();

      // Just before start
      mockNow = new Date('2026-06-23T09:59:00');
      expect(getCurrentWindow()).toBeNull();
    });

    it('should handle overnight windows', () => {
      addWindow({
        name: 'Night Watch',
        days: ['tue'],
        startTime: '22:00',
        endTime: '02:00',
        allowedTerminals: ['librarian'],
        maxSessions: 1,
      });

      // At 23:00 should be in window
      mockNow = new Date('2026-06-23T23:00:00');
      expect(isTimeInRange('23:00', '22:00', '02:00')).toBe(true);

      // At 01:00 should be in window
      expect(isTimeInRange('01:00', '22:00', '02:00')).toBe(true);

      // At 03:00 should be outside
      expect(isTimeInRange('03:00', '22:00', '02:00')).toBe(false);
    });
  });
});
