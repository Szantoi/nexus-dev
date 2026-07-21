---
id: TASK-QC-013
title: ENABLE_INBOX_WATCHER env-kulcs tényleges bekötése
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-VERIFICATION
status: ready
priority: medium
depends_on: []
owner_role: backend
created: 2026-07-18
source: TASK-QC-010 független review, 4. szakasz "3" pont
---

# ENABLE_INBOX_WATCHER env-kulcs tényleges bekötése

## Cél

A dokumentált `ENABLE_INBOX_WATCHER` env-kulcs valóban vezérelje az
inbox-watcher indítását; a DEV/PROD elszigeteltség (a conductor CLAUDE.md
előírása: "DEV: … Inbox-watcher KI") ténylegesen érvényesüljön, ne csak a
session-indítási kapun (`shouldWakeUp`) keresztül csillapodjon.

## Jelenlegi bizonyíték

- `knowledge-service/.env.dev.example` és
  `knowledge-service/src/bootstrap/README.md` dokumentálja az
  `ENABLE_INBOX_WATCHER` kulcsot.
- `knowledge-service/src/config/env.ts` NEM olvassa ezt a kulcsot (`grep -n
  "ENABLE_INBOX_WATCHER" src/config/env.ts` → 0 találat).
- `knowledge-service/src/bootstrap/startup.ts:191-193` feltétel nélkül hívja
  `startInboxWatcher()`-t — a watcher DEV-ben is fut, csak a session-indítás
  van más csatornán tompítva.

## Scope

1. Vedd fel az `ENABLE_INBOX_WATCHER` (vagy domain-konzisztens névvel, ha a
   review során jobb elnevezés adódik) kulcsot a zod env-sémába
   (`src/config/env.ts`), boolean, dokumentált defaulttal (DEV: hatástalanítva
   vagy explicit `false`, PROD: `true`).
2. `bootstrap/startup.ts`-ben a `startInboxWatcher()` hívást kösd a config
   értékéhez.
3. Ellenőrizd a többi hasonlóan dokumentált, de esetleg szintén nem bekötött
   `ENABLE_*` kulcsot (`rg "ENABLE_" knowledge-service/.env.example
   knowledge-service/src/config/env.ts`) — ha találsz továbbit, dokumentáld
   vagy kösd be egy tételben ezzel.
4. Regressziós teszt: a watcher NEM indul, ha a flag kikapcsolt; elindul, ha
   bekapcsolt.

## Nem cél

- Az inbox-watcher belső logikájának átalakítása.
- Új feature bevezetése a watcherbe.

## Elfogadási feltételek

- [ ] `ENABLE_INBOX_WATCHER=false` mellett a watcher nem indul (teszttel
      igazolva).
- [ ] A kulcs szerepel a zod-sémában, típusos, dokumentált defaulttal.
- [ ] A conductor CLAUDE.md DEV-elszigeteltségi állítása ("Inbox-watcher KI")
      ténylegesen igaz DEV configgal.
- [ ] `npm run typecheck && npm test` zöld.

## Kötelező ellenőrzés

```bash
cd knowledge-service
npm run typecheck
npx vitest run src/__tests__/unit/bootstrap*.test.ts
npm test
```

## Átadandó bizonyíték

- Diff az `env.ts`/`startup.ts`-nél.
- Az új teszt kimenete (flag ki/be).

## Kockázat és rollback

Alacsony. Figyelem: a DEV `.env.dev` alapértéke határozza meg, hogy ez a
változás nem indítja-e véletlenül be/ki a watchert egy már futó DEV-terminálon
— dokumentáld az átállás előtti és utáni tényleges DEV-viselkedést.
