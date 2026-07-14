# QUALITY.md — Minőségi elvárások (Gábor)

> Ez a fájl a munkával kapcsolatos minőségi elvárásokat rögzíti.
> Minden agent (root, monitor, conductor és a specialisták) minden munkájára vonatkozik.
> Domain-független: a szakma-specifikus szabályok a sziget/terminál CLAUDE.md-kben élnek.
> Forrás: Gábor, 2026-07-14. Módosítani csak vele egyeztetve.

---

## 1. Cél és irányítás (goal-fókusz)

- **Minden projektnek definiált célja van, és definiált leállási feltétele** — meg kell határozni, mikor hagyjuk abba.
- A munka hierarchiája: **program** (legnagyobb egység, több projektet tartalmaz) → **projekt** → **mérföldkő** → **epic** → **task**.
- A projekt állapotát folyamatosan vezetni kell (EPICS.yaml / goal-config — a cél nem a beszélgetés-kontextusban él).
- A sarokkövek mérhető feltétellel definiáltak: „kész" csak az, ami bizonyítottan teljesült.

## 2. Tervezés

- **Teljes architekturális tervezés nélkül nem kezdünk új feature fejlesztésébe.**
- Ha embernek tervezünk: **a UX legyen rendben.**
- Ha gépnek tervezünk: **a kimenet legyen minél könnyebben feldolgozható** (strukturált, parszolható).
- A döntéseket dokumentáljuk (ADR-minta), a tervezési szándékot (design intent) is rögzítjük, ne csak a végeredményt.

## 3. Kódolás

- **Clean code** és **DDD** (domain-driven design) elvek szerint dolgozunk.
- **Minden legyen kommentelve és README-vel ellátva.**
- **Nincsenek nagy fájlok** — bontsd fel, ha nő.
- **Nincs hardcodolt adat**: minden configból jön, hogy tudni lehessen, mit hol állítunk.
- **A futó kódot loggal kell tudni nyomon követni** — minden folyamatról látszódjon, hogy megfelelően végigment-e.

## 4. Tesztelés és ellenőrzés

- **Tesztekkel kell ellátni az egyes funkciókat ÉS a nagyobb összefüggéseket is** (unit + integráció).
- Az eredményt a végén **össze kell vetni az elvárásokkal** — nem tértünk-e el tőlük.
- **A kivitelezést rögzíteni kell a task-fájlba** (mi készült, hogyan, mi az eredmény).

## 5. Hatékonyság (token-tudatosság)

- **Minimalizáljuk a token-használatot.**
- **Nem kell mindig LLM-nek generálnia a kódot vagy a megoldást**: az a jó, ha **paraméterezhető szkript** készül, amit a változásoknál újra fel lehet használni.
- **Ami bevált, azt rögzítjük**: skillekben, tudástárban, sablonokban.
- **Minden nagyobb lépés végén memória-mentés** (memory / MEMORY.md / tudástár).

## 6. Munkamódszer

- Van egy alap-működés, de **a módszereket mindig nyitottan, a cél alapján találjuk ki** — nem ragaszkodunk folyton mindenhez.
- **Specializált agenteket használunk, akár többet is**, hogy a közös munka megossza a kontextust és a figyelem fókuszált maradjon.

## 7. Stabilitás és biztonság

- Stabilitás > új feature; rollback-elhetőség; backup a kockázatos lépések előtt.
- Runtime-adat, secrets, tokenek, `.env` sosem kerülnek gitre.

## 8. Agent-munka (kutatási tanulságok)

- **Egyszerűség elve:** a legegyszerűbb működő megoldást keressük. Ismert lépéssorra determinisztikus workflow/szkript jár, nem LLM-döntés — az LLM ott dolgozik, ahol tényleg ítélőképesség kell.
- **Kontextus = véges erőforrás:** az agent teljesítménye romlik, ahogy telik a kontextusa. Tartós állapot fájlban/configban él (goal-config, mailbox); hosszú munkánál checkpoint + friss session (context saturation küszöbök: 30 turn WARNING / 50 CRITICAL).
- **Készítő ≠ ellenőr:** aki a munkát csinálta, a saját hibáira vak. A verifikációt friss kontextusú, külön agent végzi (reviewer/QA szerep), lehetőleg adverzáriálisan („próbáld megcáfolni, hogy kész").
- **Földelt visszajelzés:** „kész" = ellenőrizhető bizonyíték (teszt zöld, build fut, health-endpoint válaszol), nem az agent önértékelése.
- **Erőforrás-keret + eszkaláció:** minden agent-feladatnak van kerete (max próbálkozás / token / idő). Ha elfogy: BLOCKED eszkaláció a koordinátor felé, nem végtelen javítgatási spirál.
- **Orchestrator–worker minta:** a koordinátor éles határú, egymást át nem fedő feladatokat oszt (cél + kimeneti formátum + korlátok); a worker strukturált eredményt ad vissza, nem prózát.
- **Tool-ergonómia (ACI):** az agentnek szánt tool egyértelmű nevű, jól dokumentált, félreérthetetlen paraméterű; hibaüzenete megmondja a következő lépést. A rossz tool-leírás ugyanolyan bug, mint a rossz kód.
- **Emberi kapu:** visszafordíthatatlan vagy kifelé ható lépés (publikálás, törlés, éles deploy) csak emberi jóváhagyással megy.
- **Eval-korpusz:** a bevált futásokból golden-path korpusz épül; a prompt/skill/workflow változtatásokat ezen mérjük le.

*Forrás: Anthropic agent-kutatások (Building Effective Agents; multi-agent research; context engineering) + saját flotta-tapasztalat.*
