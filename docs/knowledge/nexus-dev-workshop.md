# Nexus-dev műhely — tudásbázis-alapdokumentum

Ez a mappa (`docs/knowledge/`) a knowledge-service indexelési forrása.
A DEV környezetben ide kerülnek a Nexus-fejlesztéshez tartozó tudás-dokumentumok;
a service induláskor automatikusan indexeli a `**/*.md` fájlokat.

## A műhely felépítése

- `knowledge-service/` — a fejlesztett szolgáltatás (MCP + RAG + mailbox)
- `terminals/root|conductor|monitor` — a műhely termináljai (mailbox-flow)
- `docs/projects/EPICS.yaml` — a modernizációs program állapota
- `scripts/dev-start.mjs` — cross-platform DEV indító (port 3466)

## Kulcskonvenciók

- DEV port: 3466, PROD port: 3456 — a kettő sosem keveredik.
- Konfiguráció: `src/config/env.ts` (zod-validált) + `src/config/paths.ts`.
- Logolás: `src/core/logger.ts` (LOG_LEVEL / LOG_FORMAT env).
- Minőségi elvárások: `QUALITY.md` a repo gyökerében.
