---
domain: engineering-governance
title: A Nexus fejlesztési folyamatának érettségi értékelése
updated: 2026-07-18
status: assessment
---

# A Nexus fejlesztési folyamatának érettségi értékelése

## Vezetői összefoglaló

A Nexus fejlesztési folyamatának tervezett modellje erős: a `QUALITY.md`, a
program–mérföldkő–epic–task hierarchia, a részletes taskfájlok, a memória- és
állapot-checkpointok, valamint a független review elve jó alapot adnak
agentcsapatok irányításához.

A 2026-07-18-i munkafán ugyanakkor a tényleges végrehajtás még nem garantálja,
hogy egy késznek jelölt változás egyértelműen összeköthető a taskkal, a
committal, a CI-bizonyítékkal, a reviewerrel és a release-artifacttal. A
folyamat fő problémája ezért nem a szabályok hiánya, hanem a szabályok gépi
kikényszerítésének és az állapotforrások egységének hiánya.

Érettségi becslés:

| Terület | Érettség | Minősítés |
|---|---:|---|
| Dokumentált működési modell | 8/10 | erős és részletes |
| Helyi mérnöki minőségi kapuk | 7/10 | használható, de nem teljesen zöld |
| Verziókezelés és változásintegráció | 3/10 | a kész állapot nincs commit/PR bizonyítékhoz kötve |
| Állapot- és célkonzisztencia | 3/10 | több egymással versengő igazságforrás |
| Független review kikényszerítése | 4/10 | deklarált, de nem minden tasknál bizonyítható |
| Többplatformos CI és release-bizonyítás | 4/10 | részben kézi és Linux-központú |
| **Összesített tényleges érettség** | **5,5/10** | erős modell, közepes végrehajtási garancia |

> A pontszám architekturális és folyamatérettségi becslés, nem formális
> megfelelőségi tanúsítás. Az értékelés a 2026-07-18-i helyi munkafára
> vonatkozik.

## Vizsgálati kör

A felmérés az alábbi bizonyítékokat vizsgálta:

- `QUALITY.md` és a taskprogramok végrehajtási szerződései;
- `docs/projects/EPICS.yaml`, task-frontmatterek, `state.md`, `todo.md` és
  `MEMORY.md`;
- a task-, goal-, checkpoint-, mailbox- és Epic Router állapotkezelése;
- a Git munkafa, branch és commit állapota;
- a helyi és GitHub CI-kapuk;
- a review-, archiválási, deploy- és rollback-folyamat;
- a Windows/Linux fejlesztési és ellenőrzési út.

## A kívánt fejlesztési lánc

```mermaid
flowchart LR
    Goal["Programcél és kilépési feltétel"] --> Task["Validált task és függőségek"]
    Task --> Claim["Egyértelmű owner és munkakezdés"]
    Claim --> Branch["Taskhoz kötött branch és commit"]
    Branch --> CI["Reprodukálható helyi és távoli CI"]
    CI --> Review["Független reviewer és bizonyíték"]
    Review --> Merge["Védett merge"]
    Merge --> Release["Azonosítható artifact és kontrollált release"]
    Release --> Reconcile["Task, EPICS, state, todo és memória szinkron"]
```

A lánc csak akkor tekinthető zártnak, ha minden átmenetnek van géppel
ellenőrizhető bemenete, kimenete, felelőse és bizonyítéka.

## Bizonyított erősségek

### Pontos normatív alap

A `QUALITY.md` megköveteli a célt, a leállási feltételt, az architektúra előzetes
tisztázását, a tesztelést, az implementáció dokumentálását, a memóriamentést és
a készítőtől független review-t. Ez megfelelő alap emberi és CLI-agent
fejlesztőcsapatokhoz is.

### Végrehajtható taskstruktúra

A quality-compliance és island-runtime programok már tartalmaznak függőséget,
mérhető sikerkritériumot, kilépési feltételt, bizonyítéklistát és végrehajtási
naplót. Az island-runtime program különösen jó mintát ad a cél, state, todo,
memória és reviewer kötelező szinkronjára.

### Működő helyi minőségi kapuk

A felméréskor futtatott eredmények:

| Kapu | Eredmény |
|---|---|
| TypeScript typecheck | PASS |
| Teljes tesztsuite | 76 fájl PASS; 1307 PASS; 1 skipped |
| Coverage | 40,74% statements; 34,77% branches; 39,84% functions; 41,14% lines |
| Lint-ratchet | PASS; 786 warning, 490 info, 0 error |
| Production dependency audit | PASS; 0 ismert sérülékenység |
| Secret scan | PASS; 347 követett fájl, 11 mintacsalád |
| Fájlméret-kapu | PASS; 8 időkorlátos allowlist-bejegyzés |
| Dokumentációs linkkapu | FAIL; 2 hibás `ADR-001` hivatkozás |

A negatív tesztek során megjelenő hibalogsorok önmagukban nem tesztbukások; a
teljes Vitest-futás exit code-ja 0 volt.

## Fő megállapítások

### DEVPROC-01 — A kész munka nincs verziókezelt változásegységhez kötve

**Súlyosság: kritikus**

A vizsgálatkor a `main` munkafán több mint 160 módosított, staged vagy untracked
bejegyzés volt. A változás több programot és nagy számú forrásfájlt érint, miközben
több task már `done` vagy archivált. Így nem reprodukálható egyértelműen, hogy
melyik taskhoz melyik diff, tesztfutás, review és rollback-egység tartozik.

**Szükséges kontroll:** egy taskhoz tartozó változás kapjon taskazonosítót,
base commitot, branchet vagy egyértelmű commit-sorozatot, zöld CI-t és review-t.

### DEVPROC-02 — Több kanonikus projektállapot versenyez

**Súlyosság: kritikus**

Az `EPICS.yaml` fejléc szerint a program-, mérföldkő- és epicállapotot a fájl
vezeti. A `checkpointStore` és a projects HTTP API viszont az adatbázist nevezi
source of truthnak, az `EPICS.yaml`-t pedig egyszeri seednek. Az Epic Router
közben továbbra is olvas és visszaír YAML-állapotot.

**Szükséges kontroll:** ADR-ben rögzített egyetlen autoritatív modell,
egyirányú projekciókkal, verziózott migrációval és reconciliation riporttal.

### DEVPROC-03 — A kézi state/todo/memória szinkron elsodródott

**Súlyosság: magas**

A `todo.md` QC-állapota elmaradt a taskarchívumtól, a `state.md` pedig történeti
tesztszámot és „minden commit pusholva” állítást tartalmazott a nagy helyi diff
mellett. A kézi többszörös írás már bizonyítottan konzisztenciahibát okozott.

**Szükséges kontroll:** egy kanonikus tranzakció után generált vagy ellenőrzött
projekciók; eltérés esetén determinisztikus javítás és auditnapló.

### DEVPROC-04 — Nincs task-séma és életciklus CI-kapu

**Súlyosság: magas**

Öt `TASK-QC-008A…E` frontmatter YAML-szintaktikailag hibás az idézőjel nélküli
`allowlist:` rész miatt. Nincs teljes repository-szintű kapu az egyedi ID-kre,
engedélyezett státuszokra, függőségi DAG-ra, EPICS-hivatkozásokra, archiválási
bizonyítékra és reviewer-metadata jelenlétére.

**Szükséges kontroll:** determinisztikus `check:tasks` parancs, amely lokálisan
és CI-ben ugyanazt a sémát és invariánsokat ellenőrzi.

### DEVPROC-05 — A task-status interfész a régi könyvtármodellt használja

**Súlyosság: magas**

A mailbox `getTaskStatus` útvonala csak a `docs/tasks/new`, `active` és `archive`
könyvtárakat vizsgálja. A programalapú `quality-compliance` és `island-runtime`
taskokat ezért nem garantált, hogy megtalálja. A gépi és az emberi tasknézet
eltérhet.

**Szükséges kontroll:** közös task repository/index, amely a teljes programfát
kezeli és ugyanazt az állapotot szolgáltatja a CLI, MCP, HTTP és CI felé.

### DEVPROC-06 — A review és archiválás nem tranzakciós kapu

**Súlyosság: magas**

A dokumentáció tiltja az önreview-t, de az archivált taskoknál nincs egységes,
géppel olvasható reviewer-azonosító, döntés, bizonyíték és implementáló–reviewer
szétválasztási ellenőrzés. A végső programreview jó gyakorlat, de nem helyettesíti
az egyes változásegységek review-ját.

**Szükséges kontroll:** kötelező review record, külön identitás, döntési státusz,
CI-hivatkozás és csak sikeres review után engedélyezett archiválás.

### DEVPROC-07 — A CI fejlettebb helyben, mint az autoritatív ágon

**Súlyosság: magas**

A helyi CI-workflow tartalmaz coverage-, audit-, secret-, link- és méretkapukat,
de ezek a vizsgálatkor még a nem commitolt munkafa részei voltak. A
dokumentációs linkkapu lokálisan is piros volt. A coverage-minimumok ratchet
baseline-ok, nem a kritikus modulok kívánt minőségi céljai.

**Szükséges kontroll:** a PR-en futó, kötelező, lokálisan reprodukálható kapuk;
zöld státusz nélkül nincs merge vagy `done`.

### DEVPROC-08 — A Windows és release út nincs teljesen bizonyítva

**Súlyosság: magas**

A GitHub CI Linuxon fut, miközben a fejlesztői és runner-környezet Windowsot is
célzottan támogat. A smoke és deploy lépések nincsenek teljesen egy zöld
commitból előállított, változatlan artifacthoz kötve.

**Szükséges kontroll:** Linux–Windows CI-mátrix, hermetikus tesztadatok,
commitból származtatott artifactmanifest, canary/smoke eredmény és bizonyított
rollback.

### DEVPROC-09 — A minőségi adósság ratchetje nem egyenlő a kész állapottal

**Súlyosság: közepes**

A lint- és fájlméret-ratchet helyesen akadályozza a romlást, de 786 warning és 8
allowlistelt nagy fájl mellett a zöld kapu nem jelent tiszta kódbázist. Több
kritikus session-, registry-, workflow- és watcher-modul coverage-e nagyon
alacsony.

**Szükséges kontroll:** időkorlátos, ownerrel és taskkal rendelkező adósságkeret;
kritikus modulokra külön coverage-küszöb; lejáratkor fail-closed viselkedés.

### DEVPROC-10 — Nincs egyetlen, auditálható folyamatbizonyíték

**Súlyosság: magas**

A task, commit, CI, review, release, state és memória adatai külön helyeken
élnek, és nincs közöttük kötelező azonosító vagy lezárási manifest. Egy friss
reviewernek ezért fájl- és Git-régészetet kell végeznie.

**Szükséges kontroll:** taskonkénti géppel olvasható evidence manifest, amely a
teljes láncot összeköti és azonos adatokból újraellenőrizhető.

## Célműködés és felelősségi határok

Javasolt irány, amelyet a `TASK-DP-002` ADR-nek kell véglegesítenie:

- az adatbázis legyen autoritatív a futási állapothoz, ownershiphez, lease-hez
  és tranzakciós state transitionökhöz;
- a verziókezelt task és programdokumentum legyen autoritatív a célhoz,
  scope-hoz, elfogadási és kilépési feltételhez;
- a `state.md` legyen generálható aktuális pillanatkép;
- a `todo.md` legyen a kanonikus taskállapotból származó emberi nézet;
- a `MEMORY.md` csak tartós tanulságot őrizzen, ne pillanatnyi státuszt;
- a release manifest kösse össze a taskot, commitot, CI-t, review-t, artifactot
  és deployeredményt.

Ez az elválasztás megőrzi a verziókezelt design intentet, miközben megszünteti a
futási állapot veszélyes dual-write-ját.

## Prioritási sorrend

1. A munkafa változásainak veszteségmentes leltározása és taskhoz rendelése.
2. A kanonikus állapotmodell ADR-szintű eldöntése.
3. Task-séma, függőségi és archiválási CI-kapu bevezetése.
4. Tranzakciós task-lifecycle és generált/reconciliált állapotprojekciók.
5. Branch-, commit-, PR- és független review-kapuk kikényszerítése.
6. Linux–Windows CI-paritás és hermetikus tesztelés.
7. Release provenance, smoke, canary és rollback összekötése.
8. Clean-room dokumentáció és független folyamat-audit.

## Kapcsolódó végrehajtási program

A megállapításokat a `docs/tasks/development-process/` alatti
`NEXUS-DEVELOPMENT-PROCESS` program bontja végrehajtható feladatokra. A program
csak független reviewer által reprodukált, végponttól végpontig bizonyított
folyamat esetén zárható le.
