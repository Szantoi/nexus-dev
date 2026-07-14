# Nexus Dev

Development workspace for SpaceOS Nexus infrastructure.

## Structure

```
/opt/nexus-dev/           <- DEVELOPMENT (this repo, port 3466)
  └── knowledge-service/  <- MCP tools, workflows, messaging

/opt/nexus/               <- PRODUCTION (port 3456, CSAK deploy-nál változik!)
```

## Dev vs Production Szeparáció

| Környezet | Port | Telegram | Nightwatch | Inbox Watcher |
|-----------|------|----------|------------|---------------|
| **DEV** | 3466 | ❌ OFF | ❌ OFF | ❌ OFF |
| **PROD** | 3456 | ✅ ON | ✅ ON | ✅ ON |

**A dev környezet izolált:**
- Külön port (3466)
- Külön data mappa
- Nincs Telegram küldés
- Nincs automatikus session indítás

## Development Workflow

```bash
# 1. Fejlesztés indítása
./scripts/dev-start.sh

# 2. Kód szerkesztése
vim knowledge-service/src/workflowManager.ts

# 3. Rebuild + restart
cd knowledge-service && npm run build && PORT=3466 node dist/server.js

# 4. Tesztelés
curl http://localhost:3466/health
curl -X POST http://localhost:3466/mcp -d '{"method":"tools/list"}'
```

## Production Deploy (CSAK MÉRFÖLDKÖVEKNÉL!)

```bash
# Teljes deploy script - backup + deploy + health check
./scripts/deploy-to-prod.sh
```

**A deploy script:**
1. Build
2. Tesztek futtatása
3. Git tag létrehozás
4. Production backup
5. Deploy
6. Health check
7. Rollback info ha hiba

## Quick Start

```bash
cd /opt/nexus-dev/knowledge-service
npm install
./scripts/dev-start.sh
```

## Components

- **knowledge-service** - MCP server with 50+ tools
  - Workflow management (YAML-based)
  - Epic/task tracking
  - Inbox/outbox messaging
  - Vector search (ChromaDB)
  - Telegram integration

## Related

- Production: `/opt/nexus/`
- Docs: `/opt/spaceos/docs/knowledge/patterns/`
