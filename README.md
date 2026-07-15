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

- **knowledge-service** - MCP server with 100+ tools
  - Workflow management (YAML-based)
  - Epic/task tracking
  - Inbox/outbox messaging
  - Vector search (ChromaDB)
  - Telegram integration
  - TMUX session management with reliable Enter key handling

## TMUX Enter Key Variants

A tmux session-öknél előfordulhat, hogy az Enter billentyű "beragad" és a prompt nem fut le. Ennek csökkentésére több Enter variánst küldünk egyszerre:

```typescript
// src/pipeline/common.ts
export const TMUX_ENTER_VARIANTS = '-H 0d -H 0a Enter C-m C-j';
```

**Variánsok magyarázata:**

| Kód | Jelentés | Megjegyzés |
|-----|----------|------------|
| `-H 0d` | Hex CR (carriage return) | Legmegbízhatóbb |
| `-H 0a` | Hex LF (line feed) | Unix newline |
| `Enter` | Tmux kulcsszó | Claude Code elnyelheti |
| `C-m` | Ctrl+M | Ugyanaz mint CR |
| `C-j` | Ctrl+J | Ugyanaz mint LF |

**Root üzemeltetőknek:**

1. A konstans egy helyen van definiálva: `src/pipeline/common.ts`
2. Ha módosítani kell, csak ott kell átírni
3. Minden tmux send-keys hívás használja: sessionManager, telegramService, multiBotManager, telegramBot, contextBuilder

**Tesztelés:**

```bash
# Tmux szintaxis ellenőrzés
tmux send-keys -t test-session -H 0d -H 0a Enter C-m C-j

# Live teszt
tmux send-keys -t spaceos-monitor-chat "Teszt üzenet" && \
  sleep 0.5 && \
  tmux send-keys -t spaceos-monitor-chat -H 0d -H 0a Enter C-m C-j
```

## Related

- Production: `/opt/nexus/`
- Docs: `/opt/spaceos/docs/knowledge/patterns/`
