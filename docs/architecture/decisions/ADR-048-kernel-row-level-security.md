# ADR-048: Kernel domén — Row-Level Security (RLS) minta

- **Státusz:** proposed (rekonstrukció bizonyítékhiánnyal — review szükséges)
- **Dátum:** eredeti dátum ismeretlen; rekonstruálva: 2026-07-18
- **Döntéshozó(k):** ismeretlen (feltehetően SpaceOS kernel-domén tervezés)
- **Rekonstruált:** igen — egyetlen közvetett bizonyítékból

## Kontextus

A SpaceOS kernel-doménje multi-tenant adathozzáférést igényel. A knowledge-service
domain-pattern-matchere a "Row-Level Security (RLS)" mintát ajánlja kernel-domén
feladatokra, és forrásként erre az ADR-re hivatkozik.

## Döntés (rekonstruált, NEM bizonyított)

A rendelkezésre álló bizonyíték alapján a döntés valószínűsíthető tartalma:
a kernel-domén multi-tenant izolációja PostgreSQL Row-Level Security policy-kkel
történik, a tenant-izolációt teszttel kell igazolni.

A döntés részletei (mely táblák, milyen policy-séma, milyen alternatívákkal szemben)
ebben a repóban NEM rekonstruálhatók: a hivatkozott kód (SpaceOS kernel, PostgreSQL)
nem része a nexus-dev repónak.

## Design intent

Nem rekonstruálható bizonyítottan. A minta-ajánlás szövege alapján a szándék a
tenant-izoláció adatbázis-szinten történő kikényszerítése (nem alkalmazás-kódban).

## Alternatívák

Ismeretlenek — az eredeti dokumentum elveszett.

## Következmények

A knowledge-service oldalán csak annyi, hogy a pattern-matcher ezt a mintát ajánlja
kernel-feladatokra. A tényleges RLS-implementáció más repóban él.

## Biztonsági hatás

A döntés maga biztonsági tárgyú (tenant-izoláció); a knowledge-service-re nézve
közvetlen hatása nincs.

## Kapcsolódó kód

- `knowledge-service/src/pipeline/domainPatternMatcher.ts:54` — `adrRefs: ['ADR-048']`
  a kernel/RLS mintánál (references: `docs/knowledge/patterns/DATABASE_PATTERNS.md`,
  amely szintén nem része ennek a repónak)

## Bizonyíték

- Egyetlen közvetett bizonyíték: a fenti `adrRefs` bejegyzés. git-történeti vagy
  dokumentum-bizonyíték nincs (823db70 Initial commit-tal érkezett).

## Nyitott kérdések

- Létezik-e az eredeti ADR-048 a SpaceOS előd-repóban? Ha igen, importálni kell és
  ez a rekonstrukció superseded-re állítandó.
- Ha nem kerül elő: a domainPatternMatcher hivatkozása maradjon-e, vagy a minta
  hivatkozzon közvetlenül a DATABASE_PATTERNS.md-re?
