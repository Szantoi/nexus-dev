---
id: TASK-DP-002
title: "Kanonikus projekt- és taskállapot ADR"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M1
epic: DP-STATE-ARCHITECTURE
status: done
priority: critical
depends_on: []
parallel_with: [TASK-DP-001]
owner_role: architect
created: 2026-07-18
source: "DEVPROC-02 and DEVPROC-03"
---

# Kanonikus projekt- és taskállapot ADR

## Cél

ADR-ben megszüntetni az `EPICS.yaml`, taskfájlok, checkpoint DB, goal store,
mailbox/Epic Router és emberi ledgerek egymással versengő igazságforrásait.

## Mikor jó?

Minden állapottípushoz pontosan egy autoritatív store és owner tartozik; minden
további fájl vagy API dokumentált, egyirányú projekció; konfliktus, restart és
migráció esetére determinisztikus szabály van.

## Scope

1. Készíts állapotmátrixot a programcél, milestone, epic, task, ownership,
   checkpoint, review, release, state, todo és memória adatairól.
2. Hasonlítsd össze legalább a fájlkanonikus, DB-kanonikus és eseménynapló-alapú
   alternatívát konzisztencia, audit, offline használat és rollback szerint.
3. Döntsd el az autoritatív store-t minden adatosztályhoz, a verziókezelt design
   intent és a tranzakciós runtime state határával együtt.
4. Definiáld a transitionöket, verzió/CAS szabályt, lockot, projekciót,
   reconciliationt és konfliktusfeloldást.
5. Tervezd meg az egyirányú migrációt és a dual-write kivezetését dry-runnal,
   mérőszámokkal, rollbackkel és végdátummal.
6. Rögzítsd, hogyan működik offline CLI-agent, service-kiesés és sérült projekció
   esetén a folyamat.

## Elfogadási feltételek

- [ ] Minden állapotmezőhöz egyetlen source of truth tartozik.
- [ ] Az `EPICS.yaml` és a projects DB jelenlegi ellentmondása feloldott.
- [ ] A goalStore, checkpointStore, Epic Router és taskfájl felelősségi határa
  explicit.
- [ ] A state/todo projekció újraépíthető és nem írhatja felül a kanonikus adatot.
- [ ] A memória tartós tudás, nem tranzakciós taskállapot.
- [ ] A migráció idempotens, dry-runolható, mérhető és visszaállítható.
- [ ] Az ADR-nek van legalább egy ellenzői/adverzáriális review-ja.

## Kötelező ellenőrzés

Legalább három konfliktusforgatókönyv asztali vagy prototípustesztje: DB és YAML
eltérés, félbeszakadt projekcióírás, párhuzamos transition. A reviewer próbálja
megcáfolni az egyetlen autoritatív forrás állítását minden írási belépési ponton.

## Kilépési feltétel

`done`, ha az ADR elfogadott, a célarchitektúra egyértelmű, és a DP-003/004/005
implementálható nyitott source-of-truth kérdés nélkül. Döntetlen alternatíva vagy
adatvesztési kockázat esetén emberi döntésig `blocked`.

## Végrehajtási napló

Az implementáló a program README kötelező protokollja szerint tölti ki.

### 2026-07-18 — futásindítás

- **Goal (egy mondat):** ADR-ben lezárni a program/mérföldkő/epic/task/ownership/
  checkpoint/review/release/state/todo/memória adatosztályok autoritatív
  store-jait, a köztük lévő projekció/reconciliation/migrációs szabállyal,
  legalább 3 asztali konfliktus-forgatókönyvvel és egy önálló adverzáriális
  review-szakasszal.
- **Mérhető sikerkritérium:** az ADR minden TASK-DP-002 elfogadási feltételét
  PASS-ra állítja VAGY nyitott kérdésként dokumentálja emberi döntésre; a
  `node scripts/check-doc-links.mjs` zöld az új ADR linkjeire; a Mermaid
  állapotgép szintaktikailag ellenőrzött.
- **Kilépési feltétel:** ADR elkészül, önálló és elfogadható dokumentum (a
  meglévő 12 ADR formátumában), a taskfájl frontmatter `ready` marad
  (független review vár), a végén "KÉSZ, FÜGGETLEN (ADVERZÁRIÁLIS) REVIEW-RA
  VÁR" jelzéssel.
- **Base:** branch `main` (nincs külön feature branch — dokumentáció-only
  task, nincs commit/push ebben a futásban).
- **Owner:** architect (worker agent, ez a futás).
- **Erőforráskeret:** egy ülés, kód nem módosul, csak `docs/architecture/decisions/`
  alatt új ADR(ek) + ez a taskfájl.

## Implementáció (2026-07-18)

**KIMERÍTŐ LELTÁRRAL KIEGÉSZÍTVE, 3. KÖRÖS FÜGGETLEN REVIEW-RA VÁR.**
(Történet: "KÉSZ, FÜGGETLEN REVIEW-RA VÁR" → 1. kör REQUEST_CHANGES (2 hiányzó
writer) → "KIEGÉSZÍTVE, ÚJRA FÜGGETLEN REVIEW-RA VÁR" → 2. kör
REQUEST_CHANGES (1 újabb, harmadik hiányzó writer, `epicNotifications.ts`) →
ez a szakasz: a koordinátor utasítására EGYETLEN körben elvégzett, mechanikus,
kimerítő leltár a pontonkénti pótlás helyett. Ld. a fájl végén "## Kimerítő
leltár és az ADR kiegészítése (2026-07-18, 3. kör — készítő)" szakaszt a
teljes `rg`-kimenettel és a felvett/elvetett találatok indoklásával.) A
készítő (ez a session) nem fogadhatja el saját taskját (QUALITY.md 8. pont,
program README). A frontmatter `status` szándékosan `ready` marad — az ADR
`proposed` státuszú, elfogadása külön, független reviewer döntése.

### 1. Eredeti goal, sikerkritérium, kilépési feltétel

Ld. a "2026-07-18 — futásindítás" napló-bejegyzés fent. Változatlan a futás
alatt.

### 2. Tényleges eredmény és scope-eltérés

Elkészült: **`docs/architecture/decisions/ADR-068-canonical-project-task-state.md`**
— a TASK-DP-002 scope mind a 6 pontját (állapotmátrix, 3 alternatíva
összehasonlítás, autoritatív store döntés adatosztályonként, állapotgép +
verzió/CAS + lock + projekció/reconciliation, migrációs terv dry-run/
mérőszám/rollback/végdátummal, offline/service-kiesés/sérült projekció
kezelése) lefedi, plusz a kötelező 3 konfliktus-forgatókönyv és az önálló
adverzáriális review szakasz. Nincs scope-eltérés: kód NEM módosult, csak az
ADR + a `docs/architecture/decisions/README.md` index (új sor + szabad
sorszám 068→069) + ez a taskfájl.

Scope-bővítés (indokolt, nem elvetett): a Kontextus szakaszba — a
kötelező adverzáriális review megalapozásához — közvetlen kódbizonyítékot
gyűjtöttem (9 konkrét write/read-útvonal az `EPICS.yaml`/checkpoint/goal/
mailbox körül), túl azon, amit a puszta dokumentáció-olvasás adott volna.
Ez nem tér el a tasktól, hanem annak "Kötelező ellenőrzés" pontját
("a reviewer próbálja megcáfolni... minden írási belépési ponton") már a
készítés fázisában, magam ellen fordítva teljesítettem.

### 3. Architekturális döntések és elvetett alternatívák

Ld. az ADR "Döntés" és "Alternatívák" szakasza. Röviden: két réteg
(design-intent: EPICS.yaml + task-fájl; tranzakciós runtime-state: SQLite
`epic_router.db` bővítése), a TASK-QC-001 döntés MEGERŐSÍTVE program/
mérföldkő/epic/task szinten, a checkpoint/cornerstone kettősség (fájlbeli
`checkpoints:` mező vs. SQLite `epic_checkpoints`) FELOLDVA a fájlbeli
útvonal kivezetésével. Elvetve: tiszta DB-kanonikus (elveszítené a
git-review-kényszert a design-intent adatokon) és tiszta eseménynapló
(aránytalan építési költség a jelenlegi flotta-méretnél — nyitva hagyva
jövőbeli újraértékelésre).

### 4. Módosított fájlok, migrációk, adatkompatibilitás

Módosított/létrehozott fájlok (kizárólag dokumentáció, kód NEM változott):

- `docs/architecture/decisions/ADR-068-canonical-project-task-state.md` (új)
- `docs/architecture/decisions/README.md` (index-sor + szabad sorszám 068→069)
- `docs/tasks/development-process/TASK-DP-002-canonical-state-adr.md` (ez a fájl)

Migráció: NEM ebben a taskban hajtódik végre — az ADR "Migráció és
dual-write kivezetés" szakasza a TASK-DP-003/004 tervét adja át (dry-run
reconciliation, docstring-korrekció, törékeny writer kivezetése, tranzakciós
state-tábla, projekció-generátor, cutover-mérőszám, additív/nem-destruktív
rollback, végdátum a DP-M2 zárásáig). Adatkompatibilitás: n/a (nincs
adatmódosítás).

### 5. Base commit, branch, commitok, PR-hivatkozás

- Base commit: `5074441` (HEAD a futás elején és végén — nincs commit ebben a
  futásban, dokumentáció-only munka, a koordinátor dönt a commitolásról).
- Branch: `main`.
- Commitok: nincs (ez a futás nem commitol/pushol — a taskfájl és a program
  szerződése szerint a kód-módosítás és a git-műveletek a fájlhatáron
  kívül esnek; a koordinátor/felhasználó dönt a commitolásról).
- PR: N/A — dokumentáció-only ADR-task, nincs kódváltozás, amit PR-be kellene
  tenni ebben a fázisban; a taskfájl és az ADR maga a review tárgya.

### 6. Futtatott parancsok, exit code-ok, teszteredmények

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 67 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat." (exit 0)
```

Mermaid-ellenőrzés: a két `stateDiagram-v2` blokk kézi szintaktikai
átvizsgálása (nincs beépített renderelő ebben a környezetben) — egy hibát
találtam és javítottam (beágyazott kettőspont egy él-címkében, "CAS:
version..." → "CAS - version..."), mert a Mermaid a `-->` utáni ELSŐ
kettőspontot tekinti a címke-elválasztónak, egy második beágyazott
kettőspont kétértelmű lenne szigorúbb parsereknél.

Kódteszt (typecheck/vitest) NEM futott, mert a task fájlhatára nem
tartalmaz kódváltoztatást — nincs mit tesztelni ezen a szinten; ez
összhangban van a task "Kötelező ellenőrzés" listájával (konfliktus-
forgatókönyvek desk-check + linkellenőrzés + Mermaid), amely nem ír elő
kódtesztet egy döntési/ADR-taskhoz.

### 7. OS, shell, Node- és toolverziók

- OS: Windows 11 Home 10.0.26200
- Shell: Git Bash (POSIX sh) a Bash tool-on keresztül
- Node: v24.13.0 (`node --version`)
- Repo: `C:\Users\szant\Documents\Development\nexus-dev`

### 8. Negatív tesztek, biztonsági ellenőrzés, rollback-próba

- Negatív teszt: a linkellenőrző (`check-doc-links.mjs`) pontosan azt a
  hibaosztályt fogja meg, amit egy rosszul hivatkozott ADR-link okozna —
  lefutott, PASS, tehát az ADR új linkjei (a README index-sor, az ADR belső
  kereszthivatkozásai) érvényesek.
- Biztonsági ellenőrzés: az ADR "Biztonsági hatás" szakasza szerint nincs új
  auth/secrets-felszín; a task maga sem írt titkot vagy tokent semmilyen
  fájlba.
- Rollback-próba: mivel a változás kizárólag 2 új/módosított dokumentum +
  a taskfájl, a rollback triviálisan `git checkout -- <fájl>` vagy a 3 fájl
  törlése/visszaállítása — nincs adatvesztési kockázat, nem futtattam éles
  rollback-tesztet, mert a változás nem destruktív (nincs felülírt korábbi
  tartalom az ADR-könyvtárban, csak új sor + új fájl).

### 9. Ismert korlátok, fennmaradó kockázatok, follow-up taskok

- Az ADR "Nyitott kérdések" szakasza 5 tételt sorol: comment-preserving YAML
  döntés, dual-write végdátum pontosítása, ISL fizikai DB-elhelyezés,
  hármas "task" terminológia egyeztetése, `goalStore.ts` átnevezés (alacsony
  prioritású cleanup).
- A legkomolyabb, MA IS fennálló kockázat (ADR "Adverzáriális review" 8.
  pont): amíg a Migráció szakasz 1–3. pontja (docstring-korrekció, törékeny
  writerek kivezetése) nincs végrehajtva, a `checkpointStore.ts`/
  `projects.routes.ts` docstringje továbbra is tévesen "DB a forrás"-t
  állít — ez a taskfájl ezt nem javítja (fájlhatár), csak a DP-003/004
  implementálónak explicit, azonnali follow-up-ként adja át.
- Follow-up: QC-012 (goalStore ID-ütközés, már `ready`, trackelt) — ez az ADR
  megerősíti, hogy a mai ID-séma nem biztonságos, de a javítás nem e task
  hatásköre.

### 10. Reviewer azonosítója/szerepe, függetlenségi nyilatkozat, döntés

*(Szándékosan üresen hagyva — a készítő nem tölti ki. Független reviewer
tölti ki elfogadás/elutasítás előtt.)*

### 11. Elfogadási és kilépési feltételek — PASS/FAIL

| Feltétel | Eredmény |
|---|---|
| Minden állapotmezőhöz egyetlen source of truth tartozik | **PASS** — ld. ADR Döntés-táblázat, minden sorban egyértelmű kanonikus store |
| Az `EPICS.yaml` és a projects DB jelenlegi ellentmondása feloldott | **PASS** (döntési szinten) — a fájl marad kanonikus epic-státuszra, a DB egyirányú cache-re minősítve; a KÓDBELI kivezetés a DP-003/004 hatásköre, ezt az ADR explicit jelzi |
| A goalStore, checkpointStore, Epic Router és taskfájl felelősségi határa explicit | **PASS** — ld. Állapotmátrix + Kapcsolódó kód szakasz |
| A state/todo projekció újraépíthető és nem írhatja felül a kanonikus adatot | **PASS** (tervezési szinten) — ld. "Projekció és reconciliation" szakasz; a generátor implementációja DP-004 hatáskör |
| A memória tartós tudás, nem tranzakciós taskállapot | **PASS** — ld. Döntés-táblázat MEMORY.md sora |
| A migráció idempotens, dry-runolható, mérhető és visszaállítható | **PASS** — ld. "Migráció és dual-write kivezetés" szakasz mind a 8 pontja |
| Az ADR-nek van legalább egy ellenzői/adverzáriális review-ja | **PASS** — ld. "Adverzáriális review" szakasz, 8 konkrét belépési pont, kódbizonyítékkal |
| Kötelező ellenőrzés: 3 konfliktus-forgatókönyv | **PASS** — ld. "Konfliktus-forgatókönyvek" szakasz A/B/C |
| Kilépési feltétel: implementálható nyitott source-of-truth kérdés nélkül | **PASS** — a nyitott kérdések (9. pont) egyike sem source-of-truth-kérdés a DP-003/004/005 adatosztályaira nézve; mind vagy más program (ISL) hatásköre, vagy alacsony prioritású kód-cleanup |

Összes tételes feltétel PASS a döntési/dokumentációs szinten. A `blocked`
állapot nem indokolt (nincs döntetlen alternatíva, nincs adatvesztési
kockázat).

### 12. Task, EPICS, state, todo, memória és dokumentáció szinkronja

- **Task:** ez a fájl, frontmatter `status: ready` (nem `done` — független
  review vár).
- **EPICS.yaml:** NEM módosult ebben a futásban. A `DP-STATE-ARCHITECTURE`
  epic `status: active` marad (csak a review után, `done`-nal együtt vált,
  a program README szinkron-eljárása szerint) — szándékos, mert a task maga
  sem `done`.
- **state.md / todo.md / MEMORY.md:** NEM módosultak ebben a futásban —
  ezt a koordinátor/root terminál frissíti a review eredménye alapján
  (ez a worker-futás fájlhatára nem terjed ki a `terminals/root/` alá).
- **Kapcsolódó dokumentáció:** `docs/architecture/decisions/README.md`
  frissítve (index + szabad sorszám).

### Execution evidence

```yaml
execution_evidence:
  task_id: TASK-DP-002
  goal: "ADR-ben lezárni a kanonikus projekt-/taskállapot autoritatív store-jait"
  success_criteria:
    - "Minden TASK-DP-002 elfogadási feltétel PASS vagy dokumentált nyitott kérdés"
    - "node scripts/check-doc-links.mjs PASS az új ADR linkjeire"
    - "Mermaid állapotgép szintaktikailag ellenőrzött"
  exit_condition: "ADR kész, önálló dokumentum, taskfájl status ready marad, független review vár"
  base_commit: "5074441"
  branch: "main"
  commits: []
  pull_request: "N/A — dokumentáció-only ADR-task, nincs kódváltozás"
  environments:
    - os: windows
      shell: bash
      node: "v24.13.0"
  commands:
    - command: "node scripts/check-doc-links.mjs"
      exit_code: 0
      result: PASS
  reviewer:
    identity: "independent-adversarial-reviewer (3. kör, agent-futás)"
    independent: true
    decision: PASS
    evidence: "docs/tasks/development-process/TASK-DP-002-canonical-state-adr.md#fuggetlen-review-3-kor-2026-07-18"
  state_sync:
    task: true
    epics: false
    state: false
    todo: false
    memory: false
```

(`epics`/`state`/`todo`/`memory` a review-kör lezárásakor is szándékosan
`false` marad ebben a manifestben: az EPICS.yaml `DP-STATE-ARCHITECTURE`
epic állapotát, valamint a `terminals/root/state.md`/`todo.md`/`MEMORY.md`
frissítését a koordinátor/root terminál végzi a PASS-verdikt kézhezvétele
után — ez a review-futás fájlhatára nem terjed ki a `terminals/root/` alá
vagy az `EPICS.yaml`-ra.)

## Független review (2026-07-18)

**Függetlenségi nyilatkozat.** Ez a review egy külön, a TASK-DP-002
készítésében részt nem vett agent-futása. Nem vettem részt az ADR vagy a
taskfájl megírásában; a készítő állításait nem fogadtam el bizonyítékként,
minden alább felsorolt tényt saját maga olvasott forrásból (fájl, sor,
parancs-kimenet) igazoltam vagy cáfoltam. Cél: adverzáriálisan megpróbálni
megcáfolni az ADR konzisztenciáját és teljességét.

### 1. A 9 állítólagos write/read-útvonal ellenőrzése

Mind a 9, a Kontextus szakaszban felsorolt kódhelyet önállóan elolvastam.
**Mind a 9 pontos, pontos sorhivatkozással és idézettel igaz:**

- `pipeline/epicRouter.ts` `updateCheckpointStatus` — a regex-alapú
  `line.replace('pending', 'done')` valóban a **566. sorban** van, teljes
  fájl `fs.writeFileSync`-kel visszaírva (533–587. sor). Megerősítve.
- `conductor/checkpointTracker.ts` `updateCheckpointStatus` (152–192. sor)
  — valóban `yaml.load` → mutáció → `yaml.dump` → `writeFileSync`.
  Megerősítve.
- `projects/checkpointStore.ts` fejléc (1–13. sor) — szó szerint tartalmazza:
  *"The EPICS.yaml file is at most a one-time SEED ... the DB is the source
  of truth."* Megerősítve.
- `interfaces/http/routes/projects.routes.ts` fejléc (1–17. sor) — szó
  szerint: *"The DB (checkpointStore on the epic-router store) is the
  source of truth; EPICS.yaml is at most a one-time seed."* Az
  `/import-yaml` végpont kommentje is: *"One-time seed... After this, the
  DB is the truth."* Megerősítve.
- `interfaces/http/routes/epic-router.routes.ts` `/sync` (651–666. sor) —
  ismételten hívható, nincs egyszeri-futás védelem (`syncFromEpicsYaml`
  bármikor újrafuttatható). Ez valóban ellentmond a fenti "one-time
  seed"-nek. Megerősítve.
- `goalStore.ts` `checkCheckpointStatus` (313–317. sor körül) — hatodik,
  független `EPICS.yaml`-olvasó. Megerősítve.
- `mailbox.ts`/`checkpointTracker.ts` `checkMessageStatus` — a
  `checkpointTracker.ts` 49. sorában és a `goalStore.ts` 346. sorában is
  létezik egy-egy KÜLÖN `checkMessageStatus` implementáció (kettő, nem egy!
  — ez egy tizedik apró pontatlanság, de nem változtat az ADR lényegi
  állításán: a "kész" tényt egy string-konvención át olvassák).
- `pipeline/processLock.ts` (1–65. sor) — fájlalapú PID+TTL lock,
  `/tmp/spaceos-locks` hardcode, nem CAS. Megerősítve.
- `graph/epicsLoader.ts` `writeEpicsYaml` (203–232. sor körül, a fájlban
  ~197–234) — validál írás előtt, `tmp` + `rename` atomi mintát használ.
  Megerősítve mint az egyetlen "jó" writer-minta.

**Következtetés:** a készítő kódbizonyítékai nem voltak "önértékelés" —
mindegyik tételesen visszaellenőrizhető és pontos. Ez erős jel az ADR
alapossága mellett.

### 2. SAJÁT ADVERZÁRIÁLIS TALÁLAT — két, a készítő által KIHAGYOTT élő write-útvonal

A task kifejezetten kérte, hogy a reviewer próbáljon olyan írási
belépési pontot találni, amit a készítő kihagyott, névvel: "MCP tool-hívások,
CLI-parancsok, közvetlen fájlszerkesztés agent által". Kerestem — és
találtam **kettőt**, amelyik SEHOL nem szerepel az ADR Kontextus 9
pontjában, az Adverzáriális review 8 pontjában, sem a Kapcsolódó kód
listában:

**a) `knowledge-service/src/workflowManager.ts:updateEpicStatus`
(395–416. sor) — ÉLŐ, agent által ma is hívható MCP tool-útvonal.**

```ts
export function updateEpicStatus(epicId, status): boolean {
  const content = parseYamlFile<{ epics: Epic[] }>(EPICS_FILE);
  const epic = content.epics.find(e => e.id === epicId);
  epic.status = status;
  const yamlContent = yaml.dump(content, { lineWidth: -1 });
  fs.writeFileSync(EPICS_FILE, yamlContent);   // NINCS lock, NINCS CAS, NINCS validáció
  return true;
}
```

Ezt a `handleWorkflowTool` (workflowManager.ts, 603–658. sor) az
`'update_epic'` tool-néven kapcsolja be (644–650. sor), és az `update_epic`
tool ténylegesen szerepel a regisztrált MCP-tool-lista kontraktteszjében
(`src/__tests__/integration/mcpContract.integration.test.ts`, 157. sor) —
tehát ez NEM elméleti, hanem ÉLŐ, ma is autentikált MCP-klienstől
(bármely agenttől) hívható tizedik(!) write-útvonal ugyanarra az
`EPICS.yaml` epic-status mezőre, amit az ADR épp "egyértelműen fájl-
kanonikusnak" deklarál. Teljes fájl read-modify-write, komment-eldobó,
lock/CAS/validáció nélkül — pontosan az a hibaosztály, amit az ADR a
"törékeny writerek" közé sorol a másik két útvonalnál (1–2. pont), de ezt
nem vette észre.

**b) `knowledge-service/src/conductor/epicManager.ts:completeEpic`
(99–130. sor) — szerkezetileg azonos, ma csak unit-teszttel elért útvonal.**

Ugyanaz a minta (`yaml.load` → `epic.status = status` → `yaml.dump` →
`fs.writeFileSync`), de route/MCP-bekötést NEM találtam rá (csak
`src/__tests__/unit/conductorModules.test.ts` hívja) — tehát ez ma
analóg a `checkpointTracker.ts`-nél már elismert "élő, de inaktív"
mintával, azzal a különbséggel, hogy az ADR ezt a fájlt egyáltalán nem
nevezi meg sehol (sem a Kontextusban, sem a Kapcsolódó kód listában).

**Miért blokkoló ez, nem csak kozmetikai hiba:** a task Kötelező
ellenőrzése explicit előírja, hogy "a reviewer próbálja megcáfolni az
egyetlen autoritatív forrás állítását minden írási belépési ponton", és a
Kilépési feltétel szerint a DP-003/004-nek "implementálható nyitni
source-of-truth kérdés nélkül" kell lennie. Az (a) pont egy MA ÉLŐ,
hitelesített MCP-hívással elérhető write-útvonal, amit a Migráció szakasz
3. pontja ("Törékeny writer kivezetése") NEM sorol fel — ha a DP-003/004
implementáló szó szerint követi az ADR Kapcsolódó kód / Migráció
listáját, ez az útvonal ÉLVE MARAD a kivezetés után is, és az ADR
"egyetlen autoritatív forrás" garanciája továbbra is megkerülhető marad
pontosan úgy, ahogy az ADR saját 8. adverzáriális pontja a HTTP API-ról
írja ("bármely hitelesített hívó közvetlenül írhat... amíg a docstring/
kivezetés nincs elvégezve") — csak itt MCP tool-on, nem HTTP-n át.

### 3. Konfliktus-forgatókönyvek (asztali vs. éles teszt)

A task szövege szó szerint "asztali VAGY prototípustesztje"-t ír elő — ez
diszjunkció, nem kizárólagos éles teszt-követelmény. A készítő desk-check
elemzése (A/B/C forgatókönyv) a betű szerinti követelményt teljesíti.
A B forgatókönyv alapjául szolgáló race (`checkpointStore.ts`
`completeCheckpoint`, 98–114. sor: `getCheckpoint` SELECT majd külön
`UPDATE`) kódszinten valóban verifikálható TOCTOU-rés — ellenőriztem,
pontos. Javaslat (nem blokkoló): mivel ez a race triviálisan
prototípus-tesztelhető lett volna (két párhuzamos hívás egy kis
scripttel), erősebb bizonyíték lett volna, mint a desk-check — de a task
elfogadási szövege ezt nem követeli meg kötelezően, így ez NEM
elutasítási ok, csak follow-up javaslat a DP-004 implementálónak.

### 4. ÉLŐ, EGYIDEJŰ ADR-068 SZÁMÜTKÖZÉS — megerősítve

```
docs/architecture/decisions/ADR-068-canonical-project-task-state.md       (ez a task, DP-002)
docs/architecture/decisions/ADR-068-island-terminal-runner-identity.md    (TASK-ISL-001, párhuzamos)
```

Mindkét fájl LÉTEZIK, mindkettő `status: proposed`, mindkettő
`2026-07-18` dátummal, mindkettő untracked (`git status --porcelain`
szerint egyik sincs commitolva) — tehát nincs git-history, ami eldöntené,
melyik "érkezett előbb". Ez SZÓ SZERINT az a split-brain hiba (két
egymást nem ismerő író ugyanazon az erőforráson — itt: az ADR-sorszám
névtér), amit maga az ADR dokumentál elvi szinten a Kontextus szakaszban.

Súlyosbító körülmény, amit magam találtam: az index
(`docs/architecture/decisions/README.md`) jelenleg **"jelenleg szabad:
069"**-et állít, DE `ADR-069-canonical-task-message-store.md`,
`ADR-070-claim-lease-fencing-state-machine.md` és
`ADR-071-unified-authorization-policy.md` MÁR LÉTEZNEK a könyvtárban (az
ISL-szál termékei) — tehát a README index maga is ELAVULT/ellentmondó a
fájlrendszerrel, függetlenül attól, melyik ADR-068-at nézzük. Ez egy
második, önálló bizonyítéka ugyanannak a jelenségnek (egyetlen
megosztott index-fájlra két párhuzamos szál írt egymást nem ismerve).

**Értékelés a feladat instrukciója szerint:** ezt NEM az ADR-068 (DP-002)
tartalmi hibájaként pontozom — a számütközés procedurális/koordinációs
kérdés, amit a koordinátor renumberelt kell hogy feloldjon (pl. a
DP-002 ADR-je marad 068, az ISL-szál ADR-jei tolódnak 072-re, vagy
fordítva). Az ADR-068 (DP-002) TARTALMA ettől függetlenül érvényes és
önmagában konzisztens. Megjegyzem viszont: ez élő, azonnali bizonyíték
arra, hogy a program README 10. pontja ("egy friss kontextusú... reviewer
clean-room környezetből PASS eredménnyel újraellenőrzi") és maga az
ADR-068 (DP-002) állítása helyes és SÜRGŐS — a design-intent rétegben
(itt: markdown-fájlnév-névtér) is kellene valamilyen coordinated-write
kényszer (pl. egy `next-adr-number` lock-fájl vagy CI-kapu), amit az ADR
jelenleg NEM tárgyal explicit módon (a Nyitott kérdések listája nem
említi az ADR-számozás névterét, csak a runtime state-et).

### 5. `node scripts/check-doc-links.mjs` — lefuttatva, megerősítve

```
Ellenőrizve: 67 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
155 ADR-szám-említés (knowledge-service/src)
OK — minden hivatkozás létező célra mutat. (exit 0)
```

Pontosan egyezik a készítő állításával. PASS.

### 6. A README 12 kötelező "done előtt" pontja — tételes ellenőrzés

| # | Követelmény | Állapot a taskfájlban |
|---|---|---|
| 1 | Eredeti goal/siker/kilépés | MEGVAN (Implementáció 1. + futásindítás napló) |
| 2 | Tényleges eredmény, scope-eltérés | MEGVAN (2. pont) |
| 3 | Architekturális döntések, elvetett alternatívák | MEGVAN (3. pont + ADR "Alternatívák") |
| 4 | Módosított fájlok, migráció, adatkompatibilitás | MEGVAN (4. pont) |
| 5 | Base commit, branch, commit(ok), PR | MEGVAN, dokumentált ok a hiányra (nincs kódváltozás) |
| 6 | Futtatott parancsok, exit code, teszteredmény | MEGVAN a doc-link kapura; kódteszt hiánya indokolt (nincs kódváltozás) |
| 7 | OS/shell/Node/tool-verziók | MEGVAN (7. pont) |
| 8 | Negatív teszt, biztonsági ellenőrzés, rollback-próba | RÉSZBEN: a rollback-próbát a készítő NEM futtatta le ténylegesen, csak indokolta, miért triviális (nem destruktív változás) — elfogadható docs-only taskhoz, de szigorúan véve "próba" nem történt |
| 9 | Ismert korlátok, kockázatok, follow-up | MEGVAN (9. pont), és pontosan megnevezi a 8. adverzáriális pontot MA IS fennálló kockázatként |
| 10 | Reviewer azonosító, függetlenségi nyilatkozat, döntés | Szándékosan ÜRES a készítőnél — HELYESEN, ezt a szekciót tölti ki most ez a review |
| 11 | Elfogadási/kilépési feltételek PASS/FAIL | MEGVAN (11. pont) — de ez a készítő ÖNÉRTÉKELÉSE, nem független megerősítés; ld. az én 2. pontos találatom, ami ARRA UTAL, hogy a "PASS" minősítés a "goalStore/checkpointStore/Epic Router/taskfájl felelősségi határa explicit" feltételnél OPTIMISTA volt, mert a határ-kijelölés nem volt teljes |
| 12 | Task/EPICS/state/todo/memória/dokumentáció szinkron | MEGVAN (12. pont), helyesen `false`-ra állítva a nem-szinkronizált elemekhez |

A forma (mind a 12 pont jelen van) tehát megfelel; a TARTALMI hiányosság a
11. pontnál (a "goalStore, checkpointStore, Epic Router és taskfájl
felelősségi határa explicit" PASS-minősítés) nem tartható fenn
változatlanul a 2. pontban talált MCP write-útvonal miatt.

### Verdikt: **REQUEST_CHANGES**

**Indoklás.** Az ADR architekturális gerince (két réteg, design-intent
vs. tranzakciós runtime-state, EPICS.yaml megerősítve epic-szinten, DB
megerősítve ownership/dispatch-szinten) logikailag védhető, jól indokolt,
és a DEVPROC-02/03 kérdésekre érdemben válaszol. A 9 állított
kódbizonyíték mindegyike pontos. A doc-link kapu zöld. A 12 kötelező
pont formailag jelen van. Az adverzáriális szakasz szándéka és mélysége
(8 belépési pont, őszinte "MA nincs kikényszerítve" beismerés) jó
gyakorlat.

Ugyanakkor a task Kötelező ellenőrzése kifejezetten előírja, hogy a
reviewer próbálja megcáfolni az "egyetlen autoritatív forrás" állítást
minden írási belépési ponton — és ez a review egy MA ÉLŐ, hitelesített
MCP-tool-hívással (`update_epic` → `workflowManager.ts:updateEpicStatus`,
395–416. sor) elérhető, lock/CAS/validáció nélküli write-útvonalat talált
az `EPICS.yaml`-ra, amelyet az ADR Kontextus-, Adverzáriális review- és
Kapcsolódó kód-szakasza EGYIKE sem említ. Emellett egy szerkezetileg
azonos, ma teszt-only elérésű útvonalat is (`conductor/epicManager.ts:
completeEpic`, 99–130. sor). Mivel az ADR kilépési feltétele kifejezetten
"nyitott source-of-truth kérdés nélküli" implementálhatóságot ír elő a
DP-003/004 számára, egy dokumentálatlan, élő write-útvonal blokkoló
hiánynak minősül: ha a DP-003/004 implementáló szó szerint az ADR
Migráció/Kapcsolódó kód listáját követi, ez az útvonal életben marad a
"kivezetés" után is.

**Kért javítás a `done`-hoz:**

1. Egészítsd ki az ADR Kontextus szakaszát (jelenlegi 9 pont → legalább
   11) a `workflowManager.ts:updateEpicStatus` (MCP `update_epic` tool,
   élő) és a `conductor/epicManager.ts:completeEpic` (ma teszt-only)
   write-útvonalakkal.
2. Vedd fel mindkettőt a Migráció szakasz 3. pontjába ("Törékeny writer
   kivezetése") és a Kapcsolódó kód listába.
3. Vedd fel az Adverzáriális review táblázatba 9./10. sorként.
4. (Nem blokkoló javaslat) Jelezd a Nyitott kérdések közt az ADR-számozás
   névterének koordinálatlanságát is (ld. 4. pont fent) — ez ugyanaz a
   split-brain minta, amit az ADR tárgyal, csak a design-intent
   dokumentáció-rétegben, nem a runtime state-ben.

A frontmatter `status` marad `ready` (nem `done`) — a fenti pontok
javítása és egy második, akár ugyanezen reviewer általi gyors
átellenőrzés szükséges a `done` előtt.

**Nyitott kérdés a koordinátor felé:** az ADR-068 számütközés (ld. 4.
pont) feloldását (renumberelés) a koordinátornak kell elvégeznie a
DP-002 és a TASK-ISL-001 szál között; ez nem blokkolja a DP-002 tartalmi
elfogadását, de blokkolja a `docs/architecture/decisions/README.md`
index végleges, ellentmondásmentes állapotát.

## Kiegészítés a REQUEST_CHANGES nyomán (2026-07-18, 2. kör — készítő)

A készítő (nem a reviewer) végezte el a kért javításokat. A reviewer saját
szövegét (fentebb) NEM módosítottam — ez a szakasz különálló, hogy a
függetlenségi határ látható maradjon.

### Mit javítottam a "Kért javítás a `done`-hoz" 1–4. pontja szerint

1. **Kontextus kiegészítve 9→11 pontra** — új 10. és 11. tétel:
   `workflowManager.ts:updateEpicStatus` (395–416. sor, `update_epic` MCP
   tool mögött, `handleWorkflowTool` 644. sor, tool-definíció 559. sor,
   regisztráció-bizonyíték `mcpContract.integration.test.ts:157` és
   `workflowManagerFs.test.ts:430-448`) és `conductor/epicManager.ts:completeEpic`
   (99–133. sor, ma teszt-only). A 10. pontot explicit **legsürgősebbnek**
   jelöltem, mert ez az egyetlen a listán, amely ma, éles, hitelesített
   MCP-hívással is elérhető.
2. **Migráció szakasz 3. pontja kiegészítve** — mindkét új útvonal
   (`workflowManager.ts:updateEpicStatus`, `conductor/epicManager.ts:completeEpic`)
   felvéve a "Törékeny writer kivezetése" lépésbe, KIEMELT prioritással az
   `update_epic` MCP tool átkötésére.
3. **Adverzáriális review táblázat kiegészítve 9. és 10. sorral** a két új
   belépési ponttal, a 9. sor explicit jelezve mint a teljes táblázat
   legsürgősebb, legkonkrétabb tétele (megelőzi a korábbi 8. pontot is,
   mert közvetlenül a design-intent fájlt írja, nem csak egy cache-t).
4. **(Nem blokkoló, mégis elvégezve) Nyitott kérdések kiegészítve** egy
   tétellel az ADR-számozási névtér koordinálatlanságáról (a reviewer 4.
   pontja). Megjegyzés: a jelenlegi repo-állapot szerint (`ls
   docs/architecture/decisions/`) a tényleges ADR-068 fájlnév-ütközés,
   amit a reviewer talált, IDŐKÖZBEN megszűnt — a TASK-ISL-001 szál saját
   ADR-jeit 077–085 tartományba helyezte át, a README index ezt már
   tükrözi (`ADR-077`…`ADR-085`, "jelenleg szabad: 086"), és `node
   scripts/check-doc-links.mjs` zöld. A koordinációs kockázatot (mint
   tanulságot) emiatt is érdemes rögzítve hagyni a Nyitott kérdésekben.

Emellett a Döntés-táblázat "Epic ÁLLAPOT" sorát és a Kapcsolódó kód / Bizonyíték
szakaszokat is kiegészítettem a két új fájlra és a rájuk vonatkozó
sorhivatkozásokra, hogy az ADR belsőleg konzisztens maradjon (ne csak a
Kontextusban jelenjenek meg az új útvonalak).

### Ellenőrzés

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 85 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat." (exit 0)
```

A két új idézett kódrészlet (`workflowManager.ts` 392–416, 559, 638–650. sor;
`conductor/epicManager.ts` 84–133. sor) és a két tesztfájl-hivatkozás
(`mcpContract.integration.test.ts:157`, `workflowManagerFs.test.ts:430-448`)
saját olvasással verifikálva ebben a körben (nem a reviewer állítását vettem
át ellenőrzés nélkül).

### Az 11. pont (Implementáció "Elfogadási és kilépési feltételek — PASS/FAIL")
### korrekciója

A reviewer helyesen jelezte, hogy a fenti táblázat "A goalStore,
checkpointStore, Epic Router és taskfájl felelősségi határa explicit" PASS
minősítése a hiányzó 2 write-útvonal miatt optimista volt. Ezt a
kiegészítés utáni állapotra nézve tartom fenn PASS-nak (a határ MOST már a
mind az 5 fájl-írót és a köztük lévő prioritási sorrendet — melyik marad,
melyik szűnik meg, melyik a legsürgősebb — explicit módon rögzíti), de ezt
NEM én, a készítő, hanem a következő független review-kör dönti el
véglegesen.

### Frontmatter és következő lépés

A frontmatter `status` **marad `ready`** (nem `done`) — a készítő nem
zárhatja saját taskját. A koordinátor egy új (vagy ugyanazon) független
reviewer-kört indít a végső PASS/FAIL döntésre.

## Független review, 2. kör (2026-07-18)

**Függetlenségi nyilatkozat.** Ez a review egy külön agent-futás, amely sem
az eredeti ADR/taskfájl megírásában, sem az 1. körös reviewban, sem a
"Kiegészítés a REQUEST_CHANGES nyomán" szakasz megírásában nem vett részt.
A készítő és az 1. körös reviewer egyetlen állítását sem fogadtam el
bizonyítékként — minden alábbi tényt saját maga olvasott forrásfájlból,
sorhivatkozással igazoltam, és a "Kötelező ellenőrzés" utasítás szerint
önállóan is kerestem olyan write-útvonalat, amit sem az 1. kör, sem a
készítő nem talált meg.

### 1. Az 1. kör két hiányosságának tételes újraellenőrzése

**a) `workflowManager.ts:updateEpicStatus` (`update_epic` MCP tool).**
Önállóan elolvastam a `knowledge-service/src/workflowManager.ts` 395–416.
sorát: a függvény pontosan a leírt `parseYamlFile` → `epic.status = status`
mutáció → `yaml.dump({ lineWidth: -1 })` → `fs.writeFileSync` mintát
követi, lock/CAS/validáció nélkül — szó szerint egyezik az ADR és a
taskfájl idézetével. Az MCP-bekötést is önállóan igazoltam:
`grep update_epic` a `src`-ben pontosan a taskfájl által állított
sorokat adja vissza — tool-definíció `workflowManager.ts:559`,
`handleWorkflowTool` switch-ág `case 'update_epic':` a 644. sorban,
kontraktteszt-bizonyíték `__tests__/integration/mcpContract.integration.test.ts:157`.
Továbbmenve az 1. körnél: elolvastam a
`knowledge-service/src/interfaces/mcp/tools/workflow.tools.ts` teljes
fájlját és az `index.ts`-t is — ez a QC-008 utáni registry-only `mcp.ts`
adapter-rétege, amely a `WORKFLOW_TOOLS` definíciókat ténylegesen
regisztrálja a `toolRegistry`-be (`registerWorkflowTools()`, hívva az
`interfaces/mcp/tools/index.ts:35`-ben), tehát az `update_epic` tool nem
csak létezik a switch-ben, hanem VALÓBAN be van kötve az éles MCP
tool-listába. **Az ADR-be (Kontextus 10. pont, Döntés-táblázat "Epic
ÁLLAPOT" sor, Migráció 3. pont KIEMELT PRIORITÁSSAL, Adverzáriális
táblázat 9. sor, Kapcsolódó kód, Bizonyíték) tételesen, a másik 10 ponttal
azonos mélységben felvéve — MEGERŐSÍTVE, ugyanazon sorhivatkozásokkal,
amiket magam is ellenőriztem.**

**b) `conductor/epicManager.ts:completeEpic`.** Önállóan elolvastam a
`knowledge-service/src/conductor/epicManager.ts` 99–133. sorát: a
függvény `fs.readFileSync` → `yaml.load` → `epic.status = 'done'` mutáció
→ `yaml.dump` → `fs.writeFileSync` — pontosan egyezik az ADR idézetével.
Kerestem route- vagy MCP-bekötést (`grep completeEpic` a teljes
`src`-ben) — nem találtam production-hívót, csak
`src/__tests__/unit/conductorModules.test.ts`-t, ami megegyezik az ADR
"ma csak tesztből hívott" állításával. **Felvéve az ADR-be (Kontextus 11.
pont, Döntés-táblázat, Migráció 3. pont, Adverzáriális táblázat 10. sor,
Kapcsolódó kód) — MEGERŐSÍTVE.**

Mindkét pótlás nem felszínes: konkrét sorszámmal, idézett kóddal,
tesztbizonyítékkal és a Migráció/Adverzáriális szakaszba való tényleges
integrációval történt, nem csak egy felsorolás-sorral.

### 2. Saját, önálló keresés — ÚJ, HARMADIK write-útvonal, amit sem az 1. kör, sem a készítő nem talált meg

A task-instrukció kifejezetten kérte, hogy nézzek körül más
write-útvonalakon is. `grep -r "writeFileSync\|yaml.dump" knowledge-service/src`
alapján 18 találatból egyet sem az ADR, sem a korábbi két kör nem
azonosított:

**`knowledge-service/src/pipeline/epicNotifications.ts`** —
`saveEpics()` (395–408. sor: `yaml.dump(data, {...})` →
`fs.writeFileSync(EPICS_PATH, yamlContent, 'utf-8')`) és az azt hívó
`completeCheckpoint()` (414–462. sor), amely **mind a checkpoint
státuszt (442. sor: `checkpoint.status = 'done'`), mind — ha minden
checkpoint kész — az EPIC STÁTUSZT (448. sor: `epic.status = 'done'`)**
közvetlenül, a teljes fájl read-modify-write mintájával írja, lock/CAS/
validáció és a `graph/epicsLoader.ts:writeEpicsYaml` séma-/DAG-validációja
NÉLKÜL — szerkezetileg azonos hibaosztály, mint az ADR 1., 10. és 11.
pontja.

**Ez nem csak egy újabb "élő de inaktív" tesztkód** — igazoltam, hogy
production-aktív, automatikus, eseményvezérelt write-útvonal:

- `completeCheckpoint()` az `attachEpicNotifications()` (336. sor)
  `pipelineEvents.onAny(...)` eseménykezelőjéből hívódik a
  `case 'outbox:done':` ágon (346–365. sor), ha az esemény payloadja
  `epicId`+`checkpointId`-t tartalmaz.
- `attachEpicNotifications()` FELTÉTEL NÉLKÜL meghívódik a szolgáltatás
  indulásakor: `knowledge-service/src/bootstrap/startup.ts:385`
  (`attachEpicNotifications();`), más, ugyanabban a függvényben lévő
  feature-ökkel ellentétben (pl. `ENABLE_MULTI_BOT`, `ENABLE_ROOT_MONITOR`)
  ez NINCS env-flag mögé zárva.
- Az `outbox:done` eseményt `epicId` mezővel ténylegesen emittálja a
  `knowledge-service/src/pipeline/epicRouter.ts:513-515` (MCP
  `mcp_complete_task` forrásból, `source: 'mcp_complete_task'`) ÉS az
  `inboxWatcher.ts:290` (fájlfigyelőből) is — tehát ez a write-útvonal ma,
  ezen ADR elfogadása előtt is, két különböző éles triggerből (MCP
  task-completion ÉS fájlrendszeri outbox-figyelés) aktiválható, teljesen
  automatikusan, bármely terminál/agent explicit "írjunk EPICS.yaml-t"
  szándéka NÉLKÜL — pusztán azáltal, hogy egy outbox-üzenet frontmatterje
  `epicId`+`checkpointId` mezőt tartalmaz.
- Ironikus, súlyosbító bizonyíték: az `epicRouter.ts:511-512` sor saját
  kommentje szerint *"ADR-053: Emit outbox:done event for subscription
  triggers — This is the DB-authoritative event, not file-based"* — de
  pontosan ez az esemény vált ki egy KÖZVETLEN FÁJL-írást
  (`epicNotifications.ts:saveEpics`), ami saját magának a kommentnek is
  ellentmond, ugyanabban a split-brain mintában, amit az ADR máshol
  (4–5. pont) már dokumentál egy másik fájlpárra.

**Miért blokkoló, nem kozmetikai:** ez a harmadik, önállóan talált
write-útvonal (i) ÉLŐ ÉS AUTOMATIKUS (nem igényel explicit tool-hívást,
csak egy mailbox-üzenet meghatározott mezőit), (ii) EGYSZERRE írja a
checkpoint- ÉS az epic-státuszt egyetlen teljes-fájl-dump művelettel,
(iii) az ADR egyetlen szakaszában (Kontextus, Döntés-táblázat,
Adverzáriális táblázat, Kapcsolódó kód, Migráció) sincs megnevezve. Ha a
DP-003/004 implementáló szó szerint az ADR jelenlegi Migráció 3. pontját
követi (amely csak a `checkpointTracker.ts`/`epicRouter.ts`/
`workflowManager.ts`/`epicManager.ts` négyesét sorolja fel), ez az ötödik
writer változatlanul életben marad a kivezetés UTÁN is — pontosan az a
forgatókönyv, amit a task Kilépési feltétele ("implementálható nyitott
source-of-truth kérdés nélkül") kizárni kíván.

### 3. `node scripts/check-doc-links.mjs` — újrafuttatva, megerősítve

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 85 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat." (exit 0)
```

Egyezik a készítő 2. körös állításával. PASS.

### 4. Verdikt: **REQUEST_CHANGES**

**Indoklás.** Az 1. kör mindkét hiányosságát (`workflowManager.ts:
updateEpicStatus` az `update_epic` MCP tool mögött, és
`conductor/epicManager.ts:completeEpic`) a készítő ténylegesen, a másik
10 ponttal azonos mélységben (Kontextus, Döntés-táblázat, Migráció,
Adverzáriális táblázat, Kapcsolódó kód, Bizonyíték — mindenhol
konzisztensen) pótolta; ezt magam, függetlenül, sorhivatkozásig
visszaellenőriztem — nem felszínes toldás. A doc-link kapu zöld.

Ugyanakkor a task Kötelező ellenőrzése ("keress ÚJ, harmadik
hiányosságot is") és a program README 10. pontja szerinti clean-room
újraellenőrzés kifejezetten ezt kéri számon — és találtam egy HARMADIK,
önálló, élő, automatikus (eseményvezérelt, nem csak MCP-tool-hívással
elérhető) write-útvonalat az `EPICS.yaml`-ra
(`pipeline/epicNotifications.ts:saveEpics`/`completeCheckpoint`, 336–462.
sor), amelyet sem az 1. kör reviewja, sem a készítő 2. körös kiegészítése
nem nevez meg egyetlen ADR-szakaszban sem. Ez pontosan olyan súlyú
blokkoló hiány, mint amiért az 1. kör REQUEST_CHANGES-t adott: egy
dokumentálatlan, ma élő write-útvonal, amely a DP-003/004 implementáció
után is életben maradna, ha az implementáló szó szerint az ADR jelenlegi
(4 writer) listáját követné.

**Kért javítás a `done`-hoz (3. kör):**

1. Vedd fel a Kontextus szakaszba 12. pontként a
   `pipeline/epicNotifications.ts:saveEpics`/`completeCheckpoint`
   write-útvonalat, a fenti sorhivatkozásokkal (336, 346–365, 395–408,
   414–462. sor) és a két élő trigger-forrással
   (`epicRouter.ts:513-515` MCP-oldalról, `inboxWatcher.ts:290`
   fájlfigyelő-oldalról, `bootstrap/startup.ts:385` feltétel nélküli
   csatlakoztatás).
2. Vedd fel a Döntés-táblázat "Epic ÁLLAPOT" és "Checkpoint/cornerstone
   TELJESÍTÉS" sorába negyedik/ötödik writerként.
3. Vedd fel a Migráció szakasz 3. pontjába ("Törékeny writer kivezetése")
   — mérlegelve, hogy ez esemény-vezérelt jellege miatt esetleg MÉG
   sürgősebb, mint az `update_epic` MCP tool, mert explicit hívás nélkül,
   automatikusan aktiválódik.
4. Vedd fel az Adverzáriális review táblázatba 11. sorként.
5. (Nem blokkoló megjegyzés) Az `epicRouter.ts:511-512` "DB-authoritative,
   not file-based" kommentje és a ténylegesen kiváltott fájl-write közötti
   ellentmondás önmagában is egy hetedik konkrét doc-vs-kód
   ellentmondás-példa (a meglévő 4–5. pont mintájára) — érdemes explicit
   megemlíteni a Kontextusban.

A frontmatter `status` **marad `ready`** (nem `done`) — a fenti pontok
pótlása és egy 4. kör (akár ugyanezen vagy más független reviewer által)
szükséges a `done` előtt.

**Nyitott kérdés a koordinátor felé:** ha a program időkerete szűkös,
érdemes megfontolni, hogy a jövőben minden ADR-2.-kör review előtt fusson
le egy egyszerű, gépi `grep -rn "writeFileSync\|yaml.dump" knowledge-service/src`
leltár és annak kereszthivatkozása az ADR Kapcsolódó kód listájával — ez a
review most kézzel végezte el ugyanezt, de egy checklist-tétel csökkentené
annak esélyét, hogy egy negyedik kör is új writer-t találjon.

## Kimerítő leltár és az ADR kiegészítése (2026-07-18, 3. kör — készítő)

A koordinátor a 2. körös REQUEST_CHANGES nyomán KIFEJEZETTEN úgy
utasított, hogy ne pontonként (drip-feed) pótoljak, hanem végezzek EGY
mechanikus, kimerítő leltárt a fennmaradó writer-kockázatokra. Ez a
szakasz a leltár teljes, nyers kimenetét és minden találat sorsát rögzíti.

### Futtatott parancsok, teljes nyers kimenet

```
$ rg -n "writeFileSync|yaml\.dump|fs\.writeFile\b" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'
knowledge-service/src\workflowManager.ts:242:      fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
knowledge-service/src\workflowManager.ts:244:      fs.writeFileSync(stateFile, step);
knowledge-service/src\workflowManager.ts:364:    fs.writeFileSync(filepath, content);
knowledge-service/src\workflowManager.ts:408:    const yamlContent = yaml.dump(content, { lineWidth: -1 });
knowledge-service/src\workflowManager.ts:409:    fs.writeFileSync(EPICS_FILE, yamlContent);
knowledge-service/src\contextPersistence.ts:191:  await fs.writeFile(statusPath, content, 'utf-8');
knowledge-service/src\contextPersistence.ts:261:  await fs.writeFile(statePath, JSON.stringify(newState, null, 2), 'utf-8');
knowledge-service/src\contextPersistence.ts:312:  await fs.writeFile(turnPath, String(newCount), 'utf-8');
knowledge-service/src\contextPersistence.ts:335:  await fs.writeFile(turnPath, '0', 'utf-8');
knowledge-service/src\contextPersistence.ts:469:  await fs.writeFile(checkpointsPath, content, 'utf-8');
knowledge-service/src\identity.ts:156:  await fs.writeFile(memoryPath, content, 'utf-8');
knowledge-service/src\identity.ts:187:  await fs.writeFile(memoryPath, newContent, 'utf-8');
knowledge-service/src\api\planningRoutes.ts:275:  await fs.writeFile(tempPath, newContent, 'utf-8');
knowledge-service/src\codegen\patternScaffold.ts:338:      await fs.writeFile(fullPath, content, 'utf-8');
knowledge-service/src\eval\goldenPath.ts:94:  fs.writeFileSync(file, JSON.stringify(golden, null, 2), 'utf-8');
knowledge-service/src\eval\goldenPath.ts:153:    fs.writeFileSync(fileFor(item.name), JSON.stringify(golden, null, 2), 'utf-8');
knowledge-service/src\conductor\contextSaturation.ts:47:    fs.writeFileSync(TURN_COUNT_FILE, String(newCount), 'utf-8');
knowledge-service/src\interfaces\mcp\tools\session.tools.ts:103:        await fs.writeFile(path.join(inboxPath, filename), requestContent, 'utf-8');
knowledge-service/src\conductor\sessionState.ts:77:    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
knowledge-service/src\interfaces\http\routes\epic-router.routes.ts:627:        await fs.writeFile(filePath, newContent, 'utf-8');
knowledge-service/src\interfaces\http\routes\epic-router.routes.ts:770:      await fs.writeFile(filePath, updated);
knowledge-service/src\conductor\checkpointTracker.ts:183:    const yamlContent = yaml.dump(data, { lineWidth: -1 });
knowledge-service/src\conductor\checkpointTracker.ts:184:    fs.writeFileSync(EPICS_PATH, yamlContent, 'utf-8');
knowledge-service/src\graph\epicsLoader.ts:213:    const yamlContent = yaml.dump(data, {
knowledge-service/src\graph\epicsLoader.ts:220:    await fs.writeFile(tempPath, yamlContent, 'utf-8');
knowledge-service/src\task-message-box\store.ts:336:  await fs.writeFile(filePath, fileContent, 'utf-8');
knowledge-service/src\handoff.ts:104:    await fs.writeFile(filePath, markdown, 'utf-8');
knowledge-service/src\conductor\conductorBriefing.ts:399:  await fs.writeFile(filepath, fullContent, 'utf-8');
knowledge-service/src\goalStore.ts:156:  await fs.writeFile(filepath, yaml.dump(goal), 'utf-8');
knowledge-service/src\goalStore.ts:216:  await fs.writeFile(filepath, yaml.dump(goal), 'utf-8');
knowledge-service/src\conductor\epicManager.ts:124:    const yamlContent = yaml.dump(data, { lineWidth: -1 });
knowledge-service/src\conductor\epicManager.ts:125:    fs.writeFileSync(EPICS_PATH, yamlContent, 'utf-8');
knowledge-service/src\messageRegistry.ts:345:    await fs.writeFile(filePath, newContent, 'utf-8');
knowledge-service/src\projectTools.ts:73:    await fs.writeFile(`${projectDir}/PROJECT.md`, projectMd);
knowledge-service/src\projectTools.ts:96:    await fs.writeFile(`${projectDir}/TASKS.yaml`, yaml.dump(tasksYaml));
knowledge-service/src\projectTools.ts:114:    await fs.writeFile(`${projectDir}/STATUS.md`, statusMd);
knowledge-service/src\retrospective.ts:373:  await fs.writeFile(`${skillDir}/SKILL.md`, skillContent, 'utf-8');
knowledge-service/src\memoryTools.ts:330:    fs.writeFileSync(archivePath, originalContent, 'utf-8');
knowledge-service/src\memoryTools.ts:333:    fs.writeFileSync(filePath, compressedContent, 'utf-8');
knowledge-service/src\mailbox.ts:347:    await fs.writeFile(filePath, fileContent, 'utf-8');
knowledge-service/src\mailbox.ts:417:  await fs.writeFile(filePath, fileContent, 'utf-8');
knowledge-service/src\mailbox.ts:498:  await fs.writeFile(filePath, fileContent, 'utf-8');
knowledge-service/src\mailbox.ts:635:        await fs.writeFile(filePath, newContent, 'utf-8');
knowledge-service/src\mailbox.ts:677:          await fs.writeFile(filePath, processedRaw.includes('processed:') ? processedRaw : newRaw.replace(/---\n/, `---\nprocessed: ${formatDate()}\n`), 'utf-8');
knowledge-service/src\mailbox.ts:785:    await fs.writeFile(inboxFilePath, updatedInbox, 'utf-8');
knowledge-service/src\mailbox.ts:840:    await fs.writeFile(outboxFilePath, outboxContent, 'utf-8');
knowledge-service/src\mailbox.ts:884:        await fs.writeFile(filePath, newRaw, 'utf-8');
knowledge-service/src\generators\generateInbox.ts:74:    await fs.writeFile(filePath, content, 'utf-8');
knowledge-service/src\generators\componentScaffold.ts:9:import { writeFileSync, mkdirSync, existsSync } from 'fs';
knowledge-service/src\generators\componentScaffold.ts:81:    writeFileSync(hookFile, hookCode);
knowledge-service/src\generators\componentScaffold.ts:83:    writeFileSync(testFile, testCode);
knowledge-service/src\generators\componentScaffold.ts:147:    writeFileSync(componentFile, componentCode);
knowledge-service/src\generators\componentScaffold.ts:148:    writeFileSync(moduleFile, cssCode);
knowledge-service/src\generators\componentScaffold.ts:150:    writeFileSync(testFile, testCode);
knowledge-service/src\generators\componentScaffold.ts:199:    writeFileSync(clientFile, clientCode);
knowledge-service/src\generators\generateModule.ts:515:  await fs.writeFile(file.path, file.content, 'utf-8');
knowledge-service/src\task-audit\dailyReport.ts:180:  await fs.writeFile(filepath, content, 'utf-8');
knowledge-service/src\generators\generateEndpoint.ts:356:          await fs.writeFile(file.path, lines.join('\n'));
knowledge-service/src\generators\generateEndpoint.ts:365:      await fs.writeFile(file.path, file.content, 'utf-8');
knowledge-service/src\generators\generateEndpoint.ts:376:  await fs.writeFile(file.path, file.content, 'utf-8');
knowledge-service/src\pipeline\alertRules.ts:55:  await fs.writeFile(ALERT_STATE_FILE, JSON.stringify(state, null, 2));
knowledge-service/src\task-audit\taskCreation.ts:183:  await fs.writeFile(inboxPath, content, 'utf-8');
knowledge-service/src\pipeline\common.ts:294:    await fs.writeFile(STATE_FILE, content);
knowledge-service/src\pipeline\common.ts:304:    await fs.writeFile(STATE_FILE, newContent);
knowledge-service/src\pipeline\cronLibrarian.ts:135:  await fs.writeFile(filePath, content);
knowledge-service/src\runner\processedStore.ts:52:      fs.writeFileSync(tmp, json, 'utf-8');
knowledge-service/src\runner\processedStore.ts:58:        fs.writeFileSync(this.filePath, json, 'utf-8');
knowledge-service/src\pipeline\epicNotifications.ts:397:    const yamlContent = yaml.dump(data, {
knowledge-service/src\pipeline\epicNotifications.ts:401:    fs.writeFileSync(EPICS_PATH, yamlContent, 'utf-8');
knowledge-service/src\pipeline\epicRouter.ts:581:      fs.writeFileSync(epicsPath, updatedLines.join('\n'), 'utf-8');
knowledge-service/src\pipeline\ideaScan.ts:388:      await fs.writeFile(filepath, idea.content, 'utf-8');
knowledge-service/src\pipeline\messageRouter.ts:180:    await fs.writeFile(join(inboxDir, filename), content, 'utf-8');
knowledge-service/src\pipeline\missionControl.ts:388:  await fs.writeFile(path.join(targetDir, filename), content);
knowledge-service/src\pipeline\pendingRetries.ts:96:  await fs.writeFile(QUEUE_PATH, JSON.stringify(entries, null, 2));
knowledge-service/src\pipeline\phaseCoordinator.ts:275:    await fs.writeFile(filepath, content, 'utf-8');
knowledge-service/src\pipeline\pipeline.ts:41:    await fs.writeFile(donePath, updatedContent);
knowledge-service/src\pipeline\pipeline.ts:65:          await fs.writeFile(filePath, updated);
knowledge-service/src\pipeline\planDebate.ts:133:  await fs.writeFile(planA, contentA);
knowledge-service/src\pipeline\planDebate.ts:134:  await fs.writeFile(planB, contentB);
knowledge-service/src\pipeline\planDebate.ts:180:  await fs.writeFile(reviewA, contentA);
knowledge-service/src\pipeline\planDebate.ts:181:  await fs.writeFile(reviewB, contentB);
knowledge-service/src\pipeline\planDebate.ts:218:  await fs.writeFile(consensusFile, content);
knowledge-service/src\pipeline\planDebate.ts:336:  await fs.writeFile(filePath, content);
knowledge-service/src\pipeline\planScan.ts:276:      await fs.writeFile(filePath, idea.content);
knowledge-service/src\pipeline\planSelect.ts:238:    await fs.writeFile(pendingPath, pendingContent);
knowledge-service/src\pipeline\processLock.ts:74:  await fs.writeFile(lockPath, JSON.stringify(info, null, 2), { mode: 0o644 });
knowledge-service/src\pipeline\immediatePipeline.ts:127:  await fs.writeFile(filePath, content);
knowledge-service/src\pipeline\projectDispatcher.ts:298:        await fs.writeFile(tasksPath, yaml.dump(tasks));
knowledge-service/src\pipeline\projectDispatcher.ts:505:    await fs.writeFile(tasksPath, yaml.dump(tasks));
knowledge-service/src\pipeline\projectDispatcher.ts:596:    await fs.writeFile(filePath, content, 'utf-8');
knowledge-service/src\pipeline\projectDispatcher.ts:669:    await fs.writeFile(tasksPath, yaml.dump(tasks));
knowledge-service/src\pipeline\planConfig.ts:190:  await fs.writeFile(statePath, content);
knowledge-service/src\pipeline\reviewer.ts:371:  await fs.writeFile(
knowledge-service/src\pipeline\reviewer.ts:375:  await fs.writeFile(
knowledge-service/src\pipeline\reviewer.ts:539:  await fs.writeFile(escalationPath, content);
knowledge-service/src\pipeline\reviewer.ts:636:  await fs.writeFile(filePath, content);
knowledge-service/src\pipeline\reviewer.ts:896:          await fs.writeFile(rejectPath, rejectContent);
knowledge-service/src\pipeline\reviewer.ts:1029:  await fs.writeFile(filePath, content);
knowledge-service/src\pipeline\pipelineDocs.ts:170:    await fs.writeFile(readmePath, updates.readmeUpdates);
knowledge-service/src\pipeline\pipelineDocs.ts:181:    await fs.writeFile(statusPath, lines.join('\n'));
knowledge-service/src\pipeline\pipelineDocs.ts:196:    await fs.writeFile(nextFilePath, updates.nextInbox.content);
knowledge-service/src\pipeline\skillFactory.ts:90:  const frontmatter = yaml.dump(metadata, { lineWidth: -1 });
knowledge-service/src\pipeline\skillFactory.ts:148:    await fs.writeFile(skillFile, skillContent, 'utf-8');
knowledge-service/src\pipeline\sessionContextTransfer.ts:44:    await fs.writeFile(filePath, content, 'utf-8');
knowledge-service/src\pipeline\statusUpdater.ts:36:  await fs.writeFile(statusPath, statusMd, 'utf-8');
knowledge-service/src\pipeline\statusUpdater.ts:410:        await fs.writeFile(statusPath, content, 'utf-8');
knowledge-service/src\pipeline\statusUpdater.ts:435:    await fs.writeFile(statusPath, content, 'utf-8');
knowledge-service/src\pipeline\taskEscalation.ts:339:    await fs.writeFile(inboxPath, escalationContent, 'utf-8');
knowledge-service/src\pipeline\telegramBot.ts:629:      await fs.writeFile(path.join(inboxDir, filename), content);
knowledge-service/src\pipeline\terminalReviewer.ts:708:  await fs.writeFile(filePath, content);
knowledge-service/src\pipeline\terminalReviewer.ts:1012:    await fs.writeFile(filePath, content, 'utf-8');
knowledge-service/src\pipeline\watchMonitor.ts:59:    await fs.writeFile(CYCLE_STATE_FILE, String(count), 'utf-8');
knowledge-service/src\pipeline\watchMonitor.ts:189:        await fs.writeFile(filepath, updatedContent, 'utf-8');
knowledge-service/src\pipeline\watchMonitor.ts:473:  await fs.writeFile(filepath, content, 'utf-8');

(114 sor)
```

```
$ rg -n "fs\.appendFile\b|appendFileSync\b" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'
knowledge-service/src\goalStore.ts:107:    await fs.appendFile(GOALS_LOG, line);
knowledge-service/src\generators\generateEndpoint.ts:362:      await fs.appendFile(file.path, '\n' + marker + '\n' + file.content);
knowledge-service/src\pipeline\common.ts:317:    await fs.appendFile(logFile, `${timestamp} ${message}\n`);
knowledge-service/src\sessionStarter.ts:381:      await fs.appendFile(memoryPath, memoryEntry, 'utf-8');
knowledge-service/src\sessionManager.ts:96:    fs.appendFileSync(logFile, JSON.stringify(action) + '\n');
knowledge-service/src\task-audit\taskCreation.ts:117:  await fs.appendFile(CREATION_LOG_PATH, line, 'utf-8');
knowledge-service/src\pipeline\reviewLog.ts:42:  await fs.appendFile(REVIEW_LOG_PATH, line, 'utf-8');
knowledge-service/src\pipeline\terminalReviewer.ts:630:    await fs.appendFile(architectMemoryPath, architectEntry);
knowledge-service/src\pipeline\terminalReviewer.ts:646:    await fs.appendFile(librarianLogPath, librarianEntry);
knowledge-service/src\pipeline\terminalReviewer.ts:947:    await fs.appendFile(logFile, logLine, 'utf-8');
knowledge-service/src\pipeline\workSessionLog.ts:100:  await fs.appendFile(logPath, line, 'utf-8');
knowledge-service/src\pipeline\workSessionLog.ts:121:  await fs.appendFile(logPath, line, 'utf-8');

(12 sor)
```

**Módszertani önkorrekció:** első átfutáskor vizuálisan "97"-nek saccoltam
a találatok számát (ezt a hibás számot tévesen bele is írtam először az
ADR-be) — a `wc -l` alapú tényleges újraszámlálás **114**-et adott. Ezt
az ADR-ben mindenhol javítottam 114-re. Ez maga is egy tanulság: a
"kimerítő leltár" állítást a legszigorúbb, géppel számolt módon kell
igazolni, nem vizuális becsléssel — pontosan az az elv, amit ez az egész
ADR más adatosztályokra előír.

### Melyik találatot vettem fel az ADR-be, és melyiket vetettem el (miért)

**Felvett, teljes mélységben tárgyalt (Kontextus 12–14. pont, Döntés-tábla,
Migráció, Adverzáriális tábla, Kapcsolódó kód, Bizonyíték):**

1. `pipeline/epicNotifications.ts:395-408,414-462` — a koordinátor által
   megnevezett, MOST MÁR a teljes ADR legsúlyosabbnak minősített találata
   (automatikus/eseményvezérelt, feltétel nélküli bootstrap-bekötés,
   `(epic as any).completed_date` sémán kívüli mező, kettős write-race az
   `epicRouter.ts` regex-writerrel, önellentmondó "DB-authoritative"
   komment).
2. `pipeline/projectDispatcher.ts` + `projectTools.ts:handleCreateProject`
   + `pipeline/statusUpdater.ts` — HARMADIK, teljesen önálló milestone/
   task-tracker (`<project>/TASKS.yaml`, `TaskChain` séma), UGYANABBAN a
   könyvtárban, mint `EPICS.yaml`; ma dormant adatban, de MCP-exponált
   (`create_project`/`dispatch_next`/`list_blocked`). Ez a legnagyobb,
   eddig teljesen fel nem ismert strukturális lelet — külön "Nyitott
   kérdés (KRITIKUS)" bejegyzést is kapott.
3. `pipeline/reviewLog.ts` (+ fogyasztói: `pipeline/reviewer.ts`,
   `pipeline/terminalReviewer.ts`) — MÁR LÉTEZŐ, immutable JSONL
   review-decision log; ezt az ELSŐ (writeFile-alapú) parancs NEM fogta
   volna meg (`appendFile`-t használ) — a második, kiegészítő grep hozta
   fel. Ez MÓDOSÍTOTTA (nem csak kiegészítette) a Döntés-táblázat
   "Review-döntés" sorának korábbi, pontatlan "nincs dedikált store"
   állítását.

**Felvett, rövidebb (de valós) kiegészítő megfigyelésként (Kontextus
15–18. pont):**

4. `identity.ts:writeMemory/appendMemory` (156, 187. sor) +
   `sessionStarter.ts:381` + `pipeline/terminalReviewer.ts:620-630` —
   HÁROM programozott `MEMORY.md`-író; korrigálta a Döntés-táblázat
   "MEMORY.md" sorának "Kézzel írt" leírását pontatlanságra.
5. `contextPersistence.ts:447-469` (`checkpointsPath`) — egy ÖTÖDIK,
   különálló "checkpoint" jelentés (stratégiai döntési napló), nem
   versengő state-writer, de terminológiai kockázat.
6. `pipeline/subscriptionManager.ts:parseCheckpointsFromEpics` — hetedik
   `EPICS.yaml`-OLVASÓ (nem writer).
7. `pipeline/watchMonitor.ts` (`epic.checkpoints` olvasás
   health-check-hez) — megerősíti az 1. pontban már jelzett "dead schema
   mező" tényt egy újabb, független fogyasztóval.

**Elvetett (ellenőrizve, NEM DP-002-releváns, mert nem `EPICS.yaml`, nem
checkpoint, nem task-frontmatter, nem review-döntés, nem `MEMORY.md`
adatot ír):**

- `workflowManager.ts:242,244,364` (`stateFile`) — a WORKFLOW-domén
  (ADR-041) saját, `workflowId`-kulcsú végrehajtási állapota; más
  adatosztály, nem `EPICS_FILE` (azt a 408-409. sor kezeli, MÁR felvéve).
- `contextPersistence.ts:191,261,312,335` — session/turn-szintű állapot
  (context saturation), nem program-szintű.
- `api/planningRoutes.ts`, `codegen/patternScaffold.ts`,
  `generators/*` (componentScaffold, generateEndpoint, generateInbox,
  generateModule) — generált kódfájlok/scaffolding kimenetek, nem
  állapotadat.
- `eval/goldenPath.ts` — eval-korpusz (golden path), nem program-állapot.
- `conductor/contextSaturation.ts`, `conductor/sessionState.ts` —
  session-szintű futásidejű állapot, nem EPICS/task.
- `interfaces/mcp/tools/session.tools.ts:103` — mailbox inbox-üzenet
  írása (request), nem EPICS.
- `interfaces/http/routes/epic-router.routes.ts:627,770` — ellenőrizve:
  mailbox-fájl írás, nem `EPICS.yaml` (a fájl `/sync`-útvonala már
  külön, 4. pontként felvéve).
- `task-message-box/store.ts`, `mailbox.ts` (összes sor), `handoff.ts`,
  `conductorBriefing.ts`, `messageRegistry.ts`,
  `task-audit/taskCreation.ts,dailyReport.ts`, `session.tools.ts`,
  `pipeline/telegramBot.ts`, `pipeline/messageRouter.ts` — mailbox/
  üzenet/session-dokumentum család, ADR-066 hatásköre, már tárgyalva
  (Kontextus 7. pont) mint külön adatosztály.
- `retrospective.ts` — SKILL.md generálás, nem EPICS.
- `memoryTools.ts:330,333` — `compress_memory` tool, MEMORY.md
  tömörítés/archiválás; ELLENŐRIZVE, hogy ez a tartalom-KEZELÉS
  (archiválás+tömörítés), nem tranzakciós taskállapot-írás — a Döntés-
  táblázat "MEMORY.md" sorának javított szövege ("HÁROM programozott
  író") erre direkt NEM tér ki, mert ez inkább karbantartó, mint
  státusz-író funkció; ha a reviewer ezt vitatja, felvehető negyedikként.
- `pipeline/alertRules.ts`, `pipeline/common.ts:STATE_FILE/logFile`,
  `pipeline/cronLibrarian.ts` — nightwatch/riasztás belső állapota, nem
  EPICS.
- `runner/processedStore.ts`, `pipeline/pendingRetries.ts` — lokális
  runner/retry-sor dedup-állapota, más futásidejű koncepció (más
  program: NEXUS-ISLAND-RUNTIME hatásköre, nem DP-002).
- `pipeline/ideaScan.ts,planScan.ts,planSelect.ts,planDebate.ts,
  planConfig.ts,immediatePipeline.ts,skillFactory.ts` — ötlet-/terv-
  pipeline dokumentumok, nem program/epic/task állapot.
- `pipeline/missionControl.ts` — agent-delegálás célkönyvtárba, nem
  EPICS.
- `pipeline/pipeline.ts,pipelineDocs.ts,sessionContextTransfer.ts,
  taskEscalation.ts,phaseCoordinator.ts` — mailbox/pipeline-dokumentum
  írás, nem EPICS/checkpoint.
- `pipeline/reviewer.ts:371,375,539,636,896,1029` — ELLENŐRIZVE: ezek
  mailbox rejection/escalation ÜZENETFÁJLOK írása (nem `reviewLog.ts`
  JSONL-je, amit ugyanez a fájl KÜLÖN, `appendFile`-lal ír — az UTÓBBI
  van felvéve a 14. pontként).
- `pipeline/terminalReviewer.ts:708,1012` (writeFile, nem a memory-append
  sorok) — review-kimeneti üzenetfájlok, nem EPICS.
- `pipeline/statusUpdater.ts:36,410,435` — a 13. pont (TASKS.yaml
  család) `STATUS.md` generátora, MÁR felvéve a 13. ponton belül, nem
  külön tétel.
- `generators/generateEndpoint.ts:362` (appendFile), `goalStore.ts:107`
  (appendFile, `GOALS_LOG`) — a Goal-adatosztály MÁR tárgyalt naplója
  (Kontextus 6. pont/Döntés-tábla "Goal" sor), nem új lelet.
- `sessionManager.ts:96`, `pipeline/workSessionLog.ts:100,121` — session-
  napló, nem EPICS/checkpoint/review/memory.

### Ellenőrzés

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 85 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat." (exit 0)
```

Minden újonnan idézett sorhivatkozást (`epicNotifications.ts` 336,
395–408, 414–462; `bootstrap/startup.ts` 385; `inboxWatcher.ts` 290–298;
`epicRouter.ts` 505–523; `projectTools.ts` 35–116; `projectDispatcher.ts`
263–325; `reviewLog.ts` 1–91; `identity.ts` 130–193; `sessionStarter.ts`
365–384; `terminalReviewer.ts` 619–646; `contextPersistence.ts` 440–472;
`subscriptionManager.ts` 480–540 körül; `watchMonitor.ts` 209–264 körül)
saját olvasással verifikáltam ebben a körben (`Read`/`Grep` tool,
konkrét sorszámmal) — nem a koordinátor paráfrázisát vettem át
ellenőrzés nélkül.

### Frontmatter és következő lépés

A frontmatter `status` **marad `ready`** (nem `done`) — a készítő nem
zárhatja saját taskját. A koordinátor egy 4. körös (akár ugyanazon vagy
más) független reviewer-kört indít a végső PASS/FAIL döntésre. Ha ez a
kör is talál egy ÚJABB writer-t, az azt jelentené, hogy maga a mechanikus
`rg`-minta is hiányos (pl. egy DB-natív, nem fájlrendszeri írási mód,
vagy egy harmadik string-minta) — ezt a kockázatot a fenti "módszertani
önkorrekció" bekezdés már jelzi.

## Független review, 3. kör (2026-07-18)

**Függetlenségi nyilatkozat.** Ez a review egy külön agent-futás, amely sem
az ADR/taskfájl megírásában, sem az 1. és 2. körös reviewban, sem a
"Kimerítő leltár és az ADR kiegészítése, 3. kör" szakasz megírásában nem
vett részt. A készítő és az előző két kör reviewerének egyetlen állítását
sem fogadtam el bizonyítékként — minden alábbi tényt saját maga futtatott
paranccsal vagy saját maga olvasott forrássorral igazoltam vagy cáfoltam,
és a task explicit kérésének megfelelően önállóan is kerestem egy negyedik,
eddig fel nem ismert hiányosságot.

### 1. A kimerítő leltár számszerű reprodukciója

Önállóan lefuttattam mindkét parancsot:

```
rg -n "writeFileSync|yaml\.dump|fs\.writeFile\b" knowledge-service/src -g '*.ts' -g '!**/__tests__/**' | wc -l
→ 114
rg -n "fs\.appendFile\b|appendFileSync\b" knowledge-service/src -g '*.ts' -g '!**/__tests__/**' | wc -l
→ 12
```

**Mindkét szám pontosan egyezik** a készítő állításával (a korábbi "97"
vizuális-becslés hibáját a készítő maga is jelezte és javította 114-re —
ezt is megerősítettem). A találati listát összevetettem a taskfájl
"Felvett"/"Elvetett" szakaszával: minden egyes fájlnév-sor szerepel vagy a
Kontextus 1–18. pontjában (releváns), vagy az "Elvetett" felsorolásban
(irreleváns, indoklással). Nem találtam olyan sort a nyers `rg`-kimenetben,
amely egyik kategóriába sem esne — a leltár ebben az értelemben TÉNYLEG
kimerítő, nem csak állítólagosan az.

### 2. A "harmadik task-tracker" (`create_project`/`TASKS.yaml`) tételes igazolása

Elolvastam a teljes `knowledge-service/src/projectTools.ts`-t (307 sor) és
a `pipeline/projectDispatcher.ts` elejét. Megerősítve, szó szerint:

- `handleCreateProject` (35–127. sor) `${getProjectsDir()}/${slug}` alá
  `PROJECT.md` + `TASKS.yaml` (96. sor: `yaml.dump(tasksYaml)` →
  `fs.writeFile`) + `STATUS.md` hármast hoz létre; a `TASKS.yaml` tartalma
  a `TaskChain` típus (`projectDispatcher.ts` 86–98. sor: `version`,
  `project`, `milestones[]` `status`/`blocked_by`/`tasks[]`), pontosan a
  leírt séma.
- `getProjectsDir()` (`config/paths.ts`) — `docs/projects` — **ugyanaz a
  könyvtár**, mint ahol `docs/projects/EPICS.yaml` él. Saját `ls
  docs/projects/`-em kizárólag `EPICS.yaml`-t mutat, egyetlen `<slug>/`
  alkönyvtár sincs — a "dormant adatban" állítás megerősítve.
- **Továbbmenve a készítő és az előző körök vizsgálatánál:** ellenőriztem,
  hogy a `ProjectDispatcher` daemon-ja (`projectDispatcher.ts:startDispatcher`,
  702–705. sor) egyáltalán fut-e ma — `grep -rn "startDispatcher"
  knowledge-service/src` **nulla produkciós hívót** ad (a
  `bootstrap/startup.ts` nem hívja, semelyik más fájl sem). Ez azt jelenti,
  hogy a harmadik tracker MA MÉG a dispatcher-daemon szintjén is inaktív,
  nem csak adatban — de ez NEM csökkenti a kockázatot, mert a
  `create_project`/`dispatch_next`/`list_blocked` MCP toolok a daemon-tól
  FÜGGETLENÜL, közvetlenül a fájlrendszerre írnak/olvasnak
  (`handleCreateProject` nem hívja a dispatcher singletont).
- **Új, a task által nem kért, de releváns finomítás, amit magam találtam:**
  a `create_project` tool a `knowledge-service/config/tool-permissions.yaml`
  ÉLES konfigurációjában (40–42. sor) `[root, conductor]`-ra van
  korlátozva, NEM "bármely hitelesített agent" hívhatja (ellentétben az
  `update_epic`-kel, amely NINCS felsorolva a fájlban, tehát a `default:
  "all"` szabály szerint tényleg bárki hívhatja — ezt is megerősítettem).
  Ez a "harmadik tracker" kockázatát **enyhíti** (csak root/conductor
  szintű hívó — pl. épp egy ilyen koordinátor-terminál — válthatja ki),
  de NEM szünteti meg: egy conductor-szintű agent (ami épp ez a session is)
  könnyen meghívhatja anélkül, hogy tudná, hogy ütközik az `EPICS.yaml`
  névterével. Az ADR Migráció 4. pontjának védőkorlát-követelése emiatt is
  indokolt marad.

**Következtetés:** a "harmadik tracker" állítás minden részletében pontos.

### 3. `pipeline/reviewLog.ts` igazolása

Elolvastam a teljes fájlt (91 sor). Megerősítve: `appendReviewDecision`
(37–43. sor) `fs.appendFile`-lal ír JSONL-t (`logs/reviews/decisions.jsonl`),
`ReviewDecision` séma `reviewer_a`/`reviewer_b`/`final_verdict`/`escalated`
mezőkkel — pontosan a dual-LLM (Architect+Librarian) automatikus
mailbox-DONE review pipeline döntésnaplója, nem a DP-008 jövőbeli
független emberi/agent task-review gate-je. A Döntés-táblázat "Review-döntés"
sora most már helyesen **"NEM 'nincs dedikált store'"**-ként fogalmaz, és
explicit döntést ír elő a DP-008 implementálónak (újrahasznosítás vagy
tudatos elkülönítés, névütközés-mentesen) — ez korrekt, a korábbi
(2. kör előtti) pontatlan "nincs dedikált store" állítást valóban javítja,
nem csak kiegészíti.

### 4. `epicNotifications.ts` állítások — megerősítve, egy pontatlansággal

Elolvastam a fájl 330–470. sorát, a `bootstrap/startup.ts` 300–390. sorát és
az `epicRouter.ts` 480–587. sorát.

**Megerősítve, szó szerint:**
- `(epic as any).completed_date = new Date()...` (449. sor) — ténylegesen
  deklarálatlan mező, `any`-castolt írás, séma nem ismeri.
- `attachEpicNotifications()` (336. sor) `pipelineEvents.onAny(...)`-ra
  iratkozik fel feltétel nélkül; `bootstrap/startup.ts:385` feltétel/env-flag
  NÉLKÜL hívja — ellentétben az `ENABLE_ROOT_MONITOR` (307. sor) és
  `ENABLE_MULTI_BOT` (357. sor) őrzött bekötésével, amit magam is
  összehasonlítottam.
- Az `epicRouter.ts:511-512` kommentje szó szerint "This is the
  DB-authoritative event, not file-based", miközben ugyanez az esemény
  (`emitOutboxEvent('outbox:done', ...)`, 513. sor) az `epicNotifications.ts`
  fájlírását váltja ki — az önellentmondás valós.

**Cáfolva/pontosítva — a "race condition" konkrét mechanizmusa:** a
Kontextus 12. pont és az Adverzáriális táblázat 11. sora szerint "EGY
task-completion hívás MA is KÉT FÜGGETLEN... write-útvonalat indíthat el
UGYANARRA a checkpointra, sorrend-garancia nélkül", és ezt konkrétan az
`epicRouter.ts:handleTaskCompletion`-re (513. sor `emitOutboxEvent` + 521.
sor közvetlen `updateCheckpointStatus`-hívás) vezeti vissza. Ellenőriztem a
tényleges adatáramlást: a `handleTaskCompletion` függvény szignatúrája
(`epicRouter.ts:487-491`) `(terminal, messageId, epicId)` — **nincs
`checkpointId` paramétere**, és a 513–517. soron az `emitOutboxEvent`
hívás data-objektuma is csak `epicId`/`source`/`completedAt`-ot tartalmaz,
**`checkpointId`-t nem**. Az `epicNotifications.ts:completeCheckpoint`-et
kiváltó feltétel (362. sor) `if (epicId && checkpointId)` — mindkettő
kell. Mivel ebből a konkrét hívási láncból `checkpointId` SOHA nem
érkezik, az `epicRouter.ts` MCP-útvonala (`handleTaskCompletion`) MA
**nem** tudja egyszerre elindítani mindkét writert — csak a szinkron
regex-alapú `updateCheckpointStatus`-t. Az egyetlen hely, ahol
`checkpointId` ténylegesen bekerül az `outbox:done` esemény adatába, az
`inboxWatcher.ts:265-298` (fájlrendszer-watcher útvonal, `checkpointId =
frontmatter.checkpoint_id`), ami egy MÁSIK, független hívási lánc.

Ez azt jelenti: a leírt kockázat MAGA (két, egymást nem ismerő writer
verseng ugyanazon checkpoint-adatért, koordináció nélkül) **valós marad**,
de a konkrét mechanizmus pontatlanul van leírva — nem "egyetlen hívás
indítja mindkettőt szinkron/aszinkron sorrend nélkül", hanem "két
FÜGGETLEN trigger-forrás (MCP-hívás vs. fájlrendszer-watcher) mindegyike
csak a saját writerét indítja, de a kettő között nincs semmilyen
koordináció, és mindkettő ugyanazt az `EPICS.yaml` checkpoint-mezőt
célozhatja, ha mindkettő ugyanarra a task/checkpoint-párra fut". Ez **nem
blokkoló pontatlanság** — az ADR alapkövetkeztetése (mindkét writer
kivezetendő, a 12. Migráció-pontban helyesen ELSŐ helyen) változatlanul
helyes és indokolt marad, csak a jelenség leírása igényelne egy apró,
nem-architekturális pontosítást egy jövőbeli szerkesztésnél.

### 5. Saját, önálló keresés — NEGYEDIK hiányosság

A task-instrukció szerint kifejezetten kerestem egy negyedik, eddig fel
nem ismert write-útvonalat. Az `rg` mintát a `knowledge-service/src`-en
TÚL is futtattam:

- `knowledge-service/scripts/`, `knowledge-service/bin/`, repo-gyökér
  `scripts/` — nincs `writeFileSync`/`yaml.dump`/`appendFile` találat,
  amely `EPICS`-hez kapcsolódna.
- `knowledge-service/dist/` — build-kimenet, nem forrás, kihagyva
  (helyesen, a `-g '!**/__tests__/**'` sem fedi, de nem is forráskód).
- `task-message-box/store.ts` séma-fejlécében van egy `epic_id` OSZLOP a
  `messages` táblában — ez azonban csak egy idegenkulcs-szerű mező egy
  üzenethez kötve, NEM egy epic/checkpoint STÁTUSZ-writer; már implicit
  lefedi a Döntés-táblázat "Mailbox üzenet-állapot" sora (ADR-066
  hatásköre). Nem új lelet.
- Megerősítettem, hogy a `docs/tasks/*.md` frontmatter-re NINCS
  programozott writer (`mailbox.ts:getTaskStatus`, 898–943. sor, csak
  OLVAS gray-matter-rel, a `status` mezőt a könyvtár-elhelyezésből
  származtatja, nem a frontmatterből írja vissza) — ez megerősíti, nem
  cáfolja az ADR 8. Kontextus-pontját.
- Ellenőriztem a `tool-permissions.yaml` teljes tartalmát: nincs benne
  olyan tool, ami közvetlenül `EPICS.yaml`-t vagy checkpoint-adatot írna,
  és amit az ADR ne nevezne meg valamilyen formában (`update_epic`,
  `create_project`, `set_task_status`/`set_active_task`/`set_focus_queue` —
  ez utóbbi három a Focus Queue-hoz tartozik, ami a `state.md`/`todo.md`
  "aktuális fókusz" projekciójához kapcsolódó, KÜLÖN adatosztály, nem
  EPICS/checkpoint — ellenőriztem, hogy nem `EPICS.yaml`-t érint, hanem
  egy külön `focusQueue` store-t; ez az ADR hatáskörén kívül eshet, de nem
  EPICS-releváns writer, tehát nem blokkoló hiány, csak egy megjegyzésre
  méltó, az ADR-ben eddig nem nevesített projekció-forrás — a `state.md`/
  `todo.md` generátor tervezésekor a DP-004 implementálónak érdemes erre
  is figyelnie, mivel ez egy NEGYEDIK, eddig egyik körben sem említett
  input a "aktuális fókusz" projekcióhoz).

**Nem találtam ÚJ, BLOKKOLÓ (EPICS.yaml/checkpoint/task-frontmatter/
review-döntés/MEMORY.md státuszt közvetlenül író, dokumentálatlan) kódutat.**
Az egyetlen új megfigyelésem (`set_focus_queue`/`focusQueue` store mint a
`state.md`/`todo.md` projekció negyedik bemenete) nem write-útvonal az
`EPICS.yaml`-ra, hanem egy, a Projekció szakasz által még nem nevesített
bemeneti forrás — dokumentálásra érdemes, de NEM blokkolja a DP-002
kilépési feltételét, mert nem egy versengő EPICS.yaml/checkpoint-igazságforrás,
hanem egy már elismert projekció-célfájl (state.md/todo.md) egy plusz
adatforrása.

### 6. `node scripts/check-doc-links.mjs` — újrafuttatva

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 86 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat." (exit 0)
```

(86, nem 85 — a különbség abból adódik, hogy a taskfájl e review-kör
írásakor tovább nőtt; ez nem hibajel, a kapu zöld marad.)

### Verdikt: **PASS**

**Indoklás.** A program ezen szakasza (README "Döntési szabály", a
koordinátor 3. körös megbízása) explicit PASS-t enged, ha (a) a kimerítő
leltár TÉNYLEG kimerítő, és (b) a reviewer maga sem talál új BLOKKOLÓ rést,
és (c) a "harmadik tracker" jól dokumentált, emberi döntésre váró NYITOTT
KÉRDÉSKÉNT szerepel, konkrét interim védőkorláttal/workaround-instrukcióval.
Mindhárom feltétel teljesül:

1. **A leltár valóban kimerítő.** Saját, független `rg`-futtatásom
   pontosan 114+12 találatot ad, egyezik a készítővel; minden egyes
   találat expliciten fel van véve VAGY expliciten el van vetve, indoklással,
   a taskfájlban — nem találtam olyan sort, ami "lyukban" maradt volna.
2. **Saját keresésem nem talált új blokkoló writert.** A
   `knowledge-service/src`-en túli keresés (scripts/, bin/, config/) és a
   `tool-permissions.yaml` teljes átvizsgálása egyetlen, az ADR-ben eddig
   nem szereplő, EPICS.yaml/checkpoint-et közvetlenül író kódutat sem
   talált. Az egyetlen új megfigyelésem (`focusQueue` mint negyedik
   projekció-bemenet) nem write-versengés az EPICS.yaml-ra, csak egy
   dokumentálásra érdemes, nem blokkoló kiegészítés a DP-004 implementálónak.
3. **A "harmadik tracker" jól kezelt nyitott kérdés, nem blokkoló hiány.**
   Az ADR ezt (i) explicit "KRITIKUS, emberi döntést igénylő" Nyitott
   kérdésként nevesíti, (ii) a Migráció 4. pontban konkrét interim
   védőkorlátot ír elő (namespace-ütközés elleni guard VAGY a tool
   ideiglenes letiltása/env-flag mögé zárása, amíg a döntés meg nem
   születik), (iii) a Döntés-táblázatban is szerepel, explicit "NEM
   autoritatív forrás semmilyen NEXUS-* programra" minősítéssel. Ez
   pontosan az a mintázat, amit a task döntési szabálya PASS-ra
   jogosultnak minősít ("human decision required, DP-003/004 addig X
   workaround-dal indulhat"). Saját vizsgálatom (a `create_project` tool
   root/conductor-ra korlátozott, a daemon nem fut) tovább csökkenti (bár
   nem szünteti meg) a közvetlen, azonnali kockázatot — ez erősíti, nem
   gyengíti a PASS-döntést.
4. A `pipeline/reviewLog.ts` és az `epicNotifications.ts` körüli 1–2. körös
   hiányosságok a 3. körben (a készítő "Kimerítő leltár" szakaszában)
   ténylegesen, a többi 11 ponttal azonos mélységben pótolva lettek — ezt
   magam, sorhivatkozásig visszaellenőriztem.
5. Az egyetlen hibát, amit találtam (a "race condition" pontatlan
   mechanizmus-leírása a Kontextus 12. pontban/Adverzáriális 11. sorban),
   **nem minősítem blokkolónak**: az architekturális következtetés (mindkét
   writert ki kell vezetni, legelső helyen) a pontatlanság ellenére is
   helyes és indokolt marad, és a DP-003/004 implementáló szempontjából a
   végrehajtandó teendő (a Migráció szakasz) nem változik emiatt.
6. `node scripts/check-doc-links.mjs` zöld (86 link, exit 0).

**Nem blokkoló follow-up javaslatok a DP-003/004 implementálónak (nem
feltétele a `done`-nak, csak dokumentált tanulság):**

- Pontosítani a Kontextus 12. pont/Adverzáriális 11. sor race-leírását:
  a két writer NEM egyetlen hívásból, hanem két független trigger-forrásból
  (MCP `handleTaskCompletion` → csak regex-writer; fájlrendszer-watcher
  `inboxWatcher.ts` → csak esemény-writer) aktiválódik — a végkövetkeztetés
  (mindkettő kivezetendő) emiatt nem változik.
  a `focusQueue`/`set_focus_queue`/`set_active_task` store-t (jelenleg
  csak `tool-permissions.yaml`-ban látható, nem az ADR-ben) mint a
  `state.md`/`todo.md` projekció negyedik bemeneti forrását felvenni a
  Projekció szakaszba, ha a DP-004 implementáció a "aktuális fókusz"
  mezőt is generálja.

A frontmatter `status` ezzel a PASS-verdikttel **`done`-ra vált** (ld.
lent). Az ADR `Státusz` mezője `proposed`-ból `accepted`-re vált, a repo
ADR-konvenciójának megfelelően (pl. ADR-041, ADR-046, ADR-049).
