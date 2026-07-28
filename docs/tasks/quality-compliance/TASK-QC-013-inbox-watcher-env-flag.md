---
id: TASK-QC-013
title: ENABLE_INBOX_WATCHER env-kulcs tényleges bekötése
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-VERIFICATION
status: in_progress
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

## Végrehajtási napló

### 2026-07-28 — @root: implementáció + független review PASS

- **Owner:** @root. **Base:** `88d8d40` (origin/main, CI zöld). **Keret:** 1
  session-szelet.
- **Implementáció:** `ENABLE_INBOX_WATCHER` a zod-sémában az
  `ENABLE_HOURLY_DIGEST` opt-out mintájával (unset→true = PROD változatlan;
  `'false'`→false). A `startup.ts` új exportált
  `startInboxWatcherIfEnabled()`-je kapuzza a `startInboxWatcher()` +
  `setupInboxWatcherBridge()` párost; `initializeRegistry()` és
  `scanExistingUnread()` flag-független marad. Mindkét ág startup-szintű
  ENABLED/DISABLED sort logol.
- **Fontos lelet:** a `.env.dev` és a `.env.dev.example` MÁR TARTALMAZTA az
  `ENABLE_INBOX_WATCHER=false` sort — a kulcs dokumentált volt, csak a kód
  nem olvasta. A bekötéssel a meglévő DEV-config életbe lép: **átállás előtt
  a DEV watcher feltétel nélkül indult; utána a dokumentált úton
  (`scripts/dev-start.mjs`) indított DEV-en NEM indul** (a conductor
  CLAUDE.md „Inbox-watcher KI" állítása így vált igazzá). Közvetlen
  `npm run dev` nem tölti a `.env.dev`-et → watcher BE (README-ben
  dokumentált korlát).
- **Scope-3 sweep:** minden env-fájlban dokumentált `ENABLE_*` kulcs
  szerepel a sémában (géppel ellenőrzött kereszt-diff, 0 hiányzó).
- **Teszt:** `startupInboxWatcher.test.ts` — a flag hívásidejű olvasása miatt
  a Proxy-s env-mock hatásos (a reviewer mutáció-gondolatkísérlettel
  igazolta); 2/2 zöld.
- **Független review (adverzáriális, 1. kör FAIL → 2. kör PASS):** P2 volt a
  `bootstrap/README.md` elavult „Ismert korlátok" bejegyzése (a szállított
  viselkedés ellenkezőjét állította) — javítva, az indító-út-függéssel
  együtt dokumentálva. A reviewer empirikusan igazolta: false flagnél
  SEMMILYEN úton nem indul a watcher (egyetlen hívóhely; a
  projectDispatcher chokidar-ja alvó kód), az opt-out szemantika bitre
  azonos a másik két opt-out kulccsal, a shutdown-út flag-független.
- **Kapuk:** typecheck 0; teljes `npm run gate` zöld (a suite 1712 PASS + 1
  skipped, size/lint/audit/secret/links/tasks/worktree mind zöld).
