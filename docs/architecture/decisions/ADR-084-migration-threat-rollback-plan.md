# ADR-084: Adat-, fenyegetés-, migrációs, kompatibilitási és rollback terv

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés, az ADR-077…083 összefoglaló terve

## Kontextus

A NEXUS-ISLAND-RUNTIME program (ADR-077…083) az identitás-, tárolási-,
konkurencia-, autorizációs-, launch- és federation-réteget egyszerre
érinti. A QUALITY.md 7. pontja ("stabilitás > új feature; rollback-
elhetőség; backup a kockázatos lépések előtt") és a program README-je
("Bevezetési sorrend" P0…P4) megköveteli az egységes migrációs és
kompatibilitási tervet.

## Döntés

### Adatmodell-hatás (táblázatos összefoglaló)

| Terület | Mai állapot | Új állapot | Migráció jellege |
|---|---|---|---|
| Terminálkonfig | `terminals.yaml` + `terminals.json` párhuzamosan | egyetlen `islands:`-gyökerű YAML (ADR-077) | additív séma, majd JSON kivezetés |
| Agent-token térkép | `agents.yaml` lapos `agent_islands` | `token → {island_id, terminal_id}` (ADR-077) | üzemeltetői lépés, nem git (secrets) |
| Task/message store | 4 párhuzamos (messageRegistry, TMB, epicRouter, workerRegistry) | 1 kanonikus (task-message-box, ADR-078) | additív oszlopok → dual-write ablak → kivezetés |
| Claim/lease | nincs szerveroldali | `lease_owner`/`lease_expires_at`/`fencing_token`/`idempotency_key` (ADR-079) | additív oszlopok a kanonikus store-on |
| Federation | közös DB-n belüli API | tranzakciós outbox + relay (ADR-083) | additív tábla, párhuzamos futtatás a régi API mellett átmenetileg |

### Fenyegetésmodell (STRIDE-lite)

| Kategória | Kockázat | Mitigáció (ADR-hivatkozás) |
|---|---|---|
| Spoofing | token-lopás, hamis identitás | per-agent/per-runner token, rövid élettartamú lease + fencing (ADR-077, ADR-079) |
| Tampering | kliens-megadott `island`/`terminal` mező | szerveroldali identitásfeloldás, sosem kliensinput (ADR-080) |
| Repudiation | nem visszakövethető döntés | egységes policy-motor, EGY audit-sor minden döntésnél (ADR-080) |
| Information disclosure | cross-island olvasás | default-deny cross-island policy (ADR-080) |
| Denial of service | lease-éhezés, budget-kimerítés, federation-áradat | lease timeout + reaper (ADR-079), claim-előfeltétel budget-kapu (ADR-081), federation rate-limit (ADR-083, nyitott) |
| Elevation of privilege | root/`can_control` visszaélés | egyetlen policy-motorba foglalt root-eset, nincs bespoke route-szintű escalation (ADR-080) |

### Migrációs sorrend

A README függőségi táblájával megegyező sorrend (ADR-077 → ADR-078 →
ADR-079 → ADR-080 → ADR-081 → ADR-082 → ADR-083), mert minden downstream
döntés a compound identitásra (ADR-077) épül. Minden lépés:

1. additív séma/kód (a régi fogyasztó nem törik);
2. új fogyasztó bevezetése, párhuzamos futtatás mérőszámmal;
3. régi fogyasztó kivezetése, csak a teljes tesztkészlet zöld állapotában;
4. a régi kód/tábla törlése — ez az egyetlen pont, ami már NEM
   visszafordítható triviálisan, ezért csak a 3. lépés után, dokumentált
   döntéssel.

### Kompatibilitás

Az egy-szigetes telepítés (ma implicit `ISLAND_ID` env) tovább működik mint
"szigetszám = 1" speciális eset — nem igényel migrációt, ha nincs második
sziget. A `config/terminals.json`/`src/config/terminals.ts` fogyasztóinak
IDŐBEN KORLÁTOZOTT kompatibilitási réteg jár a migrációs ablak alatt, nem
tartós dual-support.

### Rollback

- Minden migrációs lépés VAGY git-revert-tel visszavonható, VAGY additív
  (a régi kód figyelmen kívül hagyhatja az új oszlopot/táblát) — destruktív
  lépés (oszlop/tábla törlés) csak azután fut, hogy a megfelelő legacy
  fogyasztó már törölve van a kódbázisból ÉS a teljes tesztkészlet zölden
  fut.
- Kockázatos lépés (DB-séma-migráció, tábla törlés) előtt kötelező backup
  (SQLite-fájl másolat) — QUALITY.md 7. pont.

## Design intent

Az ADR-066 "additív alap, nem big-bang" precedensének következetes
folytatása minden rétegen — a program egyetlen lépése sem tételezi fel,
hogy egy régi fogyasztót egyetlen commitban le lehet cserélni.

## Alternatívák

- **"Big-bang" teljes migráció egy release-ben** — elvetve: a jelenlegi éles
  runner-MVP és VPS-deploy miatt aránytalan kockázat.
- **Tartós dual-write/dual-config** — elvetve: a DP-002-vel egybehangzóan
  (lásd ADR-078 nyitott kérdés) a tartós dual-write maga a probléma
  osztálya, amit a program meg akar szüntetni.

## Következmények

Minden ISL-002…015 implementáló feladata explicit hivatkozni erre a
sorrendre és a saját lépése additív/destruktív jellegére.

## Biztonsági hatás

Lásd a fenyegetésmodell táblázatot fent — ez az ADR MAGA a biztonsági
hatás-összefoglaló a teljes programra.

## Kapcsolódó kód

Lásd ADR-077…083 "Kapcsolódó kód" szakaszait — ez az ADR nem ismétli meg,
hanem összefogja azokat.

## Bizonyíték

- `docs/architecture/decisions/ADR-066-cross-island-federation.md` —
  additív migrációs precedens.
- `docs/tasks/island-runtime/README.md` "Bevezetési sorrend" és
  "Végrehajtási hullámok" szakasz.
- QUALITY.md 7. pont.

## Nyitott kérdések

- A dual-write ablak pontos időtartama és mérőszáma (metrika: hány
  fogyasztó olvas még a legacy store-ból) implementációs részlet,
  ISL-004/ISL-014 hatálya.
- Lásd ADR-078 Nyitott kérdések — a DP-002 koordinációs pont ide is
  átvetül a migrációs sorrend tekintetében: ha a DP-002 más ütemet
  igényel a saját kanonikus állapotmodelljéhez, a két program migrációs
  naptárát egyeztetni kell (emberi döntés, nem ezen ADR hatálya).
