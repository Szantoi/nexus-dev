-- TaskMessageBox SQLite Schema
-- Az igazság forrása: minden task és message itt él
-- Rendered .md fájlok readonly nézetként generálódnak

-- ============================================================================
-- MESSAGES: Minden üzenet (task, question, done, blocked, info)
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,                    -- MSG-BACKEND-042

    -- Routing
    from_terminal TEXT NOT NULL,            -- küldő (root, conductor, backend, ...)
    to_terminal TEXT NOT NULL,              -- címzett terminál

    -- Type & Priority
    type TEXT NOT NULL CHECK (type IN ('task', 'question', 'done', 'blocked', 'info')),
    priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),

    -- Status lifecycle
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'in_progress', 'completed', 'blocked', 'archived')),

    -- Content
    title TEXT NOT NULL,
    description TEXT NOT NULL,              -- markdown
    acceptance_criteria TEXT,               -- JSON array of strings
    context TEXT,                           -- additional markdown context

    -- Completion data (filled when status = completed/blocked)
    completion_summary TEXT,
    completion_details TEXT,
    files_changed TEXT,                     -- JSON array
    blocked_reason TEXT,
    next_steps TEXT,

    -- References & Linking
    ref_id TEXT,                            -- reference to related message
    epic_id TEXT,                           -- EPIC-CUTTING-Q3
    project_id TEXT,                        -- spaceos/cutting

    -- Model suggestion
    model TEXT CHECK (model IN ('haiku', 'sonnet', 'opus')),

    -- Integrity
    content_hash TEXT NOT NULL,             -- SHA-256 of title + description

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- File sync
    rendered_path TEXT,                     -- path to rendered .md file
    last_rendered_at TEXT,

    -- Indexes
    FOREIGN KEY (ref_id) REFERENCES messages(id)
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_messages_to_terminal ON messages(to_terminal);
CREATE INDEX IF NOT EXISTS idx_messages_from_terminal ON messages(from_terminal);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
CREATE INDEX IF NOT EXISTS idx_messages_epic ON messages(epic_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- ============================================================================
-- MESSAGE_NOTES: Hozzáfűzött jegyzetek (append_to_message)
-- ============================================================================
CREATE TABLE IF NOT EXISTS message_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,

    section TEXT NOT NULL CHECK (section IN ('notes', 'implementation', 'feedback', 'blockers', 'progress')),
    content TEXT NOT NULL,                  -- markdown
    author TEXT,                            -- terminal or user name

    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_message ON message_notes(message_id);

-- ============================================================================
-- TERMINAL_STATUS: Terminál állapot (working/idle)
-- ============================================================================
CREATE TABLE IF NOT EXISTS terminal_status (
    terminal TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'blocked')),
    current_task_id TEXT,
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (current_task_id) REFERENCES messages(id)
);

-- ============================================================================
-- MESSAGE_SEQUENCE: Sorszám generáláshoz terminálonként
-- ============================================================================
CREATE TABLE IF NOT EXISTS message_sequence (
    terminal TEXT PRIMARY KEY,
    last_number INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- VIEWS: Hasznos nézetek
-- ============================================================================

-- Inbox nézet: egy terminál bejövő üzenetei
CREATE VIEW IF NOT EXISTS v_inbox AS
SELECT
    m.*,
    (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id) as note_count
FROM messages m
WHERE m.status NOT IN ('archived')
ORDER BY
    CASE m.priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
    END,
    m.created_at DESC;

-- Outbox nézet: egy terminál kimenő válaszai (done/blocked)
CREATE VIEW IF NOT EXISTS v_outbox AS
SELECT m.*
FROM messages m
WHERE m.type IN ('done', 'blocked')
ORDER BY m.created_at DESC;

-- Active tasks: folyamatban lévő feladatok
CREATE VIEW IF NOT EXISTS v_active_tasks AS
SELECT m.*, ts.status as terminal_status
FROM messages m
LEFT JOIN terminal_status ts ON ts.terminal = m.to_terminal
WHERE m.type = 'task'
  AND m.status IN ('read', 'in_progress')
ORDER BY m.priority, m.created_at;

-- Blocked tasks: blokkolt feladatok
CREATE VIEW IF NOT EXISTS v_blocked_tasks AS
SELECT m.*
FROM messages m
WHERE m.status = 'blocked'
ORDER BY m.updated_at DESC;

-- ============================================================================
-- TRIGGERS: Automatikus műveletek
-- ============================================================================

-- updated_at frissítés
CREATE TRIGGER IF NOT EXISTS trg_messages_updated
AFTER UPDATE ON messages
BEGIN
    UPDATE messages SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Terminal sequence auto-init
CREATE TRIGGER IF NOT EXISTS trg_terminal_sequence_init
AFTER INSERT ON messages
WHEN NOT EXISTS (SELECT 1 FROM message_sequence WHERE terminal = NEW.to_terminal)
BEGIN
    INSERT INTO message_sequence (terminal, last_number) VALUES (NEW.to_terminal, 1);
END;
