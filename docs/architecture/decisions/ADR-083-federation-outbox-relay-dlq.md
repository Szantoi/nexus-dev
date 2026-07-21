# ADR-083: Federation outbox/relay/inbox/ACK/DLQ protokoll

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés, ADR-066-ra épül

## Kontextus

SZIGET-06: a federation ma tároló/API, nem elosztott transzport. Konkrét
bizonyíték (ADR-080-ben is rögzítve): `federation.routes.ts` `POST /send`
és `GET /inbox` a `from_island`/`to_island`/`island` mezőket
`req.body`/`req.query`-ből olvassa, sosem `req.mcpIsland`-hez képest
validálva. A deduplikáció `SELECT`, majd `INSERT` — nem atomi. Nincs tartós
outbox/relay pumpa, retry, ACK vagy dead-letter két KÜLÖN
knowledge-service-példány között.

## Döntés

1. **Tranzakciós outbox** a task-message-box adatbázisában (additív,
   ADR-078 elve szerint, nem külön store): minden kimenő federation-üzenet
   beszúrása UGYANABBAN a tranzakcióban ír egy `outbox_entries` sort is —
   nincs "elküldött" állapot tartós sorbaállítás nélkül.
2. **Relay pumpa:** ütemezett háttérfolyamat (a meglévő `pollLoop` mintájára)
   olvassa a saját sziget kézbesítetlen `outbox_entries` sorait, és POST-olja
   a célsziget `POST /api/federation/inbox-delivery` végpontjára
   (island-párhoz kötött Bearer-hitelesítéssel), `idempotency_key` =
   üzenet saját UUID-ja.
3. **Idempotens fogadás:** `INSERT INTO messages (...) ... ON CONFLICT
   (idempotency_key) DO NOTHING`, majd 200 + kézbesített azonosító ACK
   válasz; a relay ACK vételekor jelöli `outbox_entries.delivered_at`-ot.
4. **Retry/backoff:** exponenciális backoff jitterrel, `attempt_count`/
   `max_attempts` az `outbox_entries`-en; a relay maga is az ADR-079
   claim/lease mintáját ÚJRAHASZNÁLJA (nem újít fel külön mechanizmust) —
   így több relay-folyamat sem küldi el kétszer ugyanazt a sort.
5. **Dead-letter:** `max_attempts` után `outbox_entries.status =
   'dead_letter'`; operátor számára látható lista + manuális requeue
   végpont (ADR-079 `dead_letter → queued` mintáját tükrözi).
6. **Auth és allow-list:** a relay hívás aláírt/dedikált Bearer-token a
   `(forrás-sziget, cél-sziget)` párra (nem egy közös, megosztott federation
   token); a fogadó fél ELLENŐRZI, hogy a forrássziget a SAJÁT federation
   allow-listáján van-e, mielőtt elfogadná (ADR-080 cross-island
   allow-list hivatkozása).
7. `from_island` MINDIG a küldő hitelesített identitásából származik
   (sosem kliensmezőből, ADR-080); `to_island` a küldő configált
   partnerlistájában kell szerepeljen.

## Design intent

Token-optimalizált federáció (ADR-066 elve: az inbox csak metaadatot ad)
megmarad; ehhez adódik hozzá a TARTÓSSÁG és a KÉZBESÍTÉSI GARANCIA, amit a
mai közös-adatbázison-belüli API modell nem ad meg két külön service-példány
között.

## Alternatívák

- **Külső üzenetbróker (Kafka/RabbitMQ/NATS)** — elvetve MOST: aránytalan a
  jelenlegi 2-3 szigetes méretskálán; újranyitható, ha a skála indokolja.
- **Fire-and-forget HTTP retry, outbox nélkül** — elvetve: nem ad tartós
  garanciát szolgáltatás-kiesés esetén (üzenetvesztés).

## Következmények

- ISL-014 implementálja; a relay a claim/lease mechanizmus (ADR-079)
  újrahasznosítására épít, nem önálló konkurenciavédelmet épít.
- A jelenlegi `federation.routes.ts` kliensmező-elfogadása javítandó
  (ADR-080 hatálya is, itt is releváns).

## Biztonsági hatás

Az island-pár-specifikus token és az allow-list ellenőrzés zárja a ma
bizonyított rést (bármely érvényes token tetszőleges `to_island`-ot
címezhet). Rate-limit hiánya (lásd Nyitott kérdések) fennmaradó kockázat.

## Kapcsolódó kód

- `knowledge-service/src/interfaces/http/routes/federation.routes.ts`
- `knowledge-service/src/task-message-box/store.ts`
- `docs/architecture/decisions/ADR-066-cross-island-federation.md`

## Bizonyíték

- Kód-felderítés 2026-07-18: `federation.routes.ts` `POST /send` (33. sor)
  és `GET /inbox` (55. sor) kliensmező-alapú sziget-meghatározás;
  `bootstrap/app.ts:201` — a federation router semmilyen root/mutation
  guard mögé nincs kötve, ellentétben a legtöbb más route-tal.
- `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` SZIGET-06.

## Nyitott kérdések

- **Rate-limit/kvóta hiánya:** egy sziget ma korlátlan mennyiségű federation
  üzenetet küldhetne egy másiknak — alacsony erőfeszítésű volumetrikus DoS
  kockázat. Javasolt kiegészítés (nem blokkoló, follow-up): forrás-sziget
  szerinti kvóta az ADR-083 implementációjában (ISL-014).
- Az outbox/inbox tábla pontos oszlopszerkezete implementációs részlet.
