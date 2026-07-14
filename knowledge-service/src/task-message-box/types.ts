/**
 * TaskMessageBox Types
 *
 * Type definitions for the DB-backed message system.
 */

// ─── Message Types ───────────────────────────────────────────────────────────

export type MessageType = 'task' | 'question' | 'done' | 'blocked' | 'info';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type MessageStatus = 'unread' | 'read' | 'in_progress' | 'completed' | 'blocked' | 'archived';

/** One entry in a message's status-transition audit trail (stored as a JSON array). */
export interface StatusHistoryEntry {
  from: MessageStatus | null;   // null = initial state at creation
  to: MessageStatus;
  at: string;                   // ISO timestamp
  by?: string;                  // who caused the transition (terminal/agent/system)
}
export type Model = 'haiku' | 'sonnet' | 'opus';
export type NoteSection = 'notes' | 'implementation' | 'feedback' | 'blockers' | 'progress';

// ─── Message Entity ──────────────────────────────────────────────────────────

export interface Message {
  id: string;                     // MSG-BACKEND-042

  // Routing
  from_terminal: string;
  to_terminal: string;

  // Federation routing (null = local intra-island message; set = cross-island).
  // A message is a federation message iff to_island is set and differs from the
  // local ISLAND_ID. Local messages leave these null and never touch the hub.
  from_island?: string;
  to_island?: string;

  // Type & Priority
  type: MessageType;
  priority: Priority;
  status: MessageStatus;

  // Content
  title: string;
  description: string;
  acceptance_criteria?: string[]; // stored as JSON
  context?: string;

  // Completion data
  completion_summary?: string;
  completion_details?: string;
  files_changed?: string[];       // stored as JSON
  blocked_reason?: string;
  next_steps?: string;

  // References
  ref_id?: string;
  epic_id?: string;
  project_id?: string;

  // Model
  model?: Model;

  // Integrity
  content_hash: string;
  status_history?: StatusHistoryEntry[];

  // Timestamps
  created_at: string;
  read_at?: string;
  started_at?: string;
  completed_at?: string;
  updated_at: string;

  // File sync
  rendered_path?: string;
  last_rendered_at?: string;

  // Computed (from joins)
  note_count?: number;
  notes?: MessageNote[];
}

// ─── Message Note ────────────────────────────────────────────────────────────

export interface MessageNote {
  id: number;
  message_id: string;
  section: NoteSection;
  content: string;
  author?: string;
  created_at: string;
}

// ─── Terminal Status ─────────────────────────────────────────────────────────

export interface TerminalStatus {
  terminal: string;
  status: 'idle' | 'working' | 'blocked';
  current_task_id?: string;
  last_activity_at: string;
}

// ─── API Input Types ─────────────────────────────────────────────────────────

export interface CreateTaskInput {
  from: string;
  to: string;
  title: string;
  description: string;
  acceptance_criteria?: string[];
  priority: Priority;
  model?: Model;
  ref_id?: string;
  epic_id?: string;
  project_id?: string;
  context?: string;
  from_island?: string;
  to_island?: string;
}

// ─── Federation (cross-island) ───────────────────────────────────────────────

export interface FederationSendInput {
  from_island: string;
  from_terminal: string;
  to_island: string;
  to_terminal: string;      // typically 'root' (the gateway); may be any local terminal
  type: MessageType;
  priority: Priority;
  subject: string;          // maps to message title
  body: string;             // maps to message description
  ref_id?: string;
}

// Token-optimized inbox row: metadata only, NO body/description.
// Fetch the full message via getMessage(id) only when actually needed.
export interface FederationInboxItem {
  id: string;
  from_island?: string;
  from_terminal: string;
  to_island?: string;
  to_terminal: string;
  type: MessageType;
  priority: Priority;
  status: MessageStatus;
  subject: string;          // = title
  ref_id?: string;
  created_at: string;
}

export interface CompleteMessageInput {
  message_id: string;
  status: 'completed' | 'blocked';
  summary: string;
  details?: string;
  files_changed?: string[];
  blocked_reason?: string;
  next_steps?: string;
}

export interface AppendNoteInput {
  message_id: string;
  section: NoteSection;
  content: string;
  author?: string;
}

// ─── Query Filters ───────────────────────────────────────────────────────────

export interface MessageFilter {
  terminal?: string;
  type?: MessageType | MessageType[];
  status?: MessageStatus | MessageStatus[];
  priority?: Priority | Priority[];
  epic_id?: string;
  project_id?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

// ─── API Response Types ──────────────────────────────────────────────────────

export interface CreateResult {
  success: boolean;
  id?: string;
  rendered_path?: string;
  error?: string;
}

export interface UpdateResult {
  success: boolean;
  rendered_path?: string;
  error?: string;
}

export interface QueryResult<T> {
  success: boolean;
  data?: T;
  count?: number;
  error?: string;
}
