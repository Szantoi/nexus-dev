# ADR-054: CRM domén — Lead/Opportunity FSM minta

- **Státusz:** proposed (rekonstrukció bizonyítékhiánnyal — review szükséges)
- **Dátum:** eredeti dátum ismeretlen; rekonstruálva: 2026-07-18
- **Döntéshozó(k):** ismeretlen (feltehetően SpaceOS CRM-domén tervezés)
- **Rekonstruált:** igen — egyetlen közvetett bizonyítékból

## Kontextus

A SpaceOS CRM-doménjében a lead/opportunity életciklus állapotgépként (FSM)
modellezendő. A knowledge-service domain-pattern-matchere a "Lead/Opportunity FSM"
mintát ajánlja CRM-feladatokra, és forrásként erre az ADR-re hivatkozik.

## Döntés (rekonstruált, NEM bizonyított)

A rendelkezésre álló bizonyíték alapján a döntés valószínűsíthető tartalma:
a lead/opportunity életciklus enum-alapú FSM-mel modellezett, az állapotátmeneteket
a domain-aggregát validálja (nem a UI vagy az adatréteg).

A döntés részletei (állapothalmaz, átmenet-mátrix, elvetett alternatívák) ebben a
repóban NEM rekonstruálhatók: a CRM-kód nem része a nexus-dev repónak.

## Design intent

Nem rekonstruálható bizonyítottan. Az ajánlás szövege ("Validate transitions in
domain aggregate") DDD-elvre utal: az üzleti szabály a doménben él.

## Alternatívák

Ismeretlenek — az eredeti dokumentum elveszett.

## Következmények

A knowledge-service oldalán csak a pattern-matcher ajánlása. A tényleges
FSM-implementáció más repóban él.

## Biztonsági hatás

Nincs a knowledge-service-re nézve.

## Kapcsolódó kód

- `knowledge-service/src/pipeline/domainPatternMatcher.ts:34` — `adrRefs: ['ADR-054']`
  a crm/Lead-Opportunity-FSM mintánál
- `knowledge-service/src/__tests__/unit/domainPatternMatcher.test.ts:179` —
  a teszt elvárja az ADR-054 hivatkozást

## Bizonyíték

- Egyetlen közvetett bizonyíték: a fenti `adrRefs` bejegyzés + tesztje.
  git-történeti vagy dokumentum-bizonyíték nincs (823db70 Initial commit-tal érkezett).

## Nyitott kérdések

- Létezik-e az eredeti ADR-054 az előd-repóban? Ha igen, importálni kell, és ez a
  rekonstrukció superseded-re állítandó.
- Ha nem kerül elő: a pattern-hivatkozás maradjon-e ADR-alapú, vagy mutasson a
  CRM_PATTERNS.md tudásdokumentumra?
