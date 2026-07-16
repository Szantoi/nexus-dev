# state.md — ROOT terminál aktuális állapot

> Pillanatnyi munkaállapot. Minden session elején olvasd el, minden nagyobb lépés után frissítsd.
> Hosszú táv → MEMORY.md, teendők → todo.md, program-állapot → docs/projects/EPICS.yaml.

**Utolsó frissítés:** 2026-07-16

## Aktuális fókusz

VPS-deploy + lokális ébresztés (pull-modell) **ÉLESBEN, végponttól végpontig igazolva**. A teljes lánc: token-auth (`36a4dad`) → lokális runner MVP (`src/runner/`, zárt parancskészletű `claude -p`, Windows-first) → SSE-ébresztés (~90 ms) → Tailscale-hálózat → VPS-deploy. Élő E2E: feladat a VPS-agyba → SSE-ébresztés a tailneten át → lokális runner elindítja a sessiont.

**VPS (109.122.222.198, Debian 13):** részletek a memóriában [[vps-uzemeltetes]]. nexus-dev deploy: `/opt/nexus-dev`, port 3466, **csak a tailnet-interfészen** (100.82.133.87) figyel, `AUTH_MODE=required`, `systemd nexus-dev-ks.service`, külön `nexus-dev-knowledge` Chroma-kollekció. Tailnet: VPS=nexus-vps (100.82.133.87), Windows=nexus-dev-win (100.78.193.104). Biztonsági javítás: a publikusan nyitott ChromaDB (8001) bezárva.

**Több-szigetes kiszolgálás KÉSZ** (`9cb2083`, élőben igazolva): egy service több szigetet szolgál ki, a sziget a hívó tokenjéből dől el (agents.yaml `agent_islands`), sosem a kérésből. A `nexus-dev-knowledge` kollekció 17 chunk (a VPS-hozzáférés oktatóanyag) — korábban 1 placeholder volt.

**PROD RELEASE KÉSZ** (`dda0bcc`, nexus-core `release/vps`): a mai javítások élesben a 3456-on. Gábor döntése alapján NEM a "beolvasztás" (egy service mindenkinek) irányba mentünk — az RAM-nyeresége (~600 MB / 15 GB) nem indokolt nagy refaktort; a valódi fájdalom a négy elsodródott kódverzió volt. Rendrakás is megtörtént: a prod `src/`-je ÜRES volt (csak júl. 15-i `dist/`-ből futott), most a saját forrásából épül; nohup → **systemd `nexus-ks.service`**. Igazolva: mailbox-hasadás gyógyult, auth `open` módban = változatlan viselkedés, 0 restart/0 hiba. Backup: `/opt/nexus/backups/pre-release-20260716-2253`. A `deploy-to-prod.sh` VESZÉLYES, ne használd (lásd [[vps-uzemeltetes]] release-recept).

**Következő:** (1) döntés az árva mailbox-fáról (17 elnyelt agent-üzenet, lásd todo Aktív); (2) terjesztés befejezése: joinerytech (3458) + doorstar (3460) még a régi, buggos kódot futtatja; (3) runner-regisztráció + heartbeat; (4) runner mint auto-induló Windows-szolgáltatás. Gábor iránya: központi szerver sziget-saját tudással (kiszolgáló réteg KÉSZ), agent-management lokálisan (= runner, KÉSZ).

## Állapot

- ✅ 1. fázis (takarítás): halott kód törölve, dependency-k rendezve — commit `0d9cba7`
- ✅ 2. fázis (tooling): Biome + CI + zod env-config + logger (944 console.* cserélve) + smoke/hermetikus teszt-szétválasztás — commit `c14dc14`
  - Bónusz bugfix: duplikált `get_workflow` MCP tool (az új workflow-manager tool elérhetetlen volt) → `get_workflow_details`
- ✅ 3. fázis (mcp.ts dekompozíció) TELJES: **103 tool migrálva** 14 modulba (ToolRegistry pattern). Modulok:
  - identity.tools.ts (6), skills.tools.ts (8), terminal-status.tools.ts (17), mailbox.tools.ts (11)
  - focus-queue.tools.ts (5), session.tools.ts (9), project.tools.ts (6), telegram.tools.ts (4)
  - codegen.tools.ts (9), goal.tools.ts (19), worker.tools.ts (6+subscription), knowledge/workflow/task-message-box (3)
  - Legacy mcp.ts switch megmarad fallback-ként (109 case) — törlése future cleanup, nincs sürgősség
- ✅ Runtime-verifikáció: szerver bootol Windowson a 3466-on, MCP tools/list 121 tool duplikáció nélkül, registry-toolok élesben hívhatók — commit `e349f97`
- ✅ 5. fázis (teszt-megerősítés) KÉSZ: 98 → 0 tesztbukás. Hermetikus suite: 49 fájl / 888 teszt zöld. A háttér-agent részmunkáját (EPICS_PATH/SPACEOS_ROOT env-varratok, temp-fixture-ök) verifikáltam és befejeztem: graphRoutes fixture séma-kiegészítés, mcp-tools pattern-elvárások igazítása a stub-viselkedéshez, epic-router terminál-kontextus reset a concurrent teszthez, hookTimeout 30s (terhelés alatti import-lassulás).
- ✅ 4. fázis (DDD-döntés) LEZÁRVA: a nappali chat-root review "A opció" döntése alapján a bekötetlen `domain/` + `infrastructure/` scaffolding (2300 LOC) TÖRÖLVE — commit `046b8bb`. (Megjegyzés: ez felülírta a korábbi "Bekötés" választ ebben a chatben.)
- ✅ 3. fázis TELJES: 103 tool migrálva 14 modulba — commit `72b953c`; tmux Enter-variánsok centralizálva — commit `d22edbd`
- ✅ Minden commit pusholva GitHubra (origin/main)
- ✅ Teszt-állapot: 57 fájl / 952 teszt zöld (2026-07-16), typecheck + biome tiszta

## Környezet

- DEV: port 3466 — MŰKÖDIK Windowson (`node scripts/dev-start.mjs`)
- ChromaDB: állapotfüggő a Windows-gépen (2026-07-16-án futott, 4817 dokumentumot szolgált ki) — ha nem megy, in-memory fallback. A health `documents` mezője INDULÁSKORI pillanatkép, nem élő szám.
- `C:\opt` (spaceos + nexus-dev maradványok) TÖRÖLVE 2026-07-15 — Gábor jóváhagyta
- PowerShell-sajátosság: tsc/npx kimenetét fájlba kell irányítani (pipeline-crash), a Bash tool megbízhatóbb
- VPS-hozzáférés: `nexus-vps` alias (+ projektenkénti kulcsok: `joinerytech-vps`, `doorstar-vps`) — oktatóanyag: `docs/knowledge/vps-hozzaferes-modell.md`

## Nyitott kérdések

- **Árva mailbox-fa a prodon** (`/opt/nexus/src/terminals`, 17 üzenet): Gábor döntésére vár — lásd todo Aktív.
- A prod `AUTH_MODE=required`-re kapcsolása: a réteg készen áll, de token-osztás kell hozzá a kliensekhez. Ma `open` módban fut (= régi viselkedés).
- Megjegyzés: a Claude havi költségkeret elfogyott a háttér-agenteknél — a további munkát inline érdemes végezni
