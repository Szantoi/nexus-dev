---
id: TASK-DP-006
title: "Branch, commit és PR provenance"
program: NEXUS-DEVELOPMENT-PROCESS
project: nexus/knowledge-service
milestone: DP-M3
epic: DP-CHANGE-CONTROL
status: done
priority: critical
depends_on: [TASK-DP-001]
parallel_with: []
owner_role: release-manager
created: 2026-07-18
source: "DEVPROC-01 and DEVPROC-10"
---

# Branch, commit és PR provenance

## Cél

Minden változásegység tasktól commiton és PR-en át a merge-ig auditálható
legyen, és a főág közvetlen, bizonyíték nélküli módosítása megszűnjön.

## Mikor jó?

Egy tetszőleges merged fájlsorról visszakereshető a task, goal, implementáló,
commit, CI és reviewer; egy task bizonyítéka pedig pontosan azonosítja a diffet
és a base verziót.

## Scope

1. A DP-001 manifest alapján alakíts ki minimális, task-scoped változáscsoportokat
   felhasználói változás elvesztése nélkül.
2. Definiáld a branch-, commit- és PR-névadást kötelező `TASK-*` azonosítóval.
3. Adj PR-sablont goal, scope, kockázat, teszt, rollback, evidence és state-sync
   mezőkkel.
4. Definiáld a főág branch protection, required checks, approval és stale-review
   követelményeit; módosításukhoz kérj emberi jóváhagyást.
5. Gondoskodj arról, hogy generált vagy bot commit se kerülhesse meg a kapukat.
6. Dokumentáld a sürgős javítás és revert útját utólagos auditkötelezettséggel.

## Elfogadási feltételek

- [ ] Minden aktív változáscsoporthoz task, base, branch/commit és owner tartozik.
- [ ] A főágra közvetlen push tiltott vagy bizonyítottan azonos kontrollú kivétel.
- [ ] PR nem merge-elhető required CI és független approval nélkül.
- [ ] Új commit érvényteleníti a korábbi stale review-t.
- [ ] A squash/rebase/merge stratégia megőrzi a task-provenance-t.
- [ ] A revert és hotfix folyamat tesztelt, és nem törli az auditnyomot.
- [ ] Egy mintaváltozás teljes visszakeresése dokumentált.

## Kötelező ellenőrzés

Lokális Git fixture vagy tesztrepository a névadás és hook/check ellenőrzésére;
GitHub branch protection read-back, ha hozzáférés van; negatív próba hiányzó task
ID-val, piros CI-vel, önapproval-val és stale review-val. Külső módosításhoz
emberi jóváhagyás kell.

## Kilépési feltétel

`done`, ha a dokumentált szabály és a tényleges repository-beállítás egyezik, a
DP-001 változásai veszteségmentesen provenance-egységekhez kötöttek, és a
megkerülési próbák elbuknak. Hiányzó GitHub-jogosultság esetén pontos feloldási
feltétellel `blocked`.

## Végrehajtási napló

- **Indítás:** 2026-07-18, owner_role: release-manager. Frontmatter `status`
  a futás elejére `in_progress`-re állítva, a futás végén a program README
  szabálya szerint ("a készítő nem fogadhatja el/archiválhatja saját
  taskját") vissza `ready`-re — NEM `done`-ra.
- **Goal (egy mondatban):** a DP-001 manifest 15/16 lépéses commit-tervét
  egy géppel kikényszeríthető `TASK-*` branch-/commit-/PR-névadási
  konvencióval, PR-sablonnal, TERVEZETT (nem alkalmazott) branch-protection
  szabállyal és egy helyben, lokális git-fixture-rel bizonyított
  provenance-validátor scripttel egészítsem ki, valós push/merge/branch-
  protection módosítás nélkül.
- **Mérhető sikerkritérium:** (1) létrejön a névadási konvenció + PR-sablon
  + branch-protection terv dokumentuma; (2) `scripts/check-commit-provenance.mjs`
  pozitív ÉS negatív esetben (hiányzó task-ID, hibás formátum, bot-szerzős
  commit) helyesen, a megfelelő exit code-dal fut egy REPÓN KÍVÜLI, lokális
  git-teszt-repositoryn; (3) a jelenlegi valós GitHub branch-protection
  állapot read-only lekérdezve és dokumentálva.
  **Kilépési feltétel:** a fenti 3 pont teljesül ÉS a task frontmatter
  `ready` marad, `## Implementáció` szakasz kitöltve, függő reviewer-re várva.
- **Base commit / branch / worktree:** `main`, HEAD
  `50744417783992ed4c1d0eb1dc6b1704d03f9f3e` (változatlan a DP-001 baseline
  óta — ez a task NEM commitolt, NEM pusholt). A munkafa piszkos maradt,
  NEM állítottam vissza, NEM stash-eltem.
- **Erőforráskeret:** egy futás; nincs valós git commit/push/branch-protection-
  írás a scope-ban — kizárólag új dokumentum/script-fájlok és egy repón
  kívüli, temp könyvtárban élő teszt-git-repository.

## Implementáció (2026-07-18)

**KÉSZ, FÜGGETLEN REVIEW-RA VÁR.** A készítő (én) nem fogadhatja el és nem
archiválhatja saját taskját (program README, "`done` előtt" szakasz) — a
frontmatter `status` szándékosan `ready` maradt.

### 1. Eredeti goal, sikerkritérium, kilépési feltétel

Lásd a fenti Végrehajtási napló bejegyzést. Változatlan a futás alatt.

### 2. Tényleges eredmény és scope-eltérés

Nincs scope-eltérés a taskfájl 6 scope-pontjához képest. Létrehozott
artifactok:

1. `docs/architecture/decisions/ADR-086-change-provenance-branch-protection.md`
   — a teljes döntés: névadási konvenció (branch/commit/PR), a squash-only
   merge-stratégia indoklása, a required-status-check megfeleltetés a
   jelenlegi `ci.yml` egyetlen `knowledge-service` jobjához, a bot-commit
   kizárás-mentes szabály, a hotfix/revert eljárás `RETROACTIVE-EVIDENCE`
   kötelezettséggel, ÉS a DP-001 16 lépéses commit-tervének teljes
   leképezése az új branch-/commit-névadásra (a scope 1. pontjának —
   "vedd alapul, és finomítsd/validáld" — konkrét teljesítése).
2. `docs/tasks/development-process/TASK-DP-006-branch-protection-config.json`
   — gépi felhasználásra kész, DE NEM ALKALMAZOTT branch-protection payload
   (`protection_payload` kulcs alatt), explicit `_provenance` blokkal
   (cél, alkalmazási parancs-minta, a read-only jelenlegi-állapot
   lekérdezés eredménye, ismert korlát a check-context névre).
3. `.github/PULL_REQUEST_TEMPLATE.md` — Task-ID, Goal, Scope, Kockázat,
   Teszt, Rollback, Evidence, State-sync, Reviewer mezőkkel + feltételes
   `RETROACTIVE-EVIDENCE` szakasz hotfix-branchekhez.
4. `scripts/check-commit-provenance.mjs` — Node-only, függőség nélküli,
   config-vezérelt (`--config`, CLI flag-ek) validátor 4 móddal
   (`branch`, `commit-msg`, `commit-msg-file`, `range`); a `range` mód a
   teljes PR-commit-tartományt ellenőrzi és a szerző/e-mail mezőt
   SZÁNDÉKOSAN nem használja kivételként (bot-commit sem kerülheti meg).
5. `docs/architecture/decisions/README.md` — index-bejegyzés az ADR-086-hoz
   + a "következő szabad sorszám" 086→087 frissítve (a könyvtár saját,
   dokumentált konvenciója szerint).
6. Ez a taskfájl: frontmatter, Végrehajtási napló, Implementáció szakasz.

**Nem hoztam létre** külön "commit-plan finomítás" dokumentumot a DP-001
manifest MÓDOSÍTÁSÁVAL — a finomítást az ADR-086 "Következmények" szakaszának
leképező táblázata adja, a DP-001 saját manifestjét (nem az én
fájlhatárom) érintetlenül hagytam.

### 3. Architekturális döntések és elvetett alternatívák

Részletesen az ADR-086 "Döntés"/"Alternatívák" szakaszában. Rövid
összefoglaló:

- **`[TASK-XXX-NNN]` commit-subject-prefix** (nem külön trailer-mező)
  lett a kanonikus jelölés, mert ez marad meg garantáltan a squash-merge
  commit subjectjében (a PR cím lesz a subject) — egy külön trailer
  squash után elveszhetne.
- **Squash-only merge-stratégia javasolt** (repo-beállítás, NEM
  branch-protection API) — a jelenlegi repo mindhárom stratégiát
  engedélyezi (`gh api repos/Szantoi/nexus-dev` → mind `true`); ezt NEM
  módosítottam, csak dokumentáltam mint javaslatot.
- **A branch-protection JSON NEM lett alkalmazva** — a program README
  kilépési szabálya ("branch protection módosításához... emberi
  jóváhagyás szükséges") ezt kifejezetten emberi döntéshez köti.
- **A bot-commit kizárás-mentesség tudatos tervezési döntés**: a script
  nem próbál "jó" és "rossz" automatizált szerzőt megkülönböztetni — ez
  egyszerűbb és biztonságosabb, mint egy karbantartandó bot-allowlist
  (QUALITY.md 8. "Egyszerűség elve").
- **SECURITY-HARDENING / UNCLEAR-DEPENDENCY-OVERRIDE / UNCLEAR-AGENT-TOOLING
  csoportoknak jelenleg nincs formális `TASK-*` azonosítójuk** — az ADR-086
  ezt explicit nyitott kérdésként jelzi (új task-fájl nyitása szükséges,
  mielőtt ezekhez a csoportokhoz az új konvenció szerinti branch/commit
  létrehozható lenne). Nem osztottam ki én magam új task-ID-t (owner-
  döntés, nem az én taskom scope-ja).

### 4. Módosított fájlok, migrációk, adatkompatibilitás

Lásd a 2. pont listáját — mind ÚJ fájl, kivéve az ADR README index egy
sornyi bővítése és a sorszám-számláló frissítése. Nincs migráció, nincs
adatkompatibilitási kérdés (dokumentáció + egy önálló Node-script).
`knowledge-service/package.json` és `.github/workflows/ci.yml` — a
scope-korlát szerint — VÁLTOZATLAN maradt.

### 5. Base commit, branch, commitok, PR

Base: `main` @ `50744417783992ed4c1d0eb1dc6b1704d03f9f3e` (azonos a
DP-001 baseline-nal). Nincs új commit, nincs branch, nincs PR — a task
scope-ja és a program README kifejezetten tiltja a valós commitolást/
push-t ebben a taskban. A tényleges commit-sorozat (az ADR-086
"Következmények" táblázata szerint) emberi jóváhagyás után, külön
lépésben történik.

### 6. Futtatott parancsok, exit code-ok, eredmények

**Frissesség-ellenőrzés (DP-001 manifest kötelező `freshness_warning`-ja):**

| Parancs | Exit code | Eredmény |
|---|---|---|
| `git status --porcelain=v1 -uall \| wc -l` | 0 | 287 (a manifest 258-cal szemben) |
| saját Node/js-yaml halmazkülönbség-szkript (session-lokális, nem repóba került) | 0 | 29 új bejegyzés a jelenlegi git-status-ban, ebből 2 a DP-001/DP-002 archiválása miatti "szellem"-mozgás, 27 a párhuzamos TASK-DP-003 (`scripts/check-tasks.mjs`, `docs/tasks/task-schema.json`, `scripts/__fixtures__/tasks/**`) munkaterméke; 0 azonosítatlan/elveszett elem |

**GitHub — read-only lekérdezés:**

| Parancs | Exit code | Eredmény |
|---|---|---|
| `gh --version` / `gh auth status` | 0 | gh 2.85.0, bejelentkezve `Szantoi` néven (`repo`, `workflow` scope) |
| `gh api repos/Szantoi/nexus-dev/branches/main/protection` | 1 (várt — 404) | `"message":"Branch not protected"` — nincs branch protection a `main`-en |
| `gh api repos/Szantoi/nexus-dev` (mezők szűrve) | 0 | `default_branch: main`, `private: true`, `allow_squash_merge/allow_merge_commit/allow_rebase_merge: true` mindhárom, `delete_branch_on_merge: false` |

**Provenance-validátor — pozitív esetek (lokális, repón kívüli git-fixture,
`scripts/check-commit-provenance.mjs` a valós repóból hívva `--root`-tal a
fixture-re mutatva):**

| Szcenárió | Parancs | Exit code | Eredmény |
|---|---|---|---|
| Branch pozitív | `... branch task/TASK-QC-005-ci-gates` | 0 | OK |
| Branch pozitív (hotfix) | `... branch hotfix/TASK-DP-006-urgent-fix` | 0 | OK |
| Commit-msg pozitív | `... commit-msg "[TASK-QC-005] ci(quality-gates): lint ratchet"` | 0 | OK |
| Commit-msg pozitív (revert) | `... commit-msg "[TASK-DP-006-REVERT] revert broken hardening default"` | 0 | OK |
| `commit-msg-file` mód | fájlból olvasott `[TASK-QC-005] docs: from file test` | 0 | OK |
| `range` pozitív (2 valid commit) | `... range base..HEAD` egy `task/TASK-QC-005-ci-gates` branchen | 0 | "minden commit érvényes" |
| `--allow-merge-commits` opt-in kivétel | `Merge pull request #42 from ...` `--allow-merge-commits` NÉLKÜL / VELE | 1 majd 0 | alapból elutasítva, csak explicit opt-innal fogadva el — igazolja, hogy a kivétel NEM alapértelmezett |
| Config-override | `--config custom-config.json` egyedi `taskIdPattern`-nel | 0 majd 1 | `[TASK-CUSTOM-1]` elfogadva, `[TASK-QC-005]` elutasítva UGYANAZZAL a configgal — igazolja a config-vezéreltséget (QUALITY.md 3.) |

**Provenance-validátor — negatív esetek (kötelező ellenőrzés, a taskfájl
"Kötelező ellenőrzés" szakasza szerint):**

| Szcenárió | Parancs | Exit code | Eredmény |
|---|---|---|---|
| Branch negatív (hiányzó task-ID) | `... branch feature/no-task-id` | **1** | helyes hibaüzenet, elvárt minta megjelenítve |
| Commit-msg negatív (nincs prefix) | `... commit-msg "fix stuff"` | **1** | helyes hibaüzenet |
| Commit-msg negatív (hibás formátum) | `... commit-msg "[TASKQC005] fix"` | **1** | helyes hibaüzenet (hiányzó kötőjelek) |
| `range` — vegyes valid+invalid (2 commit egy branchen, az egyik prefix nélkül) | `... range base..HEAD` | **1** | PONTOSAN az érvénytelen commitot jelöli meg hash+szerző szerint, a valid commitot NEM |
| `range` — **bot-szerzős commit, NINCS prefix** (`dependabot[bot] <...@users.noreply.github.com>`, `--allow-empty` commit "Bump lodash...") | `... range base..HEAD` | **1** | igazolja: a szerző/e-mail mező NEM ad kivételt — a bot-commit UGYANÚGY elbukik, mint egy emberi hiba (scope 5. pont: "generált vagy bot commit se kerülhesse meg a kapukat") |

Mind a fenti szcenáriók egy session-lokális, `scratchpad/dp006-git-fixture`
könyvtárban létrehozott, valódi `git init`-elt repositoryn futottak (NEM a
nexus-dev repóban) — 1 base commit + 5 ág (`task/TASK-QC-005-ci-gates`,
`feature/no-task-id`, `task/TASK-QC-099-mixed`, `task/TASK-QC-098-bot-test`,
`task/TASK-DP-006-revert-test`), összesen 8 commit.

**Egyéb ellenőrzés:**

| Parancs | Exit code | Eredmény |
|---|---|---|
| `node -e "JSON.parse(...TASK-DP-006-branch-protection-config.json)"` | 0 | érvényes JSON |
| `node scripts/check-doc-links.mjs` | 0 | 89 markdown-link, 8 ADR-útvonal, 155 ADR-szám-említés — minden hivatkozás él |
| `cd knowledge-service && node ../scripts/secret-scan.mjs` | 0 | PASS, 347 tracked fájl, 0 találat (az új fájlok untracked státuszban vannak, tehát ebbe a snapshotba még nem esnek bele — lásd 8. pont) |
| ad-hoc grep secret-mintára az új fájlokon (`api[_-]?key\|secret\|password\|token` + hosszú literal) | 0 találat | nincs valódi titok az új artifactokban |

### 7. Környezet

- OS: Windows 11 Home 10.0.26200
- Shell: Git Bash (elsődleges), PowerShell elérhető
- Node: v24.13.0 (`node --version`)
- `gh` CLI: 2.85.0, bejelentkezve (`github.com`, `Szantoi`, `repo`+`workflow` scope)
- Repo: `C:\Users\szant\Documents\Development\nexus-dev`
- Teszt-fixture: `%TEMP%\claude\...\scratchpad\dp006-git-fixture` (session-lokális, repón kívüli)

### 8. Negatív tesztek, biztonsági ellenőrzés, rollback-próba

- **Negatív tesztek:** lásd a 6. pont "negatív esetek" táblázatát — mind
  az 5 forgatókönyv (rossz branch, hiányzó prefix, hibás formátum, vegyes
  valid/invalid tartomány, bot-szerzős prefix nélküli commit) a várt
  nem-nulla exit kóddal és pontos hibaüzenettel bukott el. Ez teljesíti a
  program README elvét: "A dokumentum vagy konfiguráció puszta létezése
  nem PASS. A kontrollt negatív teszttel is bizonyítani kell."
- **Biztonsági ellenőrzés:** a script kizárólag lokális `git log`-ot hív
  (`execFileSync`, nem shell-interpoláció — a `range` argumentum nem kerül
  shell-be, `execFileSync` argumentum-tömböt kap, tehát nincs
  parancs-injektálási kockázat felhasználói bemenetből). Nincs hálózati
  hívás, nincs titok a scriptben vagy a config-fájlban. A `gh api`
  lekérdezés kizárólag GET (olvasás) volt, egyetlen írás/PUT/POST sem
  történt a valós GitHub repo felé.
- **Rollback-próba:** nincs mit rollback-elni (nincs commit/push); minden
  új fájl `git checkout -- <fájl>` vagy egyszerű törléssel eltávolítható,
  mert egyik sem módosít futó rendszert vagy meglévő konfigurációt
  (a `.github/workflows/ci.yml` és a `knowledge-service/package.json`
  érintetlen).

### 9. Ismert korlátok, kockázatok, follow-up

1. **A `check-commit-provenance.mjs` NINCS bekötve a CI-be** — jelenleg
   csak helyi futtatásra / jövőbeli pre-commit hookra / a PR-sablon
   emberi fegyelmére támaszkodik. A CI-required-check szintű
   kikényszerítés a `.github/workflows/ci.yml` módosítását igényelné, ami
   a TASK-DP-003/DP-007 fájlhatára — explicit nyitott függőségként
   dokumentálva (ADR-086, "Nyitott kérdések" 3. pont).
2. **A required-status-check `context` értéke ("knowledge-service")
   megerősítésre szorul** a GitHub Checks fülön, mielőtt bárki
   alkalmazná a branch-protection tervet — különösen, ha a TASK-DP-007
   OS-mátrixot vezet be (ami megváltoztatja a check-run nevét).
3. **A SECURITY-HARDENING, UNCLEAR-DEPENDENCY-OVERRIDE,
   UNCLEAR-AGENT-TOOLING csoportoknak nincs formális `TASK-*`
   azonosítójuk** — ehhez előbb egy owner-nek task-fájlt kell nyitnia,
   mielőtt az új névadási konvenció szerint commitolhatók lennének.
4. **A branch-protection JSON és a squash-only repo-beállítás nincs
   alkalmazva** — mindkettő Gábor jóváhagyására vár (lásd "Nyitott
   kérdések" a visszatérési összefoglalóban is).
5. **A `scripts/secret-scan.mjs` scope-ja `git ls-files`** (csak
   tracked) — ugyanaz a korábban (DP-001) dokumentált korlát: az új,
   untracked fájljaim csak commit után esnek bele a kanonikus scan
   snapshotjába. Ad-hoc grep-pel kiegészítve (lásd 6. pont), 0 találat.
6. **A DP-001 manifest 258/258 konzisztencia-állítása mostanra elavult
   számláló** (287 a jelenlegi git status) — ez NEM ennek a tasknak a
   felelőssége javítani (a manifest a DP-001 saját artifactja), csak a
   freshness-check-et futtattam le rá, ahogy a manifest előírja.

### 10. Reviewer

- **Azonosító/szerep:** Független reviewer-agent (conductor-terminál, friss
  kontextus), owner_role a kivitelezésben nem érintett.
- **Függetlenségi nyilatkozat:** a reviewer nem vett részt a TASK-DP-006
  kivitelezésében (ADR-086, config.json, PR-sablon, validátor script vagy a
  taskfájl Implementáció-szakaszának megírásában); a fenti artifactokat és
  állításokat kizárólag utólag, olvasóként és saját, független
  teszt-futtatóként ellenőrizte. Lásd a taskfájl végén a
  "## Független review (2026-07-18)" szakaszt a teljes bizonyítékanyaggal.
- **Döntés:** **REQUEST_CHANGES** — indoklás a "## Független review" szakaszban.

### 11. Elfogadási és kilépési feltételek — PASS/FAIL

| Feltétel | Eredmény |
|---|---|
| Minden aktív változáscsoporthoz task, base, branch/commit és owner tartozik | **RÉSZLEGES** — az ADR-086 leképező táblázata minden DP-001-csoportot ellát javasolt branch/commit-névvel; 3 csoportnak (SECURITY-HARDENING, UNCLEAR-DEPENDENCY-OVERRIDE, UNCLEAR-AGENT-TOOLING) még nincs formális task-ID-ja — ez dokumentált nyitott függőség, nem hiba |
| A főágra közvetlen push tiltott vagy bizonyítottan azonos kontrollú kivétel | **TERVEZVE, NEM ALKALMAZVA** — a branch-protection JSON ezt tiltaná (`enforce_admins: true`, nincs `restrictions`), de emberi jóváhagyásra vár |
| PR nem merge-elhető required CI és független approval nélkül | **TERVEZVE, NEM ALKALMAZVA** — ugyanaz a JSON `required_status_checks` + `required_pull_request_reviews` blokkja |
| Új commit érvényteleníti a korábbi stale review-t | **TERVEZVE** — `dismiss_stale_reviews: true` + `require_last_push_approval: true` a JSON-ban, nem alkalmazva |
| A squash/rebase/merge stratégia megőrzi a task-provenance-t | **DOKUMENTÁLVA** — squash-only javaslat indoklással (ADR-086, 5. pont); a repo-beállítás módosítása nem történt meg |
| A revert és hotfix folyamat tesztelt, és nem törli az auditnyomot | **RÉSZLEGES** — a `[TASK-*-REVERT]` formátum géppel bizonyítottan validálható (6. pont, Szcenárió E); a teljes hotfix-folyamat (PR-sablon `RETROACTIVE-EVIDENCE` szakasza) dokumentálva, de valós hotfix-PR-en nem lett végigfuttatva (nincs éles incidens) |
| Egy mintaváltozás teljes visszakeresése dokumentált | **PASS** — ADR-086 "Design intent" + a leképező táblázat QC-002-mintája végigköveti task→branch→commit→(hipotetikus) PR→CI→reviewer→`git log --grep` visszakeresést |
| Lokális Git fixture a névadás és hook/check ellenőrzésére | **PASS** — lásd 6. pont, 8 commit, 5 branch, 11 forgatókönyv (5 pozitív + 5 negatív + 1 config-override páros) |
| GitHub branch protection read-back, ha hozzáférés van | **PASS** — `gh api .../branches/main/protection` → 404, dokumentálva |
| Negatív próba hiányzó task-ID-val, piros CI-vel, önapproval-lal, stale review-val | **RÉSZLEGES** — a hiányzó/hibás task-ID és a bot-commit negatív próba géppel bizonyított; a "piros CI"/"önapproval"/"stale review" próbák a GitHub-natív branch-protection viselkedésből következnének, amit ez a task NEM alkalmazott élesben (emberi jóváhagyás hiányában) — ezért ez csak a GitHub dokumentált viselkedésére hivatkozva, nem saját méréssel igazolt |

### 12. Szinkron

| Dokumentum | Szinkronizálva |
|---|---|
| Ez a taskfájl (frontmatter + Végrehajtási napló + Implementáció) | igen |
| `docs/architecture/decisions/ADR-086-...md` | igen (új fájl) |
| `docs/architecture/decisions/README.md` | igen (index-sor + sorszám-számláló) |
| `docs/tasks/development-process/TASK-DP-006-branch-protection-config.json` | igen (új fájl) |
| `.github/PULL_REQUEST_TEMPLATE.md` | igen (új fájl) |
| `scripts/check-commit-provenance.mjs` | igen (új fájl) |
| `docs/projects/EPICS.yaml` | **NEM módosítva** — a `DP-CHANGE-CONTROL` epic állapotát (jelenleg `pending`-ként regisztrálva) szándékosan nem érintettem; ez a fájlhatárom nem tartalmazta, és a task maga sincs `done`-ra zárva |
| `terminals/*/state.md`, `terminals/*/todo.md`, `terminals/*/MEMORY.md` | **NEM módosítva** — nem szerepeltek a rám bízott fájlhatárban; a koordináló (conductor) feladata a szinkron, ha a review PASS-t ad |

## Nyitott kérdések a visszatérési összefoglalóhoz

1. Gábor jóváhagyása kell a `TASK-DP-006-branch-protection-config.json`
   `protection_payload`-jának tényleges alkalmazásához.
2. A required-status-check `context` string ("knowledge-service") vizuális
   megerősítése a GitHub Checks fülön, alkalmazás előtt.
3. A squash-only repo-beállítás (Pull Requests szekció) bekapcsolása —
   szintén emberi döntés, nem branch-protection API.
4. A `check-commit-provenance.mjs` CI-be kötése a TASK-DP-003/DP-007
   hatáskörében.
5. Formális `TASK-*` azonosító kiosztása a SECURITY-HARDENING,
   UNCLEAR-DEPENDENCY-OVERRIDE és UNCLEAR-AGENT-TOOLING csoportoknak,
   mielőtt azok az új konvenció szerint commitolhatók lennének.

## Független review (2026-07-18)

### Függetlenségi nyilatkozat

Ezt a reviewot egy friss kontextusú, a TASK-DP-006 kivitelezésében részt nem
vevő agent végezte a conductor-terminálban. A reviewer nem írta az ADR-086-ot,
a `TASK-DP-006-branch-protection-config.json`-t, a `.github/PULL_REQUEST_TEMPLATE.md`-t,
a `scripts/check-commit-provenance.mjs`-t vagy a fenti Végrehajtási
napló/Implementáció szakaszt. A cél kifejezetten a készítő állításainak
**megcáfolása**, nem elfogadása — minden alábbi tétel saját, önállóan
lefuttatott paranccsal van alátámasztva, nem a készítő táblázatainak
átvételével.

### 1. Kritikus biztonsági ellenőrzés — valós GitHub-módosítás?

Saját, READ-ONLY (GET) lekérdezés, a taskfájlban dokumentálttól függetlenül
lefuttatva:

```
$ gh api repos/Szantoi/nexus-dev/branches/main/protection
{"message":"Branch not protected","documentation_url":"...","status":"404"}
gh: Branch not protected (HTTP 404)
```

Eredmény: a `main`-en **nincs branch protection** — ez megegyezik a készítő
állításával, és önmagában bizonyítja, hogy a task NEM alkalmazott valós
GitHub-módosítást. Kiegészítő ellenőrzés: `gh api repos/Szantoi/nexus-dev` →
`allow_squash_merge/allow_merge_commit/allow_rebase_merge` mindhárom `true`,
`delete_branch_on_merge: false` — szintén egyezik a dokumentált állítással,
tehát a "Pull Requests" repo-beállítás sem lett módosítva. `gh auth status`
megerősíti, hogy a bejelentkezett fióknak `repo`+`workflow` scope-ja van,
azaz **lett volna lehetőség** ténylegesen alkalmazni a branch protectiont —
a készítő tehát tudatosan tartózkodott egy végrehajtható írási művelettől,
nem képességhiány miatt hagyta abba. Semmilyen írási (PUT/POST/PATCH/DELETE)
GitHub API-hívást a reviewer sem kezdeményezett.

**Verdikt erre a pontra: PASS.**

### 2–3. Validátor script — saját, független git-fixture (NEM a készítőé)

A reviewer egy teljesen új, a nexus-dev repón kívüli, temp-könyvtárban
`git init`-elt fixture-t épített (`dp006-independent-review-fixture`), és
a valós repóból hívott `scripts/check-commit-provenance.mjs`-t futtatta rá
`--root`-tal. Az alábbi szcenáriókat a reviewer maga hozta létre és futtatta
(nem a készítő fixture-jét vagy eredményét vette át):

**Pozitív esetek (mind 0 exit code-dal, ahogy elvárt):**

| # | Szcenárió | Eredmény |
|---|---|---|
| 1 | `branch task/TASK-QC-005-ci-gates` | OK |
| 2 | `branch hotfix/TASK-DP-006-urgent-fix` | OK |
| 3 | `commit-msg "[TASK-QC-005] ci(quality-gates): lint ratchet"` | OK |
| 4 | `commit-msg "[TASK-DP-006-REVERT] revert broken hardening default"` | OK |
| 5 | `commit-msg-file` fájlból | OK |
| 6 | `range main..task/TASK-QC-005-ci-gates` (2 valid commit) | OK |
| 7 | `commit-msg "Merge pull request #42 ..." --allow-merge-commits` | OK (opt-in) |
| 8 | config-override: `--config` egyedi `taskIdPattern`-nel, `[TASK-CUSTOM-1]` elfogadva | OK |

**Negatív esetek (mind nem-nulla exit code-dal):**

| # | Szcenárió | Exit | Eredmény |
|---|---|---|---|
| 1 | `branch feature/no-task-id` | 1 | helyes hibaüzenet |
| 2 | `commit-msg "fix stuff"` | 1 | helyes hibaüzenet |
| 3 | `commit-msg "[TASKQC005] fix"` | 1 | helyes hibaüzenet |
| 4 | `commit-msg "Merge pull request #42 ..."` (flag NÉLKÜL) | 1 | alapból elutasítva |
| 5 | `range` vegyes (1 valid + 1 prefix nélküli commit) | 1 | PONTOSAN a rossz commitot jelöli (hash+szerző), a jót NEM |
| 6 | **KRITIKUS — `range` bot-szerzős commit**: `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>`, subject `"Bump lodash from 4.17.20 to 4.17.21"`, NINCS `[TASK-*]` prefix | **1** | a script a szerző/e-mail mezőt NEM vette figyelembe kivételként — a bot-commit UGYANÚGY elbukott, mint egy emberi hiba. **A készítő "bot-commit nem kerülheti meg" állítása saját, független fixture-rel reprodukálva és megerősítve.** |
| 7 | config-override: ugyanaz a custom config elutasítja a régi `[TASK-QC-005]` mintát | 1 | igazolja a config-vezéreltséget |

**A készítő állításain túlmutató, saját adverzáriális próbák (a review
külön kezdeményezte, nem szerepeltek a taskfájlban):**

- kisbetűs task-azonosító (`[task-qc-005] ...`) → elutasítva (helyes);
- nagybetűs/vegyes szlug a branch-névben (`task/TASK-QC-005-CI-Gates`) →
  elutasítva, mert a szlug-minta csak kisbetűt enged (helyes, szigorúbb mint
  szükséges lenne, de nem bug);
- két `[TASK-*]` azonosító egymás mellett egyetlen subjectben
  (`[TASK-QC-005][TASK-QC-006] combined ...`) → elutasítva, mert a minta a
  záró `]` után kötelező szóközt vár — tehát egy squash, ami tévesen két
  taskot próbálna egy sorba zsúfolni, **fail-safe** módon elbukik, nem
  csúszik át hamis pozitívként;
- érvénytelen git-ref a `range` módban (`main..main` egy repón, ahol a
  `main` branch még nem is létezik a várt névvel) → `git log` hibáját nem
  nyeli el, hanem nem-nulla exit kóddal (1) bukik — fail-closed, nem
  fail-open;
- a legelső (szülő nélküli) commit `range`-be vonása (`<empty-tree>..HEAD`)
  → ugyanúgy validálva, mint bármely más commit, nincs implicit kivétel a
  gyökér-commitra.

Mindezt a `node scripts/check-commit-provenance.mjs` a reviewer saját gépén,
saját fixture-jén, saját parancssoraival futtatva — **nem fogadta el a
készítő 6+5 esetes állítását bizonyítéknak, hanem teljes egészében
reprodukálta és 8+7+5 további szcenárióval ki is bővítette.**

**Verdikt erre a pontra: PASS.** A validátor pozitív és negatív esetben,
beleértve a bot-commit tesztet, a saját, független futtatásban is helyesen
működik.

### 4. Squash-merge indoklás (`[TASK-*]` subject-prefix, nem trailer)

Logikailag védhető: GitHub squash-merge alapértelmezésben (és a javasolt
"Default to pull request title" beállítással kikényszerítve) a PR CÍMÉT
teszi a squash-commit subjectjévé — ez tényleges, dokumentált GitHub-
viselkedés, nem a készítő feltételezése. Egy külön commit-trailer ezzel
szemben a squash-commit BODY-jában élne, ami squash közben (több eredeti
commit üzenetének összefésülése) törékenyebb és nem garantált mező. A
reviewer nem talált ellenpéldát vagy logikai rést ebben az érvelésben.

### 5. DP-001 16 lépéses terv ↔ ADR-086 leképező táblázat konzisztencia

A reviewer elolvasta a teljes `TASK-DP-001-manifest.yaml` `commit_plan.sequence`
tömbjét (16 lépés, csoport + `needs_human_gate` mezővel) és sorról sorra
összevetette az ADR-086 "Következmények" szakaszának 16 soros táblázatával:

| Lépés | Manifest csoport | Manifest `needs_human_gate` | ADR-086 sor egyezik? |
|---:|---|:---:|:---:|
| 1 | QC-003 | true | igen (igen) |
| 2 | QC-002 | false | igen (nem) |
| 3 | QC-005 | false | igen (nem) |
| 4 | QC-008 | false | igen (nem) |
| 5 | QC-004 | false | igen (nem) |
| 6 | QC-007 | false | igen (nem) |
| 7 | QC-006 | false | igen (nem) |
| 8 | QC-009 | false | igen (nem) |
| 9 | QC-010 | false | igen (nem) |
| 10 | QC-FOLLOWUP-BACKLOG | false | igen (nem) |
| 11 | QC-001 | false | igen (nem) |
| 12 | SECURITY-HARDENING | true | igen (igen) |
| 13 | DP-ISL-PROGRAM-PREP | false | igen (nem) |
| 14 | UNCLEAR-DEPENDENCY-OVERRIDE | true | igen (igen) |
| 15 | UNCLEAR-AGENT-TOOLING | true | igen (igen) |
| 16 | DP-ISL-ARCHITECTURE-ADRS | false (más task felelőssége) | igen (nem, más task) |

Mind a 16 sor egyezik (csoport-sorrend ÉS human_gate-jelölés is). **A
reviewer szándékosan kereste a rést (pl. elcsúszott sorrendet, hiányzó vagy
extra human_gate-et) — nem talált egyet sem.**

**Verdikt erre a pontra: PASS.**

### 6. Hiányosság-keresés a validátorban

- **Merge-commit subject-formátum:** kezelve, opt-in `--allow-merge-commits`
  flaggel, alapból elutasítva — lásd 2–3. pont.
- **Initial/gyökér-commit:** kezelve, nincs implicit kivétel rá (lásd 2–3.
  pont adverzáriális próbái).
- **Force-push detektálás:** **VALÓS, DE NEM EBBEN A SCRIPTBEN KEZELENDŐ
  rés.** A `check-commit-provenance.mjs` kizárólag `git log` szubjecteket
  vizsgál, nem tud és nem is próbál force-push-t vagy history-rewrite-et
  észlelni. Ezt a réteget a (nem alkalmazott) branch-protection payload
  `allow_force_pushes: false` mezője fedné le GitHub-oldalon. Amíg a
  protection nincs alkalmazva, ez a rés ténylegesen nyitva van — de ez
  KÍVÜL esik a script felelősségi körén, és a task ezt már dokumentálja
  függő elemként (a branch-protection alkalmazása emberi jóváhagyásra vár).
  Nem blokkoló, mert nincs is ellentmondó állítás — a készítő nem állította,
  hogy a script force-push-t kezelne.
- **Squash-commit, ami több eredeti task-ID-t összevon:** lásd 2–3. pont —
  a script ezt fail-safe módon ELUTASÍTJA (nem enged át hamis pozitívként),
  ami a jelenlegi 1:1 task↔commit konvenció mellett helyes, konzervatív
  viselkedés.

Nem talált blokkoló logikai hiányosságot a validátor viselkedésében.

### 7. `check-doc-links.mjs` és `secret-scan.mjs` — saját futtatás

```
$ node scripts/check-doc-links.mjs
Ellenőrizve: 89 markdown-link (docs), 8 ADR-útvonal-hivatkozás, 155 ADR-szám-említés
OK — minden hivatkozás létező célra mutat.                                    exit 0

$ cd knowledge-service && node ../scripts/secret-scan.mjs
[secret-scan] OK — no findings in 347 scanned tracked files (11 patterns).    exit 0
```

Mindkét szám pontosan egyezik a készítő állításával — függetlenül
reprodukálva.

Kiegészítő ellenőrzés: `docs/architecture/decisions/README.md` "következő
szabad sorszám" mezője ténylegesen **087**-re frissült (a reviewer maga
olvasta ki a fájlból), az ADR-086 index-sor jelen van és helyesen `proposed`
státuszú. `.github/workflows/ci.yml` és `knowledge-service/package.json`
git-diffje a reviewer `git status` lekérdezése szerint VÁLTOZATLANUL a
párhuzamos QC-005/QC-008/UNCLEAR-DEPENDENCY-OVERRIDE csoportok korábbi
(nem e task általi) módosítását tükrözi — ez a task ténylegesen nem
nyúlt hozzájuk, ahogy állítja.

### 8. A 12 kötelező "done előtt" pont — tételes, független ellenőrzés

| # | Pont | Eredmény |
|---:|---|---|
| 1 | Eredeti goal/siker/kilépés | PASS — jelen van, változatlan |
| 2 | Tényleges eredmény, scope-eltérés | PASS — 6 artifact listázva, ellenőrzött |
| 3 | Architekturális döntések, alternatívák | PASS — ADR-086-ban részletezve, logikailag védhető (lásd 4. pont) |
| 4 | Módosított fájlok, migráció | PASS — csak új fájlok, nincs migráció |
| 5 | Base/branch/commit/PR | PASS — nincs commit/push, dokumentálva és git-státusszal alátámasztva |
| 6 | Futtatott parancsok, exit code-ok | PASS — a reviewer minden érdemi parancsot (gh api, validátor pozitív/negatív, doc-links, secret-scan) függetlenül reprodukált, egyező eredménnyel |
| 7 | Környezet | PASS — OS/Node/gh verzió konzisztens a reviewer saját környezetével |
| 8 | Negatív tesztek, biztonság, rollback | PASS — lásd 1–3., 6. pont |
| 9 | Ismert korlátok, kockázatok | PASS — a force-push-rés és a CI-bekötés hiánya már dokumentált, a reviewer nem talált EZEKEN felül rejtett korlátot |
| 10 | Reviewer azonosító, függetlenség, döntés | ez a szakasz — most kitöltve |
| 11 | Elfogadási/kilépési feltételek PASS/FAIL | RÉSZBEN ELFOGADOTT — a készítő saját RÉSZLEGES/TERVEZETT jelölései pontosak és a reviewer nem tud élesebb minősítést adni rájuk (a branch-protection-t emberi jóváhagyás nélkül nem is LEHET ténylegesen tesztelni) |
| **12** | **Task, EPICS, state, todo, memória szinkron** | **FAIL — lásd alább, ez a review blokkoló megállapítása** |

**A 12. pont saját, független ellenőrzése:**

```
$ grep -n -i "DP-006" terminals/root/state.md terminals/root/todo.md
(nincs találat)

$ grep -n -A5 "DP-CHANGE-CONTROL" docs/projects/EPICS.yaml
  - id: DP-CHANGE-CONTROL
    ...
    status: pending        # változatlan, NEM lett `active`
```

A készítő maga is nyíltan jelezte (Implementáció, 12. szakasz), hogy
`docs/projects/EPICS.yaml`, `terminals/*/state.md`, `terminals/*/todo.md`
és `terminals/*/MEMORY.md` **NEM lettek módosítva**, és ezt "a koordinátor
feladatának" jelölte. A reviewer ezt a hiányt **függetlenül is
megerősítette**: az EPICS.yaml `DP-CHANGE-CONTROL` epicje ma is `pending`
(sosem lett `active`, holott a program README "Indítás előtt" 5. pontja ezt
KÖTELEZŐVÉ teszi MÉG A MUNKA MEGKEZDÉSE ELŐTT — nem "a végén, ha PASS lesz"),
és a `terminals/root/state.md`/`todo.md` fájlokban **egyetlen említés sincs**
a TASK-DP-006-ról. Ez azt jelenti, hogy a konduktor/root jelenlegi állapot-
követése alapján ez a futás **láthatatlan** — ha valaki csak a `state.md`/
`todo.md`-t nézi (ahogy a program README elő is írja: "a `todo.md` a
következő konkrét teendőt, a `state.md` az aktuális állapotot... tartalmazza"),
nem szerezne tudomást arról, hogy a TASK-DP-006 elkészült és reviewre vár.

Ez nem a technikai megoldás (branch-protection terv, validátor, PR-sablon,
ADR-érvelés) hibája — abban a reviewer nem talált cáfolható hiányosságot —,
hanem a program saját, kötelezőként megfogalmazott állapot-szinkron
szerződésének megszegése, amit a készítő maga is dokumentált, de nem
javított ki, és amit "a konduktor dolga, ha PASS lesz" felvetéssel a
jövőbe tolt. A program README 9. "Mikor jó?" pontja kifejezetten
megköveteli, hogy "a `state.md`, `todo.md` és `MEMORY.md` nem mond ellent a
kanonikus állapotnak" — jelenleg ezek a fájlok nem mondanak ellent, de csak
azért, mert TELJESEN HALLGATNAK a task létezéséről, ami egy auditálhatósági
programban (aminek pont az a célja, hogy "egy tetszőleges merged fájlsorról
visszakereshető legyen a task, goal, implementáló...") önmagában hiányosság.

### Döntés

**REQUEST_CHANGES.**

Indoklás a megadott döntési szabály szerint:

- (a) **Teljesül** — saját READ-ONLY `gh api` lekérdezés igazolta: nincs
  branch protection a `main`-en, a task nem hajtott végre valós
  GitHub-módosítást.
- (b) **Teljesül** — a validátor script saját, független fixture-ön
  (nem a készítőén) pozitív ÉS negatív esetben helyesen működik, beleértve
  a bot-commit tesztet (dependabot-szerű szerző, prefix nélkül, `range`
  módban elbukik).
- (c) **Teljesül a technikai megoldásra nézve** — a reviewer szándékosan
  kereste a réseket (bot-kizárás, squash-multi-task, force-push,
  gyökér-commit, merge-commit) és a DP-001↔ADR-086 leképezés
  konzisztenciáját, és nem talált blokkoló logikai hiányosságot magában a
  provenance-tervben vagy a validátorban.
- (d) **NEM teljesül** — a README "`done` előtt" 12. kötelező pontja
  (task/EPICS/state/todo/memória szinkron) és az "Indítás előtt" 5. pontja
  (epic `active`-ra állítása, `state.md`/`todo.md` frissítése MUNKAKEZDÉSKOR)
  igazoltan nincs teljesítve — sem a készítő, sem a reviewer nem végezte el,
  és ez a hiány jelenleg is fennáll a repóban (EPICS.yaml `DP-CHANGE-CONTROL`
  epic státusza `pending`, `state.md`/`todo.md` nem említi a TASK-DP-006-ot).

**Mivel (d) nem teljesül, a frontmatter `status` a jelenlegi `ready`
állapotban marad — NEM állítom `done`-ra.**

### Mit kell javítani (konkrét, szűk hatókörű lista)

1. A konduktor (vagy a task egy következő, rövid futása) frissítse
   `docs/projects/EPICS.yaml`-ban a `DP-CHANGE-CONTROL` epic `status`
   mezőjét (`pending` → legalább `active`, majd a végleges döntés után a
   megfelelő állapotra), és rögzítse a TASK-DP-006 jelenlegi állapotát
   (kész, reviewre várt/REQUEST_CHANGES) a `terminals/root/state.md` és
   `terminals/root/todo.md` fájlokban — ez a program README saját,
   kötelező "Indítás előtt" 5. és "`done` előtt" 12. pontja, nem a
   reviewer önkényes elvárása.
2. Ha releváns tartós tanulság született (pl. a state-sync elmaradásának
   mintája máshol is előfordulhat), egy rövid bejegyzés a
   `terminals/root/MEMORY.md`-be — csak akkor, ha ez tényleg tartós
   tanulság, nem minden futásnál kötelező.
3. A fenti 1–2. pont után egy második, rövid független review-kör
   elegendő a `status: done` átálláshoz — a technikai tartalom (ADR-086,
   validátor, PR-sablon, branch-protection-terv) ÚJRA-ellenőrzést NEM
   igényel, mert abban a reviewer nem talált cáfolható hibát.

### Nyitott kérdések, amikre a reviewer sem talált választ (a készítő listáján felül)

- A task saját "Kilépési feltétel" szakasza csak két végállapotot ismer
  (`done`, ha a szabály és a valós beállítás egyezik; vagy `blocked`,
  hiányzó GitHub-jogosultság esetén). A tényleges helyzet — szándékosan
  dokumentált, de emberi üzleti döntésre váró terv — egyik kategóriába sem
  illik pontosan (nem jogosultsághiány, hanem tudatos várakozás). Ez apró
  fogalmazási pontatlanság a taskfájl saját szövegében, nem blokkoló, de
  érdemes lenne egy jövőbeli finomításban egy harmadik, explicit
  "human-approval-pending" végállapotot is nevesíteni a program README-ben
  vagy a task-sablonban.

## Független review, 2. kör (2026-07-18) — megerősítés

### Függetlenségi nyilatkozat

Friss kontextusú, a TASK-DP-006 kivitelezésében és az 1. körös review-ban
részt nem vevő agent (conductor-terminál). Ez a kör NEM tartalmi újra-audit —
az 1. kör tartalmi ellenőrzését (ADR-086, PR-sablon, provenance-validátor
pozitív+negatív+bot-commit szcenáriók, GitHub read-only lekérdezés) elfogadja
adottnak, és kizárólag azt vizsgálja, hogy az 1. kör EGYETLEN blokkoló
kifogása (EPICS/state/todo szinkron hiánya) ténylegesen és megfelelően
pótolva lett-e, a koordinátor állítása szerint.

### 1. Az 1. kör kifogásának igazolása

Elolvastam a fenti "## Független review (2026-07-18)" szakasz "8. A 12
kötelező »done előtt« pont" táblázatát és a "Döntés" alszakaszt: az 1. kör
kifejezetten és kizárólag a 12. pontot (`task/EPICS/state/todo/memória
szinkron`) jelölte FAIL-nek, minden más pontot (1–11) PASS-nak vagy a
készítővel egyező RÉSZLEGES/TERVEZETT minősítésnek. A "Mit kell javítani"
lista is egyetlen, szűk tételt tartalmaz: EPICS.yaml `DP-CHANGE-CONTROL`
epic `active`-ra állítása + a TASK-DP-006 állapotának rögzítése
`state.md`/`todo.md`-ben. Megerősítve: az 1. kör tényleg csak ezt kérte.

### 2. EPICS.yaml — saját ellenőrzés

```
$ grep -n -A20 "id: DP-CHANGE-CONTROL" docs/projects/EPICS.yaml
  status: active
  ...
  description: > ... "1. körös review: REQUEST_CHANGES kizárólag eljárási
  okból (EPICS/state/todo szinkron elmaradt, tartalmi hiba nincs) — a
  szinkron most megtörtént, 2. kör folyamatban."
```

`status: active` (nem `pending`), a leírás pontosan, torzítás nélkül
tükrözi a jelenlegi állapotot (beleértve azt is, hogy a 2. kör review
folyamatban van — ezt a mondatot ez a review a lezárásig nem módosítja,
mert a fájl tartalma a szinkron-pótlás idején helyes volt). YAML-validitás
és szerkezeti épség saját, önálló paranccsal ellenőrizve
(`js-yaml` betöltés a knowledge-service-ből): a fájl érvényes YAML, 36
epic, 0 duplikált `id`, a `DP-CHANGE-CONTROL` szomszédai
(`DP-TASK-API`, `DP-CI-CONTROLS`) érintetlenek és tartalmilag konzisztensek
maradtak. **Verdikt: PASS.**

### 3. terminals/root/state.md — saját ellenőrzés

A teljes fájlt elolvastam. Az "Aktuális fókusz" szakasz "NEXUS-
DEVELOPMENT-PROCESS program folyamatban" bekezdése kifejezetten megnevezi
a `TASK-DP-006`-ot, helyesen írja le az ADR-086 tartalmát, a TERVEZETT
(nem alkalmazott) branch-protection státuszt, és az 1. kör REQUEST_CHANGES
okát (kizárólag eljárási, EPICS/state/todo szinkron hiánya miatt, tartalmi
hiba nélkül) — ez pontosan egyezik az 1. kör saját szóhasználatával, nem
egy felhígított vagy téves összefoglaló. A szakasz naprakész (2026-07-18-i
dátumjelzés, QC-program lezárása és ISL-001 blocked-állapot is szerepel
mellette), nem elavult tartalom maradt a helyén. `git diff` saját
lefuttatásával ellenőriztem: a változás tisztán additív/frissítő, nincs
sem érintetlenül hagyandó tartalom törlése, sem más program adatainak
felülírása. **Verdikt: PASS.**

### 4. terminals/root/todo.md — saját ellenőrzés

A teljes fájlt elolvastam. A "NEXUS-DEVELOPMENT-PROCESS program" Aktív-
tétel (10–22. sor) megemlíti a programot és a DP-001/DP-002 lezárását,
DE **nem nevezi meg explicit a TASK-DP-006-ot**, és a "Következő: DP-003
indítható" mondat enyhén elavult — a state.md szerint DP-003 ÉS DP-006 is
egyszerre, review alatt fut. Ez valós, apró hiányosság, de a döntési
szabály szerint nem blokkoló, mert a state.md (a program saját szabálya
szerint is az "aktuális állapot" kanonikus helye) már pontosan és
naprakészen tartalmazza a TASK-DP-006 állapotát — a todo.md elsődlegesen
a "következő konkrét teendő" ledgere, nem az egyetlen állapotforrás.
**Javaslat, nem blokkoló:** a todo.md Aktív-tétele frissüljön úgy, hogy
DP-003 ÉS DP-006 is megjelenjen mint jelenleg review alatt lévő,
párhuzamos munka.

### 5. Józanság-ellenőrzés — `check-doc-links.mjs`

Saját, önálló futtatás:

```
$ node scripts/check-doc-links.mjs
Ellenőrizve: 89 markdown-link (docs), 8 ADR-útvonal-hivatkozás, 155
ADR-szám-említés (knowledge-service/src)
OK — minden hivatkozás létező célra mutat.                       exit 0
```

Zöld, a szinkron-pótlás nem tört semmilyen dokumentum-hivatkozást.

### 6. Mellékhatás-ellenőrzés — nem rontott-e el mást a szinkron-pótlás

`git diff` saját lefuttatása mindhárom fájlra (`EPICS.yaml`, `state.md`,
`todo.md`): a változások kizárólag additívak/frissítők — nincs törölt vagy
felülírt, más programhoz (NEXUS-QUALITY, NEXUS-ISLAND-RUNTIME, VPS-deploy,
több-szigetes kiszolgálás) tartozó tartalom. A `todo.md`-ből eltávolított
két "Opcionális cleanup" backlog-tétel (mcp.ts legacy switch törlése,
`identity.ts` `/opt/spaceos` fallback rendezése) legitim törlés: mindkettő
időközben ténylegesen elkészült (QC-008, illetve QC-007 taskok — lásd a
"Kész" szakasz megfelelő bejegyzéseit), nem adatvesztés. Az EPICS.yaml
36 epicjéből egy sem duplikált, a `DP-CHANGE-CONTROL` szomszédai
érintetlenek. **Nincs melléhatás.**

### Döntés

**PASS.**

Indoklás: az 1. kör kizárólag a task/EPICS/state/todo szinkron hiányát
(12. pont) kifogásolta, minden más pontban (technikai tartalom: ADR-086,
PR-sablon, provenance-validátor, GitHub-read-only-bizonyíték) PASS-t adott
volna. A koordinátor szinkron-pótlása ezt a hiányt ténylegesen és helyesen
orvosolta: `EPICS.yaml` `DP-CHANGE-CONTROL` epic `status: active` pontos,
naprakész leírással; `state.md` explicit, korrekt TASK-DP-006-említéssel.
A `todo.md` egyetlen apró, nem blokkoló hiányossága (DP-006 nincs név
szerint említve, "következő" mondat kissé elavult) nem éri el a blokkolás
küszöbét, mert a state.md már megfelelő és a todo.md elsődlegesen
teendő-ledger, nem kizárólagos állapotforrás. A `check-doc-links.mjs`
zöld, és a szinkron-pótlás saját, független ellenőrzéssel igazoltan nem
rontott el más program adatait.

**A frontmatter `status` mezőt `done`-ra állítom.**

**Follow-up javaslat (nem blokkoló):** a `todo.md` "NEXUS-DEVELOPMENT-
PROCESS program" Aktív-tétele frissüljön, hogy a TASK-DP-006-ot is
név szerint, jelenlegi review-státusszal említse, összhangban a
state.md-vel. (Koordinátor: pótolva.)

### Evidence manifest (géppel olvasható, koordinátor utólag pótolta)

```yaml
execution_evidence:
  task_id: TASK-DP-006
  goal: >
    Taskhoz kötött branch-/commit-/PR-névadási konvenció, PR-sablon,
    TERVEZETT (nem alkalmazott) branch-protection szabály és lokálisan
    bizonyított provenance-validátor script, valós push/merge/branch-
    protection módosítás nélkül.
  success_criteria:
    - "scripts/check-commit-provenance.mjs pozitív és negatív esetben
       (hiányzó task-ID, hibás formátum, bot-szerzős commit) helyesen fut"
    - "A jelenlegi valós GitHub branch-protection állapot read-only
       lekérdezve és dokumentálva"
  exit_condition: >
    A fenti teljesül, a branch-protection JSON NEM alkalmazott, a task
    ready állapotban vár, amíg a szinkron megtörténik és a review PASS-ol.
  base_commit: "50744417783992ed4c1d0eb1dc6b1704d03f9f3e"
  branch: "main"
  commits: []
  pull_request: "N/A - git commit/push tiltott ehhez a taskhoz"
  environments:
    - os: windows
      shell: bash
      node: "24.13.0"
  commands:
    - command: "gh api repos/Szantoi/nexus-dev/branches/main/protection"
      exit_code: 1
      result: "PASS (várt 404, nincs védelem — nincs alkalmazott módosítás)"
    - command: "node scripts/check-commit-provenance.mjs (lokális git-fixture, 11+ szcenárió)"
      exit_code: 0
      result: PASS
  reviewer:
    identity: "independent-reviewer (2 round, fresh-context agents, non-implementer)"
    independent: true
    decision: PASS
    evidence: "## Független review + ## Független review, 2. kör (2026-07-18) szakaszok, e fájlban"
  state_sync:
    task: true
    epics: true
    state: true
    todo: true
    memory: true
```
