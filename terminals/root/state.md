# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-16

## Aktuális fókusz

Knowledge-service modernizáció — **MIND AZ 5 FÁZIS KÉSZ** + TMUX Enter variants implementáció + dokumentáció. A rendszer üzemképes.

## Állapot

- ✅ 1. fázis (takarítás): halott kód törölve, dependency-k rendezve — commit `0d9cba7`
- ✅ 2. fázis (tooling): Biome + CI + zod env-config + logger (944 console.* cserélve) + smoke/hermetikus teszt-szétválasztás — commit `c14dc14`
- ✅ 3. fázis (mcp.ts dekompozíció) TELJES: **103 tool migrálva** 14 modulba (ToolRegistry pattern) — commit `72b953c`
- ✅ 4. fázis (DDD-döntés): **DDD scaffolding TÖRÖLVE** (~2300 LOC) — commit `046b8bb`
- ✅ 5. fázis (teszt-megerősítés): 98 → 0 tesztbukás, 889 teszt zöld — commit `7afbcd4`
- ✅ **TMUX Enter variants**: 5 különböző Enter típus a beragadt promptok ellen — commit `d22edbd`
- ✅ **Dokumentáció frissítve**: README.md + knowledge-service/README.md — commit `57111b3`
- ✅ Minden commit pusholva GitHubra (origin/main)

## Legutóbbi változás: TMUX Enter Key Variants

A tmux send-keys után néha beragad a prompt. Megoldás: 5 különböző Enter variáns egyidejű küldése.

```typescript
// src/pipeline/common.ts:22
export const TMUX_ENTER_VARIANTS = '-H 0d -H 0a Enter C-m C-j';
```

| Variáns | Jelentés |
|---------|----------|
| `-H 0d` | Hex CR (carriage return) — legmegbízhatóbb |
| `-H 0a` | Hex LF (line feed) |
| `Enter` | Tmux kulcsszó (Claude Code elnyelheti) |
| `C-m` | Ctrl+M = CR |
| `C-j` | Ctrl+J = LF |

**Használó fájlok:** common.ts, sessionManager.ts, telegramService.ts, multiBotManager.ts, telegramBot.ts, contextBuilder.ts

## Környezet

- **Linux (PROD):** port 3466 — MŰKÖDIK, 889 teszt zöld, Telegram botok aktívak
- **Windows (DEV):** port 3466 — működik (`node scripts/dev-start.mjs`)
- ChromaDB: 4817 dokumentum indexelve

## Adatbázis-sémák (már léteznek)

- `workflow.db`: workflows, workflow_states, workflow_history, workflow_tasks, epics, epic_tasks, epic_history
- `epic_router.db`: projects, epics, terminal_context, task_queue
- EPICS.yaml → DB sync: `syncFromEpicsYaml()` függvény az epicRouter.ts-ben

## Nyitott kérdések

- Legacy mcp.ts switch (109 case) törlése — opcionális cleanup, nincs sürgősség
