# SpaceOS Knowledge Service

RAG (Retrieval-Augmented Generation) + Mailbox service for SpaceOS agent infrastructure.

## Features

### Phase 1: Knowledge Service ✅
- ✅ Indexes `/opt/spaceos/docs/knowledge/**/*.md` recursively
- ✅ ChromaDB vector store (persistent, Docker-based)
- ✅ Three embedding backends (priority order):
  1. **Voyage AI** (`voyage-3-lite`, 1024 dims) — production recommended
  2. **Google Gemini** (`text-embedding-004`, 768 dims) — requires model name fix
  3. **Local** (`all-MiniLM-L6-v2`) — CPU-dependent, may fail on QEMU/old arch
- ✅ Express REST API (`GET/POST /api/knowledge/search`)
- ✅ Auto-indexing on startup (if store empty)

### Phase 2: Mailbox Tools ✅
- ✅ `list_inbox` — List inbox messages for a terminal
- ✅ `send_message` — Create new inbox message for a terminal
- ✅ `submit_done` — Create DONE outbox message
- ✅ `get_task_status` — Query task status from `docs/tasks/`

### Phase 3: SSE Live Notifications ✅
- ✅ `subscribe` — SSE endpoint for real-time inbox notifications
- ✅ `broadcast` — Send message to all connected clients
- ✅ Automatic event emission on `send_message` and `submit_done`
- ✅ 30-second heartbeat to keep connections alive

## Setup

### 1. ChromaDB

```bash
cd /opt/spaceos/spaceos-nexus
docker compose up -d
```

### 2. Embedding API Key

**Option A: Voyage AI (recommended)**

1. Get API key: https://dash.voyageai.com/
2. Add to `.env`:
   ```bash
   VOYAGE_API_KEY=your_key_here
   ```

**Option B: Google Gemini (requires fix)**

1. Fix model name in `src/embeddings.ts:66`:
   ```ts
   modelName: 'text-embedding-004',  // was: gemini-embedding-001
   ```
2. Ensure `GOOGLE_API_KEY` is set in `.env`

### 3. Install & Run

```bash
npm install
npm run dev
```

## Usage

### Index knowledge base

```bash
npm run index
```

### Start server

```bash
npm run dev
# Or production:
npm run build && npm start
```

### Test

**Knowledge Service**
```bash
../scripts/test-rag.sh
```

**Mailbox Tools**
```bash
../scripts/test-mailbox.sh
```

### API Endpoints

#### Health & Status

**Health**
```bash
curl http://localhost:3456/health
```

#### Knowledge Service

**Search (GET)**
```bash
curl "http://localhost:3456/api/knowledge/search?q=EF+Core+migration&topK=5"
```

**Search (POST)**
```bash
curl -X POST http://localhost:3456/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"q": "React testing patterns", "topK": 3}'
```

**Re-index**
```bash
curl -X POST http://localhost:3456/api/knowledge/index
```

#### Mailbox Tools

**List Inbox**
```bash
# All messages
curl http://localhost:3456/api/mailbox/nexus/inbox

# UNREAD only
curl http://localhost:3456/api/mailbox/nexus/inbox?status=UNREAD

# READ only
curl http://localhost:3456/api/mailbox/nexus/inbox?status=READ
```

**Send Message**
```bash
curl -X POST http://localhost:3456/api/mailbox/kernel/inbox \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "task",
    "content": "# Task Title\n\nTask description here...",
    "priority": "high",
    "model": "sonnet",
    "ref": "MSG-ROOT-001"
  }'
```

**Submit DONE**
```bash
curl -X POST http://localhost:3456/api/mailbox/nexus/outbox \
  -H 'Content-Type: application/json' \
  -d '{
    "task_id": "MSG-NEXUS-016",
    "summary": "Task completed successfully",
    "files_changed": [
      "file1.ts",
      "file2.ts"
    ]
  }'
```

**Get Task Status**
```bash
# All tasks
curl http://localhost:3456/api/tasks/status

# Specific task
curl http://localhost:3456/api/tasks/status?task_id=JOINERY-V2
```

#### SSE Live Notifications (Phase 3)

**Subscribe to Terminal**
```bash
# Subscribe to live updates for a terminal
# Keep-alive SSE connection (use curl -N for unbuffered output)
curl -N http://localhost:3456/api/mailbox/nexus/subscribe

# Example output:
# event: connected
# data: {"terminal":"nexus","timestamp":"2026-06-20T06:56:48.254Z"}
#
# event: new_message
# data: {"terminal":"nexus","type":"new_message","messageId":"MSG-NEXUS-019",...}
```

**Broadcast to All**
```bash
curl -X POST http://localhost:3456/api/mailbox/broadcast \
  -H 'Content-Type: application/json' \
  -d '{"message": "System maintenance in 5 minutes", "priority": "high"}'
```

**JavaScript/Browser Usage**
```javascript
const es = new EventSource('http://localhost:3456/api/mailbox/nexus/subscribe');

es.addEventListener('connected', (e) => {
  console.log('Connected:', JSON.parse(e.data));
});

es.addEventListener('new_message', (e) => {
  const msg = JSON.parse(e.data);
  console.log('New message:', msg.messageId);
});

es.addEventListener('done_submitted', (e) => {
  const msg = JSON.parse(e.data);
  console.log('Task completed:', msg.details.task_id);
});
```

#### MCP Protocol (Phase 4)

**Server Info**
```bash
curl http://localhost:3456/mcp
```

**Initialize Session**
```bash
curl -X POST http://localhost:3456/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

**List Available Tools**
```bash
curl -X POST http://localhost:3456/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

**Call Tool**
```bash
# search_knowledge
curl -X POST http://localhost:3456/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"EF Core migration","limit":5}},"id":3}'

# list_inbox
curl -X POST http://localhost:3456/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_inbox","arguments":{"terminal":"nexus","status":"UNREAD"}},"id":4}'
```

**Claude Code Configuration (`.mcp.json`)**
```json
{
  "mcpServers": {
    "spaceos-knowledge": {
      "type": "http",
      "url": "http://localhost:3456/mcp",
      "timeout": 60000
    }
  }
}
```

## Architecture

### DDD Structure (Phase 8 - 2026-06-24)

The codebase follows Domain-Driven Design and Clean Architecture principles:

```
knowledge-service/
├── src/
│   ├── server.ts                      # Entry point (55 lines) - uses createApp()
│   ├── server.legacy.ts               # Archive of original 3159-line server
│   │
│   ├── bootstrap/                     # Application bootstrap
│   │   ├── app.ts                     # Express app factory (235 lines)
│   │   ├── startup.ts                 # Init, services, shutdown (290 lines)
│   │   └── index.ts                   # Exports
│   │
│   ├── core/                          # Core Layer - Framework-independent types
│   │   ├── types/
│   │   │   ├── common.ts              # Shared enums (MessageStatus, Priority, etc.)
│   │   │   ├── terminal.ts            # Terminal types (TerminalName, FocusItem, etc.)
│   │   │   └── message.ts             # Message types (MessageFrontmatter, etc.)
│   │   └── errors/
│   │       └── domain-error.ts        # Domain error classes (NotFoundError, etc.)
│   │
│   ├── domain/                        # Domain Layer - Business logic
│   │   ├── terminal/
│   │   │   ├── terminal.entity.ts     # Terminal aggregate root
│   │   │   ├── terminal.repository.ts # ITerminalRepository interface
│   │   │   └── terminal.service.ts    # Terminal domain service
│   │   └── mailbox/
│   │       ├── message.entity.ts      # Message entity + builders
│   │       ├── mailbox.repository.ts  # IMailboxRepository interface
│   │       └── mailbox.service.ts     # Mailbox domain service
│   │
│   ├── interfaces/                    # Interfaces Layer - External adapters
│   │   ├── http/
│   │   │   └── routes/                # 17 route files (2530 lines total)
│   │   │       ├── health.routes.ts   # Health, ready, live (82 lines)
│   │   │       ├── control.routes.ts  # Dispatch control (652 lines)
│   │   │       ├── mailbox.routes.ts  # Inbox, outbox, SSE (342 lines)
│   │   │       ├── kanban.routes.ts   # Discovery & Delivery (257 lines)
│   │   │       ├── registry.routes.ts # Message registry (163 lines)
│   │   │       ├── session.routes.ts  # Session management (95 lines)
│   │   │       ├── ... (11 more)      # dashboard, task, terminal, etc.
│   │   │       └── index.ts           # Route exports
│   │   └── mcp/
│   │       └── tools/
│   │           ├── base-tool.ts       # MCP tool infrastructure
│   │           └── index.ts           # Tool registry
│   │
│   ├── infrastructure/                # Infrastructure Layer (TODO)
│   │   └── persistence/
│   │       └── file-system/           # File-based repositories
│   │
│   ├── pipeline/                      # Pipeline modules (dispatch, nightwatch, etc.)
│   ├── dispatch-control/              # Token budget & dispatch control
│   │
│   ├── mcp.ts                         # MCP protocol handler (to be refactored)
│   ├── mailbox.ts                     # Mailbox tools
│   ├── identity.ts                    # Terminal identity
│   ├── terminalConfig.ts              # Terminal configuration
│   └── terminalStatus.ts              # Terminal status tracking
│
├── package.json
├── tsconfig.json
└── .env
```

### Layer Responsibilities

| Layer | Purpose | Dependencies |
|-------|---------|--------------|
| **Core** | Type definitions, enums, error classes | None (pure TypeScript) |
| **Domain** | Business logic, entities, services | Core only |
| **Infrastructure** | External systems (DB, filesystem) | Core, Domain |
| **Interfaces** | HTTP routes, MCP tools | All layers |

### Key Design Principles

1. **Dependency Rule**: Inner layers never depend on outer layers
2. **Ports & Adapters**: Repository interfaces in domain, implementations in infrastructure
3. **Aggregate Roots**: Terminal and Message are aggregate roots with factory methods
4. **Value Objects**: Immutable types for MessageFrontmatter, FocusItem, etc.
5. **Domain Services**: Business logic that doesn't belong to a single entity

### Legacy Files (To Be Refactored)

- `mcp.ts` (2035 lines) → Tools to `interfaces/mcp/tools/`

### Recent Optimizations (2026-06-24)

- **Server.ts Refactor**: 3159 lines → 55 lines (98% reduction)
- **Bootstrap Module**: Reusable app factory and startup logic
- **17 Route Files**: Modular HTTP routes (2530 lines total)
- **Express 5 Compatible**: Fixed wildcard route pattern for path-to-regexp 8.x
- **Message Registry**: SQLite-based message tracking with hash validation
- **Model Cache**: TTL-based caching for terminal model lookups
- **Event-driven Pipeline**: InboxWatcher uses native fs events instead of polling
- **Batch Updates**: Bulk status updates for better performance

### Formal Review System (Phase 9)

A formal review rendszer automatizált ellenőrzéseket végez LLM nélkül, gyorsabban és olcsóbban mint a content review.

#### Review Types

| Type | Description | When to Use |
|------|-------------|-------------|
| `formal` | Automated checks only (no LLM) | Simple tasks: docs, config, clear-cut fixes |
| `content` | Dual Haiku LLM review | Complex code: architecture, logic, patterns |
| `manual` | Escalate to Root | High-risk: security, breaking changes |

#### Formal Review Checks

**Required Checks (always run):**
- **Frontmatter**: Valid YAML with `id:`, `type:`, `status:` fields
- **Git Commit**: All `files_changed:` listed files are committed

**Task-Type Specific Checks:**
| Task Type | Type Check | Build | Lint | Tests |
|-----------|------------|-------|------|-------|
| CODE | ✅ | ✅ | ✅* | ❌ |
| BUGFIX | ✅ | ✅ | ✅* | ✅ |
| FEATURE | ✅ | ✅ | ✅* | ❌ |
| DOCUMENTATION | ❌ | ❌ | ❌ | ❌ |
| COORDINATION | ❌ | ❌ | ❌ | ❌ |

*Lint check only runs if eslint is configured in the project.

**Strict Review Level:**
- Add `review_level: strict` in DONE frontmatter to force test execution

#### Usage in DONE Messages

```yaml
---
id: MSG-BACKEND-042-DONE
type: done
status: UNREAD
review_type: formal      # ← Use formal review
task_type: CODE          # ← Determines which checks run
review_level: standard   # ← Optional: 'strict' forces tests
files_changed:
  - src/pipeline/reviewer.ts
  - src/__tests__/unit/reviewer.test.ts
---
```

#### Performance Comparison

| Review Type | Duration | Cost | Accuracy |
|-------------|----------|------|----------|
| `formal` | ~2-5s | $0 | 100% (deterministic) |
| `content` | ~30-60s | $0.02-0.05 | ~95% (LLM judgment) |
| `manual` | varies | - | Human judgment |

**Recommendation:**
- Use `formal` for 70% of tasks (simple, well-defined)
- Use `content` for 30% (complex logic, patterns)
- Use `manual` for <1% (security, breaking changes)

## Status

### Phase 1: Knowledge Service ✅
- ✅ Code complete
- ⚠️  Google Gemini model name needs fix (`text-embedding-004`)
- ⚠️  Voyage AI key needed for production (free tier available)
- ✅ ChromaDB running and accessible
- ✅ 21 knowledge docs ready (`/opt/spaceos/docs/knowledge/`)

### Phase 2: Mailbox Tools ✅
- ✅ `list_inbox` implemented
- ✅ `send_message` implemented
- ✅ `submit_done` implemented
- ✅ `get_task_status` implemented
- ✅ Test script created (`scripts/test-mailbox.sh`)
- ✅ Documentation updated

### Phase 3: SSE Live Notifications ✅
- ✅ `subscribe` endpoint implemented (SSE)
- ✅ `broadcast` endpoint implemented
- ✅ Automatic event emission on mailbox operations
- ✅ Heartbeat every 30 seconds
- ✅ Client cleanup on disconnect
- ✅ Documentation updated

### Phase 4: MCP Protocol ✅
- ✅ MCP JSON-RPC endpoint (`/mcp`)
- ✅ 6 tools: `search_knowledge`, `list_inbox`, `send_message`, `submit_done`, `get_task_status`, `get_service_status`
- ✅ Bearer token authentication (optional, via `MCP_AUTH_TOKEN` env)
- ✅ Project `.mcp.json` configuration
- ✅ Claude Code integration ready

### Phase 6: DDD Refactoring ✅ (2026-06-24)
- ✅ Core layer created (types, errors)
- ✅ Domain layer created (terminal, mailbox entities and services)
- ✅ Interfaces layer created (http routes, mcp tools structure)
- ✅ Build system updated (tsconfig excludes)

### Phase 7: HTTP Routes Extraction ✅ (2026-06-24)
- ✅ 17 route files created (2530 lines total)
- ✅ Bootstrap app.ts created (235 lines)
- ✅ All routes logically grouped

### Phase 8: Server.ts Refactor ✅ (2026-06-24)
- ✅ server.ts reduced from 3159 to 55 lines (98% reduction)
- ✅ bootstrap/startup.ts created (290 lines)
- ✅ Graceful shutdown handler modularized
- ✅ Health routes enhanced with ready/shuttingDown state
- ✅ Express 5 wildcard route fix applied
- ✅ All endpoints tested and working

### Phase 10: Epic-Aware Task Routing ✅ (2026-06-24)

Az epic-aware task routing intelligens feladatkiosztást biztosít:

#### Logika

1. **Terminál csak IDLE állapotban kap új taskot** — nem küldjük új üzeneteket dolgozó terminálnak
2. **Epic kontextus megtartása** — ha a terminál egy epic-en dolgozik, előnyben részesítjük az azonos epic taskjait
3. **Queue management** — ha nincs azonos epic task, a következő legmagasabb prioritású taskot választjuk
4. **Automatikus leállás** — ha nincs task a queue-ban, a terminál idle marad

#### SQLite Schema

```sql
-- Projects table
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT CHECK(status IN ('active', 'paused', 'completed', 'archived'))
);

-- Epics table (linked to projects)
CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'active', 'done', 'blocked')),
  priority INTEGER NOT NULL DEFAULT 2,
  depends_on TEXT  -- JSON array of epic IDs
);

-- Terminal context: tracks current epic/project
CREATE TABLE terminal_context (
  terminal TEXT PRIMARY KEY,
  current_epic_id TEXT,
  current_project_id TEXT,
  current_task_id TEXT,
  status TEXT CHECK(status IN ('idle', 'working', 'blocked'))
);

-- Task queue with epic awareness
CREATE TABLE task_queue (
  id INTEGER PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  terminal TEXT NOT NULL,
  epic_id TEXT,
  priority_order INTEGER NOT NULL  -- 4=critical, 3=high, 2=medium, 1=low
);
```

#### API Endpoints

```bash
# Terminal status
GET /api/epic-router/terminals
GET /api/epic-router/terminals/:terminal

# Queue management
GET /api/epic-router/queue
GET /api/epic-router/queue/terminal/:terminal
GET /api/epic-router/queue/epic/:epicId
POST /api/epic-router/queue  # Add task to queue

# Routing decisions
GET /api/epic-router/routing/:terminal
POST /api/epic-router/task/:terminal/complete
POST /api/epic-router/dispatch/:terminal

# Projects & Epics
GET /api/epic-router/projects
POST /api/epic-router/projects
GET /api/epic-router/epics
POST /api/epic-router/epics

# Sync from EPICS.yaml
POST /api/epic-router/sync
```

#### Mailbox Message Format

```yaml
---
id: MSG-BACKEND-042
type: task
epic_id: EPIC-CUTTING-Q3     # Epic context
project_id: spaceos/cutting  # Project context
task_id: TASK-001            # Task reference
---
```

#### Usage Example

```typescript
import { getNextTaskForTerminal, handleTaskCompletion, queueTask } from './pipeline/epicRouter';

// Queue a task
queueTask('MSG-BACKEND-042', 'backend', 'EPIC-CUTTING-Q3', 'spaceos/cutting', 'high');

// Get next task for terminal
const decision = getNextTaskForTerminal('backend');
// { shouldDispatch: true, task: {...}, reason: 'Found task in same epic', nextAction: 'dispatch' }

// Handle task completion
const nextDecision = handleTaskCompletion('backend', 'MSG-BACKEND-042', 'EPIC-CUTTING-Q3');
// Automatically decides next task based on epic context
```

## Next Steps (Phase 11)

1. Complete mcp.ts → interfaces/mcp/tools migration (2035 lines)
2. Add infrastructure layer implementations
3. Delete server.legacy.ts after verification period
4. Marvin integration for planning pipeline
5. Guardrail service integration
6. HTTPS/WSS for production
