# Garantált szigetüzem és többplatformos CLI runner program

Ez a program a
`docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` megállapításait
végrehajtható fejlesztési feladatokra bontja. A normatív minőségi forrás a repo
gyökerében lévő `QUALITY.md`.

## Programcél

A Nexus terminálalapú agentcsapatai Linux és Windows környezetben, egymástól
biztonságosan izolált szigetekben fussanak. Egy tasknak egyszerre legfeljebb egy
aktív tulajdonosa lehessen, a futási állapot hiba és újraindítás után is
helyreálljon, és ugyanaz a runner-architektúra igazoltan támogassa a Codex CLI-t,
a Claude Code CLI-t és az Antigravity CLI-t.

## Mikor jó?

A cél akkor teljesül, ha:

1. a sziget, terminál és runner összetett identitása minden tárolóban és
   autorizációs döntésben jelen van;
2. két sziget azonos nevű terminálja nem látja és nem módosítja egymás adatait;
3. két runner versenyében egy taskot pontosan egy runner claimelhet;
4. runner- vagy service-crash után a lease alapján determinisztikusan folytatódik
   vagy újraindul a task, duplikált üzleti végrehajtás nélkül;
5. a completion, review, budget és dependency kapuk egyetlen kikényszerített
   állapotgép részei;
6. a federation tartós outboxot, idempotens kézbesítést, retryt, ACK-et és
   dead-letter állapotot használ;
7. a Codex, Claude és Antigravity CLI valós Windows és Linux környezetben
   végigfuttatja a golden-path E2E feladatot;
8. minden eredményhez reprodukálható teszt-, log-, verzió- és környezeti
   bizonyíték tartozik;
9. a dokumentáció, taskállapot, `EPICS.yaml`, `state.md`, `todo.md` és `MEMORY.md`
   egymással konzisztens;
10. egy friss kontextusú, a kivitelezésben részt nem vevő reviewer adverzáriális
    ellenőrzéssel elfogadja a programot.

## Program kilépési feltétele

A program csak akkor állítható `done` állapotba, ha mind a 17 task `done`, a
teljes 3 CLI × 2 operációs rendszer mátrix valós környezetben PASS, nincs nyitott
kritikus vagy magas eltérés, és a `TASK-ISL-017` reviewer jelentése PASS.

A programot korábban csak az alábbi esetben szabad megállítani:

- reprodukálható, dokumentált külső blokk miatt `blocked` állapot szükséges;
- elfogyott az előre rögzített idő/próbálkozás/token keret;
- a scope módosítása architekturális döntést igényel;
- irreverzibilis művelethez vagy éles deployhoz emberi jóváhagyás kell.

Egy hiányzó CLI-telepítés, licenc vagy hitelesítés nem minősíthető PASS-nak. A
task ilyenkor `blocked`, a pontos feloldási feltétellel.

## Hierarchia

- Program: `NEXUS-ISLAND-RUNTIME`
- Projekt: `nexus/knowledge-service`
- Mérföldkövek:
  - `ISL-M1` — architektúra, identitás és izoláció
  - `ISL-M2` — kanonikus állapot, ownership és runner control plane
  - `ISL-M3` — többplatformos, több-CLI-s végrehajtás
  - `ISL-M4` — workflow, federation és operability
  - `ISL-M5` — dokumentáció és független bizonyítás

## Feladatok

| Sorrend | Feladat | Mérföldkő | Prioritás | Függőség |
|---:|---|---|---|---|
| 1 | [TASK-ISL-001 — Célarchitektúra és ADR](TASK-ISL-001-target-architecture.md) | ISL-M1 | kritikus | nincs |
| 2 | [TASK-ISL-002 — Összetett identitás és terminálkonfiguráció](TASK-ISL-002-compound-identity.md) | ISL-M1 | kritikus | ISL-001 |
| 3 | [TASK-ISL-003 — Egységes autorizáció és izoláció](TASK-ISL-003-authorization-isolation.md) | ISL-M1 | kritikus | ISL-002 |
| 4 | [TASK-ISL-004 — Kanonikus task/message store](TASK-ISL-004-canonical-store.md) | ISL-M2 | kritikus | ISL-001, ISL-002 |
| 5 | [TASK-ISL-005 — Atomi claim, lease és idempotencia](TASK-ISL-005-claim-lease-idempotency.md) | ISL-M2 | kritikus | ISL-004 |
| 6 | [TASK-ISL-006 — Tartós runner registry és heartbeat](TASK-ISL-006-runner-registry.md) | ISL-M2 | kritikus | ISL-002, ISL-005 |
| 7 | [TASK-ISL-007 — CLI-adapter és process supervisor szerződés](TASK-ISL-007-cli-adapter-contract.md) | ISL-M3 | kritikus | ISL-001 |
| 8 | [TASK-ISL-008 — Codex CLI adapter](TASK-ISL-008-codex-adapter.md) | ISL-M3 | magas | ISL-007 |
| 9 | [TASK-ISL-009 — Claude Code CLI adapter](TASK-ISL-009-claude-adapter.md) | ISL-M3 | magas | ISL-007 |
| 10 | [TASK-ISL-010 — Antigravity CLI adapter](TASK-ISL-010-antigravity-adapter.md) | ISL-M3 | magas | ISL-007 |
| 11 | [TASK-ISL-011 — Windows runner host](TASK-ISL-011-windows-runner.md) | ISL-M3 | magas | ISL-006, ISL-008…010 |
| 12 | [TASK-ISL-012 — Linux runner host](TASK-ISL-012-linux-runner.md) | ISL-M3 | magas | ISL-006, ISL-008…010 |
| 13 | [TASK-ISL-013 — Egyetlen launch authority és workflow](TASK-ISL-013-workflow-launch-authority.md) | ISL-M4 | kritikus | ISL-003…007 |
| 14 | [TASK-ISL-014 — Federation outbox/relay/DLQ](TASK-ISL-014-federation-transport.md) | ISL-M4 | magas | ISL-003…005 |
| 15 | [TASK-ISL-015 — Observability, recovery és üzemeltetés](TASK-ISL-015-operability-recovery.md) | ISL-M4 | magas | ISL-005, ISL-006, ISL-013, ISL-014 |
| 16 | [TASK-ISL-016 — Migrációs és üzemeltetési dokumentáció](TASK-ISL-016-documentation-migration.md) | ISL-M5 | magas | ISL-002…015 |
| 17 | [TASK-ISL-017 — Független 3×2 E2E/chaos ellenőrzés](TASK-ISL-017-independent-verification.md) | ISL-M5 | kritikus | ISL-001…016 |

## Végrehajtási hullámok

1. **Design kapu:** ISL-001.
2. **Alapozás párhuzamosan:** ISL-002 és ISL-007.
3. **Izoláció és állapot:** ISL-003 és ISL-004, majd ISL-005 és ISL-006.
4. **CLI-adapterek párhuzamosan:** ISL-008, ISL-009, ISL-010.
5. **Hostok és workflow:** ISL-011, ISL-012, ISL-013, ISL-014.
6. **Üzemeltethetőség:** ISL-015, majd ISL-016.
7. **Független kapu:** ISL-017.

## Kötelező végrehajtási szerződés minden taskhoz

### Indítás előtt

1. Olvasd el teljesen: `QUALITY.md`, ezt a README-t, a saját taskfájlt,
   `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md`,
   `docs/projects/EPICS.yaml`, `terminals/root/state.md`,
   `terminals/root/todo.md` és `terminals/root/MEMORY.md`.
2. Ellenőrizd a függőségek `done` állapotát és bizonyítékait.
3. Írd le egy mondatban az adott futás konkrét goalját, a mérhető sikerkritériumot
   és a kilépési feltételt a task `Végrehajtási napló` szakaszába.
4. Állítsd a task frontmatterét `in_progress` állapotra, az epicet `active`
   állapotra, és frissítsd a root `state.md` és `todo.md` aktuális fókuszát.
5. Rögzíts erőforráskeretet: idő, maximális próbálkozás és szükség esetén token.

### Munka közben

- Minden nagyobb lépés után checkpoint: eredmény, következő lépés, nyitott
  kockázat és futtatott bizonyíték a task naplójában és a `state.md`-ben.
- A `todo.md` mindig a még hátralévő, konkrét teendőt mutassa.
- Tartós, később újrahasznosítható tanulságot azonnal írj a `MEMORY.md`-be;
  pillanatnyi napló ne kerüljön a memóriába.
- Kontextustelítődésnél checkpoint + memóriafrissítés + átadási összefoglaló,
  majd friss session. A cél és a státusz nem maradhat csak a chatben.
- Scope-bővítés, adatvesztési kockázat, külső publikálás vagy éles deploy előtt
  állj meg és kérj emberi döntést.
- Titkot, tokent, teljes auth-headert vagy személyes azonosítót tilos naplózni.

### `done` előtt

A task végére kötelező `## Implementáció (YYYY-MM-DD)` szakaszt írni, benne:

1. eredeti goal és tényleges eredmény;
2. architekturális döntések és elvetett alternatívák;
3. módosított fájlok és migrációk;
4. futtatott parancsok, exit code-ok és teszteredmények;
5. OS, shell, architektúra, Node- és CLI-verzió;
6. biztonsági és rollback-ellenőrzés;
7. Windows/Linux és CLI kompatibilitási eredmény, ha releváns;
8. ismert korlátok, fennmaradó kockázatok és következő teendők;
9. reviewer neve/szerepe és külön ellenőrzési bizonyítéka;
10. a sikerkritérium és a kilépési feltétel tételes PASS/FAIL értékelése.

Ezután szinkronizálandó:

- task frontmatter: `done` vagy bizonyított blokk esetén `blocked`;
- `docs/projects/EPICS.yaml`;
- `terminals/root/state.md`;
- `terminals/root/todo.md`;
- `terminals/root/MEMORY.md`;
- kapcsolódó ADR, README és `docs/knowledge` tudásanyag.

A készítő nem archiválhatja és nem fogadhatja el véglegesen a saját taskját. A
review után a coordinator mozgatja a taskot az `archive/` almappába.

## Platformbizonyíték-séma

Minden valós CLI-futtatás eredményét az alábbi géppel olvasható adatokkal kell
rögzíteni:

```yaml
platform_evidence:
  os: windows-native | windows-wsl | linux-native
  os_version: "..."
  shell: powershell | cmd | bash | zsh | other
  cli: codex | claude | agy
  cli_version: "..."
  adapter_version: "..."
  auth_mode: redacted-description
  task_fixture: "..."
  started_at: "ISO-8601"
  finished_at: "ISO-8601"
  exit_code: 0
  result: PASS | FAIL | BLOCKED | UNSUPPORTED
  log_artifact: "relative/path-without-secrets"
```

WSL Linux-környezetnek számít. A Windows oszlophoz natív Windows vagy a gyártó
által hivatalosan támogatott Windows-kompatibilitási út szükséges, és ezt külön
fel kell címkézni. Szimulált vagy mockolt futás nem helyettesíti a végső valós
platformbizonyítékot.

## Hivatalos platformbaseline

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode):
  `codex exec`, JSONL kimenet és explicit sandbox.
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage):
  `claude -p`, strukturált output és korlátozható tool/turn keret.
- [Antigravity CLI codelab](https://codelabs.developers.google.com/antigravity-cli-hands-on):
  `agy`; az aktuális `--help` és a telepített verzió alapján
  kell capability discoveryt végezni, mert a felület változhat.

A task implementálója minden platformnál a futás napján ellenőrizze az aktuális
hivatalos dokumentációt és rögzítse annak URL-jét és dátumát. Elavult flaget nem
szabad kompatibilitási ok nélkül beégetni.
