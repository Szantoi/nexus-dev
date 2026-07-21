# Bizonyítható és kikényszerített fejlesztési folyamat program

Ez a program a
`docs/knowledge/fejlesztesi-folyamat-erettsegi-ertekeles.md` megállapításait
bontja végrehajtható fejlesztési feladatokra. A normatív minőségi forrás a
repository gyökerében lévő `QUALITY.md`.

A taskbontás, a függőségek és a végrehajtási kapuk részletes indoklása:
`docs/knowledge/fejlesztesi-folyamat-taskprogram-letrehozasa.md`.

## Programcél

A Nexus minden fejlesztési változása a céltól a release-ig egyetlen,
újraellenőrizhető bizonyítékláncon haladjon végig: validált task, egyértelmű
owner, taskhoz kötött branch/commit, reprodukálható CI, független review,
kontrollált merge/release és konzisztens állapotprojekciók.

## Mikor jó?

A cél akkor teljesül, ha:

1. minden aktív változás taskazonosítóhoz és ismert base commithoz kötött;
2. pontosan egy dokumentált autoritatív állapotmodell működik, dual-write nélkül;
3. minden task-frontmatter, függőség, EPICS-hivatkozás és archiválási bizonyíték
   géppel validált;
4. a task életciklusa tranzakciósan vagy determinisztikusan reconciliálva frissíti
   a gépi állapotot és az emberi projekciókat;
5. a CLI, MCP, HTTP és CI ugyanazt a programalapú taskhalmazt látja;
6. a védett főág csak zöld kötelező kapuk és a készítőtől független review után
   fogad változást;
7. a Linux és Windows CI ugyanabból a commitból reprodukálja a támogatott
   ellenőrzéseket;
8. a release manifest összeköti a taskot, commitot, CI-t, review-t, artifactot,
   smoke/canary eredményt és rollbacket;
9. a `state.md`, `todo.md` és `MEMORY.md` nem mond ellent a kanonikus állapotnak;
10. egy friss kontextusú, a kivitelezésben részt nem vevő reviewer clean-room
    környezetből PASS eredménnyel újraellenőrzi a teljes folyamatot.

## Program kilépési feltétele

A program csak akkor állítható `done` állapotba, ha mind a 11 task `done`, nincs
nyitott kritikus vagy magas folyamateltérés, a főág required checkjei Linuxon és
Windowson zöldek, egy reprezentatív változás a goal → task → commit → CI →
review → merge → release → state-sync láncon végigment, és a `TASK-DP-011`
független auditja PASS.

A programot korábban csak az alábbi esetben szabad megállítani:

- bizonyított külső blokk miatt `blocked` állapot szükséges;
- elfogyott az előre rögzített idő-, próbálkozás- vagy tokenkeret;
- a scope architekturális vagy szervezeti döntést igényel;
- pushhoz, branch protection módosításához, éles deployhoz vagy más külső
  állapotváltozáshoz emberi jóváhagyás szükséges.

A dokumentum vagy konfiguráció puszta létezése nem PASS. A kontrollt negatív
teszttel is bizonyítani kell: a szabályt sértő változást a rendszer utasítsa el.

## Hierarchia

- Program: `NEXUS-DEVELOPMENT-PROCESS`
- Projekt: `nexus/knowledge-service`
- Mérföldkövek:
  - `DP-M1` — kontrollált baseline és állapotdöntés
  - `DP-M2` — géppel kikényszerített task-életciklus
  - `DP-M3` — változásintegráció, CI és független review
  - `DP-M4` — release-bizonyíték, dokumentáció és audit

## Feladatok

| Sorrend | Feladat | Mérföldkő | Prioritás | Függőség |
|---:|---|---|---|---|
| 1 | [TASK-DP-001 — Munkafa-leltár és kontrollált baseline](archive/TASK-DP-001-worktree-baseline.md) ✅ done (2. körben PASS) | DP-M1 | kritikus | nincs |
| 2 | [TASK-DP-002 — Kanonikus állapotmodell ADR](archive/TASK-DP-002-canonical-state-adr.md) ✅ done (3. körben PASS) | DP-M1 | kritikus | nincs |
| 3 | [TASK-DP-003 — Task-séma és konzisztencia CI-kapu](archive/TASK-DP-003-task-schema-gate.md) ✅ done (3. körben PASS) | DP-M2 | kritikus | DP-002 |
| 4 | [TASK-DP-004 — Tranzakciós task-lifecycle és projekciók](TASK-DP-004-task-lifecycle.md) | DP-M2 | kritikus | DP-002, DP-003 |
| 5 | [TASK-DP-005 — Egységes task discovery és státusz API](TASK-DP-005-task-discovery-api.md) | DP-M2 | magas | DP-003, DP-004 |
| 6 | [TASK-DP-006 — Branch, commit és PR provenance](archive/TASK-DP-006-change-provenance.md) ✅ done (2. körben PASS) | DP-M3 | kritikus | DP-001 |
| 7 | [TASK-DP-007 — CI-paritás, Windows/Linux mátrix](TASK-DP-007-ci-platform-parity.md) | DP-M3 | kritikus | DP-003, DP-006 |
| 8 | [TASK-DP-008 — Független review és archiválási kapu](TASK-DP-008-review-archive-gate.md) | DP-M3 | kritikus | DP-004, DP-006, DP-007 |
| 9 | [TASK-DP-009 — Release provenance, smoke és rollback](TASK-DP-009-release-provenance.md) | DP-M4 | kritikus | DP-006, DP-007, DP-008 |
| 10 | [TASK-DP-010 — Fejlesztői és operátori folyamatdokumentáció](TASK-DP-010-process-documentation.md) | DP-M4 | magas | DP-004, DP-005, DP-007, DP-008, DP-009 |
| 11 | [TASK-DP-011 — Független végponttól végpontig audit](TASK-DP-011-independent-audit.md) | DP-M4 | kritikus | DP-001…010 |

## Végrehajtási hullámok

1. **Baseline és döntés párhuzamosan:** DP-001 és DP-002.
2. **Taskkontroll:** DP-003, majd DP-004 és DP-005.
3. **Integráció:** DP-006, majd DP-007 és DP-008.
4. **Release:** DP-009.
5. **Reprodukálhatóság:** DP-010, végül DP-011 külön reviewerrel.

## Kötelező végrehajtási szerződés minden taskhoz

### Indítás előtt

1. Olvasd el teljesen: `QUALITY.md`, ezt a README-t, a saját taskfájlt,
   `docs/knowledge/fejlesztesi-folyamat-erettsegi-ertekeles.md`,
   `docs/projects/EPICS.yaml`, `terminals/root/state.md`,
   `terminals/root/todo.md` és `terminals/root/MEMORY.md`.
2. Ellenőrizd a függőségek `done` állapotát és bizonyítékait. Függőség megkerülése
   csak dokumentált emberi döntéssel lehetséges.
3. Írd a task `Végrehajtási napló` részébe az adott futás egy mondatos goalját,
   mérhető sikerkritériumát és kilépési feltételét.
4. Rögzítsd a base commitot, branchet, worktree-állapotot, ownert és az
   erőforráskeretet. Piszkos munkafát tilos automatikusan visszaállítani,
   áthelyezni vagy összecsomagolni.
5. Állítsd a taskot `in_progress`, az epicet `active` állapotra, és frissítsd az
   aktuális fókuszt a `state.md` és `todo.md` fájlban.

### Munka közben

- Egy worker egyszerre egy task scope-ját módosítsa. Átfedés esetén előbb
  koordináljon és dokumentálja a tulajdonost.
- Minden nagyobb lépés után checkpoint készüljön: eredmény, következő lépés,
  nyitott kockázat, diff/commit és futtatott bizonyíték.
- A `todo.md` a következő konkrét teendőt, a `state.md` az aktuális állapotot, a
  `MEMORY.md` pedig csak tartós tanulságot tartalmazzon.
- Kontextustelítődésnél checkpoint, state- és memóriafrissítés, majd átadási
  összefoglaló szükséges. A goal nem maradhat kizárólag chatben.
- Push, branch protection, PR-merge, külső publikálás és éles deploy előtt az
  aktuális jogosultsági és emberi jóváhagyási kaput be kell tartani.
- Titkot, tokent, teljes auth-headert, személyes adatot vagy érzékeny logot tilos
  bizonyítékfájlba írni.

### `done` előtt

A task végére kötelező `## Implementáció (YYYY-MM-DD)` szakaszt írni, benne:

1. eredeti goal, sikerkritérium és kilépési feltétel;
2. tényleges eredmény és scope-eltérés;
3. architekturális döntések és elvetett alternatívák;
4. módosított fájlok, migrációk és adatkompatibilitás;
5. base commit, branch, commitok és PR-hivatkozás vagy dokumentált lokális ok;
6. futtatott parancsok, exit code-ok és teszteredmények;
7. OS, shell, Node- és releváns toolverziók;
8. negatív tesztek, biztonsági ellenőrzés és rollback-próba;
9. ismert korlátok, fennmaradó kockázatok és follow-up taskok;
10. reviewer azonosítója/szerepe, függetlenségi nyilatkozata és döntése;
11. minden elfogadási és kilépési feltétel tételes PASS/FAIL értékelése;
12. task, EPICS, state, todo, memória és kapcsolódó dokumentáció szinkronja.

A készítő nem fogadhatja el és nem archiválhatja saját taskját. A reviewer FAIL
vagy REQUEST_CHANGES eredménye visszanyitja a taskot. Archiválást csak a
koordinátor végezhet az `archive/README.md` szabályai szerint.

## Kötelező evidence manifest

Minden task végrehajtási dokumentációjában vagy hivatkozott artifactjában
szerepeljen az alábbi géppel olvasható minimum:

```yaml
execution_evidence:
  task_id: TASK-DP-NNN
  goal: "..."
  success_criteria: ["..."]
  exit_condition: "..."
  base_commit: "git-sha"
  branch: "branch-name"
  commits: ["git-sha"]
  pull_request: "URL-or-N/A-with-reason"
  environments:
    - os: windows | linux
      shell: powershell | bash | other
      node: "version"
  commands:
    - command: "npm run ..."
      exit_code: 0
      result: PASS
  reviewer:
    identity: "name-or-agent-id"
    independent: true
    decision: PASS | FAIL | REQUEST_CHANGES
    evidence: "relative/path-or-URL"
  state_sync:
    task: true
    epics: true
    state: true
    todo: true
    memory: true
```

Titkot vagy teljes nyers logot a manifest nem tartalmazhat.

## Kapcsolódás más programokhoz

- A `NEXUS-QUALITY` kódminőségi és biztonsági kapui ennek a programnak kötelező
  bemenetei; ez a program nem duplikálja a coverage- és nagyfájl-refaktort.
- A `NEXUS-ISLAND-RUNTIME` taskjai ezt a folyamatot használják első nagy
  reprezentatív agentcsapat-fejlesztési programként.
- Átfedő task esetén egyetlen implementáció készül, de mindkét program
  elfogadási feltételéhez külön, egyértelmű bizonyítékhivatkozás szükséges.
