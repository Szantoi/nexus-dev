# Nexus Dev

Development workspace for SpaceOS Nexus infrastructure.

## Structure

```
/opt/nexus-dev/           <- Development (this repo)
  └── knowledge-service/  <- MCP tools, workflows, messaging

/opt/nexus/               <- Production (deployed from here)
```

## Development Workflow

1. **Edit** in `/opt/nexus-dev/knowledge-service/src/`
2. **Build**: `cd knowledge-service && npm run build`
3. **Test**: `PORT=3466 npm start` (dev port)
4. **Deploy**: Copy to production when ready

## Quick Start

```bash
cd /opt/nexus-dev/knowledge-service
npm install
cp .env.example .env
npm run build
PORT=3466 npm start
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
