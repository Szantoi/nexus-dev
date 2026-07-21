# ADR-086: Change provenance — branch/commit/PR naming, protected main, bot-commit gate

- **Státusz:** proposed (a branch protection rész `docs`-only terv — GitHub-oldali
  alkalmazása külön, emberi jóváhagyással történő lépés, lásd "Nyitott kérdések")
- **Dátum:** 2026-07-18
- **Döntéshozók:** TASK-DP-006 (owner_role: release-manager) — javaslattevő;
  a branch protection tényleges GitHub-alkalmazása Gábor jóváhagyására vár
- **Rekonstruált:** nem (előremutató terv, nem múltbeli döntés rekonstrukciója)

## Kontextus

A `docs/knowledge/fejlesztesi-folyamat-erettsegi-ertekeles.md` DEVPROC-01
("a kész munka nincs verziókezelt változásegységhez kötve") és DEVPROC-10
("nincs egyetlen, auditálható folyamatbizonyíték") megállapítása szerint a
`main` munkafán nagy, kevert, task-azonosító nélküli változáshalmaz élt.
A TASK-DP-001 ezt egy géppel olvasható manifestbe (`TASK-DP-001-manifest.yaml`)
leltározta: 15 task-scoped változáscsoport + 4 explicit `human_gate: true`
csoport (QC-003, SECURITY-HARDENING, UNCLEAR-DEPENDENCY-OVERRIDE,
UNCLEAR-AGENT-TOOLING), 16 lépéses javasolt commit-sorrenddel.

Ez a TASK-DP-006 erre épít: nem hajt végre commitot/push-t/branch protection
módosítást (ez a task scope-ja kifejezetten tiltja), hanem meghatározza **azt
a szabályrendszert**, amellyel a jövőben (1) a DP-001 backlog ténylegesen
commitolható lesz task-scope-onként, és (2) minden EZUTÁN született változás
provenance-kényszerítve halad tovább.

**Frissesség-ellenőrzés (a manifest kötelező `freshness_warning`-ja szerint,
ennek a tasknak az indításakor lefuttatva):** a manifest generálásakor
(2026-07-18T11:57:00+02:00) 258 git-status-bejegyzést fedett le. E task
indításakor a friss `git status --porcelain=v1 -uall` **287** bejegyzést
adott. A saját, géppel futtatott halmazkülönbség (lásd a taskfájl
Implementáció-szakaszát) szerint a 29 többlet-bejegyzés teljes egészében
megmagyarázható és NEM veszteség:

- **2 "szellem"-bejegyzés** (`docs/tasks/development-process/TASK-DP-001-worktree-baseline.md`
  és `TASK-DP-002-canonical-state-adr.md`) egyszerűen átkerült
  `docs/tasks/development-process/` → `docs/tasks/development-process/archive/`
  alá — ez a TASK-DP-001 és TASK-DP-002 saját, azóta lezárt `done` állapotú
  archiválása (lásd a program README ✅ jelölését mindkettőnél), nem
  tartalom-veszteség.
- **29 új untracked fájl** (`scripts/check-tasks.mjs`, `docs/tasks/task-schema.json`,
  `scripts/__fixtures__/tasks/**`) a párhuzamosan futó **TASK-DP-003**
  (task-séma CI-kapu) munkaterméke — a megbízás explicit jelezte, hogy ez a
  testvér-task párhuzamosan fut, fájlhatáraink nem fedik egymást, és ez a
  csoport az ő reviewer-láncára tartozik, nem erre a taskra.

Következtetés: a drift ismert eredetű, nulla azonosítatlan/elveszett elem —
a DP-001 manifest 15/16-os csoportosítása és 4 human_gate-je változatlanul
érvényes bemenet erre a tervre.

Jelenlegi tényleges GitHub-állapot (read-only lekérdezve, lásd taskfájl):
`gh api repos/Szantoi/nexus-dev/branches/main/protection` → **404 "Branch not
protected"** — nincs semmilyen branch protection a `main`-en. A repo
`allow_squash_merge`/`allow_merge_commit`/`allow_rebase_merge` mindhárom
`true`, `delete_branch_on_merge: false`.

## Döntés

### 1. Branch-, commit- és PR-névadás (kötelező `TASK-*`)

```
Branch:      task/TASK-<PROGRAM>-<NNN>-<kebab-slug>
             hotfix/TASK-<PROGRAM>-<NNN>-<kebab-slug>   (sürgős javítás, lásd 6. pont)
Commit:      [TASK-<PROGRAM>-<NNN>] <típus(scope): rövid leírás>
             [TASK-<PROGRAM>-<NNN>-REVERT] <leírás>       (revert, lásd 6. pont)
PR cím:      ugyanaz, mint a commit subject-minta — ez lesz a squash-merge
             commit subjectje, tehát EZ hordozza a provenance-t a fő ág
             történetében (lásd 5. pont).
```

A minta gépi kikényszerítése: `scripts/check-commit-provenance.mjs` (ÚJ,
ehhez a taskhoz készült, lásd "Kapcsolódó kód"). Config-vezérelt — a
task-id, branch- és commit-minta felülírható `scripts/check-commit-provenance.config.json`-nal
vagy CLI flag-ekkel (QUALITY.md 3.: nincs hardcodolt adat).

### 2. PR-sablon

`.github/PULL_REQUEST_TEMPLATE.md` (ÚJ) — kötelező mezők: Task-ID, Goal,
Scope, Kockázat, Teszt, Rollback, Evidence, State-sync, Reviewer, és egy
feltételes `RETROACTIVE-EVIDENCE` szakasz hotfixhez (lásd 6. pont).

### 3. Branch protection terv a `main`-re (TERVEZVE, NEM ALKALMAZVA)

> **Ez a szakasz dokumentáció, nem konfiguráció-alkalmazás.** A tényleges
> `PUT /repos/:owner/:repo/branches/main/protection` hívást ez a task
> SZÁNDÉKOSAN nem hajtja végre — a program README kilépési szabálya szerint
> ("pushhoz, branch protection módosításához... emberi jóváhagyás szükséges")
> ez Gábor explicit jóváhagyására vár egy KÉSŐBBI, külön lépésben.

A javasolt payload (a jelenlegi `.github/workflows/ci.yml` egyetlen
`knowledge-service` job-ját alapul véve):

```json
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "knowledge-service" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false
}
```

Teljes, gépi felhasználásra kész változat (a `protection_payload` kulcs
alatt, a `_provenance` metaadat-blokk NÉLKÜL küldendő az API-nak):
[`TASK-DP-006-branch-protection-config.json`](../../tasks/development-process/TASK-DP-006-branch-protection-config.json).

**A `required_status_checks.checks[].context` érték figyelmeztetése:** a
`ci.yml`-ben a job kulcsa `knowledge-service:`, explicit `name:` mező
nélkül — Actions ebben az esetben a job-id-t (`knowledge-service`) használja
check-run névként. **Alkalmazás előtt a GitHub Checks fülön vizuálisan
ellenőrizni kell a pontos check-run nevet** (különösen, ha a TASK-DP-007
mátrixot vezet be — akkor a check-run neve job-onként/OS-enként bővül, pl.
`knowledge-service (ubuntu-latest)`, és a required-checks listát ennek
megfelelően kell frissíteni). Ez a bizonytalanság nem blokkolja a TERV
dokumentálását, csak a tényleges alkalmazás előtti utolsó ellenőrzést
igényli — ezért marad ez a szakasz `proposed`, nem `accepted`.

**Repo-szintű kiegészítő javaslat (nem "branch protection", hanem "Pull
Requests" repo-beállítás, szintén NEM alkalmazva):** a squash/rebase/merge
stratégia provenance-megőrzése (lásd 5. pont) miatt javasolt `Allow merge
commits` és `Allow rebase merging` kikapcsolása, csak `Allow squash merging`
engedélyezése, alapértelmezett squash-commit-üzenetként a PR címét használva
("Default to pull request title").

### 4. Required checks megfeleltetése a meglévő CI-lépésekkel

| CI-lépés (`.github/workflows/ci.yml`) | Jelenlegi hermetikus? | Bevonva a required checkbe? |
|---|---|---|
| Typecheck | igen | igen (a `knowledge-service` job része) |
| Lint ratchet | igen | igen |
| File size gate | igen | igen |
| Hermetic tests + coverage floor | igen | igen |
| Audit production dependencies | igen | igen |
| Secret scan | igen | igen |
| Documentation link check | igen | igen |

Mind a 7 lépés **egyetlen GitHub Actions jobban** fut (`knowledge-service`),
tehát GitHub egyetlen check-runt állít elő — a required status check ezt az
EGY check-runt jelöli kötelezőnek, ami viszont csak akkor zöld, ha mind a 7
lépés lefutott és sikeres (a `steps` szekvenciálisan, `continue-on-error`
nélkül fut — egy lépés bukása a teljes job-ot pirosra állítja, tehát nincs
mód arra, hogy egy required check "átcsússzon" egy konkrét lépés hibáján).
Finomabb, lépésenkénti required-check-bontás (pl. külön job coverage-re és
külön lint-re) a TASK-DP-007 (CI-paritás, Windows/Linux mátrix) hatásköre —
ez a terv csak a JELENLEGI struktúrához illeszkedik, és jelzi a függőséget.

### 5. Squash/rebase/merge stratégia és a provenance megőrzése

A jelenlegi repo mindhárom merge-stratégiát engedélyezi. A terv szerint:

- **Squash-merge az egyetlen javasolt stratégia** (lásd 3. pont repo-beállítás
  javaslata) — a PR cím (`[TASK-XXX-NNN] ...`) válik a squash-commit
  subjectjévé, így a `main` git-története `git log --grep '\[TASK-XXX-NNN\]'`
  paranccsal közvetlenül visszakereshető marad taskonként, FÜGGETLENÜL attól,
  hány köztes "wip"/"fix typo" commit született a feature-branchen.
- **Merge-commit és rebase-merge NEM javasolt engedélyezni**, mert (a) a
  sima merge-commit subject-je platform-generált ("Merge pull request #N
  from ..."), ami NEM tartalmaz `TASK-*` azonosítót — ezért a
  `check-commit-provenance.mjs` `range` módja ezt alapból elutasítaná
  (lásd a script `--allow-merge-commits` opcióját: alapból KIKAPCSOLVA,
  pontosan azért, hogy ez a hézag ne maradjon nyitva); (b) rebase-merge
  esetén MINDEN egyes köztes commitnak önmagában kell megfelelnie a
  `[TASK-*]` mintának, ami extra fegyelmet igényel a fejlesztőtől — ezt a
  scriptet ettől függetlenül a `range` mód mindenképp kikényszeríti, ha
  mégis engedélyezve marad.

### 6. Sürgősségi javítás (hotfix) és revert

- **Hotfix-branch:** `hotfix/TASK-XXX-NNN-<slug>` — ugyanazon a PR-folyamaton
  megy át (branch protection, required check, min. 1 független approval),
  DE a PR-sablon `RETROACTIVE-EVIDENCE` szakasza **kötelező, és a merge
  utáni 24 órán belül ki kell tölteni** egy követő commitban/PR-ben: mi
  tört el, miért nem volt idő a teljes ciklusra, milyen utólagos
  teszt-bizonyíték született, és melyik follow-up TASK-* viszi tovább a
  teljes auditot. **A required CI check és a legalább 1 approval hotfixnél
  sem hagyható el** — a "sürgősség" a review MÉLYSÉGÉT gyorsíthatja
  (pl. egy reviewer helyben, szinkron review-val), de a KAPUT nem kerülheti
  meg, mert az pontosan a "megkerülhetetlen kapu" (DEVPROC-01/10) elvét
  sértené.
- **Revert:** `git revert <sha>` → új commit `[TASK-XXX-NNN-REVERT] ...`
  subjecttel, ahol `TASK-XXX-NNN` az EREDETI taskra hivatkozik. A revert
  commit ÖNMAGÁBAN is átmegy a normál PR-folyamaton (branch `hotfix/` vagy
  `task/` prefixszel, saját required check + approval) — a revert TEHÁT
  nem "sima git push", hanem ugyanaz a kapu vonatkozik rá, mint bármely más
  változásra. Ha a revert mögött érdemi utókövetés kell (pl. gyökérok-elemzés),
  azt egy ÚJ `TASK-XXX-NNN+1` követi, nem a revert commit maga.

### 7. Bot/generált commit nem kerülheti meg a kaput

`scripts/check-commit-provenance.mjs range <base>..<head>` a PR TELJES
commit-tartományát ellenőrzi (nem csak a HEAD-et), és a szerző/e-mail mezőt
**explicit NEM használja kivételként** — egy `dependabot[bot]`, egy
`github-actions[bot]` vagy egy agent (`Co-Authored-By: Claude ...`) által írt
commit UGYANAZT a `[TASK-*]` mintát kell teljesítse, mint egy emberi commit.
Ez helyben, lokális git-fixture-rel bizonyítva (lásd taskfájl "Kötelező
ellenőrzés" — Szcenárió D): egy `dependabot[bot]` szerzőjű, prefix nélküli
commit a `range` módban ugyanúgy `exit 1`-et ad, mint egy emberi hiba.

A tényleges kikényszerítés két rétegű terv (a második réteg NEM ennek a
tasknak a fájlhatára, dokumentálva mint függőség):

1. **Ez a task:** a script létezik, helyben bizonyítottan működik, és a
   PR-sablon/ADR dokumentálja a szándékot.
2. **TASK-DP-003/DP-007 függő lépése (nem ez a task hajtja végre):** a
   `.github/workflows/ci.yml`-be egy ÚJ lépés bekötése, ami a PR
   `base..head` tartományán lefuttatja `node scripts/check-commit-provenance.mjs range`-t,
   és ez a lépés IS a required status check része legyen. Enélkül a script
   csak helyi/pre-commit-hook szinten véd, nem CI-required-check szinten —
   ez az egyetlen módja annak, hogy egy közvetlen push (ha valamiért mégis
   átjutna a branch protectionön, pl. admin bypass) is elbukjon.

## Design intent

A cél a **legegyszerűbb működő megoldás** (QUALITY.md 8.: egyszerűség elve):
ahelyett, hogy egy bonyolult, csak géppel érthető commit-metaadat-sémát
vezetnénk be, a `[TASK-*]` prefix egyetlen, ember ÉS gép számára is azonnal
olvasható jelölés, ami a git natív eszközeivel (`git log --grep`, `git branch
--list 'task/TASK-QC-005-*'`) kereshető marad — nincs szükség külön
adatbázisra a puszta visszakereshetőséghez. A validátor script szándékosan
NEM tesz kivételt automatizált szerzőkre, mert pontosan az volt a
DEVPROC-01/10 kockázat, hogy egy "gyors, automatizált" commit megkerüli a
manuális fegyelmet — egy kivétel-mentes, egységes szabály zárja ezt a rést
anélkül, hogy külön bot-detektáló logikát kellene karbantartani.

## Alternatívák

- **Commit-trailer (`Task-Id: TASK-XXX-NNN`) subject-prefix helyett/mellett:**
  elvetve mint EGYEDÜLI megoldás, mert squash-merge esetén a trailer könnyen
  elveszik/összefolyik, ha a squash a body-t nem őrzi meg pontosan; a subject-
  prefix viszont garantáltan a squash-commit subjectjébe kerül (mert a PR
  cím lesz a subject). A trailer kiegészítő, nem kötelező mezőként
  megmaradhat többtaskos commitokhoz, de a scope ezt nem teszi kötelezővé,
  mert a DP-001 backlog-nál nincs ilyen eset (minden csoport pontosan 1
  taskhoz tartozik, a `shared_with` a fájlszintű kereszthivatkozás, nem a
  commit-szintű).
- **Számozott, de "TASK-" prefix nélküli azonosító (pl. csak `QC-005`):**
  elvetve, mert a repo már ma TÖBB programot fut párhuzamosan
  (NEXUS-QUALITY, NEXUS-DEVELOPMENT-PROCESS, NEXUS-ISLAND-RUNTIME), és a
  `TASK-` prefix egyértelművé teszi, hogy ez egy formális task-azonosító,
  nem egy szabad szöveges rövidítés — csökkenti az összetévesztés esélyét
  más rövidítésekkel (pl. ADR-számokkal).
- **GitHub "required status checks" azonnali, e taskon belüli alkalmazása:**
  elvetve — a task scope-ja és a program README kifejezetten emberi
  jóváhagyáshoz köti a branch protection tényleges módosítását; ez a
  döntés dokumentált TERV marad, `proposed` státusszal.
- **Merge-commit vagy rebase-merge engedélyezve hagyása:** elvetve fő
  stratégiaként (lásd 5. pont) — a squash-only politika egyszerűbben tartja
  fenn a provenance-t, mint egy vegyes stratégia validálása.

## Következmények

**Pozitív:** minden jövőbeli, ezt a szabályt követő változás egyetlen `git
log --grep`/`git branch --list` paranccsal visszakereshető a taskig; a bot-
és emberi commitok azonos szabály alá esnek; a hotfix-út nem jelent
kiskaput, csak gyorsított, de nem megkerült review-t.

**Negatív / korlátozás:** amíg a `check-commit-provenance.mjs` nincs bekötve
a CI-be (TASK-DP-003/007 függő lépés), a kikényszerítés csak PR-sablon és
opcionális helyi git-hook szinten létezik — egy figyelmen kívül hagyott
PR-cím-konvenció jelenleg NEM állítaná meg magát a mergét. Ez explicit
nyitott függőség, nem hallgatott el.

A DP-001 16 lépéses commit-terve (lásd `TASK-DP-001-manifest.yaml`
`commit_plan.sequence`) ehhez az új konvencióhoz illesztve — az alábbi
táblázat minden tervezett commitot leképez a fenti névadásra (a "vedd
alapul, és finomítsd/validáld" scope-elvárás konkrét teljesítése):

| Lépés | Csoport | Javasolt branch | Javasolt commit-subject (PR cím is) | `needs_human_gate` |
|---:|---|---|---|:---:|
| 1 | QC-003 | `task/TASK-QC-003-env-hygiene` | `[TASK-QC-003] security(env): .env.dev kivezetése git-indexből + secret-scan` | igen |
| 2 | QC-002 | `task/TASK-QC-002-adr-recovery` | `[TASK-QC-002] docs(architecture): 12 ADR helyreállítása + linkellenőrző` | nem |
| 3 | QC-005 | `task/TASK-QC-005-ci-gates` | `[TASK-QC-005] ci(quality-gates): typecheck/lint-ratchet/coverage/audit/secret-scan/linkcheck kapuk` | nem |
| 4 | QC-008 | `task/TASK-QC-008-mcp-decomposition` | `[TASK-QC-008] refactor(mcp): legacy TOOLS/switch törlése + fájlméret-kapu` | nem |
| 5 | QC-004 | `task/TASK-QC-004-safe-deploy` | `[TASK-QC-004] feat(deploy): build/deploy szétválasztás, auto-rollback, dry-run` | nem |
| 6 | QC-007 | `task/TASK-QC-007-config-centralization` | `[TASK-QC-007] refactor(config): runtime-config központosítás` | nem |
| 7 | QC-006 | `task/TASK-QC-006-critical-coverage` | `[TASK-QC-006] test(coverage): kritikus modulok tesztlefedettség 24,5%→41%` | nem |
| 8 | QC-009 | `task/TASK-QC-009-documentation` | `[TASK-QC-009] docs: README-k és modul-dokumentáció frissítése` | nem |
| 9 | QC-010 | `task/TASK-QC-010-independent-verification` | `[TASK-QC-010] docs(archive): független review archiválása` | nem |
| 10 | QC-FOLLOWUP-BACKLOG | `task/TASK-QC-011-013-followup-backlog` | `[TASK-QC-011] docs: QC follow-up backlog taskok + program-READMEk` | nem |
| 11 | QC-001 | `task/TASK-QC-001-ledger-close` | `[TASK-QC-001] docs(governance): QUALITY program ledger-zárás` | nem |
| 12 | SECURITY-HARDENING | `task/TASK-SEC-001-auth-hardening` *(ÚJ task-ID kiosztása szükséges — jelenleg nincs)* | `[TASK-SEC-001] security(hardening): CORS allowlist, CSP, requireRootForMutations, AUTH_MODE/HOST default-váltás` | **igen — Gábor jóváhagyása kötelező** |
| 13 | DP-ISL-PROGRAM-PREP | `task/TASK-DP-006-program-prep-docs` | `[TASK-DP-006] docs(process): NEXUS-DEVELOPMENT-PROCESS + NEXUS-ISLAND-RUNTIME programdokumentáció` | nem |
| 14 | UNCLEAR-DEPENDENCY-OVERRIDE | `task/TASK-DEP-001-protobufjs-override` *(ÚJ task-ID)* | `[TASK-DEP-001] chore(deps): protobufjs override pin megerősítése` | **igen — szándék tisztázása** |
| 15 | UNCLEAR-AGENT-TOOLING | `task/TASK-TOOL-001-verify-skill` *(ÚJ task-ID)* | `[TASK-TOOL-001] chore(tooling): verify skill hozzáadása` | **igen — owner/eredet tisztázása** |
| 16 | DP-ISL-ARCHITECTURE-ADRS | *(nem e task felelőssége — DP-002/ISL-001 saját branch-e)* | *(DP-002/ISL-001 dönti el)* | nem (más task) |

**Megjegyzés a 12/14/15. sorra:** a SECURITY-HARDENING, UNCLEAR-DEPENDENCY-OVERRIDE
és UNCLEAR-AGENT-TOOLING csoportnak jelenleg NINCS formális `TASK-*`
azonosítója (a DP-001 manifest maga is `owner: "ISMERETLEN"`-ként jelöli
őket) — az új naming-konvenció kikényszerítése miatt ezekhez ELŐSZÖR egy
formális task-fájlt kell nyitni (pl. `TASK-SEC-001`, a program README
szerinti frontmatterrel), MIELŐTT a commit megtörténne, mert branch/commit
nem hozható létre `TASK-*` azonosító nélkül. Ez konzisztens a DP-001 saját
`human_gate` jelölésével — a hiányzó task-ID pontosan az egyik oka, hogy
emberi döntés kell.

## Biztonsági hatás

- A branch protection terv (3. pont) explicit `enforce_admins: true`-t
  javasol — ez azt jelenti, hogy MÉG az adminisztrátori jogosultsággal
  rendelkező fiókok sem push-olhatnak közvetlenül a `main`-re, ha
  alkalmazásra kerül. Ez szigorúbb, mint sok alapértelmezett GitHub-repo —
  szándékos, mert a SECURITY-HARDENING csoport pontosan egy admin-szintű
  "gyors commit" kockázatát dokumentálja.
- A `check-commit-provenance.mjs` NEM tartalmaz titkot, nem hív külső
  hálózatot, kizárólag lokális `git log`-ot futtat.
- A branch-protection JSON terv NEM lett alkalmazva a valós repóra — a
  `gh api ... branches/main/protection` GET (read-only) lekérdezés
  megerősítette a jelenlegi, védelem nélküli állapotot, de semmilyen
  írás/PUT/POST hívás nem történt.

## Kapcsolódó kód

- `scripts/check-commit-provenance.mjs` — ÚJ, ehhez a taskhoz készült validátor
- `.github/PULL_REQUEST_TEMPLATE.md` — ÚJ PR-sablon
- `docs/tasks/development-process/TASK-DP-006-branch-protection-config.json` — ÚJ, gépi felhasználásra kész branch-protection-terv (NEM alkalmazva)
- `docs/tasks/development-process/TASK-DP-001-manifest.yaml` — bemeneti commit-terv (nem módosítva ebben a taskban)
- `.github/workflows/ci.yml` — a required-check megfeleltetés forrása (nem módosítva ebben a taskban)

## Nyitott kérdések

1. **Gábor jóváhagyása kell** a branch-protection JSON tényleges
   alkalmazásához (`gh api --method PUT .../protection` vagy a GitHub UI-n
   keresztül) — ez a task ezt szándékosan NEM hajtotta végre.
2. **A `required_status_checks.checks[].context` pontos értékét** a
   tényleges GitHub Checks fülön kell megerősíteni alkalmazás előtt (lásd
   3. pont figyelmeztetése), különösen, ha időközben a TASK-DP-007
   mátrixot vezet be.
3. **A `check-commit-provenance.mjs` CI-be kötése** (required check
   szintjén) a TASK-DP-003/DP-007 fájlhatárába tartozik (`.github/workflows/ci.yml`
   módosítása) — ez a task ezt dokumentált függőségként jelzi, nem hajtja
   végre.
4. **SECURITY-HARDENING, UNCLEAR-DEPENDENCY-OVERRIDE, UNCLEAR-AGENT-TOOLING**
   formális `TASK-*` azonosítót igényel, mielőtt a hozzájuk tartozó commit
   az új konvenció szerint létrehozható lenne — ezt a DP-001 human_gate
   már jelezte, itt csak megerősítve és a naming-konvencióhoz kötve.
5. **A repo "Pull Requests" beállításának szűkítése csak squash-merge-re**
   szintén emberi jóváhagyást igényel (nem "branch protection" API, hanem
   repo-settings API) — dokumentálva a 3. pontban, nem alkalmazva.
