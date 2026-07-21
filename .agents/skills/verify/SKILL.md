---
name: verify
description: Launch and drive the knowledge-service (DEV, port 3466) to verify changes live.
---

# Verify: knowledge-service (DEV)

## Launch

From the **repo root** (NOT knowledge-service/ — the script lives at root `scripts/`):

```bash
cd /c/Users/szant/Documents/Development/nexus-dev
node scripts/dev-start.mjs        # DEV server on port 3466
```

- Boots in ~15s on this machine. Health: `curl http://localhost:3466/health` → `{"status":"ok",...}`.
- ChromaDB is usually not running here → in-memory vector fallback (fine for verification).
- Run it via the Bash tool in background; PowerShell piping of node output can crash.
- Auth env vars if needed: `AUTH_MODE=open|required`, `MCP_AUTH_TOKEN=<master>`, `MCP_TOKEN_<NAME>=<token>` (e.g. MCP_TOKEN_BACKEND).

## Drive

MCP endpoint is JSON-RPC over HTTP POST:

```bash
curl -s -X POST http://localhost:3466/mcp -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
# tools/call: {"jsonrpc":"2.0","method":"tools/call","params":{"name":"<tool>","arguments":{...}},"id":2}
```

REST surface: `/api/*` (projects, mailbox, epic-router, ...), public: `/health`, `/ready`.

## Runner (local wake-up daemon)

```bash
cd /c/Users/szant/Documents/Development/nexus-dev
RUNNER_CONFIG_PATH='<path to runner.yaml>' RUNNER_TOKEN=<token> node scripts/runner-start.mjs
```

- Polls `/api/mailbox/<terminal>/inbox?status=UNREAD` and spawns `Codex --model <m> -p` per task.
- For live verification WITHOUT burning Codex budget: point `claude_bin` in runner.yaml at a
  stub .cmd that echoes stdin (see scratchpad fake-Codex pattern) — full chain runs, no real session.
- Set `SPACEOS_ROOT` explicitly when starting the server, otherwise mailbox writes land under
  a `/opt/spaceos`-derived path (and note: even with it set, POST inbox has been observed writing
  to `Development\terminals\` instead of the repo — pre-existing quirk, in backlog).

## Gotchas

- DEV = 3466; PROD = 3456 — never verify against 3456.
- `identity.ts`/terminalConfig still falls back to `/opt/spaceos` paths for terminal workdirs on this Windows machine (get_identity returns `/opt/spaceos/terminals/<t>` with null claudeMd) — pre-existing, don't mistake it for your change's bug.
- Kill the background server when done (TaskStop) — it holds port 3466.
