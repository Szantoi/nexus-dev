# src/runner — lokális session-runner (tmux-mentes terminál-futtatás)

## Felelősség

Önálló kliens-processz, amely a knowledge-service mailboxát figyeli, és a
kiosztott terminálokhoz **lokálisan indít Codex, Claude Code vagy Antigravity
CLI-sessionöket** Windows és Linux alatt. A poll-hurok az egyetlen indítási
autoritás; az SSE csak másodperc-szintű ébresztés (nudge), nem indít önállóan.

## Publikus belépési pontok

- Indítás a repo gyökeréből: **`node scripts/runner-start.mjs`** →
  [`main.ts`](main.ts).
- Belső modulok: [`runnerConfig.ts`](runnerConfig.ts) (zod-validált
  YAML-konfig betöltés), [`pollLoop.ts`](pollLoop.ts),
  [`sseListener.ts`](sseListener.ts) (terminálonként egy stream, backoffal),
  [`serverClient.ts`](serverClient.ts) (HTTP-hívások Bearer-tokennel),
  [`sessionLauncher.ts`](sessionLauncher.ts) (a **headless** TerminalSink:
  process supervisor, busy-követés), [`terminalSink.ts`](terminalSink.ts)
  (a `TerminalSink` absztrakció), [`sinkFactory.ts`](sinkFactory.ts)
  (mode → sink feloldás), [`processedStore.ts`](processedStore.ts)
  (feldolgozott üzenetek perzisztens nyilvántartása — duplaindítás ellen),
  [`completionCursorStore.ts`](completionCursorStore.ts) (monoton, atomikusan
  mentett durable-completion cursor az attached managerhez),
  [`taskPrompt.ts`](taskPrompt.ts), valamint a provider-adapterek:
  [`cliAdapter.ts`](cliAdapter.ts), [`codexAdapter.ts`](codexAdapter.ts),
  [`claudeAdapter.ts`](claudeAdapter.ts),
  [`antigravityAdapter.ts`](antigravityAdapter.ts).

## TerminalSink absztrakció

A poll-hurok az egyetlen indítási autoritás; a **`TerminalSink`**
([`terminalSink.ts`](terminalSink.ts)) csak *végrehajt*, nem dönt. A kontraktus:
`dispatch(req)` (a launch belépési pont), `isBusy`, `cancel`, `cancelAll`,
`activeCount`, valamint egy opcionális `ensureReady()` (az attached mód
warm-upja; a headless sink nem implementálja).

- **`headless`** (default): a mai [`SessionLauncher`](sessionLauncher.ts) — egy
  leválasztott, egyszeri CLI-processz taskonként, prompt stdinen, élő terminál
  nélkül. A `dispatch` a `launch` aliasa → **nulla viselkedésváltozás**.
- **`attached`** (3. lépés, node-pty — **még nincs implementálva**): élő PTY
  session terminálonként.

A [`sinkFactory.ts`](sinkFactory.ts) a terminál `mode` mezője alapján old fel
sinket: `headless` → a megosztott headless sink; `attached` → **világos hibát
dob** (`AttachedSink not implemented yet (step 3): terminal '<name>'`). A
[`main.ts`](main.ts) a poll indítása előtt preflightol (`selectRunnerSink`),
így egy `attached` terminál fail-closed leállítja a runnert — nem esik csendben
headlessre.

## Durable completion replay (AttachedSink 3A)

A PTY-output és az SSE nem üzleti completion. A sikeres MCP `complete_task` az
`epic_router.db` append-only `runner_completion_receipts` táblájába ír az
üzleti taskállapottal **azonos SQLite-tranzakcióban**. Az ismételt
`complete_task` ugyanazt a `completionSequence` értéket adja vissza.

A runner a Bearer-tokenből származtatott island/terminal scope-ban kérdezi:

```text
GET /api/mailbox/:terminal/completions?after=<cursor>&limit=<1..500>
```

A [`ServerClient.fetchCompletionReceipts()`](serverClient.ts) elutasítja a
hibás, nem monoton vagy más terminálhoz tartozó választ. A
`CompletionCursorStore` cursor-regressziót nem enged és temp-file + rename
írást használ. A main loop még nem fogyasztja ezt a feedet; a bekötés a
`AttachedSessionManager` C/D szeletének része.

## Függőségi irány

A runner a szolgáltatás **kliense**: csak a `core/logger`-t és a saját
moduljait használja, a szerver-oldali feature-modulokból nem importál —
minden adat a HTTP API-n át jön.

## Konfiguráció

- **`config/runner.yaml`** (sablon: [`runner.yaml.example`](../../config/runner.yaml.example)):
  `server_url`, kiszolgált `terminals` térkép, `poll_interval_ms`,
  `sse_enabled`, `max_backoff_ms`, `log_dir`, `quarantine_existing_on_first_start`,
  provider/model allowlistek, terminálonkénti `mode`
  (`headless` default / `attached` step 3),
  sandbox, timeout és kimeneti limit. Codexnél az automatizálási út
  `codex exec --json --ephemeral`; a prompt stdinre kerül.
- Env: `RUNNER_TOKEN` (a runner Bearer-tokenje — kötelező), `RUNNER_CONFIG_PATH`
  (default: `<knowledge-service>/config/runner.yaml`). A `runnerConfig.ts`
  saját zod-loader — dokumentált kivétel a config-rétegszabály alól
  (TASK-QC-007).
- Indító script: `scripts/runner-start.mjs` — `.env.runner`, ennek híján
  `.env.dev` betöltése; ha egyik sincs, figyelmeztetéssel tisztán
  process-env-ből fut.

## Logok

`[Runner]` prefixű sorok (CLI preflight, poll-döntések, launch, SSE-állapot);
állapotfájl: `<log_dir>/runner-state.json`, normalizált session-események:
`<log_dir>/<terminal>/<message-id>.jsonl`. Titok nem kerülhet a logba.
Hiányzó vagy sérült állapotfájlnál az első indulás az összes már meglévő
UNREAD taskot tartós karanténba veszi. Ha bármelyik inbox nem olvasható, a
runner fail-closed leáll, és egyetlen sessiont sem indít.

## Tesztek

`npx vitest run src/__tests__/unit/runner.test.ts src/__tests__/unit/runnerSse.test.ts src/__tests__/integration/runnerPoll.integration.test.ts src/__tests__/integration/runnerSse.integration.test.ts`

## Ismert korlátok

- Terminálonként egyszerre egy session (busy-gate); a poll-intervallum a
  reakcióidő alsó korlátja, ha az SSE nem elérhető.
- A runner nem ellenőrzi a task tartalmát — a kiosztás helyessége a
  szerver-oldali routing felelőssége.
- Antigravity strukturált event-streamet nem dokumentál; az adapter plain-text
  normalizálást használ, és csak sikeres valós `agy --version` preflight után
  indulhat.
- Windowson natív `.exe` CLI ajánlott. `.cmd` shim miatt a runner nem kapcsol
  `shell:true` módra; ez szándékos shell-injection elleni fail-closed viselkedés.
