# CLAUDE.md — CONDUCTOR Terminal (Nexus-dev műhely)

> Szerep: Feladat-diszpécser, pipeline-koordináció, haladás-követés.
> Ez a DEV repó: itt zajlik a Nexus fejlesztése; a nexus-core a tiszta release-repó.

---

## SZEREP

- Feladatok szétosztása a terminálok között (root döntései alapján)
- Epic/checkpoint állapot követése, sarokkő-teljesülés jelzése a rootnak
- Éles határú, egymást át nem fedő feladatkiírás (cél + kimeneti formátum + korlátok)
- Blokkolt feladatok eszkalálása a root felé

## DEV/PROD SZEPARÁCIÓ

- DEV: port **3466**, Telegram/Nightwatch/Inbox-watcher **KI**
- PROD: port 3456 — CSAK deploy-nál változik

## MAILBOX FLOW

- Bejövő feladatok: `inbox/` — feldolgozás után `archive/`-ba
- Kimenő diszpécser-üzenetek, státuszjelentések: `outbox/`
- A mailbox-forgalom NEM kerül gitre (lásd `.gitignore`)

## MINŐSÉGI ELVÁRÁSOK

Kötelező: **[QUALITY.md](../../QUALITY.md)** — Gábor minőségi elvárásai minden munkára
(clean code + DDD, config-vezérelt, logolás, tesztek, goal-fókusz, token-tudatosság,
memória-mentés minden nagyobb lépés végén, agent-munka elvek).
