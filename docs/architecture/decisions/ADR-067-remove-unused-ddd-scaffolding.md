# ADR-067: A használatlan DDD-scaffolding eltávolítása

- **Státusz:** accepted
- **Dátum:** 2026-07-15
- **Döntéshozó(k):** Gábor (chat-root review, "Option A") + a végrehajtó session
- **Rekonstruált:** nem — helyi git-bizonyítékkal teljesen lefedett döntés

## Kontextus

A knowledge-service-ben állt egy DDD-rétegzés scaffoldingja (`src/domain/` mailbox-
és terminal-entitásokkal, repository- és service-osztályokkal, valamint
`src/infrastructure/` file-system repository-implementációval) — összesen ~2300 sor,
amelyet SEMMI nem importált. A kód "előre megépített" architektúra volt tényleges
fogyasztó nélkül, miközben az élő funkcionalitás a `src/pipeline/` és társai alatt
fejlődött.

## Döntés

A használatlan scaffolding törlésre került (Option A a chat-root review-ból):

- törölve: `src/domain/` (mailbox + terminal entitások, repository-k, service-ek),
- törölve: `src/infrastructure/` (file-terminal.repository és index),
- 12 fájl, 1565 sor nettó törlés; mind a 888 teszt zöld maradt a törlés után.

## Design intent

A DDD-t elvként követjük (QUALITY.md 3.), nem üres könyvtárszerkezetként: a
domén-modell akkor születik meg, amikor valódi fogyasztója van. A holt kód
karbantartási teher és félrevezető jelzés ("itt él a domén") — az egyszerűség elve
(QUALITY.md 8.) a törlést diktálta.

## Alternatívák

- **Option B (implicit): a scaffolding feltöltése** — a meglévő pipeline-logika
  bemigrálása a DDD-rétegekbe. Elvetve: nagy kockázatú refaktor lett volna bizonyított
  haszon nélkül; a modularizálást a QC-008 (nagy fájlok felbontása) kezeli célzottan,
  élő kódon.
- **Megtartás "majd jó lesz" alapon** — elvetve: importer nélküli kód, amely a
  coverage-t és az auditokat is torzítja.

## Következmények

- ~2300 sorral kisebb, őszintébb kódbázis; a tesztkészlet változatlanul zöld.
- A jövőbeni DDD-bontás (QC-008) tiszta lappal, az élő kód igényeiből indul.
- A git-történet őrzi a törölt kódot — szükség esetén visszaemelhető.

## Biztonsági hatás

Nincs; kizárólag holt kód távozott.

## Kapcsolódó kód

- Törölt útvonalak: `knowledge-service/src/domain/**`, `knowledge-service/src/infrastructure/**`
  (a commitban látható teljes fájllistával)

## Bizonyíték

- git: 046b8bb61303b1474f2fa5d5566c9ac1f9cf5661 ("Remove unused DDD scaffolding
  (2300 LOC)", 2026-07-15) — commit-üzenetben: "Decision: Option A from chat-root
  review", "All 888 tests still passing"
- git: 9239bca ("docs(root): work files synced — phase 4 closed by daytime session
  (DDD deleted, phase 3 complete)")
