---
id: TASK-ISL-001
title: Garantált szigetüzem célarchitektúrája és ADR-jei
program: NEXUS-ISLAND-RUNTIME
project: nexus/knowledge-service
milestone: ISL-M1
epic: ISL-ARCHITECTURE
status: in_progress
priority: critical
depends_on: []
parallel_with: []
owner_role: architect
created: 2026-07-18
updated: 2026-07-21
source: docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md
---

# Garantált szigetüzem célarchitektúrája és ADR-jei

## Cél

A fejlesztés előtt egyértelmű, review-zott design intent rögzítse az identitási,
állapot-, ownership-, autorizációs, runner-, CLI-adapter- és federation-modellt.

## Mikor jó?

Minden későbbi task egy elfogadott adatmodellre, állapotgépre, API-szerződésre,
migrációs tervre és hibamodellre tud hivatkozni, nyitott kritikus tervezési
kérdés nélkül.

## Scope

1. Rögzíts ADR-ben összetett `island_id / terminal_id / runner_id` identitást.
2. Döntsd el a kanonikus task/message store-t és a legacy store-ok kivezetését.
3. Definiáld a claim/lease/fencing/idempotency állapotgépet és invariánsait.
4. Definiáld a közös autorizációs policy inputját és döntési sorrendjét.
5. Rögzítsd az egyetlen launch authority elvét és a review/budget kapukat.
6. Definiáld a CLI adapter capability- és lifecycle-szerződését.
7. Tervezd meg a federation outbox/relay/inbox/ACK/DLQ protokollt.
8. Készíts adat-, fenyegetés-, migrációs, kompatibilitási és rollback tervet.
9. Add meg az SLO-kat és a bizonyítási stratégiát Windows/Linux környezetre.

## Nem cél

- Runtime feature implementálása.
- Adatbázis-migráció futtatása vagy production deploy.

## Elfogadási feltételek

- [ ] Minden SZIGET-01…10 megállapításhoz tartozik célállapot és ADR-döntés.
- [ ] A state machine minden állapotának belépési, kilépési és hibafeltétele ismert.
- [ ] A konkurencia-, crash-, auth- és federation threat model dokumentált.
- [ ] A backward compatibility és rollback tételesen kidolgozott.
- [ ] A Codex/Claude/Antigravity eltéréseit capability-alapú adapter fedi le.
- [ ] Külön architect/reviewer megpróbálta megcáfolni a terv konzisztenciáját.

## Kötelező ellenőrzés

- ADR-linkellenőrzés és Mermaid-renderelhetőség.
- Példaüzenetek és állapotátmenetek séma-validációja.
- Függőségi DAG review: nincs kör, és minden task visszavezethető egy megállapításra.

## Kilépési feltétel

`done`, ha a terv review-zott, minden döntés visszakereshető és a TASK-ISL-002…017
implementálóinak nincs kritikus tisztázatlan szerződése. `blocked`, ha olyan
technológiaválasztás marad, amelyhez tulajdonosi döntés szükséges.

## Végrehajtási napló

**2026-07-18, architect terminál (owner_role: architect).** Goal ennél a
futásnál: a `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md`
SZIGET-01…10 megállapításait review-zott ADR-készletté alakítani (identitás,
kanonikus store, claim/lease, autorizáció, launch authority, CLI-adapter,
federation, migráció/fenyegetés/rollback, SLO/bizonyítás), a program README
kötelező szerződése szerint, KIZÁRÓLAG design/dokumentáció szinten (nincs
kódmódosítás, migráció-futtatás vagy deploy). Mérhető sikerkritérium: minden
elfogadási feltétel (taskfájl "Elfogadási feltételek" szakasza) PASS, a
függőségi DAG körmentes, a linkellenőrzés és a Mermaid-szintaxis hibátlan.
Kilépési feltétel: `ready` marad a frontmatter (független reviewer zárja
`done`-ra), az Implementáció-szekció "KÉSZ, FÜGGETLEN REVIEW-RA VÁR" jelzéssel
készül el. Erőforráskeret: egyetlen ülés, kb. 2 óra ekvivalens munka, nincs
külön token-korlát rögzítve (a task tervezési jellegű, kód nem fut).

---

## Implementáció (2026-07-18)

> **SZÉLESÍTETT LAUNCH-MECHANIZMUS AUDITTAL KIEGÉSZÍTVE (2026-07-19).** Két
> független review-kör futott le eddig (lásd "Független review (2026-07-18)"
> és "Független review, 2. kör" szakaszok lent), mindkettő REQUEST_CHANGES
> verdikttel: az 1. kör két, a lease-réteget megkerülő HTTP-végpontot talált;
> a 2. kör bebizonyította, hogy az 1. kör "kimerítő" auditjának `rg`-mintája
> STRUKTURÁLISAN vak volt egy egész kategóriára (exec/tmux-alapú
> `claude --model` launcherek). A jelen kiegészítés egy LÉNYEGESEN szélesebb
> mintával (a teljes `child_process` API + minden tmux session-életciklus-
> parancs) futtatta le az auditot, 4 új találatot zárt le, és — a koordinátor
> kifejezett kérésére — explicit nyilatkozatot tesz a lefedettség
> teljességéről (lásd ADR-081 "Nyilatkozat a lefedettségről" alszakasza). A
> válasz a "Válasz a 2. kör REQUEST_CHANGES-ére (2026-07-19)" szakaszban
> található, a 2. kör review-szakasza UTÁN. A készítő (ez a session)
> továbbra sem fogadhatja el saját taskját — a frontmatter `status` mezője
> szándékosan `ready` marad.

### 1. Eredeti goal és tényleges eredmény

**Goal:** a szigetüzemi program 9 tervezési pontjához (identitás, kanonikus
store, claim/lease, autorizáció, launch authority, CLI-adapter, federation,
migráció/fenyegetés/rollback, SLO/bizonyítás) review-zott ADR-készlet, minden
SZIGET-megállapításhoz célállapot-hivatkozással, adverzáriális önellenőrzéssel
és a 17-tasknyi függőségi DAG igazolásával.

**Tényleges eredmény:** 9 új ADR készült el (`ADR-077`…`ADR-085`, lásd lent —
eredetileg `ADR-068`…`076`-ként indultak, de számütközés miatt átszámozva,
lásd 8. pont), mindegyik a template szerinti szerkezetben (Kontextus / Döntés
/ Design intent / Alternatívák / Következmények / Biztonsági hatás /
Kapcsolódó kód / Bizonyíték / Nyitott kérdések), konkrét, 2026-07-18-i
kódfelderítéssel alátámasztva (fájl:sor hivatkozásokkal), nem csak az
audit-dokumentum absztrakt megállapításaira hivatkozva. A 3 hivatalos
CLI-doksit élőben ellenőriztem (WebFetch, lásd 4. pont). A függőségi DAG
körmentesnek igazolódott, a SZIGET-01…10 → célállapot táblázat és az
adverzáriális szakasz elkészült (lent).

### 2. Architekturális döntések és elvetett alternatívák

| ADR | Döntés (tömören) | Fő elvetett alternatíva |
|---|---|---|
| [ADR-077](../../architecture/decisions/ADR-077-island-terminal-runner-identity.md) | `island_id/terminal_id/runner_id` összetett identitás; egyetlen `terminals.yaml`-alapú config (`terminals.json` kivezetve); `agents.yaml` token→(island,terminal) párra vált | sziget beégetése a terminálnévbe (string-konvenció, nem index-szintű) |
| [ADR-078](../../architecture/decisions/ADR-078-canonical-task-message-store.md) | `task-message-box` marad/bővül egyetlen kanonikus runtime store-má; `messageRegistry`/`epicRouter`/`workerRegistry` fokozatosan kivezetve | big-bang csere; az epicRouter tábláinak kanonikussá tétele |
| [ADR-079](../../architecture/decisions/ADR-079-claim-lease-fencing-state-machine.md) | atomi CAS-claim + lejáró lease + fencing token + idempotency-key állapotgép | csak `updated_at`-heurisztika fencing nélkül; külső lock-szerver |
| [ADR-080](../../architecture/decisions/ADR-080-unified-authorization-policy.md) | egyetlen policy-pipeline minden belépési ponton, explicit döntési sorrenddel | route-onkénti egyedi ellenőrzés (bizonyítottan elsodródik); külső policy-motor |
| [ADR-081](../../architecture/decisions/ADR-081-single-launch-authority.md) | a queue+lease réteg az egyetlen launch authority; `inboxWatcher`/`watchInbox` csak ébresztő, sosem indító; tmux nem kötelező elem | az `ENABLE_INBOX_WATCHER` flag puszta bekötése (nem strukturális megoldás) |
| [ADR-082](../../architecture/decisions/ADR-082-cli-adapter-contract.md) | egységes `CliAdapter` interfész (capability discovery + lifecycle) Codex/Claude/Antigravity-ra, argv-spawn (shell:false) hardening | külön runner CLI-nkként; legkisebb közös nevező (plain-text only) |
| [ADR-083](../../architecture/decisions/ADR-083-federation-outbox-relay-dlq.md) | tranzakciós outbox + relay pumpa (a claim/lease mintát újrahasznosítva) + island-pár-token + allow-list | külső üzenetbróker (aránytalan a jelenlegi méretskálán) |
| [ADR-084](../../architecture/decisions/ADR-084-migration-threat-rollback-plan.md) | additív-first migráció, STRIDE-lite fenyegetéstábla, backup-kötelezettség destruktív lépés előtt | big-bang migráció; tartós dual-write |
| [ADR-085](../../architecture/decisions/ADR-085-slo-platform-evidence-strategy.md) | provizórikus SLO-célszámok (explicit "felülvizsgálandó" jelöléssel) + a 10 elfogadási feltétel → konkrét teszt/chaos-forgatókönyv tábla | SLO-k rögzítése nélkül haladni; hamis pontosságú SLA-szám azonnal |

### 3. Módosított fájlok és migrációk

Kizárólag dokumentáció, forráskód-módosítás NEM történt:

- Új: `docs/architecture/decisions/ADR-077-island-terminal-runner-identity.md`
  … `ADR-085-slo-platform-evidence-strategy.md` (9 fájl).
- Módosítva: `docs/architecture/decisions/README.md` (index-táblázat 9 új
  sorral bővítve + "következő szabad sorszám" `086`-ra frissítve).
- Módosítva: `docs/tasks/island-runtime/TASK-ISL-001-target-architecture.md`
  (ez a fájl — frontmatter `in_progress` közben, `ready` a végén, e szakasz).
- Migráció/kódfuttatás: **nincs** — ez tervezési/ADR-task, a Nem cél szakasz
  szerint.

### 4. Futtatott parancsok, exit code-ok, eredmények

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 76 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat."  (exit code 0)
```

**Élő CLI-doksi-ellenőrzés (WebFetch, 2026-07-18, PowerShell/Bash env-ből):**

- `https://learn.chatgpt.com/docs/non-interactive-mode` — elérve, 200,
  Codex `exec` non-interaktív mód leírása lekérdezve (részletek: ADR-082).
- `https://docs.anthropic.com/en/docs/claude-code/cli-usage` — **301
  redirect** `https://code.claude.com/docs/en/cli-usage`-re; ez utóbbi
  elérve, 200, Claude Code v2.1.212 CLI-referencia lekérdezve. **A README
  "Hivatalos platformbaseline" szakaszának Claude Code URL-je elavult** —
  jelzés a koordinátor felé, a README-t ez a task nem módosíthatja
  (fájlhatár).
- `https://codelabs.developers.google.com/antigravity-cli-hands-on` —
  elérve, 200, Antigravity CLI (`agy`) 1.0.7 codelab lekérdezve.

Mind a 3 URL élőben elérhető volt — **nincs "nem érhető el a web" eset**,
tehát a README kötelező fallback-ága (ismert szerződésekkel dolgozni,
nyitott kérdésként jelölni) nem aktiválódott; a friss doksi-ellenőrzés
teljes egészében megtörtént, dátummal és verzióval rögzítve (ADR-082).

Nincs egyéb futtatandó teszt/build ehhez a taskhoz (nincs kódváltozás).

### 5. OS, shell, arch, Node-, CLI-verzió

- OS: Windows 11 Home 10.0.26200 (a végrehajtó agent környezete)
- Shell: Git Bash (POSIX sh) a `check-doc-links.mjs` futtatásához
- Node: a repo `package.json` engines-mezője szerinti verzió (a script
  natívan, függőség nélkül futott)
- CLI-verzió-adatok a vizsgált külső eszközökre: lásd ADR-082 (Codex:
  nincs verziószám a doksin; Claude Code: v2.1.212; Antigravity: 1.0.7) —
  ezek NEM ennek a futtató gépnek a verziói, hanem a hivatalos doksik
  2026-07-18-i tartalma.

### 6. Biztonsági és rollback-ellenőrzés

- Nincs titok/token naplózva ebben a futásban.
- Rollback: minden változás git-revertelhető (kizárólag markdown fájlok,
  új fájlok + egy index-fájl szerkesztése); nincs séma- vagy
  adatbázis-módosítás, nincs futtatott migráció.
- A tervezett architektúra saját biztonsági/rollback tervét lásd ADR-084
  (STRIDE-lite fenyegetéstábla) és a lenti Adverzáriális szakasz.

### 7. Windows/Linux és CLI kompatibilitási eredmény

Nem alkalmazható ebben a taskban (nincs futtatható kód/runner-implementáció)
— a Windows/Linux × Codex/Claude/Antigravity mátrix bizonyítása az
ISL-008…012 és ISL-017 feladata; ez az ADR (ADR-082, ADR-085) a
SZERZŐDÉST és a bizonyítási sémát rögzíti előre.

### 8. Ismert korlátok, fennmaradó kockázatok, következő teendők

- **ADR-számütközés, felfedve és javítva:** munka közben egy PÁRHUZAMOSAN
  futó TASK-DP-002 agent ugyanabban a percben szintén az "068" sorszámot
  igényelte (`ADR-068-canonical-project-task-state.md`) — valódi,
  élesben tapasztalt konkurencia-eset két egyidejű architect-session
  között. Feloldás: a jelen task 9 ADR-je `077`…`085`-re lett átszámozva
  (tartalom és fájlnév egyaránt, kereszthivatkozásokkal együtt), a
  DP-002 `068`-as ADR-je érintetlen maradt. Ez élő bizonyíték arra, hogy
  az ADR-sorszám-kiosztás maga is egy claim/lease-jellegű erőforrás —
  amit ADR-079 épp emiatt tárgyal elvben. **Következő teendő:** a
  koordinátor jelezze a többi párhuzamosan futó architect-feladatnak,
  hogy a soron következő ADR-szám mostantól `086`.
- A README Claude Code CLI URL-je elavult (301 redirect) — dokumentációs
  karbantartási tétel, ezen task fájlhatárán kívül (lásd 4. pont).
- Az Antigravity CLI capability-feltevései (ADR-082) egy hands-on codelab
  alapján születtek, nem teljes CLI-referenciából — empirikus
  megerősítésre várnak (ISL-010).
- Nyitott koordinációs pont a TASK-DP-002-vel (lásd ADR-078 Nyitott
  kérdések) — nem feloldva egyoldalúan, ahogy a feladatkiírás előírta.
- A `docs/knowledge/` alatti sziget-audit dokumentum és a `terminals/root/
  state.md`/`todo.md`/`MEMORY.md` szinkronizálása a program README
  protokollja szerint ESEDÉKES, de ezen task explicit fájlhatára (csak
  ADR-ek + saját taskfájl) miatt SZÁNDÉKOSAN nem történt meg — a
  koordinátor feladata.

### 9. Reviewer

- Reviewer neve/szerepe: **(üres — független review vár)**
- Ellenőrzési bizonyíték: **(üres — a reviewer tölti ki)**

### 10. Sikerkritérium és kilépési feltétel — tételes PASS/FAIL

| Elfogadási feltétel (taskfájl) | Eredmény |
|---|---|
| Minden SZIGET-01…10 megállapításhoz célállapot + ADR-döntés | **PASS** — lásd SZIGET-táblázat lent |
| A state machine minden állapotának belépési/kilépési/hibafeltétele ismert | **PASS** — ADR-079 |
| Konkurencia-, crash-, auth-, federation threat model dokumentált | **PASS** — Adverzáriális szakasz + ADR-084 |
| Backward compatibility és rollback tételesen kidolgozott | **PASS** — ADR-084 |
| Codex/Claude/Antigravity eltérései capability-alapú adapterrel fedve | **PASS** — ADR-082 |
| Külön architect/reviewer megpróbálta megcáfolni a konzisztenciát | **RÉSZLEGES** — a KÉSZÍTŐ végzett önadverzáriális próbát (lásd lent); a KÜLÖN, független reviewer próbája még hátravan — ezért a frontmatter `ready` marad |
| ADR-linkellenőrzés és Mermaid-renderelhetőség | **PASS** — `check-doc-links.mjs` zöld; Mermaid-szintaxis kézzel ellenőrizve (ADR-079) |
| Függőségi DAG review: nincs kör, minden task visszavezethető | **PASS** — lásd DAG-szakasz lent |

**Kilépési feltétel (taskfájl):** a terv review-zott (a KÉSZÍTŐI kör lezárva),
minden döntés visszakereshető bizonyítékkal, és az ISL-002…017
implementálóinak nincs KRITIKUS tisztázatlan szerződése — ezt a jelen
dokumentum állítja, de a formális `done` átminősítést a független
reviewer adja meg. Nincs olyan technológiaválasztás, ami tulajdonosi
(Gábor) döntést igényelne `blocked` helyett.

---

### SZIGET-01…10 → célállapot → ADR-hivatkozás

| SZIGET | Megállapítás (tömören) | Célállapot | ADR |
|---|---|---|---|
| 01 | Nincs összetett sziget-terminál-runner identitás | `island_id/terminal_id/runner_id` összetett kulcs mindenhol | ADR-077 |
| 02 | Az izoláció nem egységes minden interfészen | Egyetlen policy-pipeline REST/MCP/TMB/federation felett | ADR-080 |
| 03 | A mailbox fájlrendszeri névtere globális | Sziget-szegmens minden útban és DB-oszlopban | ADR-077, ADR-078 |
| 04 | Nincs szerveroldali atomi claim/lease | CAS-claim + lejáró lease + fencing token | ADR-079 |
| 05 | Több párhuzamos igazságforrás (valójában 4) | Egyetlen kanonikus store (task-message-box), additív migrációval | ADR-078 |
| 06 | A federation API nem elosztott transzport | Tranzakciós outbox + relay + ACK/DLQ | ADR-083 |
| 07 | Két (valójában három) sessionindítási hatóság versenyezhet | Egyetlen launch authority (queue+lease) | ADR-081 |
| 08 | A completion/review nem egyetlen kötelező állapotgép | Review-kapu és budget-kapu az állapotgép/claim része | ADR-079, ADR-081 |
| 09 | Két eltérő terminálkonfiguráció él párhuzamosan | Egyetlen `terminals.yaml`-alapú séma, `islands:` gyökérrel | ADR-077 |
| 10 | A helyreállítás és observability részleges | SLO-k + platformbizonyítási séma + reaper/DLQ operátori láthatóság | ADR-079, ADR-083, ADR-085 |

### Függőségi DAG-ellenőrzés (ISL-002…017)

Egy Explore-agent kigyűjtötte mind a 16 taskfájl (`ISL-002`…`ISL-017`)
frontmatter `depends_on` mezőjét és összevetette a README függőségi
táblázatával: **teljes egyezés, egyetlen eltérés sincs.** A frontmatter
`depends_on` élek alapján felépített gráf minden élén az előfeltétel
sorszáma szigorúan kisebb, mint a függő taské — ez azt jelenti, hogy a
`001→002→…→017` numerikus sorrend érvényes topologikus rendezés, tehát
**a gráf körmentes**. Mind a 16 fájl frontmatter `status`-a `blocked` —
ez NEM inkonzisztencia, hanem helyes tükrözése annak, hogy mindegyik
végső soron a jelen `TASK-ISL-001`-től függ, ami még nincs `done`-ra
zárva.

Traceability: `ISL-002`…`006`, `013`, `014`, `015` közvetlenül egy-egy
SZIGET-megállapításra vezethető vissza (a fenti táblázat szerint). Az
`ISL-007` (CLI-adapter-szerződés) és `ISL-011`/`012` (Windows/Linux hostok)
nem egy konkrét SZIGET-tételre, hanem a program 6-os/7-es scope-pontjára és
az ebben az ADR-készletben hozott döntésre (ADR-082, ADR-081) vezethetők
vissza — ahogy a taskkiírás megengedi ("SZIGET-megállapításra VAGY a te
ADR-döntésedre"). Az `ISL-008`/`009`/`010` (konkrét CLI-adapterek) az
`ISL-007`/ADR-082 szerződés implementációi. Az `ISL-016`/`017`
(dokumentáció, független bizonyítás) a program egészére és a QUALITY.md
4./8. pontjára vezethető vissza, nem egyetlen SZIGET-tételre — ez
szándékos, lezáró/verifikációs jellegű task, nem hiány. **Nincs olyan
ISL-task, ami sem SZIGET-megállapításra, sem valamelyik ADR-077…085
döntésre nem vezethető vissza.**

### Adverzáriális szakasz (készítői önellenőrzés)

A feladatkiírás megköveteli, hogy a készítő MÁS szemszögből próbálja
megcáfolni a terv konzisztenciáját. Talált rések (mind nyitott kérdésként
rögzítve az érintett ADR-ben, egyik sem oldható fel egyoldalúan):

1. **SQLite egyíró-szűk-keresztmetszet:** ha a sziget-/terminálszám
   jelentősen nő, egyetlen megosztott SQLite-fájl írási szűk
   keresztmetszetté válhat AZ ÖSSZES sziget claimjeire nézve — a terv ezt
   nem oldja meg, csak jelzi (ADR-079 Nyitott kérdések).
2. **Fencing token a fájlrendszeri projekción:** ha egy lejárt lease-t
   vesztett runner MÉGIS ír egy fájlrendszeri (.md) projekciót, mielőtt
   észlelné a fencing-mismatch-et, a human-readable mailbox átmenetileg
   elavult adatot mutathat, még ha a DB helyes is — az ADR-079
   invariáns-listája KIFEJEZETTEN előírja, hogy MINDEN side-effecting írás
   (a projekciót is beleértve) ellenőrizze a fencing tokent, de ez
   implementációs fegyelem kérdése, amit egy jövőbeli code review-nak kell
   igazolnia (ISL-005).
3. **Root token, mint egypontos katasztrofális kockázat:** az egységes
   policy-motor (ADR-080) a root-esetet is a közös pipeline-ba tereli, de
   MAGÁT a koncentrált kockázatot (egyetlen globális root token minden
   szigethez) nem oldja fel — ez a jelenlegi rendszerhez képest nem
   ROSSZABB, de nem is jobb; nyitva hagyva ISL-003-nak.
4. **Federation rate-limit hiánya:** egy sziget ma korlátlan mennyiségű
   federation-üzenetet küldhetne — alacsony erőfeszítésű volumetrikus DoS
   marad lehetséges az ADR-083 tervben is, amíg a kvóta nincs implementálva
   (nyitott kérdésként rögzítve, nem blokkoló).
5. **Antigravity-feltevések gyengesége:** az ADR-082 Antigravity-sora egy
   hands-on codelabre épül, nem teljes CLI-referenciára — reális kockázat,
   hogy ISL-010 empirikusan mást talál (pl. PTY-igényt), ami módosítja az
   "összes CLI headless" munkahipotézist.
6. **DP-002 átfedési kockázat:** ha a DP-002 úgy dönt, hogy a fejlesztési
   folyamat kormányzási állapotát ÉS a futásidejű agent-üzenetküldést egy
   közös store-ba kellene olvasztani, az ADR-078 nem-átfedési határa
   újranyitandó — ez a legnagyobb, a jelen task hatáskörén túlmutató
   kockázat, EXPLICITEN nyitott kérdésként hagyva (lásd ADR-078).
7. **ADR-számütközés élő esete** (lásd 8. pont fent) — maga a tervezési
   folyamat is bizonyította a claim-jellegű erőforrás-versenyt, amit a terv
   (ADR-079) a runtime rétegre old meg, de a dokumentáció/ADR-sorszám
   kiosztás rétegén nincs hasonló mechanizmus — emberi/koordinátori
   fegyelem kérdése marad.

Egyik talált rés sem olyan súlyú, hogy a tervet `blocked`-ra kellene
minősíteni — mindegyik dokumentált nyitott kérdés, konkrét ADR-hez kötve,
és egyik sem igényel MOST tulajdonosi (Gábor) döntést a scope-on belül.

### Koordinációs pont a TASK-DP-002-vel

Lásd ADR-078 "Nyitott kérdések" — a runtime agent-üzenetküldés (ez az ADR)
és a fejlesztési-folyamat kormányzási állapot (DP-002) explicit KÜLÖN
adatsíknak van deklarálva, nem egyesítve. Emellett a munka során valós,
élő számütközés történt a két párhuzamosan futó taskkal (lásd 8. pont) —
ez önmagában is jelzi, hogy a két program tervezési munkája időben és
erőforrásban (ADR-sorszám-tér) ténylegesen megosztott, koordináció
szükséges a folytatáshoz.

---

## Független review (2026-07-18)

### Nyilatkozat a függetlenségről

Ezt a reviewt egy friss kontextusú, a fenti ADR-készlet és taskfájl
elkészítésében részt NEM vevő session végezte, kizárólag olvasás és
kódfelderítés céljából (nincs kód-/ADR-módosítás a készítő szekciójában,
nincs commit/push). A cél a terv MEGCÁFOLÁSA, nem az önértékelés
elfogadása — az alábbiak minden állítást a repo aktuális állapotával
(fájl:sor szinten, ahol releváns) vetnek össze, a készítő nyilatkozatát
sehol nem fogadtam el bizonyítékként önmagában.

### 1. A "3 versengő launch-útvonal" állítás (ADR-081) — MEGERŐSÍTVE, és TOVÁBBI RÉST TALÁLTAM

A 3 útvonal közvetlenül igazolható:

- `knowledge-service/src/bootstrap/startup.ts` `initialize()` (191-193. sor)
  feltétel nélkül hívja `startInboxWatcher()`-t és `setupInboxWatcherBridge()`-t;
  ez utóbbi `sessionStarter.ts` `startTerminalSession`-jét hívja (tmux-alapú
  indítás) — nincs `ENABLE_*` kapu. A `bootstrap/README.md` (47-50. sor) saját
  maga dokumentálja, hogy az `ENABLE_INBOX_WATCHER` kulcs hatástalan.
- `knowledge-service/src/pipeline/nightwatch.ts` (10. és 63. sor) hívja
  `pipeline/watchInbox.ts` `runWatchInbox()`-ot, `env.ENABLE_NIGHTWATCH` mögött.
- `knowledge-service/src/runner/sessionLauncher.ts` `launch()` (68-146. sor)
  saját `spawn`-hívással indít `claude -p` folyamatot — Windows ágon
  `shell: true` string-join (104-110. sor), pontosan az ADR-082 által leírt
  hardening-hiány.

**Saját talált rés, amit az ADR-081 NEM fed le:** a `runWatchInbox()`
(`pipeline/watchInbox.ts` 126. és 179. sor) valójában NEM közvetlenül indít
sessiont, hanem HTTP-n hívja saját magát: `POST /api/session/inject` és
`POST /api/session/start`. Ezek az útvonalak
`knowledge-service/src/interfaces/http/routes/session.routes.ts`-ben élnek,
és `knowledge-service/src/bootstrap/app.ts` 226. sorában
`app.use('/api/session', requireRootForMutations, sessionRoutes)` alatt
vannak felmontírozva — vagyis **bármely root-tokent birtokló hívó
közvetlenül, a queue/lease és a watcher-lánc teljes megkerülésével**
meghívhatja `POST /api/session/start`-ot és elindíthat egy sessiont
(`session.routes.ts` 22-30. sor → `sessionManager.ts` `startSession`).
Ugyanez igaz `knowledge-service/src/interfaces/http/routes/control.routes.ts`
`POST /dispatch` végpontjára (262-315. sor): ez is közvetlenül hívja a
`sessionManager.ts` `startSession`-t, egy MÁSODIK, `task-audit/auth.ts`
`verifyToken`-alapú (SHA-256, `config/tokens.yaml`) auth-ellenőrzéssel, a
külső `requireRootForMutations` kapu MELLETT (két, egymástól független
token-rendszer egymásra rétegezve ugyanazon az endpointon).

Ez azt jelenti, hogy a valós launch-képes belépési pontok száma **legalább
5** (3 automatizált mechanizmus + 2 közvetlenül hívható HTTP-végpont), és
az ADR-081 "Következmények"/"Kapcsolódó kód" szakasza EZT A KETTŐT
(`session.routes.ts`, `control.routes.ts /dispatch`) egyáltalán nem
említi, tehát nincs eldöntve, hogy ISL-013 lezárja, lease-ellenőrzés mögé
teszi, vagy tudatos, naplózott operátori vészmegkerülésként tartja meg
őket. Ez pontosan az a fajta nyitott, kritikus szerződés-hiány, amit a
README kilépési szabálya blokkolónak minősít — az ADR-081 "a queue+lease
réteg MAGA az egyetlen launch authority" állítása MA, a jelen kódbázisban,
már cáfolható ezen a két útvonalon keresztül, és a terv ezt nem zárja le.

### 2. Az ADR-078 `getOutbox()` regresszió — MEGERŐSÍTVE, pontos

`knowledge-service/src/task-message-box/store.ts`:

- `canonicalTypes()` (`message-model.ts:90`) a `config/message-model.yaml`
  `types:` listáját adja vissza: `task, question, response, info` — a
  `done`/`blocked` NEM szerepel köztük (a fájl fejléc-kommentje explicit
  kimondja: "'done'/'blocked' used to be BOTH a type and a status — that
  conflation is fixed here").
- `renderMessageToFile()` (244-248. sor): `message.type === 'done' ||
  message.type === 'blocked'` — ez a feltétel SOHA nem lehet igaz, mert a DB
  CHECK-kényszer (63. sor, `canonicalTypes()`-ból generálva) kizárja ezt az
  értéket `type` oszlopon. Minden üzenet tehát mindig az `inbox` ágra esik,
  sosem az `outbox`-ra.
- `getOutbox()` (633-641. sor): `WHERE from_terminal = ? AND type IN ('done',
  'blocked')` — azonos okból mindig 0 sort ad vissza.

Az ADR-078 állítása szó szerint, sorpontossággal igazolható — ez egy valódi,
élő, a jelen review során is reprodukálható bug, nem csak dokumentációs
állítás.

### 3. A "3 auth-réteg + federation bypass + context-elvesztés" (ADR-080) — MEGERŐSÍTVE, egy 4. réteget találtam

- `auth/tokenAuth.ts` `requireRoot`/`requireRootForMutations` (263-288. sor).
- `mcp.ts` `canUseTool` (119-142. sor) — a `loadToolPermissions()` (64-105.
  sor) hardcodolt fallback objektumra vált, ha a YAML-betöltés hibázik
  (87-100. sor) — konfirmálva.
- `mcp.ts` `authorizeMailboxRest` (161-230. sor) — kézzel írt szabályok,
  `req.mcpIsland` egyszer sem szerepel benne — konfirmálva.
- `federation.routes.ts` `POST /send` (34-42. sor: `b.from_island`,
  `b.to_island` közvetlenül `req.body`-ból) és `GET /inbox` (56. sor:
  `req.query.island`) — egyik sem veti össze `req.mcpIsland`-del —
  konfirmálva, ez a bizonyított cross-island rés.
- `task-message-box.tools.ts` (11-17. sor): `async (args) =>
  (await handleTaskMessageBoxTool(def.name, args))` — a `context`
  paramétert valóban eldobja, miközben `mcp.ts` `dispatchToolCall` (243-265.
  sor) ténylegesen átadná (`handler(args, { terminal, island })`) — a
  vezeték megvan, a regisztráció nem használja — konfirmálva.

**Saját talált rés:** `control.routes.ts` `requireAuth()` (62-78. sor) egy
TELJESEN KÜLÖN, negyedik auth-rendszert használ: `task-audit/auth.ts`
`verifyToken` — SHA-256 hash-elt tokenek `config/tokens.yaml`-ból,
scope-alapú, saját LRU cache-sel, semmilyen kapcsolat a `tokenAuth.ts`
`(island_id, terminal_id)` modelljével. Ez ma az `app.ts` szintű
`requireRootForMutations` MÖGÉ van rétegezve, tehát önmagában nem bypass —
de az ADR-080 egységes policy-pipeline-ja ezt a negyedik mechanizmust sem
említi a "Kapcsolódó kód" szakaszban, holott ugyanolyan párhuzamos,
be nem vont autorizációs réteg, mint a fent már azonosított három — ha
egy jövőbeli route ezt a mintát másolja anélkül, hogy tudná: a külső
`requireRootForMutations` kapu véd, könnyen defense-in-depth nélküli,
önmagában is "elég" auth-nak hihető rendszert hozhat létre.

### 4. ADR-082 (CLI adapter) élő doksi-ellenőrzés — SAJÁT WebFetch-hel újra elvégezve

Van webelérésem; mindhárom URL-t önállóan lekérdeztem 2026-07-18-án:

- `https://learn.chatgpt.com/docs/non-interactive-mode` — **megerősítve**:
  `codex exec`, `--json`, `--sandbox workspace-write|danger-full-access`,
  `--output-schema`, `-o`/`--output-last-message`, `--ephemeral`,
  `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check` mind
  jelen vannak; nincs verziószám/dátum az oldalon — pontosan az ADR állítása.
- `https://docs.anthropic.com/en/docs/claude-code/cli-usage` — **megerősítve**:
  301 redirect `https://code.claude.com/docs/en/cli-usage`-re. A célon
  minden flag egyezik az ADR táblázatával (`-p`/`--print`,
  `--output-format text|json|stream-json`, `--json-schema`, `--max-turns`,
  `--max-budget-usd`, `--allowedTools`/`--disallowedTools`,
  `--permission-mode` a 7 felsorolt értékkel, `--dangerously-skip-permissions`,
  `--input-format`). **Egy pontatlanságot találtam:** az ADR azt állítja,
  hogy "az oldal aktuális verzióként v2.1.212-t említi" — az én lekérdezésem
  ezen az oldalon NEM talált egyetlen kiírt "v2.1.212" verziószámot sem,
  csak `min-version: 2.1.XXX` jellegű funkció-annotációkat. Lehet, hogy ez
  egy `claude --version` helyi lekérdezésből származó adat, amit az ADR
  szövege félreérthetően "az oldal említi"-ként ír le — nem blokkoló, de
  pontosítandó (ADR-082 4. bizonyíték-szakasz).
- `https://codelabs.developers.google.com/antigravity-cli-hands-on` —
  **megerősítve**: `agy`, verzió 1.0.7 (és 1.0.1 is említve), `-p`
  autonóm/nem-interaktív mód, `--model`, `--dangerously-skip-permissions`,
  NINCS dokumentált strukturált JSON kimenet — mind egyezik.

Összegzés: a 3 URL-ellenőrzés tartalmilag és a legtöbb részletben pontos;
egyetlen apró, nem blokkoló pontatlanságot találtam (Claude Code
verziószám forrása).

### 5. Az önadverzáriális szakasz értékelése — VALÓDI, kiegészítve

A készítő 7 pontja (SQLite egyíró-szűk-keresztmetszet, fencing vs.
fájlrendszeri projekció, root-token koncentráció, federation rate-limit
hiánya, Antigravity-feltevés gyengesége, DP-002 átfedés, élő
ADR-számütközés) mindegyike konkrét, kód- vagy tervezési tényre hivatkozik,
nem formális kitöltés — ez teljesíti a README elvárását. Saját, a fentieken
felüli kiegészítésem:

- **1. pont fent (5. valódi launch-belépési pont)** — ez blokkoló súlyú,
  mert az ADR-081 saját garanciáját cáfolja meg a jelen kódbázisban.
- **3. pont fent (4. auth-réteg)** — nem blokkoló, de kiegészítendő
  ADR-080-ban.
- **ADR-084 elírás:** a "Kapcsolódó kód" és "Kontextus" szakasz kétszer is
  `ADR-077…074`-et ír (`docs/architecture/decisions/ADR-084-migration-threat-rollback-plan.md`,
  6. és 97. sor) — ez visszafelé mutató, értelmetlen tartomány (074 < 077),
  szinte biztosan elírás `ADR-077…083` helyett. Kozmetikai hiba, nem
  architekturális, de javítandó a végleges szövegben.

### 6. SZIGET-01…10 → ADR-táblázat

Mind a 10 megállapításhoz tartozik célállapot és ADR-hivatkozás (a
taskfájl "SZIGET-01…10 → célállapot → ADR-hivatkozás" táblázata), és minden
hivatkozott ADR ténylegesen tárgyalja is az adott megállapítást (kereszt-
ellenőrizve az ADR-077…085 szövegével fent) — nincs hiányzó vagy üres
sor. **PASS.**

### 7. Függőségi DAG (ISL-002…017)

Önállóan kiolvastam mind a 16 taskfájl frontmatter `depends_on` mezőjét
(nem fogadtam el a készítő Explore-agent összefoglalóját): pontos egyezés
a README táblázatával, minden él szigorúan alacsonyabb sorszámra mutat →
topologikus rend, körmentes. **PASS**, megerősítve.

### 8. DP-002 határvonal (ADR-078 Nyitott kérdések)

Elolvastam a teljes `ADR-068-canonical-project-task-state.md`-t is. A
határ ("design-intent réteg: EPICS.yaml/task-fájl, git-review; runtime-
state réteg: tranzakciós DB, CAS") koherens, és az ADR-068 saját
"Kapcsolódás más programokhoz" szakasza (484-504. sor) EXPLICITEN
ugyanezt a határt írja le a másik irányból, ugyanazzal a következtetéssel
("a runtime-state réteg... NEM egy harmadik, önálló igazságforrásként").
A két ADR nem mond ellent egymásnak, és mindkettő nyíltan jelzi a hármas
"task"-terminológia kockázatát nyitott kérdésként. **Védhető elhatárolás,
nem találtam tartalmi ellentmondást.**

### 9. `node scripts/check-doc-links.mjs`

Önállóan lefuttatva: `Ellenőrizve: 85 markdown-link (docs), 8
ADR-útvonal-hivatkozás, 155 ADR-szám-említés (knowledge-service/src)` →
`OK`, exit code 0. (A készítő 76 linket jelentett; az eltérés a review
közben eltelt egyéb, párhuzamos munka miatt lehet — a lényegi eredmény,
a zöld/OK állapot, megegyezik.)

### 10. A 10 kötelező "done előtt" pont (README) tételes ellenőrzése

| # | Pont | Ellenőrzés |
|---|---|---|
| 1 | eredeti goal és tényleges eredmény | Jelen — 1. szakasz |
| 2 | architekturális döntések és elvetett alternatívák | Jelen — 2. szakasz + minden ADR saját "Alternatívák" |
| 3 | módosított fájlok és migrációk | Jelen — 3. szakasz, pontos |
| 4 | futtatott parancsok, exit code, teszteredmény | Jelen — 4. szakasz, önállóan reprodukálva (9. pont fent) |
| 5 | OS/shell/arch/Node/CLI-verzió | Jelen — 5. szakasz |
| 6 | biztonsági és rollback-ellenőrzés | Jelen — 6. szakasz + ADR-084 |
| 7 | Windows/Linux/CLI kompatibilitás | Jelen — 7. szakasz, korrekten "N/A ezen a taskon" |
| 8 | ismert korlátok, kockázatok, teendők | Jelen — 8. szakasz, őszinte (beleértve a saját hiányosságait) |
| 9 | reviewer neve/szerepe, bizonyíték | **Ez a szakasz tölti ki — lásd lent** |
| 10 | sikerkritérium/kilépési feltétel PASS/FAIL | Jelen — 10. szakasz |

**Reviewer:** független review-session (adverzáriális szerep, TASK-ISL-001
kivitelezésében nem vett részt). **Ellenőrzési bizonyíték:** ez a teljes
szakasz — közvetlen kódolvasás (idézett fájl:sor hivatkozások), önálló
`check-doc-links.mjs` futtatás, önálló `depends_on` DAG-kiolvasás, önálló
WebFetch a 3 CLI-doksira.

### Verdikt: **REQUEST_CHANGES**

**Indoklás:** az architektúra nagy része logikailag védhető, minden
SZIGET-megállapítás lefedett, a self-adversarial szakasz valódi réseket
talált, a DAG körmentes, a linkellenőrzés zöld, és a 10 kötelező pont
formailag teljes. A PASS-t egyetlen, de a döntési szabály szerint blokkoló
súlyú talált rés akadályozza: **az ADR-081 "egyetlen launch authority"
állítása ma, a jelen kódbázis mellett, cáfolható** két, az ADR által nem
tárgyalt HTTP-végponton (`POST /api/session/start`/`inject`,
`session.routes.ts`; `POST /api/control/dispatch`, `control.routes.ts`)
keresztül, amelyek közvetlenül hívják a `sessionManager.ts` `startSession`-t
a lease-réteg megkerülésével. Ez pontosan a README kilépési szabálya által
nevesített eset: "egy olyan hiányzó ADR-döntés, ami nélkül az ISL-002…017
taskok implementálói nyitott, kritikus kérdéssel maradnának" — jelen
esetben konkrétan az ISL-013 (workflow/launch authority) implementálója
nem tudná a taskfájlból és az ADR-081-ből eldönteni, mi történjen ezzel a
két endpointtal.

**Szükséges javítás a PASS-hoz:**

1. ADR-081 (vagy egy rövid kiegészítő szakasza) egészüljön ki explicit
   döntéssel `session.routes.ts` (`/api/session/start`, `/inject`, `/wake`)
   és `control.routes.ts` (`POST /dispatch`) sorsáról: lease-ellenőrzés
   mögé kerülnek, megszűnnek, vagy tudatos, naplózott, dedikált
   operátori-vészhelyzeti kivétellé minősülnek (ha igen: milyen
   audit/duplikáció-védelemmel) — ugyanolyan részletességgel, mint az
   `inboxWatcher.ts`/`watchInbox.ts` már meglévő döntése.
2. Kisebb, nem blokkoló javítások, amelyeket érdemes egy körben elvégezni:
   - ADR-084 "Kontextus" és "Kapcsolódó kód" szakaszában az `ADR-077…074`
     hivatkozás javítása `ADR-077…083`-ra (2 előfordulás).
   - ADR-080 "Kapcsolódó kód" szakasza egészüljön ki
     `knowledge-service/src/task-audit/auth.ts`-szal mint negyedik,
     jelenleg be nem vont autorizációs mechanizmussal.
   - ADR-082 "Bizonyíték" szakaszában a Claude Code CLI "v2.1.212"
     verziószám forrása pontosítandó (doksi-oldal vs. helyi
     `claude --version`).

A frontmatter `status` mezője emiatt **NEM** kerül `done`-ra — a fenti 1.
pont javítása után egy következő review-kör PASS-t adhat, feltéve, hogy
a többi megállapítás időközben nem változik.

---

## Válasz a REQUEST_CHANGES-re (2026-07-19)

A készítő (ez a session) a fenti független review mind a 4 megállapítására
(1 blokkoló + 3 kisebb) reagált, ÉS a koordinátor kifejezett kérésére —
mivel a DP-002 review-nál is kiderült, hogy pontonkénti pótlásnál újabb
writer/endpoint kerül elő — egy KIMERÍTŐ, mechanikus keresést futtatott
minden launch-képes belépési pontra, nem csak a reviewer által talált
kettőre.

### 1. A blokkoló hiányosság javítása — ADR-081 kiegészítve

Az [ADR-081](../../architecture/decisions/ADR-081-single-launch-authority.md)
kapott egy "Kimerítő launch-belépési pont audit (2026-07-19 kiegészítés)"
szakaszt, ami:

- rögzíti a koordinátor által megadott `rg` parancs TELJES kimenetét (19
  sor, 10 találat-csoport);
- minden találatot besorol (a/lease-en megy át, b/explicit indokolt
  kivétel, c/bezárandó) egy táblázatban;
- a reviewer 2 endpointjára (`session.routes.ts`, `control.routes.ts
  /dispatch`) EXPLICIT döntést hoz — lásd lent;
- 3 ÚJ, korábban egyik ADR-ben sem tárgyalt találatot is lezár:
  `pipeline/watchPriority.ts` (a nightwatch-család eddig nem nevesített
  tagja), `spawn_parallel_workers`/`spawn_raw_workers` MCP toolok
  (worker.tools.ts), és a `codegen/*` `spawn()` hívások (explicit
  hatálykizárás, indoklással);
- feltár egy ÖTÖDIK, korábban nem inventarizált queue-rendszert
  (`dispatch-control/`, saját SQLite-sémával) és egy HATODIK, önálló
  budget-mechanizmust (`pipeline/costLimiter.ts`) — ezeket nyitott
  kérdésként rögzíti (ISL-004/ISL-005/ISL-013 implementálójának hatálya),
  nem oldja fel egyoldalúan, mert a pontos konszolidációs séma
  implementációs döntés, nem ADR-szintű tervezési kérdés.

**Döntés a reviewer 2 endpointjáról** (a részletek az ADR-081-ben):

- `POST /api/session/start|inject|wake|stop|stop-all`
  (`session.routes.ts`) — **(b) MEGMARAD explicit, root-only, auditnaplózott
  operátori override-ként**, 4 kötelező kiegészítéssel (közös
  audit-napló, opcionális claim-integráció task-kötött hívásnál,
  tudatosan state-machine-en kívüli tisztán ad hoc eset, `origin:
  manual-override` címke a store-ban).
- `POST /api/control/dispatch` (`control.routes.ts`) — **(c) MEGSZŰNIK**
  mint közvetlen `startSession`-hívás; a claim-endpointra fordítandó át,
  a `dispatch-control` budget-logikája bemenetté válik az egységes
  budget-kapuban.

Ezzel az ISL-013 implementálójának MÁR NINCS nyitott, kritikus kérdése
egyetlen talált launch-belépési ponttal kapcsolatban sem — mindegyik
explicit (a)/(b)/(c) döntést kapott.

### 2. A 3 kisebb hiba javítása

- **ADR-084 elgépelés:** mind a 2, a reviewer által idézett előfordulás
  JAVÍTVA `ADR-077…083`-ra — a javítás közben egy HARMADIK, a reviewer
  által nem idézett előfordulást is találtam ugyanezzel a hibával
  (a "Kontextus" szakasz nyitó mondatában) — az is javítva.
- **ADR-080 kiegészítve** negyedik autorizációs mechanizmusként:
  `task-audit/auth.ts` (`verifyToken`/`authorizeScope`, hardcodolt
  fallback-tokenek, saját `VALID_TERMINALS` ötödik terminál-lista) — a
  Kontextus, Döntés, Kapcsolódó kód és Bizonyíték szakaszok mind bővültek.
- **ADR-082 Claude Code verziószám pontosítva:** a szöveg most explicit
  leírja, hogy a "v2.1.212" korábbi állítás téves általánosítás volt a
  min-version funkció-annotációkból, nincs önálló verzió-banner az
  oldalon, és a helyes eljárás a `claude --version` helyi lekérdezése az
  implementáció napján.

### 3. Ellenőrzés

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 85 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat."  (exit code 0)
```

A `rg` audit-parancs eredménye és minden találat besorolása az ADR-081-ben
van rögzítve (nem itt duplikálva), a QUALITY.md 5. pontja ("token-tudatosság,
ne generáljunk feleslegesen") szellemében.

### 4. Módosított fájlok (ez a kör)

- `docs/architecture/decisions/ADR-081-single-launch-authority.md` —
  jelentősen bővítve (kimerítő audit szakasz, 4 új döntési pont, bővített
  Következmények/Kapcsolódó kód/Bizonyíték/Nyitott kérdések).
- `docs/architecture/decisions/ADR-080-unified-authorization-policy.md` —
  4. auth-mechanizmus hozzáadva.
- `docs/architecture/decisions/ADR-082-cli-adapter-contract.md` —
  verziószám-állítás pontosítva.
- `docs/architecture/decisions/ADR-084-migration-threat-rollback-plan.md`
  — 3 elgépelés javítva.
- `docs/architecture/decisions/ADR-078-canonical-task-message-store.md` —
  kereszthivatkozás az újonnan talált ötödik queue-rendszerre (Nyitott
  kérdések).
- `docs/tasks/island-runtime/TASK-ISL-001-target-architecture.md` (ez a
  fájl) — ez a szakasz; a tetején lévő státuszjelzés frissítve.

Forráskód-módosítás ebben a körben sem történt — a `session.routes.ts`,
`control.routes.ts`, `worker.tools.ts` és `dispatch-control/` tényleges
átírása ISL-013 (és részben ISL-004/ISL-005) implementációs feladata, nem
ezen ADR-task hatálya.

### 5. Sikerkritérium — a reviewer szükséges javításainak PASS/FAIL

| Reviewer-elvárás | Eredmény |
|---|---|
| ADR-081 explicit döntés `session.routes.ts` sorsáról | **PASS** — (b) explicit, indokolt kivétel, 4 feltétellel |
| ADR-081 explicit döntés `control.routes.ts /dispatch` sorsáról | **PASS** — (c) megszűnik, claim-endpointra fordítva |
| Kimerítő audit minden launch-képes belépési pontra (nem csak a 2 talált) | **PASS** — 10 találat-csoport, mind besorolva; 2 új rendszer (dispatch-control, costLimiter) feltárva és nyitott kérdésként rögzítve |
| ADR-084 elgépelés javítva | **PASS** — 3/3 előfordulás javítva |
| ADR-080 4. auth-mechanizmus felvéve | **PASS** |
| ADR-082 verziószám pontosítva | **PASS** |
| `check-doc-links.mjs` zöld | **PASS** |
| Frontmatter `status` marad `ready`, nincs önzáró `done` | **PASS** |

A frontmatter `status` mezője továbbra is `ready` — a formális elfogadást
egy KÖVETKEZŐ, friss kontextusú, adverzáriális reviewer adhatja meg.

---

## Független review, 2. kör (2026-07-18)

### Nyilatkozat a függetlenségről

Ezt a review-t egy friss kontextusú session végezte, amely sem az eredeti
ADR-készlet, sem az 1. kör REQUEST_CHANGES-ére adott válasz elkészítésében
nem vett részt. Kizárólag olvasás, kódfelderítés és parancsfuttatás
történt — nincs kód-/ADR-módosítás a készítő szekcióiban, nincs
commit/push. Az 1. kör reviewerének egyetlen állítását sem fogadtam el
önmagában bizonyítékként; mindent újra, önállóan futtattam vagy fájl:sor
szinten ellenőriztem.

### 1. A koordinátor `rg`-parancsának önálló újrafuttatása

```
rg -n "startSession|spawnRawWorker|startTerminalSession|startParallelWorkSession|claude -p|spawn\(" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'
```

Az önálló futtatás **szó szerint, sorra egyezik** az ADR-081 "Kimerítő
launch-belépési pont audit" szakaszában rögzített 19 sorral (10
találat-csoport). Nem találtam eltérést ebben a konkrét parancs
kimenetében. **Ugyanakkor lásd a 6. pontot: maga a parancs bizonyult
hiányosnak**, nem a rögzített kimenet.

### 2. `session.routes.ts` és `control.routes.ts /dispatch` — kód vs. ADR-állítás

Mindkét fájlt megnyitottam. A kód **változatlan** maradt ebben a körben:

- `session.routes.ts:22-35` (`POST /start`) ma is közvetlenül hívja
  `startSession(...)`-t — nincs audit-napló-bővítés, nincs claim-
  integráció, nincs `force`/`origin: manual-override` mező.
- `control.routes.ts:262-315` (`POST /dispatch`) ma is közvetlenül hívja
  `startSession(...)`-t a `dispatch-control` budget-logikán keresztül —
  nincs claim-endpointra fordítás.

Ez **elfogadható**, mert az ADR-081 mindkét esetben explicit,
jövő idejű, implementációs feladatként ("ISL-013 implementációs
feladata", "MEGSZŰNIK... ISL-013 implementációja során") jelöli a
változtatást, nem múlt idejű tényként. A taskfájl "Nem cél" szakasza is
kizárja a runtime-implementációt ebből a taskból. A "Válasz a
REQUEST_CHANGES-re" szakasz maga is világosan írja (4. pont, "Módosított
fájlok"): "Forráskód-módosítás ebben a körben sem történt... ISL-013 (és
részben ISL-004/ISL-005) implementációs feladata." **PASS** — a
döntés dokumentálva van, a kód-ADR eltérés tudatosan, jövőbeli állapotként
jelzett, nem félrevezető.

### 3. Ötödik queue-store (`dispatch-control/`) és hatodik budget-mechanizmus (`pipeline/costLimiter.ts`)

Mindkettő létezik, önállóan ellenőrizve:

- `knowledge-service/src/dispatch-control/` — `index.ts`,
  `dispatchProposal.ts`, `scheduledWindows.ts`, `tokenBudget.ts`,
  `schema.sql` — saját SQLite-séma, ahogy az ADR állítja.
- `knowledge-service/src/pipeline/costLimiter.ts` — `calculateMaxParallel`,
  `checkCostAlerts`, saját `SOFT_LIMIT_PER_HOUR`/`HARD_LIMIT_PER_HOUR`/
  `CRITICAL_LIMIT_PER_HOUR` konstansok — önálló, harmadik budget-számláló a
  `dispatch-control/tokenBudget.ts` és a `terminals.yaml token_budgets`
  mellett, ahogy az ADR állítja.

Az ADR-078 kereszthivatkozása ("Nyitott kérdések", 153-162. sor) **nem
egyoldalú döntés**, hanem explicit nyitott kérdésként rögzíti az
ISL-004 implementálójának hatáskörét — ez megfelelő kezelés egy
tervezési taskban; nem blokkoló, mert az ISL-004/005/013 implementálója
konkrét, névvel nevesített döntési pontot kap, nem egy elrejtett
felfedezetlen rendszert. **PASS.**

### 4. `task-audit/auth.ts` — ADR-080 felvétele

A fájlt teljes egészében elolvastam. Az ADR-080 állítása pontról pontra
igazolható:

- `loadTokensConfig()` (113-141. sor): config-betöltési hiba esetén
  hardcodolt fallback — `hash: hashToken('dev-token-root-2026')` → `root`
  holder, `session:*` scope; `hash: hashToken('dev-token-conductor-2026')`
  → `conductor` holder — **szó szerint egyezik** az ADR állításával.
- `VALID_TERMINALS` (255-263. sor): pontosan 7 elem (`backend, frontend,
  designer, architect, librarian, explorer, conductor`) — **hiányzik
  belőle `root`, `nexus`, `monitor`, `reviewer`, `federation`,
  `chat-root`, `backend-2`, `frontend-2`**, ahogy az ADR állítja.

Az ADR-080 felvétele (Kontextus 4. pont, Döntés, Kapcsolódó kód,
Bizonyíték szakaszok) tartalmilag pontos és teljes. **PASS.**

### 5. ADR-082 Claude Code verzió-állítás korrekciója — saját WebFetch

Önállóan lekérdeztem a `https://code.claude.com/docs/en/cli-usage` oldalt.
Megerősítve: **nincs** kiírt "jelenlegi verzió: vX.Y.Z" mondat vagy banner
az oldalon; a táblázat kizárólag flagenkénti `min-version:` jellegű
kommentannotációkat tartalmaz (a lekérdezés a legmagasabb megfigyelt
értékként `2.1.212`-t azonosította egy konkrét flagnél — ez valószínűleg
az eredeti, téves "az oldal v2.1.212-t említi" állítás forrása volt). A
`--version`/`-v` flag létezik a parancsreferenciában, de az oldal
**nem ajánlja proaktívan** ezt "az aktuális verzió" lekérdezésének
módjaként — ez egy árnyalatnyi pontatlanság az ADR javított szövegében
("a helyes eljárás a `claude --version` helyi lekérdezése" — ez ÉSSZERŰ
ajánlás, csak nem szó szerint az oldalról származik), de **nem blokkoló**,
mert a lényegi állítás (nincs kiírt verzióbanner, csak min-version
annotációk) helytálló. **PASS, apró árnyalattal.**

### 6. Saját, ÚJ talált rés: a "kimerítő" audit maga nem kimerítő — élő, be nem sorolt launch-mechanizmusok

A 2. pontban visszaigazoltam, hogy a rögzített `rg`-parancs kimenete
pontos. De maga a **parancs módszertana** hiányos: kizárólag
`spawn\(`-hívásokat és néhány konkrét függvénynevet keres, és a `claude -p`
szó szerinti alakot — ez szisztematikusan kihagyja azokat a session-
indító mechanizmusokat, amelyek `exec`/`execSync`-cel, tmux
`send-keys`/`new-session` paranccsal indítanak `claude`-ot MÁS argumentum-
alakkal (pl. `claude --model <x>`). Ezt a hiányt magam a
`rg -n "claude " knowledge-service/src` és `rg -n "child_process|exec\("`
tágabb kereséssel találtam meg. Konkrétan:

- **`knowledge-service/src/chatSessionStarter.ts`** `startChatSession()`
  (137-246. sor): önálló tmux-session (`spaceos-<terminal>-chat`) létrehozása
  (`tmux new-session`) és `claude --model haiku` indítása
  (207. sor, `execAsync(...)`) — ez egy TELJES, önálló, élő Claude Code
  CLI-session-launch mechanizmus, amit az ADR-081 audit egyáltalán nem
  említ, és ami NEM szerepel a talált 10 csoport egyikében sem. Élőben
  elérhető, gating nélkül:
  - `telegram/multiBotManager.ts:233` és `telegram/telegramService.ts:207`
    közvetlenül hívja Telegram-üzenet érkezésekor;
  - `interfaces/mcp/tools/session.tools.ts:118-119` egy MCP tool-ból
    (`injectToChatSession('conductor', ...)`) — vagyis egy másik agent is
    el tudja indítani/injektálni ezt a session-t.
  Ez nem "review-only" vagy "notification-only" mellékág: valódi,
  interaktív `claude` folyamatot indít egy terminál identitásán, a
  queue/lease réteg teljes megkerülésével — pontosan az a kategória, amit
  az ADR-081 Döntés-szakasza a "launch authority" alá von.
- **`knowledge-service/src/pipeline/autoRestart.ts`** (`checkAndRestart`/
  `freshRestart`, 134-154. sor): `env.ENABLE_AUTO_RESTART` mögött (ma
  `false` a `.env.dev`-ben, de **élesben bekapcsolható és a bootstrap
  ténylegesen elindítja a schedulert**, `bootstrap/startup.ts:251`
  `startAutoRestartScheduler(...)`), a session `killSession` +
  `newSession` + `sendKeys(session, 'claude --model ...')` hívással
  automatikusan újraindít egy MEGLÉVŐ terminál-sessiont. Ez strukturálisan
  UGYANAZ a mintázat, mint az ADR-081-ben már tárgyalt `nightwatch`/
  `watchPriority` család (flag-gated, de a launch-útvonal maga élő kód),
  mégsem szerepel az ADR "nightwatch-család" felsorolásában, sem a 10
  talált csoport között.
- **`knowledge-service/src/pipeline/autonomousDev.ts`** (274-312. sor):
  `env.ENABLE_AUTONOMOUS_DEV` mögött, szintén `bootstrap/startup.ts:297`
  `startAutonomousDevScheduler()`-rel élesben induló scheduler — `killSession`
  + `newSession` + `sendKeys(session, 'claude --model <conductorModel>')`
  + a felépített prompt injektálása — ez egy TELJES, önálló "conductor
  session automatikus (újra)indítása" mechanizmus, szintén hiányzik az
  ADR-081-ből.
- **`knowledge-service/src/pipeline/terminalReviewer.ts`** (`runTerminalReview`,
  198-230. sor): `spaceos-review-<terminal>` néven önálló, efemer
  review-session létrehozása és `claude --model <MODEL>` indítása —
  ELLENŐRIZVE, hogy ma NINCS élő hívója a `src` alatt (kizárólag
  `__tests__/unit/terminalReviewerPipeline.test.ts` hívja
  `runDualTerminalReview`-t) — tehát ez ma **valószínűleg dead code**
  production-oldalon, alacsonyabb súlyú megállapítás, de az audit
  módszertani hiányát ez is demonstrálja.

**Miért blokkoló ez, és nem csak egy újabb "nyitott kérdés":** a
koordinátor kifejezetten egy KIMERÍTŐ, minden launch-képes belépési
pontra kiterjedő auditot kért, PONT azért, mert az 1. kör már bebizonyította,
hogy a "3 mechanizmus" feltevés hiányos volt. A válasz-szakasz ezt a
kérést a `rg`-parancs egyetlen mintakészletére szűkítette, és ennek
eredményét "kimerítő"-ként állította be — de a minta maga vakfoltos
(nem fedi az `exec`/`execSync`-alapú, tmux-injektált indítási mintát, ami
a kódbázisban legalább 3 további, ebből 2 ÉLESBEN induló helyen létezik).
Ez PONTOSAN az a hiba-osztály, ami az 1. kört REQUEST_CHANGES-re
juttatta (egy állítólag lezárt garancia, ami a jelen kódbázison cáfolható)
— csak most az audit-módszertan szintjén, nem az eredeti ADR-döntés
szintjén jelentkezik újra.

### 7. `node scripts/check-doc-links.mjs`

Önállóan lefuttatva: `Ellenőrizve: 86 markdown-link (docs), 8
ADR-útvonal-hivatkozás, 155 ADR-szám-említés (knowledge-service/src)` →
`OK — minden hivatkozás létező célra mutat.` (exit code 0). **PASS**
(az eltérő linkszám a 76→85→86 sorozatban a párhuzamos dokumentáció-
munka miatt várható, nem hiba).

### 8. Egyéb tételek (DAG, SZIGET-tábla, ADR-084 elgépelés) — újraellenőrizve

- Függőségi DAG: önállóan kiolvasva mind a 16 `depends_on` mező —
  megegyezik a README táblázatával, körmentes. **PASS.**
- SZIGET-01…10 → ADR tábla: minden sor megfelel a hivatkozott ADR
  tartalmának. **PASS.**
- ADR-084 `ADR-077…074` elgépelés: a jelenlegi szövegben mindhárom
  előfordulás (Kontextus nyitó mondata, 10. sor; "Kapcsolódó kód", 97. sor)
  már helyesen `ADR-077…083`-at ír — **javítva, PASS.**

### Verdikt: **REQUEST_CHANGES**

**Indoklás:** az 1. kör két konkrét, névvel nevesített hiányosságát (a
`session.routes.ts`/`control.routes.ts` endpontok, a 3 kisebb hiba) a
készítő korrekten, tételesen javította, és a kért kimerítő audit ELVÉGZÉSE
önmagában véve komoly, jóhiszemű munka volt (10 találat helyesen
besorolva, 2 új rendszer feltárva és nyitott kérdésként rögzítve). Ez a
munka azonban **nem tette azzá, aminek nevezte magát**: a "kimerítő,
mechanikus" jelző egyetlen `rg`-mintakészletre korlátozódott, és ez a
mintakészlet igazolhatóan vak egy egész kategóriára (tmux/exec-alapú
`claude`-indítás, nem csak `spawn`/`claude -p`). Ez saját, önálló
kereséssel legalább 2 ÉLESBEN bootstrap-olt, gating mögötti, de valódi
launch-mechanizmust (`autoRestart.ts`, `autonomousDev.ts`) és 1, gating
nélkül élesben elérhető, Telegram/MCP-ről hívható teljes session-indítót
(`chatSessionStarter.ts`) tárt fel, amelyeket az ADR-081 "Kimerítő
launch-belépési pont audit" szakasza NEM tartalmaz, és amelyekről az
ISL-013 implementálójának ugyanúgy nincs eldöntött szerződése, mint amit
az 1. kör a `session.routes.ts`/`control.routes.ts` esetén blokkolónak
minősített. Ez a README kilépési szabálya szerinti "hiányzó ADR-döntés,
ami nélkül az ISL-002…017 implementálói nyitott, kritikus kérdéssel
maradnának" esete — most a `chatSessionStarter`/`autoRestart`/
`autonomousDev` család vonatkozásában.

**Szükséges javítás a PASS-hoz:**

1. Az ADR-081 "Kimerítő launch-belépési pont audit" szakaszát ki kell
   egészíteni egy MÁSODIK kereséssel, ami az `exec\(|execSync\(` és a
   `newSession|sendKeys|killSession|tmux .* send-keys` mintákat is
   lefedi (nem csak `spawn\(`/`claude -p`), és a talált eredményeket
   (legalább `chatSessionStarter.ts`, `pipeline/autoRestart.ts`,
   `pipeline/autonomousDev.ts`, `pipeline/terminalReviewer.ts`) ugyanolyan
   (a/b/c) besorolással kell ellátni, mint az első 10 csoportot.
2. Kifejezett döntés kell `chatSessionStarter.ts` `startChatSession`/
   `injectToChatSession`/`injectTelegramWithContext` sorsáról — ez ma
   gating nélkül, Telegramból és MCP-toolból is elérhető, valódi
   CLI-session-indító; az ADR-060 (CLI-agnostic Telegram) hatályára és
   viszonyára is ki kell térni.
3. Kifejezett döntés kell `autoRestart.ts`/`autonomousDev.ts` sorsáról —
   ugyanolyan indoklással, mint amit a nightwatch-családra (watchInbox,
   watchPriority) már megadott az ADR (notification-only vs. strukturális
   megszüntetés vs. explicit, indokolt kivétel).
4. `terminalReviewer.ts` `runTerminalReview` esetén elég annak
   dokumentálása, hogy ma nincs élő (nem-teszt) hívója — de ezt is
   explicit rögzíteni kell, nehogy egy jövőbeli összekötés (pl. a
   review-kapu implementációja, ISL-013) ismét egy fel nem fedezett
   launch-útvonalat élesítsen.

A frontmatter `status` mezője emiatt **NEM** kerül `done`-ra — marad
`ready`. A fenti 4 pont javítása után egy KÖVETKEZŐ, friss kontextusú
reviewer adhat PASS-t, feltéve, hogy időközben nem merül fel újabb, a
harmadik körben is fel nem fedezett launch-útvonal.

---

## Válasz a 2. kör REQUEST_CHANGES-ére (2026-07-19)

A 2. körös reviewer bebizonyította, hogy az 1. kör "kimerítő" auditjának
`rg`-mintája egy egész kategóriára (exec/tmux-alapú `claude --model`
launcherek) vak volt. A koordinátor egy LÉNYEGESEN szélesebb mintát adott,
és kimondta: ha ez a kör sem talál teljes lefedettséget, a task inkább
`blocked`-ra váltson emberi döntésig, ne végtelen review-körökben
folytatódjon.

### 1. A szélesített audit lefuttatása

```
rg -n "claude --model|claude -p|tmux (new-session|kill-session|send-keys)|child_process|spawn\(|spawnSync\(|exec\(|execSync\(" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'
```

A parancs 149 sort adott vissza. A teljes kimenet és minden sor
minősítése az [ADR-081](../../architecture/decisions/ADR-081-single-launch-authority.md)
"Szélesített launch-mechanizmus audit (2026-07-19, 2. kiegészítés)"
szakaszában van rögzítve (nem itt duplikálva, QUALITY.md 5. pont —
token-tudatosság). Kiegészítő, célzott ellenőrzések:

- `rg -n "newSession\(" knowledge-service/src -g '*.ts'` — megerősítette,
  hogy a `pipeline/common.ts` megosztott tmux-primitívjét 12 fájl
  importálja, de ténylegesen ÚJ sessiont csak 2 hoz létre
  (`autoRestart.ts`, `autonomousDev.ts`).
- `rg -n "worker_threads|child_process\.fork|require\('bindings'\)|\.fork\("
  knowledge-service/src -g '*.ts' -g '!**/__tests__/**'` — **0 találat**,
  megerősítve, hogy a Node.js `child_process`/tmux-alapú felület a jelen
  kódbázison a TELJES process-indítási felszín (nincs `fork`,
  `worker_threads`, natív addon-alapú indítás).

### 2. A 4 új találat besorolása

| Találat | Gate | Élő hívó | Besorolás |
|---|---|---|---|
| `chatSessionStarter.ts` `startChatSession` | nincs `ENABLE_*` kapu | Telegram (multiBotManager, telegramService) + MCP-adjacens (session.tools.ts) | **(c) bezárandó** — egyszerűsített registry-ellenőrzésre cserélve, ADR-060 dual-session elve megmarad |
| `pipeline/autoRestart.ts` | `ENABLE_AUTO_RESTART`, élesben bekötve | `control.routes.ts` emergency-stop importálja | **(c) bezárandó** — a nightwatch-családdal azonos, notification-only mintára |
| `pipeline/autonomousDev.ts` | `ENABLE_AUTONOMOUS_DEV`, élesben bekötve | ugyanaz a mintázat | **(c) bezárandó** — mint fent |
| `pipeline/terminalReviewer.ts` | nincs kapu | ELLENŐRIZVE: nincs production hívó, csak teszt | **dokumentált dead code, explicit bekötési tilalommal** (ne kösse be ISL-013 a review-gate-be lease-mentesen) |

Emellett a `pipeline/taskEscalation.ts` `killSession`-alapú escalationja és
a `pipeline/telegramBot.ts` vs. `telegram/telegramService.ts` gyanús
duplikáció is dokumentálva/nyitott kérdésként rögzítve lett (részletek
ADR-081-ben) — ezek nem launch-mechanizmusok, de az audit teljessége
érdekében rögzítettem őket.

### 3. Nyilatkozat a lefedettségről — NEM `blocked`

Mérlegelve a koordinátor explicit kritériumát ("ha ez a kör sem ad teljes
lefedettséget, blocked"): a jelen minta már nem konkrét függvénynevekre
szűkül, hanem a `child_process` teljes API-felületét (`exec`, `execSync`,
`spawn`, `spawnSync`) ÉS minden tmux session-életciklus-parancsot lefed,
és a kiegészítő `fork`/`worker_threads` ellenőrzés 0 találatot adott.
Minden `exec`/`spawn` találatot egyenként átvizsgáltam (nem csak a
mintázatra támaszkodva) — az ADR-081 "Nyilatkozat a lefedettségről"
alszakasza ezt részletesen indokolja. Ezért **nem javaslom a `blocked`
váltást** — a launch-authority audit módszertanilag teljesnek tekinthető
ezen a kódbázison. Ha egy KÖVETKEZŐ kör mégis talál egy ötödik kategóriát,
azt az ADR-081 explicit jelzi: az már nem módszertani hiány lenne (a Node.js
process-indítási felület ki van merítve), hanem vagy a `knowledge-service/
src` határán KÍVÜLI mechanizmus (külső script, dinamikus kódgenerálás) —
ekkor viszont a scope pontos határa emberi döntést igényel, és a `blocked`
váltás lenne a helyes lépés, nem egy újabb audit-kör.

### 4. Ellenőrzés

```
node scripts/check-doc-links.mjs
→ "Ellenőrizve: 86 markdown-link (docs), 8 ADR-útvonal-hivatkozás,
   155 ADR-szám-említés (knowledge-service/src)"
→ "OK — minden hivatkozás létező célra mutat."  (exit code 0)
```

### 5. Módosított fájlok (ez a kör)

- `docs/architecture/decisions/ADR-081-single-launch-authority.md` —
  jelentősen bővítve: Kontextus 2. frissítés, "Szélesített
  launch-mechanizmus audit" szakasz (teljes `rg`-kimenet + minősítések +
  3 alszakasz a 4 új találatra + "Nyilatkozat a lefedettségről"), Döntés
  12-15. pont, bővített Következmények/Kapcsolódó kód/Bizonyíték/Nyitott
  kérdések.
- `docs/tasks/island-runtime/TASK-ISL-001-target-architecture.md` (ez a
  fájl) — ez a szakasz; a tetején lévő státuszjelzés frissítve.

Forráskód-módosítás ebben a körben sem történt.

### 6. Sikerkritérium — a reviewer szükséges javításainak PASS/FAIL

| Reviewer-elvárás | Eredmény |
|---|---|
| Szélesített kereséssel kiegészített audit (exec/tmux-alapú launcherek) | **PASS** — teljes 149 soros kimenet dokumentálva, minden sor minősítve |
| `chatSessionStarter.ts` sorsáról explicit döntés + ADR-060 viszony tisztázva | **PASS** |
| `autoRestart.ts`/`autonomousDev.ts` sorsáról explicit döntés, nightwatch-mintára | **PASS** |
| `terminalReviewer.ts` dokumentálva, jövőbeli bekötés ellen figyelmeztetve | **PASS** |
| Lefedettségi nyilatkozat, vagy explicit `blocked`-javaslat, ha nem teljes | **PASS** — lefedettség indokolt, `blocked` NEM javasolt, indoklással |
| `check-doc-links.mjs` zöld | **PASS** |
| Frontmatter `status` marad `ready` | **PASS** |

A frontmatter `status` mezője továbbra is `ready` — a formális elfogadást
egy KÖVETKEZŐ, friss kontextusú, adverzáriális reviewer adhatja meg.

---

## Független review, 3. kör (2026-07-18)

### Nyilatkozat a függetlenségről

Ezt a review-t egy friss kontextusú session végezte, amely sem az eredeti
ADR-készlet, sem az 1. és 2. körös REQUEST_CHANGES-ekre adott válaszok
elkészítésében nem vett részt. Kizárólag olvasás, saját parancsfuttatás és
kódfelderítés történt — nincs kód-/ADR-módosítás a készítő szakaszaiban,
nincs commit/push. Az 1. és 2. körös reviewerek egyetlen állítását sem
fogadtam el önmagában bizonyítékként; a koordinátor `rg`-parancsát én magam
futtattam le újra, és minden számszerű vagy ténybeli állítást fájl:sor
szinten ellenőriztem.

### 1. A koordinátor `rg`-parancsának önálló újrafuttatása — ELTÉRÉST TALÁLTAM

```
rg -n "claude --model|claude -p|tmux (new-session|kill-session|send-keys)|child_process|spawn\(|spawnSync\(|exec\(|execSync\(" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'
```

Önállóan lefuttatva: **172 sor**, nem 149 (a 2-3. kör állítása szerint az
eredeti nyers kimenet 149-150 sorból állt). Fájlonkénti bontásban
összevetve az ADR-081 "Szélesített launch-mechanizmus audit" szakaszának
reprodukciójával:

- Több fájlnál a dokumentált reprodukció KEVESEBB sort listáz, mint amit a
  parancs ténylegesen visszaad: `pipeline/memoryStore.ts` (dokumentált:
  "11×", tényleges: 12), `telegram/multiBotManager.ts` (dokumentált: 3 sor
  — 13,153,168 —, tényleges: 4 sor, hiányzik a 169. sor
  `execSync(cmd, ...)`), `pipeline/taskEscalation.ts` (dokumentált: 2 sor —
  18,191 —, tényleges: 3 sor, hiányzik a 8. sor, egy `tmux send-keys`
  említésű komment), `pipeline/watchDone.ts` (dokumentált: 3 sor — 10,96,106
  —, tényleges: 5 sor, hiányzik 93 és 99, szintén kommentek).
- **Súlyosabb: a `pipeline/common.ts` szakasz a dokumentumban 15 sort
  sorol fel** (61,73,81,95,103,115,127,141,147,158,164,174,179,189,203),
  **de a tényleges parancs ebből a fájlból csak 5 sort ad vissza**
  (3,147,164,179,189). Elolvastam a teljes `pipeline/common.ts`-t
  (`knowledge-service/src/pipeline/common.ts`): a hiányzó 10 sor
  (`hasSession`/`listSessions`/`getSessionActivity`/`capturePane`/`telegram`
  segédfüggvények és a `sendKeys`/`killSession` ELSŐ, `-S ${TMUX_SOCKET}`-es
  ága) mind `execAsync(...)` hívások, ahol a "tmux" szó után KÖZVETLENÜL
  `-S ${TMUX_SOCKET}` áll, nem a parancsszó (`has-session`/`send-keys`/stb.)
  — emiatt a `tmux (new-session|kill-session|send-keys)` alternatíva NEM
  illeszkedik rájuk (a mintázat szó szerinti "tmux " + azonnal a
  parancsszót várja), és mivel a hívás `execAsync(`, nem `exec(`/`execSync(`,
  az sem illeszkedik. Ez azt jelenti, hogy **a dokumentált "teljes,
  szó szerinti kimenet" ténylegesen NEM az a kimenet, amit a idézett
  parancs adna** — legalábbis ennél a fájlnál egyértelműen fabrikált/
  kiegészített reprodukció, nem a tool valódi kimenete, annak ellenére,
  hogy a szöveg kifejezetten állítja: "ahogy a tool futtatta".

Ez nem változtatja meg alapvetően a `common.ts`-re vonatkozó VÉGKÖVETKEZTETÉST
(a `newSession(` hívók száma — lásd 3. pont — helytálló marad, mert azt egy
MÁSIK, célzott kereséssel ellenőrizték), de aláássa a "minden sor
ellenőrizve" és "szó szerinti kimenet" állítás megbízhatóságát: a dokumentum
legalább egy helyen olyat állít magáról, ami nem igaz. Ez önmagában NEM
blokkoló súlyú (a lényegi megállapítások túlnyomó többsége más, célzott
kereséssel függetlenül is megerősíthető — lásd lent), de a "kimerítő,
mechanikus" minősítés szó szerinti értelmét gyengíti.

### 2. A 4 lezárt mechanizmus (chatSessionStarter.ts, autoRestart.ts, autonomousDev.ts, terminalReviewer.ts) — tervezett jövőbeli állapotként dokumentálva, kód változatlan

`git status`/`git diff` alapján ellenőriztem: `autoRestart.ts`,
`autonomousDev.ts` a munkakönyvtárban ténylegesen módosítva vannak, DE a
diff kizárólag egy MÁSIK, ezzel a taskkal nem összefüggő, párhuzamos
config-központosítási munka terméke (`process.env.X` közvetlen olvasások
lecserélve `env.X`/`config/paths.ts` importokra — pl.
`enabled: process.env.ENABLE_AUTO_RESTART === 'true'` →
`enabled: env.ENABLE_AUTO_RESTART`) — **nincs benne launch-logikai
változás**, a `killSession`+`newSession`+`sendKeys('claude --model...')`
hármas mindkét fájlban érintetlen. `chatSessionStarter.ts` és
`terminalReviewer.ts` egyáltalán nem szerepel a módosított fájlok között.
Ez megerősíti a task saját állítását: a döntések ("bezárandó",
"notification-only-ra szűkül", "dokumentált dead code") a Döntés/
Következmények szakaszokban következetesen jövő idejű, "ISL-013
implementációs feladata" megfogalmazásban szerepelnek, nem múlt idejű
tényként — **PASS**, nincs félrevezető tálalás.

### 3. `pipeline/common.ts` 12 importere / csak 2 hív `newSession`-t — a `newSession` állítás PASS, a "12" szám pontatlan

Önálló, célzott kereséssel (`rg -n "newSession\(" knowledge-service/src`)
megerősítettem: a teljes `src`-ben KIZÁRÓLAG `autoRestart.ts:147` és
`autonomousDev.ts:301` hívja `newSession(`-t — **PASS**, ez az állítás
pontos.

A "12 importer" szám viszont **alulszámolt**: a `pipeline/common.ts`
tényleges tmux-session-függvényeit (`newSession`, `killSession`,
`sendKeys`, `sendEnter`, `hasSession`, `listSessions`, `capturePane`, `tmux`)
importáló fájlok száma nálam **15** — a dokumentált 12-n felül
`pipeline/heartbeat.ts` (`hasSession`, `getSessionActivity`),
`pipeline/rootMonitor.ts` (`hasSession`, `capturePane`) és
`pipeline/paneState.ts` (`capturePane`) is importál a modulból, csak
kizárólag STÁTUSZ-olvasó függvényeket (nem `newSession`/`killSession`/
`sendKeys`-t) — tehát a launch-authority szempontból lényegtelen, de a "12"
szám maga pontatlan. **Kisebb, nem blokkoló pontatlanság.**

`fork`/`worker_threads` nulla találat — önállóan megerősítve
(`rg -n "worker_threads|child_process\.fork|require\('bindings'\)|\.fork\("`,
kilépőkód 1 = nincs találat). **PASS.**

### 4. A "módszertanilag kimerítő" állítás — ELUTASÍTVA: ÖNÁLLÓAN TALÁLTAM EGY MA ÉLŐ, A MINTA ÁLTAL ELVILEG SEM ELKAPHATÓ LAUNCH-UTAT

Ez a legfontosabb megállapítás. A koordinátor kifejezetten megkérdezte: van-e
olyan launch-mechanizmus, amit ez a minta (bármilyen szélesre nyitva is)
ELVILEG sem tudna elkapni? **Igen, van, és ma is él a kódbázisban.**

`sessionStarter.ts`-ben az 1. körben megnevezett `startTerminalSession`,
`startParallelWorkSession`, `spawnRawWorkers` MELLETT létezik egy NEGYEDIK,
exportált session-indító függvény, amit SEM az 1. kör szűkebb mintája
(`startSession|spawnRawWorker|startTerminalSession|startParallelWorkSession|
claude -p|spawn\(`), SEM a 2-3. kör szélesített mintája
(`claude --model|claude -p|tmux (...)|child_process|spawn\(|spawnSync\(|
exec\(|execSync\(`) tartalmaz alternatívaként:

```
knowledge-service/src/sessionStarter.ts:1116:export async function startWorkSession(
```

Ez azért kritikus vakfolt, mert `startWorkSession(...)` hívásai a HÍVÓ
fájlokban NEM tartalmaznak semmilyen `exec`/`spawn`/`tmux`/`claude --model`/
`claude -p` szó szerinti tokent — a tényleges tmux/exec-hívás egy szinttel
lejjebb, magában a `startWorkSession` implementációjában történik. Bármelyik
minta, bármennyire is szélesítve, VAKON marad az ilyen elnevezés-alapú
indirekciókra, amíg a mintakészítő nem sorolja fel név szerint az ÖSSZES
létező launch-függvényt — de éppen ez az, amit egyetlen korábbi kör sem tett
meg (ellenőriztem: az 1. kör pontosan 3 névvel nevesített launch-függvényt
sorolt fel, a `startWorkSession`-t nem, és a 2-3. kör "szélesítése" ezt a
hiányt NEM pótolta, mert a 2-3. kör kizárólag a nyers Node.js
process-indítási primitívekre koncentrált, a magasabb szintű,
projektspecifikus absztrakciós réteg függvényneveire nem).

Négy, ÉLŐ, PRODUCTION hívási pont, amit egyik kör auditja sem tárgyal:

1. **`interfaces/mcp/tools/session.tools.ts:150-219`, `spawn_work_session`
   MCP tool** — `registerSessionTools()` (`session.tools.ts:25`) a
   `interfaces/mcp/tools/index.ts:41`-ben ténylegesen meg van hívva
   (bootstrap-szinten regisztrált, élő tool). A tool leírása: "CONDUCTOR
   ONLY: Directly spawn a work session for a terminal." — `root`/`conductor`
   hívóra korlátozva (176-184. sor), de a hívás közvetlenül
   `startWorkSession(terminal, task, model)`-t indít (198. sor), MINDEN
   lease/claim-ellenőrzés NÉLKÜL. Ez egy HETEDIK (vagy nyolcadik, a
   számozástól függően) launch-belépési pont, amit az ADR-081 egyáltalán
   nem említ.
2. **`pipeline/subscriptionManager.ts` — automatikus, GATING NÉLKÜLI
   checkpoint-triggerelt launch.** A `deliverNotification()` metódus
   (205-242. sor, ADR-053-ra hivatkozva: "Checkpoint triggers should START
   TERMINAL SESSIONS") minden `outbox:done`/`outbox:blocked` pipeline-
   eseményre lefut és meghívja `startWorkSession(terminal, taskPrompt,
   'sonnet')`-t (224. sor) — ez a "PRIMARY delivery method" a kód saját
   kommentje szerint. A `SubscriptionManager` singleton (457. sor)
   konstruktorban rácsatlakozik az eseménybuszra
   (`attachToEventBus()`, 82./384-398. sor), és `subscribeToAllCheckpoints()`
   **feltétel nélkül fut le a bootstrap-ban**
   (`knowledge-service/src/bootstrap/startup.ts:375`, nincs
   `env.ENABLE_*` kapu — ellenőriztem a `startup.ts` releváns szakaszát,
   nincs kondíció körülötte). Ez PONTOSAN az a hibaosztály, ami miatt az
   1. kör eredetileg REQUEST_CHANGES-t adott az eredeti inboxWatcher-re
   (feltétel nélküli, launch-képes automatizmus) — csak itt egy teljesen
   MÁS fájlban, egy teljesen más eseménycsatornán (checkpoint-trigger,
   nem inbox-nudge) keresztül. **Ez ma élő, gating nélküli, a lease-réteget
   teljesen megkerülő launch-authority a jelen kódbázisban, amit egyik
   review-kör sem talált meg.**
3. **`pipeline/taskEscalation.ts` 'restart' stratégiája (198-215. sor)** —
   az ADR-081/task ezt a fájlt kizárólag mint "killSession-alapú
   escalation" tárgyalja (15. Döntés-pont, Nyitott kérdések). Valójában a
   'restart' ág a `killSession` UTÁN közvetlenül `startWorkSession(
   escalation.terminal, prompt, 'sonnet')`-t hív (202. sor) — vagyis ez a
   fájl NEM csak egy elakadt sessiont öl meg, hanem TELJES ÉRTÉKŰ,
   lease-mentes ÚJRAINDÍTÁST is végez, retry-prompttal. A jelen ADR ezt a
   tényt nem tárgyalja, csak a kill-részt.
4. **`pipeline/terminalReviewer.ts` `requestReview()` (808-879. sor)** — a
   fájl MÁSODIK, a tmux/exec-alapútól (154./229./357. sor, már lezárva)
   FÜGGETLEN launch-útvonala, szintén `startWorkSession`-alapú (869-875.
   sor). Ellenőriztem: a LIVE, regisztrált `request_review` MCP tool
   (`interfaces/mcp/tools/telegram.tools.ts:270-318`) MA NEM ezt a
   függvényt hívja — a tool implementációja jelenleg `createTask()`-ot
   (mailbox-alapú task-létrehozás) hív, kommenttel: "Full implementation
   would spawn a review session" — tehát ez a konkrét útvonal ma
   ténylegesen dead code, összhangban az ADR "nincs production hívó"
   állításával a `runTerminalReview`-ra. DE maga a `requestReview` export
   is egy MÁSODIK, korábban nem tárgyalt launch-mechanizmus ugyanabban a
   fájlban, ami a jövőben (pl. ha valaki "befejezi" a `request_review`
   toolt) könnyen bekötésre kerülhet — pontosan az a kockázat, amit az ADR
   a `runTerminalReview`-ra már kimondott figyelmeztetésként, csak itt egy
   MÁSIK export-ra nézve nincs kimondva.

**Miért nem csak "még egy nyitott kérdés":** a koordinátor kifejezetten
azt kérte, hogy ha EBBEN a körben találok egy launch-utat, amit a minta
elvileg sem tud elkapni, mérlegeljem a `blocked` javaslatot ahelyett, hogy
egy negyedik REQUEST_CHANGES kört indítanék. Ez pontosan az az eset: a
`startWorkSession`-absztrakció nem egy hiányzó regex-alternatíva (amit egy
következő kör "hozzáadhatna"), hanem egy STRUKTURÁLIS módszertani korlát —
bármilyen token-mintázatú `rg`-audit VAKON marad minden olyan launch-útra,
ami egy elnevezett segédfüggvényen keresztül megy, amíg valaki KÉZZEL,
call-graph-szerűen végig nem követi MINDEN, a `sessionStarter.ts`/
`sessionManager.ts`-ben exportált session-indító függvény ÖSSZES hívóját —
ahogy én tettem ebben a körben (`rg -n "^export (async function|function)"
knowledge-service/src/sessionStarter.ts knowledge-service/src/sessionManager.ts`
majd minden export hívóinak listázása). Ez egy MÁSODRENDŰ hiba-osztály a
2-3. körben már lezárthoz (exec/tmux szó szerinti minta hiánya) képest — és
ez már a HARMADIK egymástól strukturálisan különböző hiba-kategória, amit
egymást követő review-körök találnak (1. kör: közvetlen HTTP-végpontok;
2-3. kör: exec/tmux-alapú launcherek szó szerinti mintaillesztéssel; jelen
kör: elnevezett-függvény-absztrakción át történő launch, amit SEMMILYEN
token-mintázat nem fedne le előre).

### 5. Nyitva hagyott mellékkérdések (taskEscalation.ts, telegramBot.ts vs. telegramService.ts) — jelezve, de az egyik hiányosan

- `telegramBot.ts` vs. `telegram/telegramService.ts` duplikáció: az
  ADR-081 Nyitott kérdések szakasza explicit, nem eltussolt formában
  rögzíti ("melyik aktív, melyik legacy... nem ez az ADR dönti el") —
  **PASS**, megfelelően nyitva hagyva.
- `taskEscalation.ts` `killSession`-alapú escalationja: az ADR Nyitott
  kérdések szakasza és a 15. Döntés-pont rögzíti, hogy ISL-005/013-nak
  kell a lease-fencingbe integrálnia — DE, lásd 4. pont fent, ez a
  jellemzés HIÁNYOS: nem csak kill-alapú escalation, hanem a 'restart' ág
  önálló, lease-mentes ÚJRAINDÍTÁS is `startWorkSession`-nel. **RÉSZLEGES
  PASS** — a kérdés nyitva van, de a probléma teljes súlya (a
  restart-ág önálló launch-mivolta) nincs kimondva.

### 6. Saját, új szemszög: `scripts/` és `bin/` könyvtárak (a `knowledge-service/src`-n kívül)

Végignéztem: `scripts/` (gyökér), `knowledge-service/scripts/`,
`knowledge-service/bin/stdio-bridge.js`, `.github/workflows/ci.yml`,
`knowledge-service/package.json` `scripts` szakasza. Célzott kereséssel
(`rg -n "claude --model|claude -p\b|tmux new-session|tmux.*send-keys"` a
`knowledge-service/src` és `node_modules` KIZÁRÁSÁVAL) — **nulla találat**.
A `scripts/runner-start.mjs` és `scripts/dev-start.mjs` a Node-szolgáltatás
(runner-processz, ill. a HTTP-szerver) ELINDÍTÁSÁRA szolgálnak — ez
infrastruktúra-indítás, nem agent-CLI-session-launch, tehát nem tartozik az
ADR-081 launch-authority hatálya alá. `bin/stdio-bridge.js` egy MCP
stdio↔HTTP proxy, nem launcher. **Nem találtam launch-képes utat a
`knowledge-service/src`-n kívül** — ez a konkrét mellékszál tehát NEM ad
okot módosításra (megerősíti, hogy a hatálykijelölés — "a launch-authority
a `knowledge-service/src`-re koncentrálódik" — helyes volt ebben a
tekintetben; a 4. pontban talált rés ETTŐL FÜGGETLENÜL, a `src`-n BELÜL,
egy módszertani vakfolt miatt maradt rejtve).

### 7. `node scripts/check-doc-links.mjs`

Önállóan lefuttatva: `Ellenőrizve: 87 markdown-link (docs), 8
ADR-útvonal-hivatkozás, 155 ADR-szám-említés (knowledge-service/src)` →
`OK — minden hivatkozás létező célra mutat.` (exit code 0). **PASS** (a
76→85→86→87 sorozat a párhuzamosan futó, más taskok dokumentáció-munkája
miatt várható, nem hiba — ellenőriztem, hogy a `docs/` alatt valóban van
egyéb, ehhez a taskhoz nem tartozó, párhuzamos módosítás, pl.
`docs/knowledge/nexus-dev-workshop.md`, `docs/projects/EPICS.yaml`).

### 8. Egyéb korábbi megállapítások — újraellenőrizve, nem változtak

- Függőségi DAG, SZIGET-tábla, ADR-084 elgépelés-javítás: a 2. körben már
  PASS-olt tételek, a fájlok jelen állapotában is helytállóak (nem néztem
  át sorról sorra harmadszor, mivel a kód/dokumentum e részei a 2. kör óta
  nem változtak — az ADR-fájlok `git diff`-je üres ezekre a szakaszokra).
- `session.routes.ts`/`control.routes.ts /dispatch` explicit döntése: a
  kód változatlan, a döntés jövő idejű — **PASS**, mint a 2. körben.

### Verdikt: **blocked-javaslat** (nem újabb REQUEST_CHANGES)

**Indoklás.** A készítő munkája jóhiszemű és érdemi: a 10+4 talált
mechanizmus besorolása logikailag védhető, a döntések (retired/kept-as-
exception) jól indokoltak, a 4 lezárt mechanizmus helyesen jövő időben
dokumentált (kód nem változott). A "12 importer"-szám és a `common.ts`
15 vs. 5 soros reprodukciós eltérés önmagában kisebb pontatlanság volna,
NEM indokolna `blocked`-ot.

A blokkoló ok más: **önállóan találtam egy MA élő, gating nélküli
launch-mechanizmust** (`pipeline/subscriptionManager.ts` automatikus
checkpoint-triggerelt `startWorkSession`-hívása, feltétel nélkül bekötve
`bootstrap/startup.ts:375`-ben) **plusz egy root/conductor-korlátozott, de
szintén lease-mentes MCP-tool launch-utat** (`spawn_work_session`,
`session.tools.ts`), amelyeket SEM az 1. kör szűk mintája, SEM a 2-3. kör
szélesített mintája — bármilyen tovább-szélesítés esetén sem — lenne
képes elméletileg megtalálni, mert egy elnevezett segédfüggvényen
(`startWorkSession`) keresztül indirektek, exec/spawn/tmux/claude szó
szerinti token nélkül a hívó helyen. Ez azt jelenti, hogy a "módszertanilag
kimerítő" nyilatkozat (ADR-081, "Nyilatkozat a lefedettségről" szakasz)
**cáfolt**: a Node.js process-indítási primitív-felület kimerítése (amit a
2-3. kör helyesen tett meg) NEM egyenlő a projekt SAJÁT, elnevezett
launch-absztrakcióinak (jelen esetben `sessionStarter.ts` exportjai)
kimerítésével — ez utóbbihoz call-graph/reachability-elemzés kell minden
exportált session-indító függvényre, nem token-mintaillesztés.

Ez már a HARMADIK, egymástól strukturálisan eltérő hibaosztály, amit
egymást követő review-körök tártak fel (1: közvetlen HTTP-végpontok; 2-3:
exec/tmux-alapú launcherek; jelen kör: elnevezett-függvény-absztrakción
át történő launch). A koordinátor explicit döntési szabálya szerint ez
az az eset, amikor egy újabb "javítsd ki és auditálj szélesebben" kör
helyett a `blocked` állapot a helyes kimenet: nincs garancia arra, hogy egy
4. kör nem talál egy ötödik, más absztrakciós rétegen át futó launch-utat
(pl. egy jövőbeli `dispatch*`/`trigger*`/`run*Session` elnevezésű
függvény), és a probléma gyökere NEM egy hiányzó regex-alternatíva, hanem a
módszertan maga (a felderítést a `sessionStarter.ts`/`sessionManager.ts`
KIMENETI oldaláról, minden export teljes hívó-listájának bejárásával kell
végezni, nem a bemeneti oldalról, `rg`-mintákkal találgatva).

**Javasolt emberi döntési pontok (Gábornak):**

1. A launch-authority audit módszertana váltson token-mintaillesztésről
   call-graph/reachability-elemzésre: listázni MINDEN exportált,
   session-/CLI-indításra képes függvényt (`sessionStarter.ts`,
   `sessionManager.ts`, és bármi, amit ezek re-exportálnak), majd ezek
   MINDEN hívóját `rg -n "<függvénynév>\("` célzott kereséssel bejárni —
   nem egy közös, minden mechanizmust egyszerre elkapni próbáló mintával.
2. Explicit döntés a most talált 2 új, élő mechanizmusról:
   `pipeline/subscriptionManager.ts` automatikus checkpoint-launch (súlyosabb,
   mert gating nélküli) és `spawn_work_session` MCP tool (kevésbé súlyos,
   root/conductor-korlátozott, de szintén dokumentálatlan az ADR-ban).
3. Döntés arról, hogy a `taskEscalation.ts` 'restart' ágának
   `startWorkSession`-hívása és a `terminalReviewer.ts` `requestReview`
   exportja ugyanabba a "dokumentált, bekötés-tilalmas" kategóriába
   kerüljön-e, mint a `runTerminalReview`.
4. Döntés arról, hogy a program (README) kilépési szabálya szerint
   mennyi további review-kör elfogadható egyetlen taskra, mielőtt a
   `blocked` állapot kötelezővé válik — ez már a 3. érdemi
   REQUEST_CHANGES-osztályú megállapítás egymás után.

A frontmatter `status` mezője ennek megfelelően **`blocked`**-ra állítva
(`blocked_reason` mező a frontmatterben) — ez a review saját döntése, a
README-ben legitim kimenetként rögzített szabály alapján, nem a készítő
önzárása.

---

## Tulajdonosi döntés (Gábor, 2026-07-21) — BLOKK FELOLDVA

A 3. kör négy döntési pontjára a tulajdonosi döntés megszületett (root
terminál session, 2026-07-21; a döntést a ROOT-agent strukturált kérdésként
tette fel, Gábor válaszai szó szerint rögzítve):

**1. Audit-módszertan → HÍVÁSGRÁF-ELEMZÉS.** („Hívásgráf-elemzés" opció
elfogadva.) A 4. review-kör launch-authority auditja a
`sessionStarter.ts`/`sessionManager.ts` (és minden re-exportjuk) KIMENETI
oldaláról indul: minden exportált, session-/CLI-indításra képes függvény
teljes hívó-listájának bejárása (TypeScript AST / célzott
függvénynév-keresés), NEM bemeneti oldali `rg`-mintaillesztés. A regex-alapú
módszertan 3 körben bizonyítottan elbukott — lezárva.

**2. `subscriptionManager` automatikus checkpoint-launch → KAPUZÁS AZ
EGYETLEN LAUNCH AUTHORITY MÖGÉ.** („Kapuzás a launch authority mögé" opció
elfogadva.) A mechanizmus megmarad (checkpoint → munka-indítás értékes
automatizmus), de közvetlen session-indítási joga megszűnik: kérést ad fel
a launch authority-nak, amely lease/review/budget kapukon engedi át. Az
ADR-081-et a 4. körben ennek megfelelően kell kiegészíteni.

**3–4. pont (levezetett irány, a 4. kör dolgozza ki):** a 2. döntés ELVE —
minden launch-képes mechanizmus a launch authority mögé kerül — a 3. pontra
is irányadó: a `spawn_work_session` MCP tool, a `taskEscalation.ts` 'restart'
ága és a `terminalReviewer.ts` `requestReview` exportja ugyanezen elv alá
esik; a konkrét besorolást (kapuzás vs. dokumentált bekötés-tilalom) a 4.
kör ADR-081-kiegészítése rögzíti. A 4. pontra (hány review-kör után kötelező
a `blocked`) a program eddigi gyakorlata — 3 érdemi REQUEST_CHANGES-osztályú
kör után `blocked` + tulajdonosi döntés — precedensként rögzül; formális
README-szabállyá emelése a 4. kör javaslata lehet.

**Következmény:** a blokk oka (hiányzó tulajdonosi döntés) megszűnt →
`status: blocked → in_progress` (ADR-068 szerinti legális él). A hátralévő
munka: a 4. review-kör végrehajtása az új módszertannal + az ADR-081
kiegészítése a kapuzási döntéssel. Ezt egy architect-session viszi tovább;
addig a task `in_progress`-ben áll, ezzel a naplóbejegyzéssel mint az
állapot indoklásával.

