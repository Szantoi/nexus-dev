# ADR-078: Kanonikus task/message store és a legacy store-ok kivezetése

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés, ADR-066-ra épül

## Kontextus

A SZIGET-05 megállapítás szerint a feladat- és üzenetállapot több párhuzamos
igazságforrásban él. 2026-07-18-i kódfelderítés ezt PONTOSÍTOTTA: nem 3, hanem
**négy** független állapotmodell létezik egyszerre:

1. `messageRegistry` (legacy, 12 NAGYBETŰS státusz) — ADR-066 szerint már
   deprecated irányba tart.
2. `task-message-box` (SQLite, ADR-066 kanonikus üzenetmodell — `type` ×
   `status` két dimenzió, `config/message-model.yaml`-ből konfigurálva).
3. `pipeline/epicRouter.ts` **saját** SQLite táblái: `task_queue.status IN
   ('queued','dispatched','executing','completed','cancelled')`,
   `epics.status`, `terminal_context.status` — ezek NEM ugyanaz a
   szókészlet, mint a task-message-box-é, és nincs FK-kapcsolat közöttük
   (`epicRouter.ts:592` `dispatchTask`/`markTaskDispatched`). A modul saját
   kommentje szerint (`epicRouter.ts:487`, `handleTaskCompletion`) ez az
   "ADR-053 szerint AUTORITATÍV" completion-forrás — vagyis a kódbázisban
   **már ma is két, egymásnak ellentmondó "autoritatív" állítás** él
   egymás mellett (epicRouter completion-eseménye vs. inboxWatcher
   fájl-alapú detektálása).
4. `pipeline/workerRegistry.ts`: kizárólag memóriában élő
   `Map<string, WorkerState>`, restart esetén nyomtalanul elvész, saját
   dependency-gráf-fogalommal (`depends_on`), sziget-szkópolás nélkül.

Konkrét, korábban nem jelzett regresszió is előkerült: a `task-message-box`
`store.ts` `getOutbox()` (633-647. sor) és `renderMessageToFile()` (246. sor)
még mindig `type IN ('done','blocked')` értékekre szűr/ágaz, holott a
kanonikus modell (és a DB CHECK constraint) ezt az értéket `type`-ként MÁR
NEM engedi be — a `getOutbox` ezért ma véglegesen üres eredményt ad, halott
kód post-ADR-066.

A `pipeline/epicRouter.ts` az `EPICS.yaml`-t is közvetlenül, regex-alapú
szövegcserével módosítja (`updateCheckpointStatus`, 533. sor) — séma-ellenőrzés
és tranzakcionalitás nélkül, a DB-írástól függetlenül.

## Döntés

1. A **`task-message-box`** (ADR-066) marad és BŐVÜL a platform egyetlen
   kanonikus RUNTIME task/message/queue store-jává. A `messageRegistry`, az
   `epicRouter` saját `task_queue`/`terminal_context`/`epics` táblái és a
   `workerRegistry` memóriabeli térképe **kivezetésre kerülnek** — megmaradó
   egyedi felelősségük (epic/ütemezési logika, párhuzamos worker-függőség)
   **nézetté/szolgáltatássá** válik a task-message-box sorai FÖLÖTT, nem
   önálló táblaként külön szókészlettel.
2. Additív sémabővítés (nem big-bang): a task-message-box kap
   `epic_id`/ütemezési mezőket (az epicRouter idle-check/same-epic-first
   logikájának kiváltásához) és egy `task_dependencies` táblát (a
   workerRegistry `depends_on`-jának perzisztens megfelelője) — mindkettő a
   MEGLÉVŐ `island_id`/`terminal_id`/`status` oszlopokra épül, nem önálló
   státuszgépet vezet be.
3. **Fokozatos migráció** (ADR-066 "nem big-bang" precedensét folytatva):
   1. additív oszlopok/tábla hozzáadása;
   2. epicRouter ütemezési logikájának átírása task-message-box olvasásra;
   3. időben korlátozott, mérőszámmal követett dual-write ablak (nem tartós
      dual-write — végdátummal és metrikával, ADR-084 szerint);
   4. fogyasztók (MCP toolok, HTTP route-ok, runner) átállítása kizárólag a
      kanonikus store-ra;
   5. `messageRegistry`, `epicRouter` saját táblái, `workerRegistry` memóriabeli
      térképe törlése, csak a szükséges dependency-sorok átemelése után;
   6. minden lépés kapuja: a meglévő tesztkészlet (idézett 180 teszt +
      task-message-box saját suite-ja) zöld marad.
4. A `getOutbox()`/`renderMessageToFile()` `type IN ('done','blocked')`
   halott ága **hibaként rögzítve** — javítása ISL-004 implementációs
   feladata, nem ennek az ADR-nek a hatálya, de itt dokumentált, hogy ne
   vesszen el.
5. Fájlrendszeri mailbox (`.md` projekció) marad best-effort, regenerálható
   NÉZET (ADR-066 elve), sziget-szegmenssel bővítve (ADR-077).

## Design intent

Egy tranzakciós, gépi fogalommodell — ne szöveges fájlból, ne memóriából, ne
harmadik párhuzamos SQLite-ból olvasson az agent-menedzsment. Additív
migráció, mert a 10+ fogyasztó egyszerre történő átállítása aránytalan
kockázat egy már bevált mintához (ADR-066) képest.

## Alternatívák

- **Big-bang csere** — elvetve: aránytalan kockázat, a fogyasztók száma és a
  runner MVP élő futása miatt.
- **Az epicRouter tábláit tenni kanonikussá, a task-message-box-ot
  beolvasztani** — elvetve: a task-message-box már ADR-066-tal elfogadott,
  konfigurált (`message-model.yaml`) és tesztelt kanonikus modell; az
  epicRouter szókészlete (`dispatched`/`executing`) NEM konfigurálható,
  hardcodolt, és nincs sziget-oszlopa.
- **Négy store párhuzamos fenntartása, csak dokumentálva** — elvetve: ez a
  SZIGET-05 probléma maga, nem megoldása.

## Következmények

- Az `epicRouter.ts` és a `workerRegistry.ts` élettartama véges — a
  kivezetés után törlendők (nem "future cleanup", hanem ütemezett lépés).
- Az `EPICS.yaml` közvetlen regex-alapú írása (`updateCheckpointStatus`)
  vagy megszűnik, vagy egy validált, tranzakciós projekció-írásra cserélendő
  — ez átfed a NEXUS-DEVELOPMENT-PROCESS `TASK-DP-002` kanonikus
  állapot-döntésével (lásd Nyitott kérdések).
- A `messageRegistry` teljes kivezetése lezárja az ADR-066-ban már jelzett
  "deprecated irányba tart" állapotot.

## Biztonsági hatás

Az egységes store egyetlen ponton kényszeríti ki a sziget-szkópolást
(`WHERE island_id = ?`), ami az ADR-080 autorizációs döntésének alapja;
négy külön store mellett ez a kényszerítés négyszer, inkonzisztensen kellene
megtörténjen.

## Kapcsolódó kód

- `knowledge-service/src/task-message-box/store.ts`, `message-model.ts`, `types.ts`
- `knowledge-service/config/message-model.yaml`
- `knowledge-service/src/messageRegistry.ts` — kivezetendő
- `knowledge-service/src/pipeline/epicRouter.ts` — kivezetendő, `updateCheckpointStatus` speciálisan
- `knowledge-service/src/pipeline/workerRegistry.ts` — kivezetendő
- `knowledge-service/src/config/paths.ts` — `DATA_DIR` sziget-szegmens (ADR-077)

## Bizonyíték

- Kód-felderítés 2026-07-18: `epicRouter.ts:487` "ADR-053: This is the
  AUTHORITATIVE source..." kommentje; `epicRouter.ts:98` és `:592-595`
  `task_queue`/`dispatchTask` séma; `epicRouter.ts:533` `EPICS.yaml`
  regex-írás; `epicRouter.ts:715` hardcodolt `TERMINALS`; `store.ts:246`
  és `:633-647` a `type IN ('done','blocked')` halott ág;
  `pipeline/workerRegistry.ts:27` memóriabeli `Map`, nincs perzisztencia.
- `docs/architecture/decisions/ADR-066-cross-island-federation.md` —
  kanonikus üzenetmodell és migrációs precedens.
- `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` SZIGET-05.

## Nyitott kérdések

- **Koordinációs pont a TASK-DP-002-vel (NEXUS-DEVELOPMENT-PROCESS
  program):** a DP-002 az `EPICS.yaml`, taskfájlok, checkpoint/goal store és
  emberi ledgerek (a Nexus-dev MŰHELY saját fejlesztési folyamatának
  KORMÁNYZÁSI állapota) autoritatív határát dönti el. Ez az ADR a FUTÓ
  agentcsapatok közötti operatív üzenetküldés/task-ownership (RUNTIME)
  állapotát dönti el — más adatsík. A két döntés NEM olvasztható össze
  automatikusan: ha a DP-002 úgy dönt, hogy a fejlesztési folyamat
  task-életciklusa (pl. `TASK-DP-004`) magán a task-message-box-on
  keresztül fusson, az az ÜZENET-TRANSZPORT újrahasznosítása lehet, de a
  "kész-e a TASK-DP-004" autoritatív forrása azt DP-002 határozza meg, nem
  ez az ADR. Ha bármely jövőbeli implementáció ezt a két síkot egy
  táblába akarná olvasztani, az EXPLICIT, külön döntést igényel — ez az ADR
  NEM dönt a fejlesztési-folyamat állapotmodellről, és a `pipeline/
  epicRouter.ts` `updateCheckpointStatus`-ának (ami ma az `EPICS.yaml`-t
  írja) végső sorsa a DP-002 elfogadása UTÁN dől el egyértelműen.
- A `task_dependencies` tábla pontos sémája implementációs részlet
  (ISL-004/ISL-005 hatálya).
- **Ötödik, korábban nem inventarizált queue-rendszer:** az ADR-081
  2026-07-19-i kimerítő launch-audit-ja feltárta, hogy
  `knowledge-service/src/dispatch-control/` saját SQLite-sémával
  (`schema.sql`) task-dispatch-szerű állapotot tart
  (`queueDispatch`/`getDispatchQueue`/`markDispatchExecuting`), amit ez az
  ADR (068-i felderítéskor) nem vett figyelembe. Nyitott kérdés — az
  ISL-004 implementálójának kell eldöntenie, hogy ez a rendszer a
  task-message-box-ba olvad-e be (jelen ADR mintájára) vagy kizárólag
  budget-/proposal-bookkeeping-ként él tovább, saját task-állapot nélkül.
  Lásd ADR-081 "Kimerítő launch-belépési pont audit" szakasza a részletekért.
