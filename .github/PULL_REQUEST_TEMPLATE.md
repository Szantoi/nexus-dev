<!--
  Kötelező PR-sablon (TASK-DP-006 — Branch, commit és PR provenance).
  Cél: minden merge-elt sor visszakereshető legyen taskra, goalra,
  implementálóra, commitra, CI-futásra és reviewerre (program README
  "Mikor jó?" 1. pontja). A mezők törlése/kihagyása helyett írj "N/A" +
  indoklást, ha egy mező ténylegesen nem értelmezhető erre a PR-re.

  A PR CÍME kötelezően `[TASK-XXX-NNN] <rövid összefoglaló>` formátumú
  (lásd docs/architecture/decisions/ADR-086-change-provenance.md) — ez
  válik a squash-merge commit subjectjévé, tehát ez hordozza a
  provenance-t a fő ág történetében.
-->

## Task

- **Task-ID:** TASK-XXX-NNN <!-- kötelező; a branch-névnek és a PR-címnek is ugyanezt kell tartalmaznia -->
- **Task-fájl:** `docs/tasks/<program>/TASK-XXX-NNN-....md`
- **Program / epic:** <!-- pl. NEXUS-DEVELOPMENT-PROCESS / DP-CHANGE-CONTROL -->
- **Owner:** <!-- felelős szerep/agent -->

## Goal

<!-- Egy-két mondatban: mit old meg ez a változás, és miért most. -->

## Scope

<!-- Mi VÁLTOZIK és mi NEM. Ha a task-fájl scope-jától eltérsz, indokold itt. -->

- Érintett fájlok/modulok:
- Kifejezetten KIZÁRVA ebből a PR-ből:

## Kockázat

- **Kockázati szint:** alacsony / közepes / magas / kritikus
- **Viselkedés-változtató alapértelmezés?** igen/nem — ha igen, melyik (pl. AUTH_MODE, HOST bind)
- **Emberi jóváhagyás szükséges a push/merge/deploy előtt?** igen/nem — ha igen, ki hagyta jóvá és mikor
- **Backward compatibility / migráció:**

## Teszt

<!-- Pontosan mely parancsokat futtattad, milyen eredménnyel. A required CI
     checkeknek zöldnek kell lenniük merge előtt — ez a szakasz a HELYI,
     PR nyitása előtti reprodukciót dokumentálja. -->

| Parancs | Exit code | Eredmény |
|---|---|---|
| `npm run typecheck` | | |
| `npm run lint:ratchet` | | |
| `npm run test:coverage` | | |
| `npm run secret-scan` | | |
| ... | | |

## Rollback

- **Revert-parancs:** `git revert <commit-sha>` (a revert commit subjectje `[TASK-XXX-NNN-REVERT] ...`)
- **Ismert rollback-kockázat:** <!-- pl. adatmigráció nem visszafordítható, konfig-default más rendszereket érint -->
- **Rollback tesztelve?** igen/nem/nem-alkalmazható + indoklás

## Evidence

- **Base commit:** `git-sha`
- **Branch:** `task/TASK-XXX-NNN-...` vagy `hotfix/TASK-XXX-NNN-...`
- **CI futás:** <link a required check run(ok)ra>
- **Kapcsolódó ADR/döntés (ha van):** `docs/architecture/decisions/ADR-NNN-....md`

## State-sync

<!-- Jelöld, mely dokumentumok frissültek EBBEN a PR-ben ehhez a taskhoz. -->

- [ ] Taskfájl (frontmatter + Végrehajtási napló / Implementáció szakasz)
- [ ] `docs/projects/EPICS.yaml`
- [ ] `terminals/*/state.md`
- [ ] `terminals/*/todo.md`
- [ ] `terminals/*/MEMORY.md` (csak ha tartós tanulság született)

## Reviewer

- **Reviewer azonosító/szerep:**
- **Függetlenségi nyilatkozat:** a reviewer nem vett részt ennek a PR-nek a kivitelezésében — igen/nem
- **Döntés:** PASS / FAIL / REQUEST_CHANGES

---

### RETROACTIVE-EVIDENCE (csak hotfix-branchre kötelező)

<!-- Ha ez a PR egy hotfix/ branchről érkezik, ezt a szakaszt A MERGE UTÁNI
     24 ÓRÁN BELÜL kötelező kitölteni és egy követő commit/PR-ben rögzíteni
     (lásd ADR-086 "Sürgősségi javítás és revert" szakasza). -->

- **Mi tört el (production incidens leírása):**
- **Miért nem volt idő a teljes review-ciklusra a hotfix előtt:**
- **Utólagos teszt-bizonyíték (a hotfix után lefuttatva):**
- **Follow-up task a teljes auditra:** TASK-XXX-NNN
- **Kitöltve, mikor (dátum, óra:perc, időzóna):**
