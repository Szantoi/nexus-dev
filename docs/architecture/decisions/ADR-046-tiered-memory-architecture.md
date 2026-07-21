# ADR-046: Rétegzett (tiered) memória-architektúra és session-életciklus

- **Státusz:** accepted
- **Dátum:** eredeti dátum ismeretlen (2026-06 vége előtt; import: 2026-07-14); rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (eredeti ADR az előd-repóban)
- **Rekonstruált:** igen — kód, kódkommentek és tier-policy konstansok alapján

## Kontextus

Az agentek kontextusa véges erőforrás (QUALITY.md 8.): a session-ök közötti tudás
elveszett, minden indulás "cold start" volt, és nem volt szabály arra, hogy melyik
emlék meddig releváns. Kellett egy perzisztens, öregedő-felejtő memóriamodell és a
session-életciklus hookolása.

## Döntés

Négy párhuzamos track-ben bevezetett memória-architektúra:

- **Track A — Tiered memory store:** SQLite-alapú memóriatár tier-ekkel
  (`hot` 48h / 15%-os napi decay, `warm` 14d / 5%, továbbá hosszú távú tier),
  salience-értékkel, napi decay-futtatással, tier-promócióval és cross-terminal
  megosztott (shared) memóriákkal.
- **Track B — Session lifecycle hooks:** cold start kontextus-injektálás session
  indulásakor (releváns memóriák betöltése), session-end kezelés (Marveen cold start
  minta nyomán).
- **Track C — Handoff + retrospektíva + tier-kezelő MCP toolok:** HANDOFF.md
  generálás session/task átadáshoz; session-elemzés javaslatokkal (skill/memória/
  workflow); memória-tier kezelés MCP-n át.
- **Track D — Daily digest:** napi terminál-összefoglaló (session-ök, memóriák,
  elkészült taskok, DONE/BLOCKED üzenetek) HTTP route-okkal.
- Kiegészítők: rendszermetrika-gyűjtés (monitoring), watchPriority cold-start
  indítás, hibrid API azonnali trigger a mailboxban, opcionális modell-paraméter
  priority sessionökhöz.

## Design intent

A tartós állapot fájlban/DB-ben él, nem a beszélgetés-kontextusban. A salience-decay
a "felejtés" szabályozott formája: ami fontos, azt promóció menti feljebb; ami nem,
az magától kikopik — így a cold start kontextus kicsi és releváns marad
(token-tudatosság, QUALITY.md 5.).

## Alternatívák

Az eredeti ADR elveszett; bizonyítottan nem rekonstruálható. A kódból valószínűsíthető
elvetett irány: egyetlen lapos MEMORY.md fájl tier-ek nélkül (ennek korlátai — méret,
relevancia-szűrés hiánya — motiválták a tier-modellt).

## Következmények

- Minden session indulása determinisztikus kontextus-építéssel történik
  (`sessionHooks.buildStartupContext`), ami az ADR-049 domain-tudás betöltésével bővült.
- A memória-DB (better-sqlite3) közös infrastruktúra lett a digest, a retrospektíva
  és a messageRegistry számára is (`messageRegistry.ts:11` explicit erre hivatkozik).
- A decay/promóció paraméterei kódkonstansok (`TIER_POLICIES`) — a QC-007
  konfig-központosítás jelöltje.

## Biztonsági hatás

A memória-DB lokális fájl; titok nem való bele. Külön auth-rétege nincs — a
hozzáférés a szolgáltatás API-ján keresztül történik.

## Kapcsolódó kód

- `knowledge-service/src/pipeline/memoryStore.ts` — Track A (TIER_POLICIES, decay, promote)
- `knowledge-service/src/sessionHooks.ts` — Track B
- `knowledge-service/src/handoff.ts`, `src/retrospective.ts` — Track C
- `knowledge-service/src/digest.ts`, `src/interfaces/http/routes/digest.routes.ts`,
  `src/interfaces/http/routes/memory.routes.ts` — Track C/D
- `knowledge-service/src/pipeline/systemMetrics.ts`, `src/pipeline/watchPriority.ts`,
  `src/interfaces/http/routes/mailbox.routes.ts:164`

## Bizonyíték

- Kódkommentek: `sessionHooks.ts:2` (Track B), `handoff.ts:2` és `retrospective.ts:2`
  (Track C), `digest.ts:2` (Track D), `pipeline/memoryStore.ts:88` (tier-policyk)
- git: 823db70 (Initial commit, 2026-07-14) — a teljes Track A–D implementáció készen érkezett
