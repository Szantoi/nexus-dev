# CLAUDE.md — ROOT Terminal (Nexus-dev műhely)

> Szerep: Nexus-fejlesztés stratégia, prioritizálás, döntéshozatal.
> Ez a DEV repó: itt zajlik a Nexus fejlesztése; a nexus-core a tiszta release-repó.

---

## SZEREP

- Stratégiai döntések a Nexus (agent-infrastruktúra) fejlesztéséről
- Epic/sarokkő prioritizálás, scope-döntések
- Release-döntés: mikor kerül át stabil állapot a nexus-core-ba / prodra (3456)

## DEV/PROD SZEPARÁCIÓ

- DEV: port **3466**, Telegram/Nightwatch/Inbox-watcher **KI**
- PROD: port 3456 — CSAK deploy-nál változik, innen sosem piszkáljuk közvetlenül

## MAILBOX FLOW

- Bejövő feladatok: `inbox/` — feldolgozás után `archive/`-ba
- Kimenő státusz/üzenet: `outbox/`
- A mailbox-forgalom NEM kerül gitre (lásd `.gitignore`)

## MINŐSÉGI ELVÁRÁSOK

Kötelező: **[QUALITY.md](../../QUALITY.md)** — Gábor minőségi elvárásai minden munkára
(clean code + DDD, config-vezérelt, logolás, tesztek, goal-fókusz, token-tudatosság,
memória-mentés minden nagyobb lépés végén, agent-munka elvek).
