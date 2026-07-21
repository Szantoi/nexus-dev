# ADR-085: SLO-k és platformbizonyítási stratégia (Windows/Linux)

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés

## Kontextus

A program README-je kötelező, géppel olvasható `platform_evidence` sémát
definiál minden valós CLI-futtatáshoz, és megköveteli, hogy szimulált/
mockolt futás sose helyettesítse a valós bizonyítékot. A jelenlegi
rendszernek nincs rögzített SLO-készlete a claim-, lease-, federation- és
helyreállítási időkre.

## Döntés

### SLO-k (kezdeti, MEGBECSÜLT célértékek — explicit jelezve: nem mért
alapvonal, hanem ISL-017 empirikus mérése után felülvizsgálandó)

| Metrika | Cél | Megjegyzés |
|---|---|---|
| Claim-latencia (`queued → leased`, verseny alatt) | p95 < 500 ms egy hoszton | SQLite egyíró-szemantika |
| Heartbeat-intervallum vs. lease-időtartam | heartbeat a lease-időtartam 1/3-ánál | konfigurálható, pl. 5 perces lease → ~100 mp heartbeat |
| Lease-lejárat észlelése | egy seprési intervallumon belül (pl. 30 mp) | ADR-079 reaper |
| Federation kézbesítési latencia (mindkét sziget elérhető) | p95 < 10 mp | ADR-083 relay |
| Helyreállítás runner-crash után | a task újra claimelhető `lease_duration + sweep_interval` időn belül, manuális beavatkozás nélkül | ADR-079 |

### Bizonyítási stratégia

A README `platform_evidence` sémája MINDEN ISL-008…012 és ISL-017 PASS
állításának kötelező formátuma. Az érettségi audit 10 elfogadási
feltételéhez (lásd `docs/knowledge/terminal-agent-sziget-mukodes-
ertekeles.md` "Elfogadási feltételek" szakasza) az alábbi konkrét
teszt/chaos-forgatókönyv rendelendő:

| # | Feltétel | Bizonyítási módszer |
|---|---|---|
| 1 | két azonos nevű terminál két szigeten, ütközés nélkül | integrációs teszt: 2 island_id ugyanabban a store-ban, párhuzamos műveletek |
| 2 | cross-island olvasás/írás tiltása | negatív authz teszt-suite (a meglévő `islandScoping.test.ts` minta bővítése) |
| 3 | konkurens claim → pontosan egy nyer | N párhuzamos claim-kísérlet egy sorra, `affected rowcount` összege = 1 |
| 4 | crash + lease-lejárat helyreállítás | teszt-harness: gyermekfolyamat megölése lease közben, óra előretekerése, reaper requeue-t igazol |
| 5 | idempotens újraküldés | azonos `idempotency_key` kétszer, egyetlen üzleti sor jön létre |
| 6 | restart-perzisztencia | store újranyitása/process-restart, állapot nem vész el |
| 7 | review-kapu kikényszerítve | közvetlen `running → completed` kísérlet review-köteles taskon, elutasítva |
| 8 | federation-kiesés | célsziget szimulált leállása, outbox megtartja/később kézbesíti vagy DLQ-ba kerül |
| 9 | egységes configforrás | a legacy terminálconfig-betöltő elutasítva/nem létezik, egyetlen betöltési út |
| 10 | többpéldányos + chaos E2E | ISL-017 hatálya, a valós 3×2 CLI×OS mátrix — automatizált unit teszttel NEM helyettesíthető |

### Windows/Linux platform-specifikus dimenziók

- Mindkét platform SQLite WAL módot használ (megerősítendő, hogy azonos
  journal-mode fut mindkét oldalon).
- Process-tree cleanup platformonként eltérő mechanizmus (Windows Job
  Objects vs. Linux process group/systemd cgroup) — külön bizonyíték-sor
  OS-enként (ISL-011/ISL-012 hatálya), nem összevonható egy állítássá.
- A CLI-doksi frissessége: az ADR-082-ban rögzített verziók (Codex: nincs
  verziószám a doksin; Claude Code: v2.1.212; Antigravity: 1.0.7) a
  2026-07-18-i lekérdezés pillanatképei — a README saját szabálya szerint
  ("a futás napján ellenőrizze") az ISL-008/009/010 implementálóinak
  ÚJRA kell ellenőrizniük a saját futtatásuk napján, ez az ADR csak
  kiindulási alapot ad, nem fagyasztja be a verziókat.

## Design intent

Az SLO-számok explicit "cél, nem mért alapvonal" jelöléssel szerepelnek —
ezzel elkerülve a hamis pontosság látszatát; az ISL-017 empirikus mérése
után az ADR felülvizsgálandó.

## Alternatívák

- **SLO-k rögzítése nélkül, "majd meglátjuk működés közben"** — elvetve:
  QUALITY.md 1. pont ("mérhető sarokkő") megköveteli a mérhető célt már a
  tervezési fázisban.
- **Azonnal szigorú, pontos SLA-szerű számok** — elvetve: valós mérés
  hiányában hamis pontosság lenne; ezért "cél, felülvizsgálandó" jelölés.

## Következmények

Az ISL-015 (observability) és ISL-017 (független bizonyítás) ezekre a
számokra és a bizonyítási táblázatra hivatkozik.

## Biztonsági hatás

Nincs közvetlen — ez egy mérési/bizonyítási keretdöntés.

## Kapcsolódó kód

Nincs közvetlen kódkapcsolat — ez keretszabály a jövőbeli metrikagyűjtéshez
és teszttervhez (ISL-015, ISL-017).

## Bizonyíték

- `docs/tasks/island-runtime/README.md` "Platformbizonyíték-séma" szakasz.
- `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` "Elfogadási
  feltételek a szigetüzem garantált állításhoz" szakasz (10 pont).
- `docs/architecture/decisions/ADR-082-cli-adapter-contract.md` — a
  2026-07-18-i élő doksi-ellenőrzés forrása.

## Nyitott kérdések

- A konkrét `lease_duration`/`sweep_interval` alapértékek implementációs
  hangolási kérdés — az ISL-017 empirikus mérése alapján finomítandó.
