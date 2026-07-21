# Projektfeladatok

Ez a könyvtár a tartós, agenteknek vagy fejlesztőknek kiosztható projektfeladatok kanonikus gyűjtőhelye.

## Aktív programok

- [QUALITY.md megfelelőségi program](quality-compliance/README.md) — a 2026-07-18-i biztonsági és minőségi felmérés javítási terve, tíz végrehajtható taskkal.
- [Garantált szigetüzem és többplatformos CLI runner](island-runtime/README.md) —
  17 task az izolált agentcsapatok, az atomi ownership, a federation és a
  Codex/Claude/Antigravity × Windows/Linux futtatás bizonyításához.

Egy feladat csak akkor jelölhető késznek, ha a saját elfogadási feltételeihez előírt bizonyítékok is rendelkezésre állnak.

## Archiválás

A lezárt (`done`) taskfájlok a program `archive/` almappájába kerülnek (pl.
`quality-compliance/archive/`), a fájl végére írt `## Implementáció` szekcióval,
amely rögzíti, mi készült, hogyan, és milyen bizonyítékkal. A részletes szabály:
[quality-compliance/archive/README.md](quality-compliance/archive/README.md).
