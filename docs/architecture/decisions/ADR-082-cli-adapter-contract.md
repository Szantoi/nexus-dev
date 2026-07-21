# ADR-082: CLI adapter capability- és lifecycle-szerződés

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés

## Kontextus

A runner MVP (`src/runner/sessionLauncher.ts`) ma **Claude Code-specifikus**:
Windowson egyetlen shell-stringgé fűzi össze a `[claude_bin, '--model',
model, '-p', ...extra_args]` argumentumokat és `shell: true` móddal indítja
(`.cmd`-shim kerülő megoldás); a prompt kizárólag stdinen megy be
(`taskPrompt.ts`). Nincs Codex- vagy Antigravity-adapter. A program célja
(README, 7. sikerkritérium), hogy ugyanaz a runner-architektúra futtassa a
Codex, Claude Code és Antigravity CLI-t Windows és Linux alatt.

**Élő doksi-ellenőrzés (WebFetch, futtatva 2026-07-18-án — lásd lent, a
platformbizonyíték-séma szerint rögzítve):**

- Codex non-interactive mode
  (`https://learn.chatgpt.com/docs/non-interactive-mode`, elérve
  2026-07-18): `codex exec` parancs; kulcs-flagek `--json` (JSONL kimenet,
  `thread.started`/`turn.started`/`turn.completed`/`item.*` eseménytípusok),
  `--sandbox` (`workspace-write`|`danger-full-access`|read-only alapértelmezett),
  `--output-schema`, `-o`/`--output-last-message`, `--ephemeral`,
  `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`. Kilépési
  kód nem-nulla, ha egy `required=true` MCP-szerver nem inicializálódik. Az
  oldalon nincs verziószám vagy utolsó-frissítés dátum feltüntetve.
- Claude Code CLI reference — a README-ben szereplő
  `https://docs.anthropic.com/en/docs/claude-code/cli-usage` URL **301
  redirect** a `https://code.claude.com/docs/en/cli-usage` címre (megerősítve
  2026-07-18-án, `WebFetch` explicit jelezte az átirányítást). A friss oldal
  (elérve 2026-07-18): `-p`/`--print` nem-interaktív mód;
  `--output-format text|json|stream-json`; `--json-schema` (v2.1.205+ hibára
  fut érvénytelen sémánál); `--max-turns`, `--max-budget-usd`;
  `--allowedTools`/`--disallowedTools`/`--tools`; `--permission-mode
  default|acceptEdits|plan|auto|dontAsk|bypassPermissions|manual`;
  `--dangerously-skip-permissions`; `--input-format text|stream-json`;
  `--verbose`, `--include-partial-messages`. **Pontosítás a 2026-07-19-i
  független review nyomán:** az eredeti szöveg tévesen állította, hogy "az
  oldal aktuális verzióként v2.1.212-t említi" — a független reviewer saját
  lekérdezése NEM talált ilyen kiírt verzió-bannert az oldalon. A valóság:
  az oldal EGYES flagek mellett `min-version:` jellegű funkció-annotációkat
  tartalmaz (a legmagasabb megfigyelt ilyen annotáció ~v2.1.211, pl. a
  `--forward-subagent-text` flagnél), és a "jelenleg telepített verzió"
  lekérdezésének javasolt módjaként a `claude --version` parancsot nevezi
  meg — DE nincs egyetlen, önmagában kiírt "aktuális kiadás: vX.Y.Z" mondat
  a lapon. A "v2.1.212" korábban tévesen, a funkció-annotációk összesített
  benyomásaként került az ADR-ba; a helyes hivatkozási mód: "a min-version
  annotációk ~v2.1.2xx tartományúak, a tényleges telepített verziót
  `claude --version`-nel kell az implementáció napján ellenőrizni." Nincs
  explicit "utolsó frissítve" dátum a lapon.
- Antigravity CLI codelab
  (`https://codelabs.developers.google.com/antigravity-cli-hands-on`, elérve
  2026-07-18): telepítő script (`curl ... antigravity.google/cli/install.sh
  | bash` macOS/Linuxon, PowerShell/CMD Windowson); a codelab **1.0.7**
  verziót említ írás közben (a telepítési példákban 1.0.1 is szerepel);
  `agy -p` nem-interaktív/autonóm mód ("directly provide it the prompt...
  without the interactive terminal opening up"); `--model` (Gemini
  modellekhez); `--dangerously-skip-permissions`. A codelab explicit jelzi,
  hogy a teljes parancslista `agy --help`-ből és az interaktív `/help`-ből
  fedezendő fel, mert a felület változhat — NINCS a codelabben dokumentált
  strukturált (JSON) kimeneti mód.

## Döntés

### Egységes `CliAdapter` szerződés

```text
interface CliAdapterCapabilities {
  cliId: 'codex' | 'claude' | 'agy'
  headlessSupported: boolean
  structuredOutputFormats: string[]   // pl. ['jsonl'] | ['json','stream-json'] | []
  supportsMaxTurns: boolean
  supportsBudgetLimit: boolean
  supportsToolAllowlist: boolean
  requiresPty: boolean                 // csak akkor true, ha nincs életképes headless mód
}

interface CliAdapter {
  discoverCapabilities(installedVersion: string): Promise<CliAdapterCapabilities>
  buildLaunchSpec(task: LeasedTask): ProcessLaunchSpec   // argv+env+stdin tömb, NEM shell-string
  parseEvents(stream): AsyncIterable<AdapterEvent>        // JSONL/stream-json/sima szöveg → egységes eseményalak
  cancel(handle): Promise<void>
  finalize(handle): Promise<AdapterResult>                // exit code, végső üzenet, strukturált eredmény ha van
}
```

Életciklus-állapotok minden adapterre egységesen: `spawned → streaming →
(cancelling) → exited`. `cancel()` garantálja a folyamat ÉS minden
gyermekfolyamat leállítását (process group / Windows Job Object — ISL-011/
ISL-012 hatálya). Host-crash esetén nincs adapter-specifikus állapot, ami
túlélné a folyamatot — a helyreállítás KIZÁRÓLAG a lease/reaper mechanizmus
(ADR-079) felelőssége.

### Konkrét leképezés a mai (2026-07-18) doksik alapján

| CLI | Parancs | Strukturált kimenet | Turn/budget limit | Tool allowlist |
|---|---|---|---|---|
| Codex | `codex exec --json --sandbox workspace-write --output-schema <séma> -o <fájl>` | JSONL (`thread.*`/`turn.*`/`item.*`) | nincs explicit turn-limit flag a fetchelt oldalon (nyitott kérdés, ISL-008 ellenőrzi) | `--sandbox` szint, nem tool-lista |
| Claude Code | `claude -p --output-format stream-json --verbose --max-turns <n> --max-budget-usd <n> --allowedTools "..." --permission-mode <mode> --input-format text` | `json` / `stream-json` | igen (`--max-turns`, `--max-budget-usd`) | igen (`--allowedTools`/`--disallowedTools`) |
| Antigravity (`agy`) | `agy -p --model <modell> --dangerously-skip-permissions` | **ismeretlen/nincs dokumentált** (`structuredOutputFormats: []` munkahipotézis) | nem dokumentált a codelabben | nem dokumentált a codelabben |

- A jelenlegi `claude -p` hívás **hardening-igényét** ez az ADR rögzíti:
  a mai `shell: true` string-összefűzés (injekciós kockázat, ha bármely
  argumentum támadó-befolyásolt) helyett argv-tömbös `spawn(..., { shell:
  false })` + explicit `.cmd`-feloldás Windowson; a strukturált
  `--output-format stream-json` és `--max-turns`/`--max-budget-usd`
  bevezetése a mai plain-text, korlátlan futássá váltja fel (ISL-009
  implementációs feladata).
- Antigravity `requiresPty=false` és `structuredOutputFormats=[]` MUNKA-
  HIPOTÉZIS, mert a forrás egy hands-on codelab, nem teljes CLI-referencia —
  ISL-010-nek EMPIRIKUSAN kell megerősítenie `agy --help`/telepített
  verzió alapján, a README saját szabálya szerint ("a felület változhat").
- Minden 3 CLI hitelesítése (API-kulcs/OAuth) adapteren kívüli, host-szintű
  előfeltétel — az adapter-szerződés nem kezel CLI-bejelentkezést.

## Design intent

A runner ne "Claude Code futtató" legyen, hanem egy capability-alapú
adapter-regiszter fogyasztója — az adapterek közötti eltérést (strukturált
kimenet megléte, turn/budget-limit támogatottsága) explicit, futásidőben
lekérdezhető képességként kezeljük, nem hardcodolt feltételezésként.

## Alternatívák

- **Külön runner-implementáció CLI-nkként** — elvetve: megsokszorozná a
  lease/claim/state-machine integrációt (ADR-079) három helyen.
- **Legkisebb közös nevező (csak plain-text stdout parse)** — elvetve:
  eldobná a Codex/Claude JSONL strukturált eseményeit, amik a
  megbízhatóbb esemény-feldolgozáshoz kellenek.

## Következmények

- ISL-008/009/010 ezt a szerződést implementálja; ISL-007 magát a
  szerződést (interfészt + registry-t) építi.
- A README hivatkozott Claude Code URL-je elavult (301 redirect) — jelezve
  dokumentációs karbantartási tételként (ISL-016 vagy egy külön
  maintenance-task hatálya; ez az ADR NEM módosítja a README-t, mert az
  kívül esik a jelen task fájlhatárán).

## Biztonsági hatás

Az argv-tömbös spawn (shell:false) bevezetése konkrét hardening: megszünteti
a jelenlegi `shell: true` string-összefűzés injekciós kockázatát. A
`--sandbox`/`--permission-mode`/`--dangerously-skip-permissions` flagek
explicit, naplózott megválasztása (sosem "danger-full-access" alapértelmezés)
biztonsági döntés, nem csak funkcionális.

## Kapcsolódó kód

- `knowledge-service/src/runner/sessionLauncher.ts`, `taskPrompt.ts`,
  `runnerConfig.ts`

## Bizonyíték

- `WebFetch` 2026-07-18: `https://learn.chatgpt.com/docs/non-interactive-mode`,
  `https://docs.anthropic.com/en/docs/claude-code/cli-usage` (301 →
  `https://code.claude.com/docs/en/cli-usage`),
  `https://codelabs.developers.google.com/antigravity-cli-hands-on` — a
  fenti táblázat és verziószámok ezekből a lekérdezésekből származnak.
- Kód-felderítés 2026-07-18: `sessionLauncher.ts:104-110` Windows
  `shell: true` string-join spawn; `taskPrompt.ts:10` stdin-only prompt.
- `docs/tasks/island-runtime/README.md` "Hivatalos platformbaseline" szakasz.

## Nyitott kérdések

- Codex `exec` esetén nincs a fetchelt oldalon explicit turn-limit flag —
  ISL-008-nak kell megerősítenie, van-e ekvivalens mechanizmus (pl.
  `--output-schema`+timeout kombináció) vagy ez tényleges képesség-hiány.
- Antigravity strukturált kimenet és PTY-igény EMPIRIKUS megerősítésre vár
  (ISL-010) — a jelen ADR csak munkahipotézist rögzít.
- A README három URL-je közül az egyik (Claude Code) igazoltan elavult;
  frissítése kívül esik e task fájlhatárán, jelezve a koordinátor felé.
