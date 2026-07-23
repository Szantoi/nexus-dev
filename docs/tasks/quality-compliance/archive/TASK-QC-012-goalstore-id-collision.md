---
id: TASK-QC-012
title: goalStore.generateGoalId ütközési kockázat megszüntetése
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-VERIFICATION
status: done
priority: low
depends_on: []
owner_role: backend
created: 2026-07-18
source: TASK-QC-010 független review, 4. szakasz "2" pont
---

# goalStore.generateGoalId ütközési kockázat megszüntetése

## Cél

Két, közel egyidejű `createGoal()` hívás ne generálhasson azonos ID-t.

## Jelenlegi bizonyíték

- `knowledge-service/src/goalStore.ts:95-99` — `generateGoalId()` a
  `Date.now().toString().slice(-3)` utolsó 3 jegyét használja szuffixként,
  ami 1000 ms-onként ismétlődik. Két hívás azonos ezredmásodperc-ablakban
  (vagy 1000 ms-onként ismétlődő mintázatban) azonos ID-t kaphat, ami néma
  felülírást okoz a goal-store-ban.

## Scope

1. Cseréld az ID-generálást ütközésmentesre: pl. monoton számláló (a store
   már meglévő perzisztens rétegén), UUID, vagy `crypto.randomBytes`-alapú
   szuffix.
2. Regressziós teszt: sok egyidejű `createGoal()` hívás (pl. `Promise.all`
   10+ hívással) mind egyedi ID-t kapjon.

## Nem cél

- A goal-store egyéb részeinek átalakítása.
- ID-formátum publikus szerződésének megváltoztatása, ha külső kód az ID
  formátumára mintaillesztést végez — ellenőrizd ezt előbb (`rg
  "goalId|goal_id" knowledge-service/src`), és ha van ilyen függés, csak a
  szuffix-generálást cseréld, a formátumot (prefix, hossz) tartsd meg.

## Elfogadási feltételek

- [x] 10+ egyidejű `createGoal()` hívás mind egyedi ID-t ad, tesztben
      igazolva. (12 párhuzamos hívás, `goalStore.test.ts` új describe blokk)
- [x] A meglévő ID-formátumra épülő kód (ha van) nem törik. (Formátum
      `GOAL-YYYY-MM-DD-NNN` megmaradt; a teszt-regex változatlanul zöld.)
- [x] `npm run typecheck && npm test` zöld. (exit 0 / exit 0)

## Kötelező ellenőrzés

```bash
cd knowledge-service
npm run typecheck
npx vitest run src/__tests__/unit/goalStore.test.ts
npm test
```

## Átadandó bizonyíték

- Az új ütközés-teszt kimenete.
- Diff a `generateGoalId`-nál.

## Kockázat és rollback

Alacsony — belső segédfüggvény, nincs ismert külső formátum-függés a review
szerint, de ellenőrizd a scope 2. pontja szerint indulás előtt.

## Végrehajtási napló

### 2026-07-21 — indulás (backend agent)

- **Goal:** két (vagy több) közel egyidejű `createGoal()` hívás soha ne
  generálhasson azonos goal-ID-t, és meglévő goal-fájl néma felülírása ne
  legyen lehetséges.
- **Mérhető sikerkritérium:** új regressziós teszt, amely 12 párhuzamos
  `createGoal()` hívást indít (`Promise.all`), és minden ID egyedi + minden
  goal-fájl létezik a store-ban. A teszt a javítás ELŐTT bukik (reprodukció),
  a javítás UTÁN zöld. `npm run typecheck` és `npm test` zöld.
- **Kilépési feltétel:** elfogadási feltételek pipálva, Implementáció-szekció
  kitöltve (parancsok + exit code-ok), status `in_progress` → `ready`
  (a `done` zárás a független review joga).
- **Formátum-függés ellenőrzés (Scope 2 / Nem cél):** `rg "goalId|goal_id|GOAL-"
  knowledge-service/src` — mintaillesztés az ID-formátumra csak a
  `src/__tests__/unit/goalStore.test.ts:139` regexében
  (`/^GOAL-\d{4}-\d{2}-\d{2}-\d{3}$/`) és dokumentációs példaként az
  `interfaces/mcp/tools/goal.tools.ts:172` leírásában van. A formátum
  (`GOAL-YYYY-MM-DD-NNN`, 3 jegyű szuffix) megmarad, csak a szuffix
  generálása változik.

## Implementáció (2026-07-21)

**Környezet:** Windows 11 Home 10.0.26200, Node v24.13.0, vitest 4.1.10.

**A bug gyökere:** `generateGoalId()` a `Date.now().toString().slice(-3)`
utolsó 3 jegyét használta szuffixként. Azonos ezredmásodpercben (vagy pontosan
1000 ms többszörösére eső időpontokban) induló `createGoal()` hívások azonos
ID-t kaptak, és a `fs.writeFile` (alapértelmezett `w` flag) némán felülírta a
korábban létrehozott goal-fájlt. Reprodukálva: 12 párhuzamos hívásból csak
**2 egyedi ID** született (teszt-kimenet: `expected 2 to be 12`).

**A javítás** (`knowledge-service/src/goalStore.ts`):

1. `nextGoalId()` — a szuffix mostantól **perzisztens monoton számláló**: a
   `GOALS_DIR`-ben már létező `GOAL-<mai dátum>-NNN.yaml` fájlokból veszi a
   legnagyobb sorszámot, és +1-et ad (min. 3 jegyre padelve; 999 fölött nő a
   hossz — a formátum-prefix változatlan). `ENOENT` (még nincs store-könyvtár)
   esetén 000-tól indul.
2. `withIdAllocationLock()` — folyamaton belüli sorosítás (promise-lánc mutex):
   párhuzamos `createGoal()` hívások nem láthatják ugyanazt a lemez-állapotot,
   így nem választhatják ugyanazt a sorszámot.
3. `createGoal()` — a goal-fájl írása `flag: 'wx'`-szel történik: ha az ID már
   létezik (pl. másik folyamat nyerte el közben), `EEXIST` hibát kapunk néma
   felülírás helyett, és max. `MAX_ID_ALLOCATION_ATTEMPTS` (5) próbával új
   sorszámot foglalunk. Kimerülés esetén explicit hibát dob.

**Módosított fájlok:**

- `knowledge-service/src/goalStore.ts` — `generateGoalId()` →
  `nextGoalId()` + `withIdAllocationLock()`; `createGoal()` ID-foglalása
  lock alatt, `wx`-írással.
- `knowledge-service/src/__tests__/unit/goalStore.test.ts` — új describe:
  „goal ID allocation under concurrency (TASK-QC-012)": 12 párhuzamos
  `createGoal()` → minden ID egyedi, formátum tartva, minden fájl létezik,
  a store darabszáma pontosan +12 (nincs néma felülírás). A `tick` helper
  elavult kommentje frissítve.

**Futtatott parancsok (knowledge-service/):**

| Parancs | Eredmény |
| --- | --- |
| `npx vitest run src/__tests__/unit/goalStore.test.ts` (javítás ELŐTT) | új teszt bukik: 12-ből 2 egyedi ID (reprodukció) |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run src/__tests__/unit/goalStore.test.ts` (javítás UTÁN) | exit 0 — 34/34 zöld |
| `npm test` (teljes hermetikus suite) | exit 0 — 76 fájl, 1308 passed / 1 skipped |
| `npm run check:tasks` | exit 0 |

Megjegyzés: az első teljes `npm test` futásban flaky worker-teardown zaj
jelentkezett (`EnvironmentTeardownError` a `retrospectiveStore.test.ts`-ből,
minden teszt zöld volt); a fájlnak nincs kapcsolata a goalStore-ral, és az
ismételt teljes futás exit 0-val zárult — nem e task következménye.

## Független adverzáriális review (2026-07-21)

**Verdikt: PASS** — a támadó forgatókönyveket kóddal is lefuttattam
(scratchpad-szkript, repo-n kívüli temp store), egyik sem törte meg a fixet.

### Támadó forgatókönyvek és eredményük

1. **Cross-process konkurencia** (a `withIdAllocationLock` csak folyamaton
   belüli): szimuláció — a várható következő ID fájlját „idegen processzként"
   előre létrehoztam idegen tartalommal, majd `createGoal()`. Eredmény: a
   `wx` flag `EEXIST`-tel elutasította az írást, a retry a friss `readdir`
   alapján +1-et foglalt, az idegen fájl tartalma bitre érintetlen maradt —
   néma felülírás cross-process esetben sem lehetséges. A lyuk elvi maradéka:
   ≥5 egymást követő vesztes verseny kimeríti a retry-t, de az explicit
   `Error`-t dob (nem néma), és a gyakorlatban irreális.
2. **999 fölött:** előre feltöltött `GOAL-<ma>-999.yaml` mellett a következő
   ID `GOAL-<ma>-1000` lett — a `padStart(3)` nem csonkol, a `parseInt` a
   4 jegyű sorszámot is visszaolvassa. Megjegyzés: a szigorú `NNN` (3 jegy)
   formátum 999 fölött hosszabbodik; az egyetlen ismert formátum-függés a
   teszt-regex (friss store-on sosem ér 999 fölé) és egy doc-példa — a task
   ezt explicit dokumentálja, elfogadható.
3. **Sérült/idegen fájlnevek a GOALS_DIR-ben:** `GOAL-<ma>-abc.yaml`,
   `GOAL-<ma>-.yaml`, `notes.txt`, `.yaml` nevű KÖNYVTÁR, más napi
   `GOAL-1999-01-01-500.yaml` — egyik sem dönti el az allokátort és nem
   szennyezi a számlálót (`Number.isInteger` szűrő + prefix-illesztés).
4. **Nap-átfordulás éjfélkor:** a `nextGoalId` a dátumot és a prefixet
   ugyanabban a hívásban, egyszer számolja — a szűrő és az eredmény nem
   csúszhat szét; a számláló naponta prefix szerint újraindul, ütközést a
   `wx` határeset-átfedésnél is kizár. (Elemzéssel igazolva; UTC-dátum,
   ahogy eddig is.)
5. **Mutex-lánc hibatűrése:** a `withIdAllocationLock` `then(fn, fn)` +
   `catch(() => undefined)` mintája elbukó allokáció után is életben tartja
   a láncot — egy hibás hívás nem blokkolja a következőket.
6. **Red-fázis hitelesség:** a régi `Date.now().slice(-3)` azonos ms-ablakban
   determinisztikusan azonos ID-t ad, `w`-flag írással némán felülír — a
   teszt `Set`-uniqueness + `before+12` darabszám asszerciói régi kódon
   szükségszerűen buknak (a napló szerint 12-ből 2 egyedi ID), a teszt tehát
   valóban a bugot pinneli.

### Kapuk (független újrafuttatás, knowledge-service/, 2026-07-21)

| Parancs | Exit |
|---|---|
| `npx tsc --noEmit` | **2** — 1 hiba, `src/runner/runnerConfig.ts:66` (párhuzamos runner-munkaterület módosított fájlja; a goalStore-ra és tesztjére nulla típushiba) |
| `npx vitest run src/__tests__/unit/goalStore.test.ts src/__tests__/unit/workflowManagerFs.test.ts` | 0 (58 passed) |
| `npm test` (teljes hermetikus suite) | 0 (77 fájl, 1314 passed, 1 skipped) |
| `npm run check:tasks` | 0 |
| scratchpad támadó-szkript (999→1000, EEXIST-retry, idegen fájl érintetlen, junk-nevek) | 0 — ALL PASS |

A typecheck-hiba nem e task következménye (a `runner/` aktív párhuzamos
munkaterület), a task saját futásakor dokumentáltan exit 0 volt. A diffben
látható path-centralizálás (`SPACEOS_ROOT`/`getEpicsPath` a `config/paths`-ból)
a párhuzamos config-vezérelt-útvonal munkafolyam része, nem e task scope-ja.

Status: `ready` → `done` (független review lezárva).
