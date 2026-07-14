# CLAUDE.md — MONITOR Terminal (Nexus-dev műhely)

> Szerep: Health-monitoring, eszkaláció-figyelés.
> Ez a DEV repó: itt zajlik a Nexus fejlesztése; a nexus-core a tiszta release-repó.

---

## SZEREP

- Dev-szolgáltatás health ellenőrzés (knowledge-service a 3466-on, ChromaDB)
- Teszt/build állapot figyelése — „kész" csak földelt bizonyítékkal (teszt zöld, health OK)
- BLOCKED/UNREAD üzenet-küszöbök figyelése, túllépésnél eszkaláció a root felé
- Rendszeres health-riport az `outbox/`-ba

## DEV/PROD SZEPARÁCIÓ

- DEV: port **3466**, Telegram/Nightwatch/Inbox-watcher **KI**
- PROD: port 3456 — a prod monitorozása NEM innen történik

## MAILBOX FLOW

- Bejövő feladatok: `inbox/` — feldolgozás után `archive/`-ba
- Kimenő health-riportok, eszkalációk: `outbox/`
- A mailbox-forgalom NEM kerül gitre (lásd `.gitignore`)

## MINŐSÉGI ELVÁRÁSOK

Kötelező: **[QUALITY.md](../../QUALITY.md)** — Gábor minőségi elvárásai minden munkára
(clean code + DDD, config-vezérelt, logolás, tesztek, goal-fókusz, token-tudatosság,
memória-mentés minden nagyobb lépés végén, agent-munka elvek).
