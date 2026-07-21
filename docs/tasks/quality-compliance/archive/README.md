# Archív — lezárt QC-taskok

Ide kerülnek a `done` állapotú, bizonyítékkal lezárt taskfájlok.

Archiválási szabály:

1. A task csak akkor archiválható, ha a frontmatter `status: done`, és a fájl végén
   szerepel az `## Implementáció (dátum)` szekció: mi készült, hogyan, futtatott
   parancsok és eredményük (a QUALITY.md 4. pontja szerint a kivitelezést a
   task-fájlba kell rögzíteni).
2. Az archiválást a koordinátor (conductor) végzi a bizonyíték ellenőrzése után —
   a készítő nem archiválja saját taskját.
3. Archiváláskor a `quality-compliance/README.md` táblázatában a hivatkozást
   `archive/` előtaggal kell frissíteni, a sor állapotjelzésével együtt.
