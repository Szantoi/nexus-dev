# Project-Scoped Knowledge and Mailbox System

> **Verzió:** 1.0
> **Dátum:** 2026-07-22
> **Státusz:** TERV
> **Epic:** EPIC-PROJECT-SCOPE

---

## Executive Summary

A jelenlegi Knowledge Service **sziget-alapú** (spaceos, joinerytech, nexus, doorstar) tudástárat és mailbox-ot támogat. A cél: **projekt-alapú** erőforrások hozzáadása, ahol több sziget együtt dolgozhat egy projekten.

**Példa use case:**
- `joinerytech-platform` projekt
- Résztvevő szigetek: JoineryTech, Nexus, SpaceOS
- Közös tudástár, mailbox, epic tracking
- Lokál PC-ről is elérhető (Tailscale)

---

## Jelenlegi vs. Cél Architektúra

### Jelenlegi

```
Knowledge Service
└── islands/
    ├── spaceos/      (sziget tudás + mailbox)
    ├── joinerytech/  (sziget tudás + mailbox)
    ├── nexus/        (sziget tudás + mailbox)
    └── doorstar/     (sziget tudás + mailbox)
```

### Cél

```
Knowledge Service
├── islands/              ← Sziget-specifikus (HOGYAN dolgozunk)
│   ├── spaceos/
│   ├── joinerytech/
│   ├── nexus/
│   └── doorstar/
│
└── projects/             ← Projekt-specifikus (MIT csinálunk)
    ├── joinerytech-platform/
    │   ├── PROJECT.yaml    # Projekt metadata
    │   ├── knowledge/      # ADR-ek, API docs, patterns
    │   │   ├── adr/
    │   │   ├── api/
    │   │   └── patterns/
    │   ├── mailbox/        # Projekt-szintű feladatok
    │   │   ├── inbox/
    │   │   ├── outbox/
    │   │   └── archive/
    │   └── epics/          # Epic tracking
    │       └── EPICS.yaml
    │
    ├── spaceos-orchestration/
    └── doorstar-instance/
```

---

## Fázisok

### Phase 1: Data Model Extensions

**1.1 Új path config** (`config/paths.ts`)

```typescript
export function getProjectsDir(): string;
export function getProjectPath(projectId: string): string;
export function getProjectKnowledgePath(projectId: string): string;
export function getProjectMailboxPath(projectId: string): string;
export function getProjectEpicsPath(projectId: string): string;
```

**1.2 DB schema bővítés** (`epicRouter.ts`)

```sql
-- Projects tábla bővítés
ALTER TABLE projects ADD COLUMN owner_island TEXT DEFAULT 'spaceos';
ALTER TABLE projects ADD COLUMN participating_islands TEXT DEFAULT '["spaceos"]';
CREATE INDEX IF NOT EXISTS idx_projects_islands ON projects(participating_islands);
```

**1.3 Message registry bővítés** (`messageRegistry.ts`)

```sql
ALTER TABLE messages ADD COLUMN project_id TEXT;
ALTER TABLE messages ADD COLUMN project_scope BOOLEAN DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
```

---

### Phase 2: Project Management Core

**2.1 Új modul: `src/projectStore.ts`**

```typescript
interface Project {
  id: string;                      // "joinerytech-platform"
  name: string;                    // "JoineryTech Platform"
  description?: string;
  owner_island: string;            // "joinerytech"
  participating_islands: string[]; // ["spaceos", "joinerytech", "nexus"]
  status: 'active' | 'paused' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
}

// CRUD operations
export function createProject(params): Project;
export function getProjectById(id: string): Project | null;
export function listProjects(islandId?: string): Project[];
export function updateProject(id: string, updates): Project;
export function addIslandToProject(projectId, islandId): void;
export function removeIslandFromProject(projectId, islandId): void;
export function canAccessProject(projectId, islandId): boolean;
```

**2.2 Új modul: `src/projectMailbox.ts`**

```typescript
// Projekt-szintű mailbox (párhuzamos a mailbox.ts-sel)
export function listProjectInbox(projectId, status?): Promise<InboxMessage[]>;
export function createProjectTask(params): Promise<Result>;
export function submitProjectDone(params): Promise<Result>;
export function listProjectOutbox(projectId, status?): Promise<OutboxMessage[]>;
```

**2.3 Új modul: `src/projectKnowledge.ts`**

```typescript
export function indexProjectKnowledge(projectId): Promise<IndexResult>;
export function searchProjectKnowledge(projectId, query): Promise<SearchResult[]>;
export function addProjectDocument(projectId, path, content): Promise<void>;
export function listProjectDocuments(projectId, category?): Promise<Document[]>;
```

---

### Phase 3: MCP Tool Extensions

**Új MCP toolok:** `src/interfaces/mcp/tools/project-scoped.tools.ts`

#### Project Management
| Tool | Leírás |
|------|--------|
| `project_create` | Új projekt létrehozása |
| `project_get` | Projekt részletek |
| `project_list` | Projektek listázása (sziget szerint szűrve) |
| `project_update` | Projekt beállítások módosítása |
| `project_add_island` | Sziget hozzáadása projekthez |
| `project_remove_island` | Sziget eltávolítása |

#### Project Mailbox
| Tool | Leírás |
|------|--------|
| `project_inbox_list` | Projekt inbox listázása |
| `project_task_create` | Task létrehozása projekt inbox-ban |
| `project_done_submit` | DONE küldése projekt outbox-ba |
| `project_outbox_list` | Projekt outbox listázása |

#### Project Knowledge
| Tool | Leírás |
|------|--------|
| `project_knowledge_search` | Keresés projekt tudástárban |
| `project_knowledge_index` | Újraindexelés |
| `project_document_add` | Dokumentum hozzáadása |
| `project_document_list` | Dokumentumok listázása |

#### Project Epics
| Tool | Leírás |
|------|--------|
| `project_epic_list` | Epic-ek listázása |
| `project_epic_create` | Epic létrehozása |
| `project_checkpoint_complete` | Checkpoint befejezése |
| `project_status` | Projekt progress áttekintés |

---

### Phase 4: Access Control

**4.1 Projekt-szintű auth** (`auth/tokenAuth.ts`)

```typescript
export function authorizeProjectAccess(req, res, next): void {
  // Ellenőrzi: a hívó szigete benne van-e a projekt participating_islands-ben
}
```

**4.2 ToolContext bővítés** (`base-tool.ts`)

```typescript
export interface ToolContext {
  terminal?: string;
  island?: string;
  project?: string;    // ÚJ: projekt-scoped tool esetén
  permissions?: string[];
}
```

**4.3 Permission config** (`config/tool-permissions.yaml`)

```yaml
project_permissions:
  project_create: ['root', 'conductor']
  project_add_island: ['root', 'conductor']
  project_task_create: ['root', 'conductor', 'backend', 'frontend']
  project_knowledge_search: ['*']  # mindenki
```

---

### Phase 5: File System Infrastructure

**5.1 Projekt directory struktúra**

```typescript
async function ensureProjectStructure(projectId: string): Promise<void> {
  const projectPath = getProjectPath(projectId);

  await fs.mkdir(path.join(projectPath, 'knowledge', 'adr'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'knowledge', 'api'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'knowledge', 'patterns'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'mailbox', 'inbox'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'mailbox', 'outbox'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'mailbox', 'archive'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'epics'), { recursive: true });

  await createProjectYaml(projectId);
}
```

**5.2 Inbox watcher bővítés** (`inboxWatcher.ts`)

```typescript
// Watch projects/**/mailbox/{inbox,outbox}/*.md
const PROJECTS_PATH = path.join(SPACEOS_ROOT, 'projects');

watch([TERMINALS_PATH, PROJECTS_PATH], {
  ignored: (pathStr: string) => {
    if (pathStr.includes('/projects/') &&
        (pathStr.includes('/mailbox/inbox/') || pathStr.includes('/mailbox/outbox/'))) {
      return false;  // ne hagyd figyelmen kívül
    }
    // ... meglévő logika
  }
});
```

---

### Phase 6: REST API Routes

**Új route fájl:** `src/interfaces/http/routes/project.routes.ts`

```
GET    /api/projects                        # Projektek listázása
POST   /api/projects                        # Projekt létrehozása
GET    /api/projects/:id                    # Projekt részletek
PUT    /api/projects/:id                    # Projekt frissítése
DELETE /api/projects/:id                    # Projekt archiválása

GET    /api/projects/:id/inbox              # Projekt inbox
POST   /api/projects/:id/inbox              # Task létrehozása
GET    /api/projects/:id/outbox             # Projekt outbox
POST   /api/projects/:id/outbox             # DONE küldése

GET    /api/projects/:id/knowledge          # Tudástár keresés
POST   /api/projects/:id/knowledge/index    # Újraindexelés
GET    /api/projects/:id/documents          # Dokumentumok

GET    /api/projects/:id/epics              # Epic-ek
GET    /api/projects/:id/status             # Progress overview
POST   /api/projects/:id/islands            # Sziget hozzáadása
DELETE /api/projects/:id/islands/:island    # Sziget eltávolítása
```

---

### Phase 7: Vector Store Integration

**Projekt-specifikus collection** (`vectorStore.ts`)

```typescript
function getProjectCollectionName(projectId: string): string {
  return `project-${projectId}-knowledge`;
}

export function indexProjectDocuments(projectId): Promise<void>;
export function searchProjectVectors(projectId, query, topK): Promise<Result[]>;
```

---

### Phase 8: Migration

**Migration script:** `scripts/migrate-projects.ts`

1. Új oszlopok hozzáadása meglévő táblákhoz
2. `projects/` directory struktúra létrehozása
3. Meglévő epic-ek opcionális migrálása projekt-scope-ra

**Backward compatibility:**
- Sziget-scoped toolok változatlanul működnek
- Projekt-scoped toolok additívak
- Terminál mailboxok maradnak `terminals/{terminal}/`
- Projekt mailboxok külön `projects/{project}/mailbox/`

---

## Implementációs Sorrend

| Hét | Fázis | Fő feladatok |
|-----|-------|--------------|
| 1 | Phase 1 + 2 | Data model + Project core |
| 2 | Phase 3 + 4 | MCP tools + Auth |
| 3 | Phase 5 + 6 | File system + REST API |
| 4 | Phase 7 + 8 | Vector store + Migration + Testing |

---

## Kritikus Fájlok

| Fájl | Változtatás |
|------|-------------|
| `src/config/paths.ts` | Projekt path functions |
| `src/pipeline/epicRouter.ts` | Projects tábla bővítés |
| `src/mailbox.ts` | Minta a projectMailbox.ts-hez |
| `src/interfaces/mcp/tools/base-tool.ts` | ToolContext bővítés |
| `src/inboxWatcher.ts` | Projekt directory watching |

---

## Használati Példák

### Projekt létrehozása

```bash
# MCP tool
project_create
  id="joinerytech-platform"
  name="JoineryTech Platform"
  owner_island="joinerytech"
  participating_islands=["joinerytech", "nexus", "spaceos"]
```

### Cross-island task küldés

```bash
# Nexus root küld feladatot JoineryTech backend-nek
project_task_create
  project="joinerytech-platform"
  from="nexus:root"
  to="joinerytech:backend"
  title="MCP tool bug fix"
  priority="high"
```

### Projekt tudástár keresés

```bash
# Bármelyik résztvevő szigetről
project_knowledge_search
  project="joinerytech-platform"
  query="procurement API"
```

### Projekt státusz lekérdezés

```bash
project_status
  project="joinerytech-platform"

# Válasz:
{
  "project": "joinerytech-platform",
  "progress": 45,
  "active_epic": "EPIC-PROCUREMENT-V1",
  "pending_tasks": 3,
  "participating_islands": ["joinerytech", "nexus", "spaceos"],
  "recent_activity": [...]
}
```

---

## Lokál PC Hozzáférés

A rendszer Tailscale-en keresztül elérhető lokál PC-ről:

```bash
# Lokál gépről
source ~/.joinerytech-mcp-env.sh

# Projekt tudástár keresés
curl -X POST http://100.82.133.87:3466/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -d '{
    "method": "tools/call",
    "params": {
      "name": "project_knowledge_search",
      "arguments": {
        "project": "joinerytech-platform",
        "query": "procurement API"
      }
    }
  }'
```

---

_SpaceOS / Nexus — Project-Scoped Knowledge Plan — 2026-07-22_
