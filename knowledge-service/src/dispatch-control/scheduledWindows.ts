/**
 * Scheduled Windows — Phase 5 Time-Based Dispatch Control
 *
 * Allows configuration of time windows for autonomous sessions.
 * Outside windows: manual dispatch only.
 * Inside windows: dispatch allowed based on terminal permissions.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { log } from '../pipeline/common';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DispatchWindow {
  name: string;
  days: DayOfWeek[];
  startTime: string; // HH:MM format
  endTime: string;   // HH:MM format
  allowedTerminals: string[];
  maxSessions: number;
}

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface WindowConfig {
  timezone: string;
  windows: DispatchWindow[];
  defaultMode: 'manual' | 'auto';
}

export interface WindowCheck {
  inWindow: boolean;
  windowName?: string;
  terminalAllowed: boolean;
  reason: string;
  currentTime: string;
  nextWindow?: {
    name: string;
    startsIn: string;
  };
}

export interface ActiveSession {
  terminal: string;
  windowName: string;
  startedAt: string;
}

// ── Database Access ──────────────────────────────────────────────────────────

let db: Database.Database | null = null;

export function setWindowsDb(database: Database.Database): void {
  db = database;
  // Create scheduled windows tables if not exist
  db.exec(`
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

function getDb(): Database.Database {
  if (!db) {
    throw new Error('Windows database not initialized. Call setWindowsDb first.');
  }
  return db;
}

// ── Time Utilities ───────────────────────────────────────────────────────────

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
  return DAY_MAP[new Date().getDay()];
}

function getCurrentTime(): string {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function isTimeInRange(current: string, start: string, end: string): boolean {
  const currentMin = timeToMinutes(current);
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);

  // Handle overnight windows (e.g., 22:00 - 02:00)
  if (endMin < startMin) {
    return currentMin >= startMin || currentMin < endMin;
  }

  return currentMin >= startMin && currentMin < endMin;
}

function minutesToDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ── Window Management ────────────────────────────────────────────────────────

export function addWindow(window: DispatchWindow): void {
  getDb().prepare(`
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

  log(`[ScheduledWindows] Added window: ${window.name} (${window.startTime}-${window.endTime})`);
}

export function removeWindow(name: string): boolean {
  const result = getDb().prepare('DELETE FROM dispatch_windows WHERE name = ?').run(name);
  return result.changes > 0;
}

export function getWindows(): DispatchWindow[] {
  const rows = getDb().prepare(`
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

export function setDefaultMode(mode: 'manual' | 'auto'): void {
  getDb().prepare('UPDATE window_config SET default_mode = ? WHERE id = 1').run(mode);
}

export function getDefaultMode(): 'manual' | 'auto' {
  const row = getDb().prepare('SELECT default_mode FROM window_config WHERE id = 1').get() as { default_mode: string };
  return (row?.default_mode as 'manual' | 'auto') || 'manual';
}

// ── Window Checking ──────────────────────────────────────────────────────────

export function getCurrentWindow(): DispatchWindow | null {
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

export function getNextWindow(): { window: DispatchWindow; startsIn: number } | null {
  const currentDay = getCurrentDay();
  const currentTime = getCurrentTime();
  const currentMinutes = timeToMinutes(currentTime);
  const windows = getWindows();

  let closest: { window: DispatchWindow; startsIn: number } | null = null;

  for (const window of windows) {
    // Check if window starts later today
    if (window.days.includes(currentDay)) {
      const startMinutes = timeToMinutes(window.startTime);
      if (startMinutes > currentMinutes) {
        const startsIn = startMinutes - currentMinutes;
        if (!closest || startsIn < closest.startsIn) {
          closest = { window, startsIn };
        }
      }
    }
  }

  return closest;
}

export function checkWindowForTerminal(terminal: string): WindowCheck {
  const currentTime = getCurrentTime();
  const currentWindow = getCurrentWindow();

  if (!currentWindow) {
    const defaultMode = getDefaultMode();
    const nextWindow = getNextWindow();

    return {
      inWindow: false,
      terminalAllowed: defaultMode === 'auto',
      reason: defaultMode === 'auto'
        ? 'Outside scheduled windows - default mode is auto'
        : 'Outside scheduled windows - manual dispatch only',
      currentTime,
      nextWindow: nextWindow ? {
        name: nextWindow.window.name,
        startsIn: minutesToDuration(nextWindow.startsIn),
      } : undefined,
    };
  }

  const terminalAllowed = currentWindow.allowedTerminals.includes(terminal) ||
    currentWindow.allowedTerminals.length === 0; // Empty list means all allowed

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

// ── Session Tracking ─────────────────────────────────────────────────────────

export function registerWindowSession(terminal: string, windowName: string, sessionId?: string): void {
  getDb().prepare(`
    INSERT INTO window_sessions (terminal, window_name, session_id)
    VALUES (?, ?, ?)
  `).run(terminal, windowName, sessionId);
}

export function endWindowSession(terminal: string): void {
  getDb().prepare(`
    UPDATE window_sessions
    SET ended_at = datetime('now')
    WHERE terminal = ? AND ended_at IS NULL
  `).run(terminal);
}

export function getActiveSessionsInWindow(windowName: string): ActiveSession[] {
  const rows = getDb().prepare(`
    SELECT terminal, window_name, started_at
    FROM window_sessions
    WHERE window_name = ? AND ended_at IS NULL
  `).all(windowName) as Array<{
    terminal: string;
    window_name: string;
    started_at: string;
  }>;

  return rows.map(row => ({
    terminal: row.terminal,
    windowName: row.window_name,
    startedAt: row.started_at,
  }));
}

export function getAllActiveSessions(): ActiveSession[] {
  const rows = getDb().prepare(`
    SELECT terminal, window_name, started_at
    FROM window_sessions
    WHERE ended_at IS NULL
  `).all() as Array<{
    terminal: string;
    window_name: string;
    started_at: string;
  }>;

  return rows.map(row => ({
    terminal: row.terminal,
    windowName: row.window_name,
    startedAt: row.started_at,
  }));
}

// ── Preset Configurations ────────────────────────────────────────────────────

export function loadDefaultWindows(): void {
  const presets: DispatchWindow[] = [
    {
      name: 'Morning Planning',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startTime: '08:00',
      endTime: '09:00',
      allowedTerminals: ['conductor', 'architect'],
      maxSessions: 3,
    },
    {
      name: 'Dev Session 1',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startTime: '10:00',
      endTime: '12:00',
      allowedTerminals: ['backend', 'frontend', 'designer'],
      maxSessions: 2,
    },
    {
      name: 'Dev Session 2',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startTime: '14:00',
      endTime: '18:00',
      allowedTerminals: ['backend', 'frontend', 'designer'],
      maxSessions: 3,
    },
    {
      name: 'Night Watch',
      days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      startTime: '22:00',
      endTime: '23:00',
      allowedTerminals: ['conductor', 'librarian'],
      maxSessions: 1,
    },
  ];

  for (const preset of presets) {
    addWindow(preset);
  }

  log('[ScheduledWindows] Loaded default window configuration');
}

// ── Statistics ───────────────────────────────────────────────────────────────

export interface WindowStats {
  totalWindows: number;
  currentWindow: string | null;
  activeSessionsCount: number;
  sessionsToday: number;
}

export function getWindowStats(): WindowStats {
  const windows = getWindows();
  const currentWindow = getCurrentWindow();
  const activeSessions = getAllActiveSessions();

  const sessionsToday = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM window_sessions
    WHERE DATE(started_at) = DATE('now')
  `).get() as { count: number };

  return {
    totalWindows: windows.length,
    currentWindow: currentWindow?.name || null,
    activeSessionsCount: activeSessions.length,
    sessionsToday: sessionsToday.count,
  };
}
