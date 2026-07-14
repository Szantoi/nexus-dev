# MCP Authentication & Authorization

> **Version:** 1.1
> **Updated:** 2026-06-24
> **Status:** PRODUCTION

## Overview

A Knowledge Service MCP API token-alapú hitelesítést és jogosultság-kezelést használ. Minden terminálnak saját tokenje van az audit trail biztosítására.

## Token Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code (settings.json)                                    │
│  MCP_AUTH_TOKEN → stdio-bridge.js → HTTP Bearer token          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Knowledge Service (mcp.ts)                                     │
│                                                                 │
│  authenticate() middleware:                                     │
│    1. Extract Bearer token from Authorization header            │
│    2. Check master_token (root access)                          │
│    3. Check agents map (terminal-specific token)                │
│    4. Set req.mcpTerminal for audit & permission checks         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Tool Permission Check                                          │
│                                                                 │
│  canUseTool(terminal, toolName):                                │
│    1. root → always allowed                                     │
│    2. Check tool-permissions.yaml                               │
│    3. Enforce terminal isolation (code-level)                   │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration Files

### 1. agents.yaml — Token → Terminal mapping

**Location:** `config/agents.yaml`

```yaml
version: "1.1"
updated: "2026-06-24"

# Master token (root access)
master_token: "IoUpLUgr4v6Mj5lt4u2XD1JOy5iGmVdxne473srMl2o="

# Terminal tokens (token → terminal_name)
agents:
  "6ozohLp1ESnTWhWhlkUiyxTwh3cm3Ia+yGT/5YXgqhs=": "conductor"
  "DAP3+yV6SIQo9PH9zcoDYzLp3/XGpP1hFpiOjVO8ru4=": "architect"
  "luBZgBbnTwLKsQ1HKmVMYo+j3Cwul64QVxOVb5/7wYE=": "librarian"
  "aT/iZsIUyNY94CjuHChyGVgv5MFES5/l3V99gorrxcQ=": "explorer"
  "jKB4yyFknSgwRiC8ewLbdFuPxEo8Vgi157lW5QBsmsY=": "backend"
  "hsS4SbZGWWljJ8VNTkG18ys2X40BPbl2bH33h6+WIqk=": "frontend"
  "gZnKTnAZ2pgRrkee1EQ7qvcMKBCJ4tDsFgCId5oFGzw=": "designer"
```

### 2. tool-permissions.yaml — Tool → Terminal mapping

**Location:** `config/tool-permissions.yaml`

```yaml
version: "1.1"
updated: "2026-06-24"

default: "all"

permissions:
  # Only root/conductor can create tasks
  create_task:
    - root
    - conductor
  tmb_create_task:
    - root
    - conductor

  # Only root/conductor can manage focus queue
  set_focus_queue:
    - root
    - conductor

  # Everyone can read (with terminal isolation enforced in code)
  list_inbox: "all"
  tmb_get_inbox: "all"
```

## Terminal Isolation

A tool jogosultság ellenőrzésen túl a kód terminál-izolációt is végrehajt:

```typescript
// mcp.ts - read_inbox_message handler
if (callerTerminal !== 'root' && callerTerminal !== terminal) {
  return { error: `Terminal ${callerTerminal} cannot read inbox for ${terminal}` };
}
```

**Szabályok:**
- `root` → mindenhez hozzáfér
- `conductor` → mindenkit koordinálhat (task creation)
- Többi terminál → csak saját inbox/outbox-ot olvashat

## Token Hierarchy

| Token Type | Access Level | Example |
|------------|--------------|---------|
| **master_token** | Root access (all tools, all terminals) | Root session |
| **conductor** | Coordination (task creation, dispatch) | Conductor session |
| **support** (architect, librarian, explorer) | Read + own terminal write | Support sessions |
| **developer** (backend, frontend, designer) | Read + own terminal write | Dev sessions |
| **external** (marketing-*, partner-*) | Read-only | External integrations |

## Audit Trail

Minden MCP tool hívás naplózva:

```
[MCP] 📥 create_task (caller: conductor, target: backend)
[MCP] ✅ create_task (42ms)

[MCP] 📥 create_task (caller: backend, target: frontend)
[MCP] 🚫 create_task DENIED for terminal: backend
```

## Adding New Tokens

### 1. Generate token
```bash
openssl rand -base64 32
```

### 2. Add to agents.yaml
```yaml
agents:
  "NEW_TOKEN_HERE": "terminal-name"
```

### 3. (Optional) Set permissions in tool-permissions.yaml
```yaml
permissions:
  some_sensitive_tool:
    - root
    - conductor
    - terminal-name  # Add new terminal
```

### 4. Wait 30s or restart service
Config auto-reloads every 30 seconds.

## Security Notes

1. **Never commit real tokens to git** — Use environment variables for production
2. **Rotate tokens regularly** — Update agents.yaml, wait for auto-reload
3. **Monitor audit logs** — Check for unauthorized access attempts
4. **Use HTTPS in production** — Tokens are sent in HTTP headers

## Testing

```bash
# Test valid token
curl -s -X POST http://localhost:3456/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'

# Test invalid token (should return 403)
curl -s -X POST http://localhost:3456/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid-token" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'
```

## Related Files

- `src/mcp.ts` — Authentication middleware, token loading
- `config/agents.yaml` — Token → terminal mapping
- `config/tool-permissions.yaml` — Tool → terminal permissions
- `bin/stdio-bridge.js` — Claude Code → HTTP bridge
