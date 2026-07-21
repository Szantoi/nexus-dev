# ADR-059: Monitor-vezérelt cél-progresszió (goal store + watchGoals)

- **Státusz:** accepted
- **Dátum:** 2026-07-04; rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (eredeti ADR az előd-repóban)
- **Rekonstruált:** igen — kód és datált kódkommentek alapján

## Kontextus

A Mode #4 (ADR-053) programvezérlés drága volt: a haladás-figyeléshez erős (Sonnet)
sessionöknek kellett futniuk akkor is, amikor csak "várunk valamire". Kellett egy
olcsó, determinisztikus figyelő-mechanizmus, amely csak akkor ébreszti a drága
agentet, amikor tényleg van teendő.

## Döntés

Cél (goal) objektumok, amelyeket a Monitor figyel és teljesüléskor triggerel:

- **Goal store:** fájl-alapú goal-tár (`$SPACEOS_ROOT/store/goals`), goal-életciklus:
  `watching → triggered → completed | expired`.
- **Kompozit teljesülési kritériumok:** `done_outbox` (outbox-üzenet minta),
  `checkpoint_status`, `message_status`, `terminal_idle`, valamint `all_of`/`any_of`
  kombinátorok.
- **watchGoals:** minden Nightwatch-ciklusban (2 perc) végigellenőrzi a watching
  goalokat; teljesüléskor a cél-terminált triggereli.
- **MCP goal-toolok:** goal létrehozás/lekérdezés/kezelés agentek számára.

## Design intent

"Haiku (olcsó) folyamatosan figyel, Sonnet (drága) csak akkor indul, ha a cél
teljesült" — a watchGoals fejlécének explicit megfogalmazása. A kritérium-ellenőrzés
determinisztikus kód, nem LLM-ítélet (QUALITY.md 8.: ismert lépéssorra szkript jár).
A goal a leállási feltétel gépi formája (QUALITY.md 1.).

## Alternatívák

Az eredeti ADR elveszett. A kontextusból kiolvasható szembeállítás: folyamatosan
futó drága session-ök vs. esemény/kritérium-alapú ébresztés — az utóbbit választották.

## Következmények

- A Nightwatch-ciklus új felelősséget kapott (goals ellenőrzés a 12. lépés).
- A goal-tár útvonala env-vezérelt, de defaultja `/opt/spaceos` — QC-007 jelölt.
- A trigger session-indítást jelent, ami az ADR-046/049 cold-startútvonalat használja.

## Biztonsági hatás

Nincs közvetlen; a goal-fájlok lokálisak, titkot nem hordoznak.

## Kapcsolódó kód

- `knowledge-service/src/goalStore.ts` — goal-tár, kritérium-típusok, életciklus
- `knowledge-service/src/pipeline/watchGoals.ts` — ciklikus ellenőrzés + trigger
- `knowledge-service/src/pipeline/nightwatch.ts:86` — bekötés a Nightwatch-ciklusba
- `knowledge-service/src/mcp.ts:2097,4896` — goal MCP toolok

## Bizonyíték

- Kódkommentek: `goalStore.ts:2-7` ("ADR-059 ... 2026-07-04: Initial implementation"),
  `watchGoals.ts:2-12` ("core of Mode #4 cost-efficient operation")
- git: 823db70 (Initial commit, 2026-07-14)
