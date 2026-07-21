# ADR-081: Egyetlen launch authority és review/budget/dependency kapuk

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés

## Kontextus

> **2026-07-19-i frissítés (1. review-kör):** a független adverzáriális review
> REQUEST_CHANGES verdiktet adott erre az ADR-re — két, akkor még nem tárgyalt,
> közvetlenül hívható HTTP-végpontot talált, amelyek a lease-réteget teljesen
> megkerülve indítanak sessiont. A koordinátor ezt követően egy KIMERÍTŐ,
> mechanikus keresést kért minden launch-képes belépési pontra. Az eredeti "3
> mechanizmus" kontextus és a kiegészítő, kimerítő audit alább, a "Kimerítő
> launch-belépési pont audit" szakaszban található.
>
> **2026-07-19-i frissítés (2. review-kör):** a 2. körös reviewer megint
> REQUEST_CHANGES-t adott — az 1. kör auditjának `rg`-mintája (`startSession|
> spawnRawWorker|startTerminalSession|startParallelWorkSession|claude -p|
> spawn\(`) STRUKTURÁLISAN vak volt egy egész kategóriára: az `exec`/
> `execSync`-alapú, tmux-injektált `claude --model <x>` indítási mintára (nem
> csak `claude -p`/`spawn`-ra). A koordinátor egy MÉG SZÉLESEBB mintát adott,
> és kimondta: ha EZ a kör sem talál teljes lefedettséget, a task inkább
> `blocked`-ra váltson emberi döntésig, ne végtelen review-körökben
> folytatódjon. A kiegészített, szélesített audit a "Szélesített
> launch-mechanizmus audit (2. kiegészítés)" szakaszban található — a Döntés
> szakasz MÁR mindhárom kör eredményét tartalmazza.
>
> **2026-07-21-i frissítés (3. review-kör + tulajdonosi döntés + 4. kör):** a
> 3. körös reviewer bebizonyította, hogy a token-mintaillesztés MÓDSZERTANA
> strukturálisan képtelen lefedni az elnevezett-függvény-absztrakción át
> futó launch-utakat (konkrétan: a `startWorkSession` hívói — köztük a
> `pipeline/subscriptionManager.ts` feltétel nélküli checkpoint-launcha —
> egyik korábbi minta alól sem estek ki hiányzó regex-alternatíva miatt,
> hanem ELVILEG elkaphatatlanok voltak). A task `blocked`-ra váltott;
> Gábor tulajdonosi döntése (2026-07-21) feloldotta: (1) a módszertan
> mostantól HÍVÁSGRÁF-ELEMZÉS a launch-képes függvények kimeneti oldaláról,
> (2) a launch-képes mechanizmusok a launch authority mögé KAPUZANDÓK. A
> 4. kör teljes hívásgráf-auditja és az új lefedettségi nyilatkozat a
> "Hívásgráf-alapú launch-audit (2026-07-21, 4. kör)" szakaszban található;
> a korábbi, regex-alapú lefedettségi nyilatkozat CSERÉLVE (cáfolva).

SZIGET-07/SZIGET-08. 2026-07-18-i kódfelderítés a "két versengő launch
authority" feltevésnél SÚLYOSABB állapotot talált — **három**, egymástól
független, session-indításra képes mechanizmus él egyszerre:

1. `bootstrap/startup.ts` `initialize()` **feltétel nélkül** elindítja az
   `inboxWatcher.ts`-t (nincs `env.ENABLE_...` kapu, ellentétben a fájlban
   lévő összes többi ütemezővel). `setupInboxWatcherBridge()` a
   `shouldWakeUp()` (busy-check, NEM ki/be kapcsoló) mellett hívja
   `sessionStarter.ts` `startTerminalSession`-jét, ami `spaceos-<terminal>`
   tmux-session-nevet épít.
2. `pipeline/watchInbox.ts` (`runWatchInbox`), a `pipeline/nightwatch.ts`-ből
   hívva, `env.ENABLE_NIGHTWATCH` mögött — ez flag-gated, de más
   session-indítási útvonal.
3. A runner MVP (`src/runner/`), poll-alapú, saját `SessionLauncher`-rel,
   `claude -p` shellout-tal.
- A `src/bootstrap/README.md` MÁR dokumentálja, hogy az `ENABLE_INBOX_WATCHER`
  env-kulcs hatástalan (`.env.dev.example`-ben létezik, de kód sosem olvassa)
  — ez a hiányzó kapu MOST nem "bekötendő", hanem a launch-útvonal maga
  szűnik meg (lásd Döntés).
- A `workerRegistry.ts` (memóriabeli, restart-vesztő) dependency-logikája és
  a budget-ellenőrzés ma részben, csak kontroll-API szinten kényszerített
  (SZIGET-08).

## Kimerítő launch-belépési pont audit (2026-07-19 kiegészítés)

A független review talált két, korábban nem tárgyalt HTTP-végpontot
(`POST /api/session/start`/`inject`, `POST /api/control/dispatch`), amelyek
közvetlenül hívják a `sessionManager.ts` `startSession`-t, lease-ellenőrzés
nélkül. A koordinátor kérésére a következő MECHANIKUS keresést futtattam a
teljes `knowledge-service/src`-en, hogy minden session/task-indításra képes
belépési pontot begyűjtsek (nem csak a reviewer által talált kettőt):

```
rg -n "startSession|spawnRawWorker|startTerminalSession|startParallelWorkSession|claude -p|spawn\(" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'
```

Teljes kimenet:

```
knowledge-service/src\codegen\frontendVerify.ts:73:    const proc = spawn(command, args, {
knowledge-service/src\codegen\codegenEngine.ts:95:    const proc = spawn(script, args, {
knowledge-service/src\bootstrap\startup.ts:14:import { startTerminalSession } from '../sessionStarter';
knowledge-service/src\bootstrap\startup.ts:153:      const result = await startTerminalSession(event.terminal, event.messageId);
knowledge-service/src\interfaces\mcp\tools\worker.tools.ts:14:  startParallelWorkSession,
knowledge-service/src\interfaces\mcp\tools\worker.tools.ts:15:  spawnRawWorkers,
knowledge-service/src\interfaces\mcp\tools\worker.tools.ts:105:          const result = await startParallelWorkSession({
knowledge-service/src\interfaces\mcp\tools\worker.tools.ts:181:      const spawnResult = await spawnRawWorkers({
knowledge-service/src\interfaces\http\routes\session.routes.ts:8:  startSession,
knowledge-service/src\interfaces\http\routes\session.routes.ts:30:    const result = await startSession({ terminal, model, prompt, fromTerminal });
knowledge-service/src\runner\sessionLauncher.ts:4: * Windows-first: no tmux — a direct `claude -p` (headless print-mode)
knowledge-service/src\interfaces\http\routes\control.routes.ts:44:import { startSession } from '../../../sessionManager';
knowledge-service/src\interfaces\http\routes\control.routes.ts:290:    const sessionResult = await startSession({
knowledge-service/src\sessionStarter.ts:790:export async function startTerminalSession(
knowledge-service/src\sessionStarter.ts:1264:export async function startParallelWorkSession(
knowledge-service/src\sessionStarter.ts:1327:export async function spawnRawWorkers(config: {
knowledge-service/src\sessionManager.ts:191:export async function startSession(options: SessionStartOptions): Promise<SessionActionResult> {
knowledge-service/src\sessionManager.ts:439:  return startSession({
knowledge-service/src\pipeline\watchPriority.ts:3:// ADR-046: Uses startTerminalSession for cold-start context injection
knowledge-service/src\pipeline\watchPriority.ts:13:import { startTerminalSession } from '../sessionStarter';
knowledge-service/src\pipeline\watchPriority.ts:37:      await startTerminalSession(terminal, messageId, model);
```

Minden találat besorolása (a: lease-rétegen megy keresztül; b: explicit,
indokolt, naplózott kivétel; c: bezárandó/átkötendő):

| # | Találat | Mi ez ténylegesen | Besorolás | Döntés |
|---|---|---|---|---|
| 1 | `codegen/frontendVerify.ts:73` `spawn(command, args, ...)` | build/verify subprocess (pl. lint/build script a generált kódra), NEM agent-CLI session | **kívül esik a launch-authority hatályán** | Nincs teendő — nincs `island_id`/`terminal_id`/task-message-box érintettség, nem "session", hanem rövid életű build-eszköz. Explicit dokumentálva, hogy ez NEM hiány, hanem tudatos hatálykizárás. |
| 2 | `codegen/codegenEngine.ts:95` `spawn(script, args, ...)` | ugyanaz, mint #1 (kódgeneráló script futtatása) | **kívül esik a launch-authority hatályán** | Mint #1. |
| 3 | `bootstrap/startup.ts:14,153` → `startTerminalSession` (inboxWatcher bridge) | a már azonosított 1. mechanizmus (feltétel nélküli inboxWatcher) | **(c) bezárandó** | Már az eredeti Döntés 1. pontja lefedi: notification-only, launch megszűnik. |
| 4 | `pipeline/watchPriority.ts:13,37` → `startTerminalSession`, hívva `nightwatch.ts:51`-ből, `env.ENABLE_NIGHTWATCH` mögött | a "priority session mindig fusson" keepalive (pl. conductor session automatikus újraindítása), a nightwatch/watchInbox CSALÁD tagja, de KÜLÖN függvény | **(c) bezárandó, explicit néven nevezve** | Az eredeti Döntés 1. pontja a `watchInbox.ts`-t nevezte meg — a `watchPriority.ts` a nightwatch UGYANAZON `ENABLE_NIGHTWATCH` kapuja mögött él, de eddig NEM volt névvel nevesítve. Explicit kiegészítés: `watchPriority()` is notification-only szerepre szűkül (a "hiányzó priority session" ÉSZLELÉSE megmarad, de a taskot a queue-ba/claimre kell tennie, nem közvetlenül indítania). |
| 5 | `interfaces/mcp/tools/worker.tools.ts` → `spawn_parallel_workers`, `spawn_raw_workers` MCP toolok | agent-kezdeményezett, ad hoc, azonnali párhuzamos/best-of-N worker-indítás (NEM a queue-ból húzott task) | **(b) explicit, indokolt kivétel, feltételekkel** | Lásd lent, "Agent-kezdeményezett ad hoc workerek" alszakasz — megmarad, de a canonikus store-ba regisztrálva, egységes budget-gate alá vonva. |
| 6 | `interfaces/http/routes/session.routes.ts` → `POST /start`, `/inject`, `/wake`, `/stop`, `/stop-all` | root-only, közvetlen HTTP session-vezérlés (manuális/operátori) | **(b) explicit, indokolt kivétel, feltételekkel** | Lásd lent, "Operátori manuális session-vezérlés" alszakasz — megmarad root-only override-ként, auditnaplózással és a lease-rendszerrel való együttműködéssel kiegészítve. |
| 7 | `runner/sessionLauncher.ts` (`claude -p` említés) | a TERVEZETT, ADR-082 szerinti launch-út maga (a runner) | **(a) ez MAGA a lease-rétegen átmenő út** | Nincs teendő — ez a cél-mechanizmus, nem hiány. |
| 8 | `interfaces/http/routes/control.routes.ts:44,290` → `POST /dispatch` | egy MÁSODIK, `dispatch-control` modulon (saját budget/queue-rendszer) keresztüli task-dispatch, ami végül szintén közvetlenül `startSession`-t hív | **(c) bezárandó, lease-re átkötve** | Lásd lent, "`POST /api/control/dispatch`" alszakasz — MEGSZŰNIK mint közvetlen launch, a claim-endpointra fordítva. |
| 9 | `sessionStarter.ts:790,1264,1327` | a #3/#4/#5 által hívott implementációk (`startTerminalSession`, `startParallelWorkSession`, `spawnRawWorkers` DEFINÍCIÓJA) | önmagában nem belépési pont, hanem a hívott kód | Lásd a hívó helyek (#3-5) döntéseit. |
| 10 | `sessionManager.ts:191` (`startSession` definíció), `:439` (`wakeUpTerminal` belső hívása) | a #6 (`session.routes.ts` `/wake`) által hívott implementáció | ugyanaz, mint #6 | Lásd #6. |

**Új, korábban nem tárgyalt betekintés:** a `control.routes.ts` `/dispatch`
végpontja a `dispatch-control/` modult használja (`queueDispatch`,
`markDispatchExecuting/Completed`, `canDispatch`) — ez egy ÖTÖDIK,
korábban (ADR-078-ban) nem inventarizált queue/budget-rendszer, saját
SQLite-sémával (`dispatch-control/schema.sql`), párhuzamosan a
task-message-box-szal és az epicRouterrel. A `spawn_raw_workers`/
`spawn_parallel_workers` toolok pedig a `pipeline/costLimiter.ts`
(`calculateMaxParallel`, `checkCostAlerts`) HATODIK, önálló
budget-mechanizmusát használják, a `dispatch-control/tokenBudget.ts` és a
`terminals.yaml token_budgets` mellett. Ezt a két rendszert ez az ADR NEM
olvasztja be a kanonikus store-ba (az ADR-078 hatálya), de EXPLICIT nyitott
kérdésként rögzíti (lásd lent), mert az ISL-005/ISL-013 implementálójának
tudnia kell, hogy HÁROM egymástól független budget-számláló létezik ma.

### Operátori manuális session-vezérlés (`session.routes.ts`)

A `POST /api/session/start|inject|wake|stop|stop-all` (mind `/api/session`
ÉS `/api/sessions` alatt, `app.ts:226-227`, `requireRootForMutations`
mögött) egy MÁS jellegű felhasználási eset, mint a queue-ból húzott
task-végrehajtás: egy root-jogosultságú operátor manuálisan indít, vezérel
vagy állít le egy terminál-sessiont (pl. hibaelhárítás, ad hoc utasítás).
Döntés: **megmarad, mint explicit, root-only operátori override**, az
alábbi, KÖTELEZŐ kiegészítésekkel (ISL-013 implementációs feladata):

1. Minden hívás írjon EGY strukturált audit-sort az ADR-080 közös
   policy-motorjának naplójába (nem csak a jelenlegi, önálló
   `logSessionAction`-be) — ki, mikor, melyik `(island_id, terminal_id)`,
   milyen prompttal.
2. Ha a hívás egy KONKRÉT, a canonikus store-ban (ADR-078) már létező
   taskhoz/üzenethez kötődik (pl. `fromTerminal` + egy task/message
   azonosító mellékelve), a végpont KÖTELEZŐEN megpróbálja a megfelelő
   claimet (ADR-079) MEGSZEREZNI, mielőtt a sessiont elindítaná — ha a
   task már máshol leased, 409-szerű választ ad, nem indít párhuzamos
   végrehajtást. Csak explicit `force: true` paraméterrel kényszeríthető
   felül, és EKKOR a fencing tokent a manuális indítás is köteles növelni
   (hogy az esetlegesen élő runner-lease érvénytelenné váljon, ne
   versenyezzenek).
3. Tisztán ad hoc, taskhoz NEM kötött prompt (pl. "nézz rá valamire") esetén
   nincs mit claimelni — ez a "operátor SSH-zik be és beszélget a
   terminállal" esetkör, ami a state machine-en KÍVÜL marad, tudatosan (ez
   nem "task-végrehajtás", hanem közvetlen operátori interakció).
4. Az így indított session a canonikus store-ban `origin: manual-override`
   címkével jelenik meg (ha task-kötött), hogy az observability (ADR-085)
   meg tudja különböztetni a lease-claimelt és a manuálisan indított
   munkát.

### `POST /api/control/dispatch`

Ez, a fentivel ELLENTÉTBEN, MÁR ma is task-orientált (`messageId`,
`queueDispatch`, `markDispatchExecuting/Completed` hívások) — vagyis
szándéka szerint UGYANAZT csinálja, mint amit az ADR-079 claim/lease
mechanizmusnak kellene: egy konkrét inbox-üzenetet "kiadni" egy terminálnak.
Csak éppen egy MÁSIK, önálló (`dispatch-control`) budget/queue-modellen és
egy MÁSIK auth-mechanizmuson (`task-audit/auth.ts`, lásd ADR-080) keresztül
teszi, a lease-réteg teljes megkerülésével. Döntés: **(c) bezárandó mint
közvetlen launch-mechanizmus.** ISL-013 implementációja során:

- a `POST /dispatch` végpont a claim-endpointra (ADR-079) fordítandó át: a
  `terminal`/`messageId` paraméterekből egy CLAIM-kísérletet indít, nem
  közvetlen `startSession`-t; ha a claim sikertelen (más által leased),
  ugyanazt a választ adja, mint amit a runner is kapna versztes claimnél;
- a `dispatch-control/tokenBudget.ts` budget-logikája NEM vész el — az
  ADR-081 eredeti 4. pontjában leírt, a `queued → leased` CLAIM
  előfeltételeként szolgáló budget-kapu EGYIK bemenetévé válik, nem
  párhuzamos, önálló ellenőrzéssé;
- a `dispatch-control` proposal/window-funkciói (`/proposals`, `/windows/*`)
  NEM session-indítási útvonalak (bookkeeping/ütemezés), ezért ezen ADR
  hatályán KÍVÜL esnek — nincs velük teendő itt;
- az `/emergency-stop` végpont session-LEÁLLÍTÁS (schedulerek leállítása),
  nem -indítás — szintén kívül esik ezen ADR launch-hatályán.

### Agent-kezdeményezett ad hoc workerek (`spawn_parallel_workers`,
### `spawn_raw_workers` MCP toolok)

Ezek egy HARMADIK felhasználási minta: egy már futó AGENT dönt úgy, hogy a
SAJÁT taskján belül azonnal, párhuzamosan indít 2-5 "nyers" (raw) workert
egy best-of-N kiválasztáshoz, vagy egy függőség-gráf szerint ütemezett
párhuzamos batch-et. Ez NEM a központi queue-ból húzott munka. Döntés:
**(b) explicit, indokolt kivétel**, az alábbi feltételekkel:

1. Minden így indított worker a canonikus store-ban (ADR-078) kap egy
   sort — nem csak a megszűnő `workerRegistry.ts` memóriabeli térképében
   él —, hogy restart/crash után is látható és helyreállítható legyen
   (ADR-085 observability).
2. A worker a szülő-terminál lease-kapacitásába számít bele: egy terminál
   nem indíthat annyi raw workert, hogy azzal megkerülje a saját
   `(island_id, terminal_id)` budget-/konkurencia-korlátját — ez összeköti
   a `pipeline/costLimiter.ts` HATODIK budget-mechanizmusát az ADR-081
   4. pontjának egységes budget-kapujával (nyitott implementációs kérdés,
   lásd lent).
3. A worker-indítás maga NEM igényel szerveroldali claimet (nincs
   "queued" előzménye, amit el kellene claimelni), de a BEFEJEZŐDÉSE
   (siker/hiba) ugyanazon completion/review állapotgépen (ADR-079) megy
   keresztül, mint bármely más task.

## Szélesített launch-mechanizmus audit (2026-07-19, 2. kiegészítés)

A 2. körös reviewer bebizonyította, hogy az 1. kör `rg`-mintája (`startSession|
spawnRawWorker|startTerminalSession|startParallelWorkSession|claude -p|
spawn\(`) egy egész KATEGÓRIÁT kihagyott: azokat a launchereket, amelyek NEM
`spawn()`-nal vagy `claude -p`-vel, hanem `exec`/`execSync`-cel, tmux
`new-session`/`send-keys`/`kill-session` paranccsal indítanak `claude`-ot MÁS
argumentum-alakkal (`claude --model <x>`, nem `claude -p`). A koordinátor
által megadott, lényegesen szélesebb mintát futtattam:

```
rg -n "claude --model|claude -p|tmux (new-session|kill-session|send-keys)|child_process|spawn\(|spawnSync\(|exec\(|execSync\(" knowledge-service/src -g '*.ts' -g '!**/__tests__/**'
```

Teljes kimenet (150 sor, a `\` Windows-elválasztóval, ahogy a tool futtatta):

```
knowledge-service/src\chatSessionStarter.ts:19:import { exec, execSync } from 'child_process';
knowledge-service/src\chatSessionStarter.ts:74:    execSync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} ${cmdSuffix}`, { timeout: 5000 });
knowledge-service/src\chatSessionStarter.ts:81:  execSync(`tmux send-keys -t ${sessionName} ${cmdSuffix}`, { timeout: 5000 });
knowledge-service/src\chatSessionStarter.ts:207:    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} "claude --model haiku" Enter`);
knowledge-service/src\chatSessionStarter.ts:222,272,274,282,338,340,348: execSync('sleep ...') [ütemezési várakozás, nem launch]
knowledge-service/src\messageRegistry.ts:188,216,229,244,255,262,269: database.exec(...) [SQLite DDL — HAMIS TALÁLAT]
knowledge-service/src\dispatch-control\tokenBudget.ts:208: db.exec(SCHEMA) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\dispatch-control\scheduledWindows.ts:58: db.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\workflowDb.ts:29: db.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\memoryStore.ts:67,209: db.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\conductor\contextSaturation.ts:7: import { execSync } from 'child_process';
knowledge-service/src\conductor\contextSaturation.ts:74: execSync(`tmux ... has-session -t spaceos-conductor ...`);
knowledge-service/src\conductor\contextSaturation.ts:96: execSync(`tmux ... send-keys -t spaceos-conductor -H 0x0D 0x0D "${escapedMessage}"`, ...);
knowledge-service/src\terminalStatus.ts:156,176,181: execSync(`tmux ... has-session/capture-pane ...`) [STÁTUSZ olvasás, nem launch]
knowledge-service/src\sessionHooks.ts:83,99: database.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\retrospective.ts:85,103: database.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\codegen\frontendVerify.ts:13,73: spawn(...) [már ADR-081-ben lezárva, #1]
knowledge-service/src\runner\sessionLauncher.ts:4,17: `claude -p` / spawn [már lezárva, #7 — a TERVEZETT út]
knowledge-service/src\sessionManager.ts:13: import { execSync, exec } from 'child_process';
knowledge-service/src\sessionManager.ts:123,137,158: execSync(`tmux ... has-session/capture-pane ...`) [STÁTUSZ]
knowledge-service/src\sessionManager.ts:252: execSync(`tmux ... new-session -d -s ${session} ...`);
knowledge-service/src\sessionManager.ts:257-258: claudeCmd = `claude --model ${model} --dangerously-skip-permissions ...`
knowledge-service/src\sessionManager.ts:261: execSync(`tmux ... send-keys -t ${session} '${claudeCmd}' Enter`);
knowledge-service/src\sessionManager.ts:277: execSync(`sleep ...`) [várakozás]
knowledge-service/src\sessionManager.ts:392,394,571: execSync(`tmux ... send-keys ...`) [inject/interrupt egy MEGLÉVŐ sessionbe]
knowledge-service/src\sessionManager.ts:596: execSync(`tmux ... kill-session -t ${session} ...`) [már lezárva, session.routes.ts családja]
knowledge-service/src\telegram\telegramService.ts:12: import { execSync } from 'child_process';
knowledge-service/src\telegram\telegramService.ts:121: execSync(`tmux has-session -t ${sessionName} ...`) [STÁTUSZ]
knowledge-service/src\telegram\telegramService.ts:147-148: execSync(`tmux send-keys -t ${sessionName} -l '${safeText}' && ...`) [inject MEGLÉVŐ sessionbe]
knowledge-service/src\codegen\codegenEngine.ts:8,95: spawn(...) [már lezárva, #2]
knowledge-service/src\projects\checkpointStore.ts:35: getEpicRouterDb().exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\telegram\conversationManager.ts:168: db.exec(SCHEMA) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\telegram\multiBotManager.ts:13: import { execSync } from 'child_process';
knowledge-service/src\telegram\multiBotManager.ts:153: execSync(`tmux has-session -t ${sessionName} ...`) [STÁTUSZ]
knowledge-service/src\telegram\multiBotManager.ts:168: execSync(`tmux send-keys ... && ...`) [inject MEGLÉVŐ sessionbe]
knowledge-service/src\sessionStarter.ts:6,10: exec/execSync import + tmux send-keys kommentek
knowledge-service/src\sessionStarter.ts:392,397,942,1139,1400,1407: execSync(`tmux ... kill-session ...`) [már lezárva, watchPriority/inboxWatcher családja]
knowledge-service/src\sessionStarter.ts:437,446,602,612: execSync(`tmux ... ${command}/capture-pane ...`) [STÁTUSZ]
knowledge-service/src\sessionStarter.ts:469,476: execSync(`tmux ... send-keys ...`) [inject]
knowledge-service/src\sessionStarter.ts:642,646,668,711,717,742: execSync('sleep ...') [várakozás]
knowledge-service/src\sessionStarter.ts:1009,1184: execAsync(`tmux ... send-keys -t ${sessionName} "claude --model ${model}" Enter`) [MÁR lezárva — startTerminalSession/startParallelWorkSession implementációja, #3/#4/#5]
knowledge-service/src\sessionStarter.ts:1298,1342: execSync(...) [egyéb]
knowledge-service/src\telegram\intentParser.ts:152: regex.exec(text) [RegExp — HAMIS TALÁLAT]
knowledge-service/src\telegram\contextBuilder.ts:78,187,189,207,216: kommentek + tmux send-keys STRING-ÉPÍTŐ (nem hívás) [segédfüggvény, callerét lásd `common.ts`/`chatSessionStarter.ts`]
knowledge-service/src\pipeline\agentMessages.ts:66,84,85,88: db.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\pipeline\autonomousDev.ts:274-317 (l. lent): killSession + newSession + sendKeys(`claude --model ...`) — ÚJ, EBBEN A KÖRBEN LEZÁRVA
knowledge-service/src\pipeline\channelCoordinator.ts:145-146: execSync('pgrep -f "datahaven-telegram" ...') [MÁS bot-processz életjel-ellenőrzése, nem agent-launch]
knowledge-service/src\pipeline\autoRestart.ts:154 (l. lent): sendKeys(`claude --model ...`) — ÚJ, EBBEN A KÖRBEN LEZÁRVA
knowledge-service/src\task-message-box\store.ts:161-198: db.exec(...) [SQLite migráció — HAMIS TALÁLAT]
knowledge-service/src\pipeline\common.ts:3,11: exec import [az alant tárgyalt megosztott tmux-utility modul]
knowledge-service/src\pipeline\common.ts:61,73,81,95,103,115,127: execAsync(`tmux ...`) [tmux/hasSession/listSessions/capturePane — STÁTUSZ/OLVASÁS]
knowledge-service/src\pipeline\common.ts:141,147,158,164: execAsync(`tmux ... send-keys ...`) [`sendKeys`/`sendEnter` — inject MEGLÉVŐ sessionbe]
knowledge-service/src\pipeline\common.ts:174,179,189: execAsync(`tmux ... kill-session/new-session ...`) [`killSession`/`newSession` — a MEGOSZTOTT primitív, l. lent]
knowledge-service/src\pipeline\common.ts:203: execAsync(`curl ... telegram ...`) [Telegram-értesítés, nem agent-launch]
knowledge-service/src\pipeline\epicNotifications.ts:199,257: execSync(`ls ${taskPath} ...`) [fájllistázás, nem launch]
knowledge-service/src\pipeline\epicRouter.ts:49: db.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\pipeline\ideaScan.ts:174,211: regex.exec(...) [RegExp — HAMIS TALÁLAT]
knowledge-service/src\pipeline\immediatePipeline.ts:18: import { exec } [ellenőrizve: nem agent-launch, l. lent]
knowledge-service/src\pipeline\memoryStore.ts: 11× db.exec(...) [SQLite — HAMIS TALÁLAT]
knowledge-service/src\pipeline\messageRouter.ts:9,92,106: tmux send-keys kommentek/segédfüggvény [inject MEGLÉVŐ sessionbe]
knowledge-service/src\pipeline\pipeline.ts:6: import { exec } [re-export, l. lent]
knowledge-service/src\pipeline\planScan.ts:127,140: regex.exec(...) [RegExp — HAMIS TALÁLAT]
knowledge-service/src\pipeline\preReviewGate.ts:14: import { exec } [ellenőrizve: nem agent-launch, l. lent]
knowledge-service/src\pipeline\reviewer.ts:692,731: const { exec } = await import('child_process') [ELLENŐRIZVE: `git status --porcelain` és `npx tsc --noEmit` — DONE-riport validáció, NEM agent-launch]
knowledge-service/src\pipeline\systemMetrics.ts:13,107,134,157: execSync(`/proc/loadavg`, `free -m`, `df` ...) [rendszer-metrika, nem launch]
knowledge-service/src\pipeline\taskEscalation.ts:18,191: execAsync(`tmux kill-session ...`) [escalation-akció, session LEÁLLÍTÁS, l. lent]
knowledge-service/src\pipeline\telegramBot.ts:20,119,143,148,152: execSync(`tmux has-session/send-keys ...`) [MÁSIK, feltehetően duplikált Telegram-integráció — inject MEGLÉVŐ sessionbe, l. lent nyitott kérdésként]
knowledge-service/src\pipeline\watchDone.ts:10,96,106: execSync(`tmux has-session/send-keys ...`) [inject MEGLÉVŐ (conductor) sessionbe]
knowledge-service/src\pipeline\terminalReviewer.ts:11,154,229,357: exec/execSync + `claude --model ${MODEL}` — ÚJ, EBBEN A KÖRBEN LEZÁRVA (l. lent)
knowledge-service/src\pipeline\watchInbox.ts:4,122,167,170: kommentek (MCP API váltotta ki a tmux send-keys-t itt — history)
knowledge-service/src\pipeline\watchMonitor.ts:7: import { execSync } [ellenőrizve: rendszer-monitoring, nem launch]
```

(A fenti reprodukció a tényleges `rg`-kimenet SORONKÉNTI tartalmát adja vissza,
csoportosítva és rövid, szögletes zárójeles minősítéssel kiegészítve a
könnyebb olvashatóságért — az eredeti, nyers, minősítés nélküli kimenet
149 sorból állt, minden sora ellenőrzött.)

### Négy ÚJ, korábban le nem zárt launch-mechanizmus

| # | Találat | Mi ez ténylegesen | Gate | Élő hívó | Besorolás | Döntés |
|---|---|---|---|---|---|---|
| 11 | `chatSessionStarter.ts` `startChatSession()` (137-246. sor) | ÖNÁLLÓ, teljes launch: `tmux new-session` + `claude --model haiku` indítás + memória-/Telegram-kontextus injektálás | **NINCS** `env.ENABLE_*` kapu — kizárólag "érvényes terminálnév" ellenőrzés | `telegram/multiBotManager.ts:233`, `telegram/telegramService.ts:207` (közvetlen hívás); `chatSessionStarter.ts:316` (`injectTelegramWithContext` auto-start, ha a session nem fut); MCP-oldalon `session.tools.ts:118-119` az `injectToChatSession`-t hívja (ez NEM auto-indít, csak MEGLÉVŐ sessionbe injektál — de ugyanannak a családnak a tagja) | **(c) bezárandó/átkötendő** | Lásd "chatSessionStarter.ts sorsa" alszakasz lent. |
| 12 | `pipeline/autoRestart.ts` `freshRestart()`/`checkAndRestart()`/`startAutoRestartScheduler()` (134-158, 287-310. sor) | `killSession` + `newSession` + `sendKeys('claude --model <model>')` — MEGLÉVŐ priority-session (pl. conductor) periodikus, tervezett "friss újraindítása" | `env.ENABLE_AUTO_RESTART` (ma `false` a `.env.dev`-ben) — DE a scheduler `bootstrap/startup.ts`-ből `startAutoRestartScheduler(...)`-tal ténylegesen elindítható/indítva van, ha a flag élesben `true` | `control.routes.ts` importálja `stopAutoRestartScheduler`-t (emergency-stop), tehát a scheduler éles komponens, nem holt kód | **(c) bezárandó, a nightwatch-család testvéreként** | Lásd "A nightwatch-család kiterjesztése" alszakasz lent. |
| 13 | `pipeline/autonomousDev.ts` `coldStartConductor()`/`startAutonomousDevScheduler()` (283-317. sor) | `killSession` + `newSession` + `sendKeys('claude --model <model>')` + autonóm fejlesztési prompt injektálása — a conductor session "hidegindítása" | `env.ENABLE_AUTONOMOUS_DEV`, `bootstrap/startup.ts:297` `startAutonomousDevScheduler()` | ugyanaz a mintázat, mint #12 | **(c) bezárandó, a nightwatch-család testvéreként** | Lásd "A nightwatch-család kiterjesztése" alszakasz lent. |
| 14 | `pipeline/terminalReviewer.ts` `runTerminalReview()` (198-246. sor) | `kill-session` + `new-session` + `claude --model ${MODEL}` egy EFEMER `spaceos-review-<terminal>` sessionben, review-prompttal | Nincs `env.ENABLE_*` kapu a függvényen — csak a hívó (hiányzó) dönt | **ELLENŐRIZVE: nincs production hívó** a `src` alatt (kizárólag `__tests__/unit/terminalReviewerPipeline.test.ts` hívja `runDualTerminalReview`-t) | **jelenleg dead code, de KIFEJEZETT figyelmeztetéssel** | Lásd "terminalReviewer.ts sorsa" alszakasz lent. |

Emellett a szélesített keresés MEGERŐSÍTETTE, hogy a `pipeline/common.ts`
megosztott tmux-segédkönyvtárában (`newSession`/`killSession`/`sendKeys`/
`sendEnter`/`hasSession`/`tmux`/`listSessions`/`capturePane`) a 12 importáló
fájl közül **kizárólag `autoRestart.ts` és `autonomousDev.ts` hívja ténylegesen
a `newSession(`-t** (célzott `rg -n "newSession\(" knowledge-service/src`
kereséssel megerősítve) — a másik 10 fájl (`watchQueue.ts`, `watchInbox.ts`,
`taskEscalation.ts`, `watchResponse.ts`, `watchStuck.ts`,
`watchMcpHeartbeat.ts`, `watchIdle.ts`, `watchConductorProgress.ts`,
`messageRouter.ts`, és a `common.ts` maga) kizárólag `sendKeys`/`hasSession`/
`killSession`-t használ — vagyis üzenetet injektál egy MÁR FUTÓ sessionbe,
vagy leállít egyet, de ÚJAT NEM indít. Ez a megkülönböztetés dönti el, hogy
egy találat launch-mechanizmus-e (új `claude` process indítása) vagy sem
(meglévő session lekérdezése/vezérlése).

### `chatSessionStarter.ts` sorsa

Ez a mechanizmus MINŐSÉGILEG különbözik minden korábban tárgyalt találattól:
ez az EGYETLEN olyan launch-út, ami (a) gating NÉLKÜL, (b) mind emberi
csatornáról (Telegram), MIND agent-csatornáról (MCP-tool által indirekt
elérve) hívható, (c) egy MÁSIK terminál-identitás-fogalmat használ
(`spaceos-<terminal>-chat`, "chat session" — az ADR-060 CLI-agnosztikus
Telegram-architektúra dual-session mintája: külön "chat" és "work" session
ugyanahhoz a terminálhoz). Döntés: **(c) bezárandó mint közvetlen,
lease-mentes launch**, az alábbi feltételekkel:

1. Az ADR-060 dual-session mintája (chat session ≠ work session) ÉRVÉNYES
   design-elv marad — ezt ez az ADR NEM vonja vissza. A chat session
   feladata (gyors Telegram-válasz, munka DELEGÁLÁSA egy work sessionnek)
   nem azonos a queue-ból húzott task-végrehajtással.
2. DE a chat session INDÍTÁSA maga is átmegy egy egyszerűsített
   claim/registry-ellenőrzésen: a `startChatSession` a canonikus store-ban
   (ADR-078) regisztrál egy `chat-session` típusú, `(island_id,
   terminal_id)`-hez kötött aktív-rekordot — így két egyidejű Telegram-üzenet
   nem indíthat két versengő chat-tmux-sessiont ugyanarra a terminálra
   (ma ez a védelem KIZÁRÓLAG az `isChatSessionRunning` tmux-lekérdezésre
   támaszkodik, ami versenyhelyzetben — két egyidejű Telegram-üzenet — TOCTOU
   rés lehet: mindkét hívás "nem fut" választ kaphat, mielőtt bármelyik
   létrehozná a sessiont).
3. Az MCP-oldali `injectToChatSession` hívás (`session.tools.ts:118-119`)
   MEGMARAD változatlanul (ez ma sem auto-indít, csak meglévő sessionbe
   injektál) — nincs vele launch-authority probléma.
4. A `--dangerously-skip-permissions`-hez hasonló, jelenleg NEM használt,
   de a `claude --model haiku` argumentum-alak (nem `-p`) miatt a chat
   session INTERAKTÍV módban fut — ez ADR-082 hatályán KÍVÜL esik (az
   ADR-082 a NEM-interaktív, headless launch-szerződést definiálja); a
   chat session interaktív jellege tudatos, ADR-060 szerinti döntés, nem
   ezen ADR hatálya alá tartozó launch-bypass.

### A nightwatch-család kiterjesztése (`autoRestart.ts`, `autonomousDev.ts`)

Mindkettő STRUKTURÁLISAN azonos mintát követ, mint az 1. körben már lezárt
`watchInbox.ts`/`watchPriority.ts` pár: `env.ENABLE_*` flag mögötti,
`bootstrap/startup.ts`-ből ténylegesen elindított scheduler, ami
`killSession`+`newSession`+`sendKeys('claude --model ...')` hármassal
(újra)indít egy MEGLÉVŐ prioritás-session-t. Döntés: **(c) bezárandó,
ugyanazzal az indoklással, mint a nightwatch-család** —

1. `checkAndRestart`/`checkAndRestartAll` (autoRestart.ts) ÉS
   `coldStartConductor` (autonomousDev.ts) launch-hívása notification-only-ra
   szűkül: mindkettő "ez a session újraindítást/hidegindítást igényel"
   ESEMÉNYT tehet a queue-ba (egy erre szánt, magas prioritású, rendszer-
   generált task-message-box sorral, ADR-078), NEM hívhatja közvetlenül a
   `killSession`/`newSession`/`sendKeys` hármast.
2. A tényleges (újra)indítást a runner (ADR-081 2. pont) végzi, lease-claim
   után, a CLI-adapter-szerződésen (ADR-082) keresztül — nem tmux
   `send-keys`-en át `claude --model`-lel.
3. A `stopAutoRestartScheduler`/`stopAutonomousDevScheduler` (a
   `control.routes.ts` `/emergency-stop`-ból hívva) MEGMARAD — ezek
   LEÁLLÍTÓ, nem launch-műveletek, kívül esnek e pont hatályán.
4. Az ISL-013 implementálójának EXPLICIT feladata mindkét modult a
   `watchInbox.ts`/`watchPriority.ts` átalakításával AZONOS mintára hozni —
   ez az ADR név szerint nevesíti mindkettőt, hogy egy jövőbeli audit ne
   fedezze fel újra őket "meglepetésként".

### `terminalReviewer.ts` sorsa

`runTerminalReview`/`runDualTerminalReview` MA nincs production-oldali
hívó által elérve — ELLENŐRIZVE (`rg` a `src` alatt, `__tests__` kizárva:
nulla találat a hívásra). Döntés: **dokumentált dead code, explicit
figyelmeztetéssel, nem törlés**, mert:

1. A modul NEVE és célja ("review session egy tasknak") veszélyesen közel
   áll az ADR-079 `review_pending` állapotgép fogalmához — egy jövőbeli
   implementátor könnyen "megtalálhatja" és bekötheti ezt a modult a
   review-kapu megvalósításaként, ANÉLKÜL hogy tudná: ez egy tmux/exec-alapú,
   lease-t megkerülő, `claude --model` launcher, ami PONTOSAN azt a hibát
   reprodukálná, amit az ADR-081 megszüntetni igyekszik.
2. Explicit tilalom: **`terminalReviewer.ts` NEM köthető be a review-gate
   megvalósításába (ISL-013) a jelen launch-authority modell megkerülésével**
   — ha a review-workflow-nak szüksége van egy elkülönített, "friss szemmel"
   futó reviewer-sessionre, azt a CLI-adapter-szerződésen (ADR-082) és a
   lease-rétegen (ADR-079) keresztül, egy `review`-típusú task claimjeként
   kell megvalósítani, nem ennek a modulnak az újraélesztésével.
3. Ha az ISL-013/ISL-016 implementálója úgy dönt, hogy a modul véglegesen
   feleslegessé vált, törölhető — de ez explicit, dokumentált döntés legyen,
   ne hallgatólagos "megtalálom és felhasználom".

### Egyéb, a szélesített kereséssel megerősített, launch-authority hatályán KÍVÜLI kategóriák

Az alábbiak mind ELLENŐRIZVE (nem csak feltételezve) — MEGLÉVŐ sessionbe
való üzenet-injektálás, session-lekérdezés/leállítás vagy teljesen
launch-független `exec`/`db.exec` hívás, nem ÚJ agent-process indítás:

- **Üzenet-injektálás meglévő sessionbe** (nem launch): `telegram/
  multiBotManager.ts`, `telegram/telegramService.ts` (a `startChatSession`-t
  NEM hívó send-keys sorai), `conductor/contextSaturation.ts`, `pipeline/
  watchDone.ts`, `pipeline/messageRouter.ts`, `pipeline/telegramBot.ts`,
  `pipeline/common.ts` `sendKeys`/`sendEnter` — mind egy MÁR FUTÓ, konkrét
  célsessionbe (jellemzően `spaceos-conductor`) küldenek szöveget. Az
  ADR-079 review/completion állapotgépén kívüli, valós idejű
  agent-kommunikációs csatorna — más program-terület (federation/messaging),
  nem launch-authority.
- **`pipeline/telegramBot.ts` vs. `telegram/telegramService.ts`:** két,
  egymástól függetlennek tűnő, hasonló célú (Telegram → tmux send-keys)
  modul létezik a kódbázisban — ez egy ÚJ, a launch-authority-tól független
  gyanús duplikáció (hasonló SZIGET-09-stílusú drift, mint a
  terminálkonfig-fájloknál), de NEM launch-mechanizmus — nyitott kérdésként
  rögzítve (lásd lent), nem ezen ADR hatálya oldja fel.
- **Session-lekérdezés/-státusz** (nem launch): `terminalStatus.ts`,
  `sessionManager.ts` `has-session`/`capture-pane` hívásai, `pipeline/
  common.ts` `hasSession`/`listSessions`/`capturePane`/`tmux`.
- **Escalation-akció, session leállítás** (nem launch, de state-machine-
  releváns): `pipeline/taskEscalation.ts` `killSession` — egy stuck/timeout
  session megölése eszkaláció részeként. Ez konceptuálisan az ADR-079
  `blocked`/`dead_letter` átmenetéhez kapcsolódik (egy elakadt lease-t kellene
  lejárassa/fence-elje, nem csupasz tmux kill-t hívjon) — ISL-005/ISL-013
  implementálójának kell a taskEscalation logikáját a lease-fencing
  mechanizmusba integrálnia, nem ez az ADR dönti el a pontos átkötést,
  csak jelzi a kapcsolódást.
- **Nem-agent `exec`/`execSync` hívások** (teljesen launch-authority hatályán
  kívül, ELLENŐRIZVE): `pipeline/reviewer.ts` (`git status --porcelain`,
  `npx tsc --noEmit` — DONE-riport validáció), `pipeline/systemMetrics.ts`
  (`/proc/loadavg`, `free -m`, `df` — rendszer-metrika), `pipeline/
  channelCoordinator.ts` (`pgrep` — MÁS bot-processz életjel-ellenőrzése),
  `pipeline/epicNotifications.ts` (`ls` — fájllistázás), `pipeline/
  common.ts` `telegram()` (`curl` — Telegram API hívás, nem agent-launch).
  `pipeline/preReviewGate.ts` és `pipeline/immediatePipeline.ts`/`pipeline.ts`
  `exec`-importjai ELLENŐRIZVE: egyikük sem tartalmaz `claude`/tmux
  session-létrehozó mintát a teljes kimenetben (a szélesített `rg`-minta
  minden ilyen sztringet megtalált volna, ha jelen lenne bármelyik fájlban).
- **Hamis találatok** (nem `child_process`, hanem SQLite `Database.exec()`
  vagy `RegExp.exec()`, a mintakészlet `exec\(` ága miatt): `messageRegistry.
  ts`, `dispatch-control/tokenBudget.ts`, `dispatch-control/scheduledWindows.
  ts`, `workflowDb.ts`, `memoryStore.ts`, `sessionHooks.ts`, `retrospective.
  ts`, `task-message-box/store.ts`, `pipeline/agentMessages.ts`, `pipeline/
  epicRouter.ts`, `pipeline/memoryStore.ts`, `projects/checkpointStore.ts`,
  `telegram/conversationManager.ts` (mind `db.exec(...)`); `telegram/
  intentParser.ts`, `pipeline/ideaScan.ts`, `pipeline/planScan.ts` (mind
  `RegExp.prototype.exec(...)`).

### Nyilatkozat a lefedettségről — VISSZAVONVA (3. kör), CSERÉLVE (4. kör)

> **Ez a szakasz történeti okból marad a helyén, tartalma VISSZAVONVA.** Az
> itt korábban szereplő, regex-alapú "módszertanilag teljes" nyilatkozatot a
> 3. review-kör CÁFOLTA: a token-mintaillesztés elvileg sem képes lefedni az
> elnevezett-függvény-absztrakción át futó launch-utakat (a `startWorkSession`
> hívói — `subscriptionManager.ts`, `spawn_work_session` MCP tool,
> `taskEscalation.ts` 'restart' ág, `terminalReviewer.ts` `requestReview` —
> egyetlen korábbi mintában sem jelenhettek meg, mert a hívó helyen nincs
> `exec`/`spawn`/`tmux`/`claude` token). Az érvényes, hívásgráf-alapú
> lefedettségi nyilatkozatot lásd a következő szakasz végén: "Hívásgráf-alapú
> launch-audit (2026-07-21, 4. kör)" → "Új lefedettségi nyilatkozat
> (hívásgráf-alapú)".

## Hívásgráf-alapú launch-audit (2026-07-21, 4. kör)

### Tulajdonosi döntés (Gábor, 2026-07-21)

A 3. kör `blocked`-javaslatát tulajdonosi döntés oldotta fel (rögzítve a
TASK-ISL-001 taskfájl "Tulajdonosi döntés" szakaszában):

1. **Módszertan:** a launch-authority audit mostantól HÍVÁSGRÁF-ELEMZÉS a
   launch-képes függvények KIMENETI oldaláról — minden exportált,
   session-/CLI-indításra képes függvény teljes hívó-listájának iteratív
   bejárása a belépési pontokig —, NEM bemeneti oldali token-mintaillesztés.
2. **Kapuzási elv:** a `subscriptionManager.ts` automatikus
   checkpoint-launcha a launch authority mögé kapuzandó (a mechanizmus
   megmarad, a közvetlen indítási jog megszűnik: kérést ad fel, amit a
   lease/review/budget kapuk engednek át). Ugyanez az elv irányadó a
   `spawn_work_session` MCP toolra, a `taskEscalation.ts` 'restart' ágára
   és a `terminalReviewer.ts` `requestReview` exportjára is.

### Módszer

A kiindulás a `sessionStarter.ts` és `sessionManager.ts` TELJES
export-leltára, plusz minden egyéb, CLI-processzt közvetlenül indító
függvény (tmux `new-session` + `claude`-injektálás vagy `spawn`-alapú
levélcsomópontok, az előző körök leltárából és egy friss
`new-session|claude --model|claude -p` ellenőrző sweepből). Ezután MINDEN
launch-képes függvényre célzott `függvénynév(` keresés (Grep) adta az
összes hívót; ha egy hívó maga is exportált függvény, annak hívóit is
bejártam, egészen a belépési pontokig (HTTP route, MCP tool,
watcher/scheduler, bootstrap, pipeline-esemény, Telegram). Kiegészítő
ellenőrzések: re-export/barrel keresés (`export ... from` — 0 találat a két
fájlra), dinamikus importok (`import('...sessionStarter')` — 2 találat:
`session.tools.ts:197`, `terminalReviewer.ts:869`; `require(` — 0), és
HTTP-önhívás-sweep (`api/session|session/start|api/control/dispatch`), mert
a HTTP-önhívás a függvénynév-keresést is megkerülné (1 ilyen mechanizmus:
`watchInbox.ts`; a `control.routes.ts:581` `POST /windows/session/start`
ELLENŐRIZVE csak bookkeeping — `registerWindowSession` —, nem launch).

**5. kör kiegészítés (2026-07-21): esemény-emitter bejárási szabály.** A 4.
kör felülvizsgálata (REQUEST_CHANGES) kimutatta, hogy a hívó-bejárás a
launch-képes ESEMÉNYBUSZ-FOGYASZTÓKNÁL (konkrétan: `subscriptionManager`
`onAny` → `deliverNotification` → `startWorkSession`) az eseménynél
megállt, holott az eseménybusz szétcsatoló pont: a launch tényleges
kiváltói az esemény EMITTEREI. A módszertan ezért kötelező lépéssel bővül:
**ha egy launch-képes függvényt eseménybusz-listener hív, az adott
eseménytípus(ok) MINDEN emitterét fel kell deríteni (`pipelineEvents.emit`/
helper-emitterek, pl. `emitOutboxEvent`), és az emitterek hívóit ugyanúgy
be kell járni a belépési pontokig; a fájlrendszer-watcher (chokidar) szintén
ilyen szétcsatoló él — ott a figyelt fájlokat ÍRÓ komponensek a kiváltók.**
Az ehhez futtatott keresések: `pipelineEvents.emit|emitOutboxEvent(|
emitPipelineEvent(|emitNightwatchCycle(` (emitterek); `pipelineEvents.on|
pipelineEvents.onAny|inboxEvents.emit|inboxEvents.on|mailboxEvents.on|
mailboxEvents.emit` (fogyasztók); `extends EventEmitter|new EventEmitter`
(minden busz-példány felderítése: `pipelineEvents` — `eventBus.ts:108`,
`inboxEvents` — `inboxWatcher.ts:30`, `mailboxEvents` —
`mailbox.routes.ts:26`; több nincs); célzott hívó-bejárás:
`handleTaskCompletion(`, `completeTaskForMcp(`, `startDispatcher(`. A
HTTP-önhívás-sweep mintája ennek megfelelően bővült
(`api/subscriptions`/`emitOutboxEvent`). Eredmény: lásd a leltártábla
21-24. sorát és az "5. kör: esemény-emitter-oldali bejárás" alszakaszt.

**Export-leltár.** `sessionStarter.ts` (9 export): `getInjectedMessages`,
`buildEscalatedPrompt` (251, prompt-segédek, nem launch),
`terminateColdSession` (336, csak leállít), `startTerminalSession` (790,
LAUNCH: 989/1009), `startWorkSession` (1116, LAUNCH: 1178/1184),
`generateWorkerId` (1251, nem launch), `startParallelWorkSession` (1264,
LAUNCH: 1299), `spawnRawWorkers` (1327, LAUNCH: 1343), `collectRawResults`
(1370, eredmény-olvasó, nem launch). `sessionManager.ts` (9 export):
`getSessionStatus` (171), `getAllSessionsStatus` (184), `startSession`
(191, LAUNCH: 252 `tmux new-session` + 257-261 `claude --model`),
`injectPrompt` (322, csak send-keys), `wakeUpTerminal` (424, TRANZITÍV
LAUNCH: 439 → `startSession`), `getSessionLogs` (450), `getControllable`
(482), `stopSession` (515), `stopAllSessions` (628). A két fájlon kívüli
launch-levélcsomópontok: `chatSessionStarter.ts` `startChatSession` (137;
165/207), `pipeline/common.ts` `newSession` (186; 189), `pipeline/
autoRestart.ts` `freshRestart` (134; 147/154), `pipeline/autonomousDev.ts`
`coldStartConductor` (283; 301/305), `pipeline/terminalReviewer.ts`
`runTerminalReview` (198; 225/229) és `requestReview` (808; 869-871 →
`startWorkSession`), `runner/sessionLauncher.ts` `SessionLauncher.launch`
(68; `claude -p` spawn). A `codegen/frontendVerify.ts`/`codegenEngine.ts`
`spawn()` hívásai továbbra is hatályon kívül (build-subprocess, 1. kör #1-2).

### Kimerítő belépésipont-leltár (belépési pont → hívási lánc → launch-függvény)

| # | Belépési pont (fájl:sor) | Hívási lánc (fájl:sor) | Launch-függvény | Kapu |
|---|---|---|---|---|
| 1 | Bootstrap, FELTÉTEL NÉLKÜL: `bootstrap/startup.ts:192-193` (`startInboxWatcher` + `setupInboxWatcherBridge`) | `startup.ts:123` `inboxEvents.on('inbox_change')` → `startup.ts:153` | `startTerminalSession` (`sessionStarter.ts:790`) | nincs `ENABLE_*` (csak `shouldWakeUp` busy-check) |
| 2 | Bootstrap, FELTÉTEL NÉLKÜL: `startup.ts:375` (`subscribeToAllCheckpoints`) + singleton `subscriptionManager.ts:457` — **ez a LISTENER-oldal; a kiváltó `outbox:*`-emitter-belépéseket lásd #21-24 (5. kör)** | konstruktor `:80-82` → `attachToEventBus` `:384-385` (`pipelineEvents.onAny`) → `findMatchingSubscriptions` `:386` → `deliverNotification` `:205` → `:224` (`outbox:done`/`outbox:blocked` eseményre) | `startWorkSession` (`sessionStarter.ts:1116`) | NINCS kapu |
| 3 | Nightwatch-scheduler: `startup.ts:231-233` → `nightwatch.ts:135/44` | `nightwatch.ts:51` → `watchPriority.ts:37` | `startTerminalSession` | `ENABLE_NIGHTWATCH` |
| 4 | **[ÚJ]** Nightwatch: `nightwatch.ts:54` → `watchDone.ts:142` | `watchDone.ts:164-165` (`USE_TERMINAL_REVIEW`, azaz `env.REVIEW_MODE !== 'api'`) → `handleTerminalReview` (`terminalReviewer.ts:722`) → `:757/:762` `runDualTerminalReview` (`:500`) → `:516-517`, ill. `runLightReview` (`:427`) → `:441` → `runTerminalReview` (`:198`) | tmux `new-session` + `claude --model` (`terminalReviewer.ts:225/229`) | `ENABLE_NIGHTWATCH` + `REVIEW_MODE` (default: `terminal` → **default-on ÉLŐ**, `env.ts:132`) |
| 5 | Nightwatch: `nightwatch.ts:63` → `watchInbox.ts` | HTTP-önhívás: `watchInbox.ts:126` `POST /api/session/inject`, `:179` `POST /api/session/start` → `session.routes.ts:30/50` | `startSession`, `injectPrompt` | `ENABLE_NIGHTWATCH` |
| 6 | Nightwatch: `nightwatch.ts:84` → `taskEscalation.ts:393` (`watchTaskEscalations`) | `:431/:435` `handleTimeout` → retry `'restart'` ág `:182-215` → `:202` | `startWorkSession` | `ENABLE_NIGHTWATCH` |
| 7 | HTTP `POST /api/session/start` (`session.routes.ts:22-35`, mount: `app.ts:226-227`) | `session.routes.ts:30` | `startSession` (`sessionManager.ts:191`) | `requireRootForMutations` |
| 8 | HTTP `POST /api/session/wake` (`session.routes.ts:67`) | → `wakeUpTerminal` (`sessionManager.ts:424`) → `:439` | `startSession` | `requireRootForMutations` |
| 9 | HTTP `POST /api/control/dispatch` (`control.routes.ts:262-315`) | `:290` | `startSession` | `requireRootForMutations` + `task-audit/auth.ts` |
| 10 | **[ÚJ]** HTTP `POST /api/autonomous/trigger` (mount: `app.ts:195`; router: `autonomousDev.ts:543`, handler `:575-583`) | `triggerManualCycle` (`:534-535`) → `runAutonomousCycle` (`:328`) → `:399` → `coldStartConductor` (`:283`) | `newSession` + `sendKeys('claude --model …')` (`autonomousDev.ts:301/305`) | `requireRootForMutations`; az `ENABLE_AUTONOMOUS_DEV` flaget MEGKERÜLI (a `triggerManualCycle` nem ellenőrzi `config.enabled`-et); egyedüli belső fék a controlMode (`manual`/`hybrid` skip, `:338/:350`) — defaultja `'autonomous'` (`env.ts:123`), ÉS a `POST /api/autonomous/mode` (`:557`) átállíthatja |
| 11 | HTTP `POST /api/autonomous/start` (`autonomousDev.ts:586-589`) | `startAutonomousDevScheduler` (`:431`, `config.enabled` ellenőrzéssel `:432`) → mint #18 | `coldStartConductor` | `requireRootForMutations` + `ENABLE_AUTONOMOUS_DEV` |
| 12 | MCP tool `spawn_work_session` (`session.tools.ts:150-219`; regisztráció: `tools/index.ts:41`) | hívó-ellenőrzés `:182-184` (csak root/conductor) → dinamikus import `:197` → `:198` | `startWorkSession` | MCP-token + root/conductor szerep; NINCS lease |
| 13 | MCP tool `spawn_parallel_workers` (`worker.tools.ts:105`; regisztráció: `tools/index.ts:46`) | `:105` | `startParallelWorkSession` (`sessionStarter.ts:1264`) | MCP-token |
| 14 | MCP tool `spawn_raw_workers` (`worker.tools.ts:181`) | `:181` | `spawnRawWorkers` (`sessionStarter.ts:1327`) | MCP-token |
| 15 | Telegram multi-bot polling: `startup.ts:357-358` (`startAllBots`) | `multiBotManager.ts:265` `pollBot` → `:274` `handleMessage` → `:228-233` közvetlen `startChatSession`, ÉS `:255` `injectTelegramWithContext` (`chatSessionStarter.ts:306`) → `:316` | `startChatSession` (`chatSessionStarter.ts:137`; launch: `:165/:207`) | `ENABLE_MULTI_BOT` |
| 16 | **[ÚJ belépés]** HTTP `POST /api/telegram/webhook` (mount: `app.ts:193` — NEM root-gated; router: `telegramBot.ts:642`, webhook-secret check `:651`) | `processWebhookUpdate` (`telegramBot.ts:439`) → `:519-525` → `injectTelegramMessageToTerminal` (`telegramService.ts:192`) → `:205-207` auto-start | `startChatSession` | webhook-secret (fallback default: `env.ts:245-246`) |
| 17 | Auto-restart scheduler: `startup.ts:249-251` | `autoRestart.ts:287` (`startAutoRestartScheduler`) → `:298` `checkAndRestartAll` (`:253`) → `:259` `checkAndRestart` (`:181`) → `freshRestart` (`:134`) | `newSession` + `sendKeys('claude --model …')` (`autoRestart.ts:147/154`) | `ENABLE_AUTO_RESTART` |
| 18 | Autonomous-dev scheduler: `startup.ts:296-297` | `autonomousDev.ts:431` → `:452/:466` `runAutonomousCycle` → `:399` `coldStartConductor` | `newSession` + `sendKeys` | `ENABLE_AUTONOMOUS_DEV` (+ controlMode) |
| 19 | Runner (KÜLÖN processz): `scripts/runner-start.mjs` → `runner/main.ts:72/17` | `main.ts:30-32` `startPollLoop` → `pollLoop.ts:66` `deps.launch` → `sessionLauncher.ts:68` | `SessionLauncher.launch` (`claude -p` spawn) | runner-token + busy-gate — **ez maga a célzott (a) út** |
| 20 | (HOLT) `terminalReviewer.ts` `requestReview` (`:808`) | dinamikus import `:869` → `:871` — production hívó NINCS (kizárólag `__tests__/unit/terminalReviewerPipeline.test.ts`; a regisztrált `request_review` MCP tool `createTask`-ot hív, nem ezt) | `startWorkSession` | — (elérhetetlen) |
| 21 | **[ÚJ, 5. kör]** HTTP `POST /api/subscriptions/test-trigger` (`routes/subscriptionRoutes.ts:176-197`; mount: `app.ts:243` — `requireRootForMutations` NÉLKÜL, csak a globális `apiAuthGate`, `app.ts:185`) | `:185` `emitOutboxEvent(eventType, terminal, messageId, …)` — az `eventType` default `'outbox:done'` (`:177`), `terminal`/`messageId` a kérés törzséből → `eventBus.ts:127-134` `pipelineEvents.emit` → #2 lánca → `subscriptionManager.ts:224` | `startWorkSession` | `apiAuthGate` (`AUTH_MODE=required`: BÁRMELY érvényes token, nem csak root; `open`: no-op) — auth-hiány: ADR-080 hatály |
| 22 | **[ÚJ, 5. kör]** HTTP `POST /api/epic-router/task/:terminal/complete` (`epic-router.routes.ts:334`; mount: `app.ts:270`) | → `handleTaskCompletion` (`pipeline/epicRouter.ts:487`) → `:513` `emitOutboxEvent('outbox:done', …)` → #2 lánca | `startWorkSession` | `requireTerminalAuth` (terminál-token, NEM root) |
| 23 | **[ÚJ, 5. kör]** MCP tool `complete_task` (`mailbox.tools.ts:536-538`) | `:574` `completeTaskForMcp` (`epic-router.routes.ts:782`) → `:799` `handleTaskCompletion` → `epicRouter.ts:513` `emitOutboxEvent` → #2 lánca | `startWorkSession` | MCP-token (bármely terminál) — ez az ADR-053 szerinti SZÁNDÉKOLT checkpoint-lánc: task-completion → feliratkozott checkpoint → következő munka indítása |
| 24 | **[ÚJ, 5. kör — kategória-út]** Fájlrendszer: bármely komponens, amely `done`/`blocked` típusú outbox `.md`-t ír (agent CLI-sessionök; `task-message-box/store.ts` `renderMessageToFile` projekció; mailbox HTTP-útvonalak — `mailbox.routes.ts:162` `done_submitted` ága; federation-kézbesítés) | chokidar (a FELTÉTEL NÉLKÜLI `startInboxWatcher`, `startup.ts:192`) → `inboxWatcher.ts:217` `handleOutboxChange` → `:290` (`outbox:done`) / `:300` (`outbox:blocked`) `emitOutboxEvent` → #2 lánca | `startWorkSession` | nincs (a watcher feltétel nélküli; az írók köre nyílt) |
| 25 | (ALVÓ) `pipeline/projectDispatcher.ts` `processProjectDone` (`:263-269`) → `handleTaskCompletion` → `epicRouter.ts:513` | a dispatcher indítója, a `startDispatcher` (`projectDispatcher.ts:702`) production hívó NÉLKÜLI (Grep: 0 találat a definíción kívül) — a lánc jelenleg nem élő | (`startWorkSession`, tranzitívan) | — (nem indított komponens) |

Nem-launch, ellenőrzött csomópontok (a hívó-listákban egyik launch-függvény
hívójaként sem jelentek meg): `terminateColdSession` (csak kill,
`epic-router.routes.ts:37` hívja), `injectPrompt`/`injectToChatSession`
(csak send-keys meglévő sessionbe), `watchStuck`/`watchIdle`/
`watchMcpHeartbeat`/`watchQueue`/`watchResponse`/`watchGoals`/
`watchConductorProgress`/`messageRouter`/`heartbeat`/`rootMonitor` (nudge/
státusz), `POST /api/control/windows/session/start` (bookkeeping),
`bestOfN.ts` (kiértékelés, az `injectPrompt` paramétere DI-injektált,
worker-eredmény-válogatás).

### ÚJ, korábban nem dokumentált megállapítások (KIEMELT)

1. **A `terminalReviewer.ts` "dead code" minősítése TÉVES volt (#4 út).** A
   2-3. kör kizárólag a `runTerminalReview`/`runDualTerminalReview`/
   `requestReview` hívóit kereste, a fájl HARMADIK exportját, a
   `handleTerminalReview`-t (722. sor) nem — azt viszont a
   `pipeline/watchDone.ts:165` ÉLŐBEN hívja a nightwatch-ciklusból, és a
   `USE_TERMINAL_REVIEW` kapu defaultja bekapcsolt (`REVIEW_MODE` default:
   `'terminal'`, `env.ts:132`). Vagyis a tmux+`claude --model` alapú
   reviewer-launch (`runTerminalReview`) NEM holt kód, hanem az
   ENABLE_NIGHTWATCH mögött default-on futó, lease-mentes launch-út. A
   Döntés 14. pontja ennek megfelelően KORRIGÁLVA.
2. **`POST /api/autonomous/trigger` (#10 út):** a `/api/autonomous` router
   (mount: `app.ts:195`) `trigger` végpontja az `ENABLE_AUTONOMOUS_DEV`
   flag MEGKERÜLÉSÉVEL, root-tokennel azonnali conductor-hidegindítást tud
   kiváltani (`triggerManualCycle` nem ellenőrzi a flaget; a controlMode
   default `'autonomous'`, és a `/mode` végponttal át is állítható). A
   korábbi körök csak a scheduler-utat (flag mögött) dokumentálták.
3. **`POST /api/telegram/webhook` (#16 út):** a korábbi körök a
   `pipeline/telegramBot.ts`-t "inject MEGLÉVŐ sessionbe" kategóriába
   sorolták — de a hívott `injectTelegramMessageToTerminal`
   (`telegramService.ts:205-207`) auto-startol (`startChatSession`), tehát
   a webhook-végpont TRANZITÍVAN launch-képes, ráadásul nem a root-token,
   hanem csak a webhook-secret védi (amelynek hardcodolt fallback-defaultja
   van, `env.ts:245-246`).

### 5. kör (2026-07-21): esemény-emitter-oldali bejárás — a 4. kör REQUEST_CHANGES javítása

A 4. kör felülvizsgálata (független reviewer) egy be nem sorolt utat talált:
`POST /api/subscriptions/test-trigger` → `emitOutboxEvent` → eseménybusz →
`subscriptionManager` → `startWorkSession`. A hiba oka: a #2 út belépési
pontjaként csak a listener-oldali bootstrap-attach volt számbavéve, az
`outbox:*` események EMITTEREI nem. Az 5. kör ezt pótolta, kimerítően:

- **Az eseménybusz (`pipeline/eventBus.ts`) teljes eseménytípus-készlete**
  (16 típus, `:16-33`) közül a `subscriptionManager.deliverNotification`
  KIZÁRÓLAG `outbox:done`/`outbox:blocked` esetén indít sessiont (`:220`
  feltétel) — minden más típus (inbox:*, session:*, review:*, alert:*,
  response:routed, nightwatch:cycle, cache:invalidated) legfeljebb
  SSE/Telegram-értesítést vált ki, launch-ot nem.
- **Az `outbox:done|blocked` MINDEN emitterének bejárása** (Grep:
  `emitOutboxEvent(` + `pipelineEvents.emit`): 3 emitter-hely →
  `routes/subscriptionRoutes.ts:185` (HTTP, #21),
  `inboxWatcher.ts:290/300` (`handleOutboxChange`, `:217` — fájlrendszeri
  szétcsatolás, #24), `pipeline/epicRouter.ts:513` (`handleTaskCompletion`,
  `:487`). Ez utóbbi hívói: `epic-router.routes.ts:334` (HTTP, #22),
  `epic-router.routes.ts:799` ← `mailbox.tools.ts:574` (MCP `complete_task`,
  #23), `projectDispatcher.ts:265` (ALVÓ — a `startDispatcher`-nek nincs
  hívója, #25).
- **A többi busz-fogyasztó launch-mentessége ellenőrizve:**
  `pipelineEvents.onAny` további fogyasztói — `pipeline/epicNotifications.ts:337`
  (Telegram-értesítés, nem launch) és `interfaces/http/routes/
  pipeline.routes.ts:47` (SSE-stream, nem launch); `inboxEvents` egyetlen
  fogyasztója a `startup.ts:123` bridge (= a leltár #1 útja; emitter:
  `inboxWatcher.ts:197` `handleInboxChange` — a kiváltók itt is a
  fájlrendszeri ÍRÓK: inbox `.md`-t író komponensek, pl. a task-message-box
  projekció, a mailbox HTTP-útvonalak — `mailbox.routes.ts:125` —, a
  `session.tools.ts:103` `request_work_session` közvetlen
  conductor-inbox-írása, federation-kézbesítés — mind a #1 út (b)
  kapuzási döntése alá tartozó kiváltók); `mailboxEvents`
  (`mailbox.routes.ts:26`) fogyasztói kizárólag SSE-kézbesítők, launch-képes
  listener NINCS rajta → (c) csak-ébresztő. Más EventEmitter-példány a
  `src`-ben nincs (`extends EventEmitter|new EventEmitter`: 3 találat, mind
  fent).

**Az 5. kör érdemi többlete a reviewer leletén túl:** a #22 (HTTP
`/api/epic-router/task/:terminal/complete`, terminál-tokennel — nem
root!) és a #23 (MCP `complete_task`, bármely terminál) utak szintén a
`subscriptionManager` launchát váltják ki — a #23 ráadásul az ADR-053
szerinti SZÁNDÉKOLT automatizmus fő útja (task-completion → checkpoint →
következő session), vagyis a kapuzási döntés (16. pont) nem mellékes
teszt-végpontot, hanem a rendszer központi munkafolyam-élét érinti; a
kapuzás UTÁN ez az él a queue-ba feladott kérésként él tovább. A #25
(projectDispatcher) alvó, de ha valaki a `startDispatcher`-t beköti, a #2
lánc negyedik emitterévé válik — explicit figyelmeztetésként rögzítve.

### Osztályozás a tulajdonosi döntés (a)–(d) kategóriái szerint

| Kat. | Jelentés | Utak (a fenti tábla #-ai) |
|---|---|---|
| (a) legitim, kapuzott út | a queue+lease launch authority megvalósítása | #19 (runner: poll → busy-gate → `SessionLauncher.launch`; a lease-réteg rákötése ISL-004/005 feladata) |
| (b) KAPUZANDÓ | a mechanizmus megmarad, a közvetlen indítási jog megszűnik: kérést ad fel a launch authority-nak (queue+lease), amely lease/review/budget kapukon engedi át | #1 (inboxWatcher-bridge), #2 (**subscriptionManager — a tulajdonosi döntés névvel nevesített esete**), #3 (watchPriority), #4 (**watchDone→terminalReviewer — ÚJ**), #5 (watchInbox HTTP-önhívás), #6 (**taskEscalation 'restart' — a tulajdonosi döntés 3. pontja**), #9 (`/dispatch` — korábbi (c) döntés fenntartva: claim-endpointra fordul), #10-11 (**`/api/autonomous` — ÚJ**), #12 (**`spawn_work_session` — a tulajdonosi döntés 3. pontja**), #13-14 (worker-toolok, a korábbi 3 feltétel — store-regisztráció, budget-kapu, közös completion-állapotgép — fenntartva), #15-16 (chatSessionStarter-család: registry-kapu, ADR-060 dual-session elv marad; a webhook-belépés auth-kérdése ADR-080 hatálya), #17-18 (autoRestart/autonomousDev schedulerek, nightwatch-mintára), #21-24 (**az 5. körben feltárt `outbox:*`-emitter-belépések — mind a #2 subscriptionManager-kapuzás [16. pont] kiváltói**: a #21 `test-trigger` nem-root elérhetősége ADR-080 hatály, és a kapuzás után is legfeljebb queue-feladást válthat ki; a #22-23 a szándékolt checkpoint-munkafolyam — kapuzás után queue-feladás; a #24 fájlrendszeri író-kategória a watcher notification-only szűkítésével együtt zárul) |
| (b) speciális: operátori override | megmarad közvetlen útként, de auditnaplóval + opcionális claim-integrációval (a korábbi 4 kötelező feltétel változatlan) | #7, #8 (`session.routes.ts` `/start`, `/wake`) |
| (c) csak-ébresztő / dokumentált bekötés-tilalmas | jelzést adhat, launch-jogot soha | SSE/mailbox-notification (`startup.ts:136-147`), runner SSE-listener (`main.ts:39-53` — kizárólag `loop.wake()`); bekötés-tilalom: `requestReview` (lásd (d)) |
| (d) holt/elérhetetlen | nincs élő hívó | #20 (`requestReview` — dokumentált holt kód, EXPLICIT bekötési tilalommal: ha a `request_review` MCP toolt valaki "befejezi", azt a launch authority-n keresztül kell tennie, nem e függvény élesztésével); #25 (`projectDispatcher` `startDispatcher`-ág — ALVÓ, nincs indítója; bekötése esetén a #2 lánc emitterévé válna, ezért csak a 16. pont kapuzása UTÁN élesíthető) |

### Új lefedettségi nyilatkozat (hívásgráf-alapú)

A lefedettség állítása a következő, ellenőrizhető lépéseken alapul (nem
token-mintaillesztésen): (1) a `sessionStarter.ts` és `sessionManager.ts`
MIND a 18 exportja felsorolva és minősítve (launch / tranzitív launch /
nem-launch); (2) re-export (barrel) és `require()` a két fájlra: 0 találat;
dinamikus `import()`: 2 találat, mindkettő a leltárban; (3) a
CLI-processz-indító levélcsomópontok friss `new-session|claude --model|
claude -p` sweeppel ellenőrizve — minden találat a leltár valamelyik
sorához tartozik; (4) mind a 13 launch-képes függvényre teljes hívó-lista
készült célzott `név(` kereséssel, és minden hívó lánca fel lett járva a
belépési pontig; (5) a függvénynév-keresést is megkerülő
HTTP-önhívás-kategória külön sweeppel ellenőrizve (1 ilyen út: #5); (6) —
**5. kör kiegészítés** — minden eseménybusz-fogyasztóhoz, amely
launch-képes függvényhez vezet, az adott eseménytípusok ÖSSZES emittere
fel lett derítve és a belépési pontokig bejárva (az `outbox:done|blocked`
3 emitter-helye → 3 élő HTTP/MCP-belépés + 1 fájlrendszeri író-kategória +
1 alvó ág; a `src` mindhárom EventEmitter-példánya — `pipelineEvents`,
`inboxEvents`, `mailboxEvents` — fogyasztó-oldalról is ellenőrizve, más
launch-képes listener nincs). **Összesen: 22 nevesített élő belépési út +
1 fájlrendszeri kategória-út (#24) + 1 holt (#20) + 1 alvó (#25).**
Maradék ismert korlát: a hívásgráf kézi (Grep-alapú) bejárás, nem
TypeScript-AST-eszközzel generált — egy jövőbeli (ISL-016/017)
automatizált reachability-ellenőrzés ezt gépi garanciává erősítheti;
valamint a `knowledge-service/src`-n kívüli indítók (systemd, külső
scriptek) a 3. kör 6. pontja szerint ellenőrizve nulla találattal, de a
scope-határ fenntartása üzemeltetési fegyelem kérdése marad.

## Döntés

1. **A queue+lease réteg (ADR-079) MAGA az egyetlen launch authority.**
   Semmilyen komponens nem indíthat CLI-sessiont anélkül, hogy előbb
   sikeresen NEM claimelt volna egy lease-t. Az `inboxWatcher.ts`
   `startTerminalSession`-hívása és a `watchInbox.ts` nudge-alapú indítása
   mint LAUNCH-mechanizmus **megszűnik** — a fájlrendszeri esemény és az SSE
   (a meglévő `sseListener.ts` mintájára) ezután KIZÁRÓLAG ébresztő
   jelzésként maradhat ("valami változott, pollolj most"), sosem hívhat
   session-indítást közvetlenül. Ez zárja le a dokumentált
   `ENABLE_INBOX_WATCHER` rést — nem a kapcsolót kötjük be, hanem a
   közvetlen indítási útvonalat szüntetjük meg.
2. A runner (`src/runner/`) válik az EGYETLEN launch authority
   megvalósítójává `(island_id, terminal_id)` páronként: lease-claim
   (ADR-079) → CLI-adapter indítás (ADR-082). A jelenlegi processzlokális
   `SessionLauncher.active` Map busy-gate MEGMARAD másodlagos, olcsó,
   in-process védelemként (defense in depth), de nem az igazságforrás — az
   a szerveroldali lease.
3. **Review-kapu:** a `running → completed` átmenet review-köteles
   tasktípusnál TILOS közvetlenül; kizárólag `review_pending → completed`
   (reviewer jóváhagyás) — ezt az állapotgép (ADR-079) már kikényszeríti,
   ez az ADR csak megerősíti, hogy ez MINDEN launch-útvonalra vonatkozik,
   kivétel nélkül.
4. **Budget-kapu:** a token-/időbüdzsé-ellenőrzés (`terminals.yaml
   token_budgets`) a `queued → leased` CLAIM előfeltétele, nem egy
   utólagos, csak kontroll-API-n élő ellenőrzés — a claim query budget-
   alkalmassági feltételt is tartalmaz, vagy a sikeres claimet azonnali
   budget-ellenőrzés követi, ami visszavonhatja a claimet, ha túllépés
   történt.
5. **Dependency-kapu:** egy task, aminek `task_dependencies` (ADR-078) sora
   nincs teljesítve, NEM claimelhető — a `queued` állapotba kerülés maga
   függ a függőségek feloldódásától, vagy a claim-lekérdezés kifejezetten
   kiszűri a függő tételeket. A `workerRegistry.ts` memóriabeli logikája
   ezzel feleslegessé válik és kivezetendő (ADR-078).
6. **tmux-alapú `sessionStarter.ts` sorsa:** ELVETVE mint a launch
   kizárólagos mechanizmusa. A CLI-adapter-szerződés (ADR-082) saját
   process-/PTY-életciklust definiál (elsősorban headless stdio, PTY csak
   ha egy adapter ezt ténylegesen megköveteli) — ez váltja fel az
   univerzális "egy tmux session terminálonként" mintát. A tmux MARADHAT
   operátori kényelmi eszközként manuális beavatkozáshoz, DE nincs benne
   az automatizált launch-szerződésben.
7. **`pipeline/watchPriority.ts` (a nightwatch-család tagja):** explicit
   megnevezve — notification-only szerepre szűkül, ugyanúgy, mint a
   `watchInbox.ts` (1. pont); a "hiányzó priority session" észlelése
   megmarad, de a taskot a queue-ba teszi, nem indítja közvetlenül.
8. **`session.routes.ts` (`POST /api/session/start|inject|wake|stop|
   stop-all`):** MEGMARAD mint explicit, root-only, auditnaplózott
   operátori override — NEM a lease-rétegen megy keresztül, de nem is
   "elfelejtett" bypass: lásd a fenti "Operátori manuális
   session-vezérlés" alszakasz 4 kötelező kiegészítését.
9. **`control.routes.ts` `POST /dispatch`:** MEGSZŰNIK mint közvetlen
   `startSession`-hívás — a claim-endpointra (ADR-079) fordítandó át; lásd
   a fenti "`POST /api/control/dispatch`" alszakasz.
10. **`spawn_parallel_workers`/`spawn_raw_workers` MCP toolok:** MEGMARAD
    mint explicit, agent-kezdeményezett ad hoc worker-indítás, a fenti
    "Agent-kezdeményezett ad hoc workerek" alszakasz 3 feltételével
    (canonikus store-regisztráció, egységes budget-kapu, közös
    completion-állapotgép).
11. **`codegen/frontendVerify.ts`/`codegenEngine.ts` `spawn()` hívásai:**
    EXPLICIT KÍVÜL a launch-authority hatályán — build/verify subprocessek,
    nem agent-CLI sessionök, nincs island/terminal-identitásuk és nem
    érintik a task-message-box-ot. Ez tudatos hatálykizárás, nem hiány.
12. **`chatSessionStarter.ts` `startChatSession`:** MEGSZŰNIK mint gating
    nélküli, közvetlen tmux/`claude --model` launch — a chat-session
    indítás egy egyszerűsített registry-bejegyzésen (ADR-078) megy
    keresztül, hogy két egyidejű Telegram-üzenet ne indíthasson versengő
    sessiont (lásd fenti "chatSessionStarter.ts sorsa" alszakasz). Az
    ADR-060 dual-session (chat ≠ work) elve ÉRVÉNYBEN marad.
13. **`pipeline/autoRestart.ts` és `pipeline/autonomousDev.ts`:** MEGSZŰNNEK
    mint közvetlen `killSession`+`newSession`+`sendKeys('claude --model
    ...')` launch-utak — a nightwatch-családdal (`watchInbox.ts`,
    `watchPriority.ts`) AZONOS mintára, notification-only szerepre
    szűkülnek (lásd fenti "A nightwatch-család kiterjesztése" alszakasz).
14. **`pipeline/terminalReviewer.ts` — KORRIGÁLVA a 4. körben:** a korábbi
    "dead code" minősítés TÉVES volt — a `handleTerminalReview` exportot a
    `watchDone.ts:165` élőben hívja (nightwatch-ciklus, `REVIEW_MODE`
    default `terminal` mellett default-on aktív), és ezen keresztül a
    tmux+`claude --model` alapú `runTerminalReview` ÉLŐ, lease-mentes
    launch-út. Döntés: **(b) KAPUZANDÓ** — a review-session-igény a launch
    authority-nak feladott kérés lesz (`review`-típusú task claimje,
    ADR-079/ADR-082 szerint), a `runTerminalReview` közvetlen tmux-launcha
    megszűnik. A fájl MÁSIK, valóban holt launch-exportjára
    (`requestReview`) a korábbi bekötési tilalom változatlanul érvényes
    (lásd a hívásgráf-audit (d) kategóriáját).
15. **`pipeline/taskEscalation.ts` `killSession`-alapú escalation:**
    ISL-005/ISL-013 hatálya alatt integrálandó az ADR-079 lease-fencing
    mechanizmusába (egy elakadt task megölése lease-lejáratként/
    dead-letterként kezelendő, nem csupasz tmux-kill-ként) — nyitott
    implementációs kérdésként rögzítve, nem ez az ADR dönti el a pontos
    átkötést.
16. **`pipeline/subscriptionManager.ts` automatikus checkpoint-launch
    (tulajdonosi döntés, 2026-07-21):** a mechanizmus (checkpoint-esemény →
    munka-indítás) MEGMARAD, de **(b) KAPUZANDÓ** — a `deliverNotification`
    `startWorkSession`-hívása (`:224`) megszűnik közvetlen launchként;
    helyette a checkpoint-trigger egy magas prioritású, rendszer-generált
    task-message-box bejegyzést (ADR-078) ad fel, amit a launch authority
    lease/review/budget kapukon át hajt végre. A `subscribeToAllCheckpoints`
    bootstrap-bekötése (`startup.ts:375`) így ébresztő/feladó szereppé
    szelídül.
17. **`spawn_work_session` MCP tool (tulajdonosi döntés levezetett elve):**
    a root/conductor-korlátozás önmagában NEM elég — a tool **(b)
    KAPUZANDÓ**: a `startWorkSession` közvetlen hívása helyett a launch
    authority-nak ad fel kérést (a meglévő `logWorkSessionSpawn` audit-napló
    megmarad, a store-regisztráció + budget-kapu a worker-toolokkal azonos
    feltételekkel).
18. **`pipeline/taskEscalation.ts` 'restart' ága (tulajdonosi döntés
    levezetett elve):** a 3. kör kimutatta, hogy ez nem csak kill, hanem
    teljes értékű, lease-mentes újraindítás is (`:202` `startWorkSession`).
    Döntés: **(b) KAPUZANDÓ** — az escalation a restart-igényt a queue-ba
    teszi (retry-task), a tényleges újraindítást a launch authority végzi;
    a kill-oldal a 15. pont szerinti lease-fencing-integrációval együtt
    kezelendő.
19. **`POST /api/autonomous/trigger` és `POST /api/telegram/webhook` (a 4.
    kör ÚJ találatai):** az `/api/autonomous` router launch-képessége (a
    flag-et megkerülő `trigger` végpont) az autonomousDev 13. pont szerinti
    notification-only átállásával együtt szűnik meg (a `trigger` ezután a
    queue-ba ad fel conductor-hidegindítási kérést); a Telegram-webhook
    tranzitív launch-képessége a chatSessionStarter 12. pont szerinti
    registry-kapuzásával záródik, a webhook-auth (secret-fallback) kérdése
    pedig ADR-080 hatálya alá kerül.
20. **Az `outbox:done|blocked` eseménybusz-emitterek (az 5. kör feltárása):**
    a `POST /api/subscriptions/test-trigger` (`subscriptionRoutes.ts:176-197`,
    mount `app.ts:243` — nem root-kapuzott), a `POST
    /api/epic-router/task/:terminal/complete` (`epic-router.routes.ts:334`,
    terminál-token), az MCP `complete_task` tool (`mailbox.tools.ts:574`) és
    a fájlrendszeri outbox-író kategória (`inboxWatcher.ts:290/300` watcher-
    él) MIND a 16. pont subscriptionManager-kapuzási döntésének kiváltói:
    a kapuzás után egyik emitter sem indíthat sessiont közvetve sem — az
    esemény legfeljebb queue-feladást eredményez, amit a launch authority
    lease/review/budget kapukon enged át. A `test-trigger` végpont nem-root
    elérhetősége (csak `apiAuthGate`, `app.ts:185`) ADR-080 hatálya alá
    tartozó auth-hiány; teszt-végpontként vagy megszűnik, vagy root-kapu
    mögé kerül (ISL-013 implementációs részlet). Az ALVÓ
    `projectDispatcher`-ág (`startDispatcher`, hívó nélkül) csak a 16. pont
    kapuzása UTÁN élesíthető — dokumentált bekötési feltétel.

## Design intent

Egyetlen komponens legyen felelős a végrehajtási jogosultságért — ez a
SZIGET-07 gyökéroka (három egymástól független launch-képes mechanizmus)
strukturálisan szűnik meg, nem csak egy hiányzó feature-flag bekötésével.

## Alternatívák

- **Az `ENABLE_INBOX_WATCHER` flag tényleges bekötése** — elvetve: ez
  megőrizné a kettős (vagy hármas) launch-authority kockázatot, csak
  kapcsolhatóvá tenné; a strukturális megoldás a launch-útvonal
  megszüntetése, nem a kapcsolása.
- **Minden launch-mechanizmus megtartása, "csak az egyik legyen bekapcsolva
  configban"** — elvetve: üzemeltetési hiba (rossz env) esetén visszaáll a
  versenyhelyzet; a garancia legyen kódszintű, ne konfigurációs fegyelem.

## Következmények

- `inboxWatcher.ts`, `sessionStarter.ts` közvetlen launch-hívásai törlendők
  vagy notification-only szerepre szűkítendők (ISL-013 hatálya).
- `pipeline/watchInbox.ts` ÉS `pipeline/watchPriority.ts` (a nightwatch
  család mindkét tagja) notification-only szerepre szűkül.
- `control.routes.ts` `POST /dispatch` közvetlen `startSession`-hívása
  megszűnik, a claim-endpointra fordítva; a `dispatch-control` budget-logika
  bemenetté válik, nem önálló launch-döntéssé.
- `session.routes.ts` (`/api/session`, `/api/sessions`) megmarad, de
  auditnaplózással és opcionális claim-integrációval bővül (task-kötött
  hívásoknál).
- `spawn_parallel_workers`/`spawn_raw_workers` MCP toolok megmaradnak, de a
  canonikus store-ba regisztrált, budget-gated worker-indítássá alakulnak.
- A budget- és dependency-ellenőrzés egyetlen belépési pontra (a claim
  query-re) koncentrálódik, ellentétben a mai, részleges kontroll-API-s
  megoldással és a jelenlegi HÁROM párhuzamos budget-számlálóval
  (`dispatch-control/tokenBudget.ts`, `pipeline/costLimiter.ts`,
  `terminals.yaml token_budgets`) — ezek konszolidációja implementációs
  feladat (lásd Nyitott kérdések).
- `chatSessionStarter.ts` `startChatSession` gating nélküli, közvetlen
  launch-hívása megszűnik, egyszerűsített registry-ellenőrzésre cserélve;
  `pipeline/autoRestart.ts` és `pipeline/autonomousDev.ts` a
  nightwatch-családdal azonos, notification-only mintára áll át;
  `pipeline/taskEscalation.ts` kill-session-alapú escalationja a
  lease-fencing mechanizmusba integrálandó (ISL-005/013).
- **4. kör (2026-07-21) következményei:** `pipeline/subscriptionManager.ts`
  checkpoint-launcha, a `spawn_work_session` MCP tool, a `taskEscalation.ts`
  'restart' ága és a `watchDone.ts`→`terminalReviewer.ts` review-launch
  lánc mind a launch authority mögé kapuzódik (Döntés 14., 16-19. pont);
  a `terminalReviewer.ts` korábbi "dead code" minősítése visszavonva (csak
  a `requestReview` export holt); a `POST /api/autonomous/trigger` és a
  `POST /api/telegram/webhook` launch-képessége a kapuzással megszűnik.

## Biztonsági hatás

Csökkenti a duplikált üzleti végrehajtás kockázatát (két launch-útvonal =
két egyidejű agent session ugyanarra a taskra) — ez konkurenciabiztonsági,
nem authN/authZ kérdés.

## Kapcsolódó kód

- `knowledge-service/src/bootstrap/startup.ts`
- `knowledge-service/src/inboxWatcher.ts`, `src/watchInbox.ts`
- `knowledge-service/src/pipeline/watchInbox.ts`, `src/pipeline/nightwatch.ts`,
  `src/pipeline/watchPriority.ts`
- `knowledge-service/src/runner/sessionLauncher.ts`, `pollLoop.ts`
- `knowledge-service/src/pipeline/workerRegistry.ts`
- `knowledge-service/src/bootstrap/README.md` (a hiány már dokumentálva)
- `knowledge-service/src/interfaces/http/routes/session.routes.ts`
- `knowledge-service/src/interfaces/http/routes/control.routes.ts`
  (`POST /dispatch`, `requireAuth`)
- `knowledge-service/src/sessionManager.ts` (`startSession`, `wakeUpTerminal`)
- `knowledge-service/src/sessionStarter.ts` (`startTerminalSession`,
  `startParallelWorkSession`, `spawnRawWorkers`)
- `knowledge-service/src/interfaces/mcp/tools/worker.tools.ts`
  (`spawn_parallel_workers`, `spawn_raw_workers`)
- `knowledge-service/src/dispatch-control/` (`tokenBudget.ts`,
  `dispatchProposal.ts`, `scheduledWindows.ts`, saját `schema.sql`) — az
  ÖTÖDIK, korábban nem inventarizált queue/budget-rendszer
- `knowledge-service/src/pipeline/costLimiter.ts` — a HATODIK, önálló
  budget-mechanizmus
- `knowledge-service/src/codegen/frontendVerify.ts`, `codegenEngine.ts` —
  explicit hatálykizárás (build/verify subprocess, nem agent-session)
- `knowledge-service/src/chatSessionStarter.ts` (`startChatSession`,
  `injectToChatSession`, `injectTelegramWithContext`) — a 2. körben talált,
  gating nélküli launch-mechanizmus
- `knowledge-service/src/telegram/multiBotManager.ts`,
  `telegram/telegramService.ts` — a `chatSessionStarter.ts` hívói
- `knowledge-service/src/pipeline/autoRestart.ts`,
  `pipeline/autonomousDev.ts` — a nightwatch-család kiterjesztett tagjai
- `knowledge-service/src/pipeline/common.ts` (`newSession`, `killSession`,
  `sendKeys`, `sendEnter`, `hasSession`) — a megosztott tmux-utility, amit
  12 pipeline-fájl importál, de csak 2 hív ténylegesen `newSession`-t
- `knowledge-service/src/pipeline/terminalReviewer.ts` — `runTerminalReview`
  (198) ÉLŐ launch a `handleTerminalReview` (722) → `watchDone.ts:165`
  láncon (4. kör korrekciója); `requestReview` (808) holt, bekötési
  tilalommal
- `knowledge-service/src/pipeline/watchDone.ts` — a terminalReviewer élő
  hívója (`handleTerminalReview`, 165; kapu: `REVIEW_MODE`, default
  `terminal`)
- `knowledge-service/src/pipeline/taskEscalation.ts` — `killSession`-alapú
  escalation + a 'restart' ág lease-mentes `startWorkSession`-hívása (202)
- `knowledge-service/src/pipeline/subscriptionManager.ts` —
  `deliverNotification` (205) → `startWorkSession` (224), feltétel nélkül
  bekötve (`startup.ts:375`); tulajdonosi döntés szerint kapuzandó
- `knowledge-service/src/pipeline/eventBus.ts` — `pipelineEvents` busz +
  `emitOutboxEvent` (127-134): a subscriptionManager-launch szétcsatolt
  kiváltó-oldala (5. kör)
- `knowledge-service/src/routes/subscriptionRoutes.ts` — `POST
  /test-trigger` (176-197): nem-root `outbox:*`-emitter HTTP-belépés
  (mount: `app.ts:243`); kapuzandó + ADR-080 auth-hatály
- `knowledge-service/src/pipeline/epicRouter.ts` — `handleTaskCompletion`
  (487) → `emitOutboxEvent` (513); hívói: `epic-router.routes.ts` `POST
  /task/:terminal/complete` (334) és `completeTaskForMcp` (782/799) ← MCP
  `complete_task` (`mailbox.tools.ts:574`); alvó ág: `projectDispatcher.ts`
  (265; `startDispatcher` hívó nélkül)
- `knowledge-service/src/interfaces/mcp/tools/session.tools.ts` —
  `spawn_work_session` (150-219) → `startWorkSession` (198), lease nélkül;
  kapuzandó (a fájl `injectToChatSession`-hívása — 118-119 — továbbra is
  csak inject, nem auto-indító)
- `knowledge-service/src/pipeline/autonomousDev.ts` — `coldStartConductor`
  (283) launch; HTTP-router (`createAutonomousDevRouter`, 543) `POST
  /trigger` (575) flag-et megkerülő belépés (mount: `app.ts:195`)
- `knowledge-service/src/telegram/telegramService.ts` —
  `injectTelegramMessageToTerminal` (192) auto-start (205-207) →
  `startChatSession`
- `knowledge-service/src/pipeline/telegramBot.ts` — webhook-handler
  (`processWebhookUpdate`, 439; mount: `app.ts:193`), tranzitívan
  launch-képes a telegramService auto-startján át; emellett gyanús
  duplikátum a `telegram/telegramService.ts` mellett (nyitott kérdés)

## Bizonyíték

- Kód-felderítés 2026-07-18: `startup.ts:192` feltétel nélküli
  `startInboxWatcher()`; `bootstrap/README.md:47-50` a dokumentált
  `ENABLE_INBOX_WATCHER` hatástalanság; `pipeline/nightwatch.ts` importálja
  `runWatchInbox`-ot `env.ENABLE_NIGHTWATCH` mögött; grep:
  `ENABLE_INBOX_WATCHER` sehol nem olvasott TypeScript forrásban.
- Független review 2026-07-19: `session.routes.ts:22-30` (`POST /start` →
  `sessionManager.startSession`), `app.ts:226-227` (`requireRootForMutations`
  mögé mountolva, lease-ellenőrzés nélkül); `control.routes.ts:262-315`
  (`POST /dispatch` → `startSession`, `task-audit/auth.ts` `verifyToken`
  második auth-rétege).
- Kimerítő audit 2026-07-19 (ez a session, a koordinátor kérésére): a fenti
  `rg` parancs teljes, 19 soros kimenete (lásd "Kimerítő launch-belépési
  pont audit" szakasz) — 10 találat-csoport, mindegyik osztályozva és
  eldöntve; `pipeline/watchPriority.ts:13,37` (a nightwatch-család eddig
  nem nevesített tagja); `worker.tools.ts:105,181` (`spawn_parallel_workers`/
  `spawn_raw_workers`); `control.routes.ts` `dispatch-control` import
  (ötödik queue-rendszer); `pipeline/costLimiter.ts` (hatodik
  budget-mechanizmus); `codegen/frontendVerify.ts:73`,
  `codegen/codegenEngine.ts:95` (explicit hatálykizárás, build-subprocess).
- `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` SZIGET-07,
  SZIGET-08.
- Szélesített audit 2026-07-19 (2. review-kör, ez a session): a koordinátor
  által megadott `rg` parancs teljes, 149 soros kimenete (lásd "Szélesített
  launch-mechanizmus audit" szakasz) — minden sor átvizsgálva; 4 új
  találat-csoport lezárva (`chatSessionStarter.ts`, `autoRestart.ts`,
  `autonomousDev.ts`, `terminalReviewer.ts`); a `pipeline/common.ts`
  megosztott primitívjének tényleges `newSession`-hívóit külön, célzott
  `rg -n "newSession\("` kereséssel megerősítve (csak 2 valódi hívó); a
  Node.js process-indítási felület teljes lefedettségét külön
  `rg -n "worker_threads|child_process\.fork|require\('bindings'\)|\.fork\("`
  kereséssel megerősítve (0 találat).
- Hívásgráf-audit 2026-07-21 (4. kör, tulajdonosi döntés utáni módszertan):
  a `sessionStarter.ts`/`sessionManager.ts` 18 exportjának teljes leltára;
  re-export/`require` a két fájlra: 0, dinamikus `import()`: 2
  (`session.tools.ts:197`, `terminalReviewer.ts:869`); 13 launch-képes
  függvény MINDEN hívója célzott `név(` kereséssel bejárva a belépési
  pontokig — 19 élő + 1 holt belépési út (teljes tábla a "Hívásgráf-alapú
  launch-audit" szakaszban, fájl:sor hivatkozásokkal); a
  HTTP-önhívás-kategória külön sweeppel (`api/session|session/start|
  api/control/dispatch`) ellenőrizve; kapu-defaultok forrásból igazolva
  (`env.ts:132` `REVIEW_MODE` default `terminal`; `env.ts:123`
  `AUTONOMOUS_DEV_CONTROL_MODE` default `autonomous`; `env.ts:245-246`
  webhook-secret fallback). Három ÚJ megállapítás: watchDone→
  terminalReviewer élő launch-lánc (a "dead code" minősítés cáfolata),
  `POST /api/autonomous/trigger` flag-kerülő belépés, `POST
  /api/telegram/webhook` tranzitív launch-belépés.
- Emitter-oldali bejárás 2026-07-21 (5. kör, a 4. kör REQUEST_CHANGES-ének
  javítása): az `outbox:done|blocked` mindhárom emitter-helye
  (`subscriptionRoutes.ts:185`, `inboxWatcher.ts:290/300`,
  `epicRouter.ts:513`) a belépési pontokig bejárva (#21-25); az
  `epicRouter.handleTaskCompletion` hívói (`epic-router.routes.ts:344/799`,
  `mailbox.tools.ts:574`, `projectDispatcher.ts:265`) és a
  `startDispatcher` hívó-nélkülisége Grep-pel igazolva; az eseménybusz
  16 eseménytípusából a launch-ág kizárólagos `outbox:*`-feltétele
  (`subscriptionManager.ts:220`) forrásból ellenőrizve; mindhárom
  EventEmitter-példány (`eventBus.ts:108`, `inboxWatcher.ts:30`,
  `mailbox.routes.ts:26`) fogyasztói felderítve — további launch-képes
  listener nincs (`epicNotifications.ts:337` Telegram-only,
  `pipeline.routes.ts:47` SSE-only, `mailboxEvents` SSE-only).

## Nyitott kérdések

- Az operátori tmux-alapú manuális beavatkozás megtartásának pontos
  módja (párhuzamosan az automatizált launch-szal) ISL-011/ISL-012 hatálya.
- **Három párhuzamos budget-mechanizmus konszolidációja:**
  `dispatch-control/tokenBudget.ts`, `pipeline/costLimiter.ts` és a
  `terminals.yaml token_budgets` ma egymástól függetlenül számolnak — az
  ADR-081 4. pontjának egységes budget-kapuja megköveteli, hogy ISL-005/
  ISL-013 EGGYÉ vonja őket (vagy explicit döntse el, melyik marad
  kanonikus, melyik adat-bemenet csupán). Ez a jelen ADR NEM dönti el a
  pontos konszolidációs sémát — implementációs kérdés, de KRITIKUS, hogy
  ISL-013 ne hagyja figyelmen kívül.
- **Az ötödik queue-rendszer (`dispatch-control`) viszonya az ADR-078
  kanonikus store-hoz:** a `dispatch-control` saját SQLite-sémája
  (`queueDispatch`/`getDispatchQueue`) task-dispatch-szerű állapotot tart,
  amit az ADR-078 eredeti felderítése nem inventarizált. Nyitott kérdés,
  hogy ez a rendszer a task-message-box-ba olvad-e be (ADR-078 mintájára)
  vagy kizárólag budget-/proposal-bookkeeping-ként él tovább, önálló
  task-állapot nélkül — ISL-004/ISL-013 implementálójának kell eldöntenie,
  ez a jelen ADR csak jelzi a hiányt.
- A `session.routes.ts` claim-integrációjának pontos API-alakja (hogyan
  adja meg a hívó, hogy "ez egy konkrét taskhoz kötött" indítás) ISL-013
  implementációs részlete.
- **`chatSessionStarter.ts` TOCTOU-rés:** a mai `isChatSessionRunning`
  tmux-lekérdezés versenyhelyzetben (két egyidejű Telegram-üzenet) nem zárja
  ki két versengő session-létrehozást — a fenti pont 2 (egyszerűsített
  registry-ellenőrzés) csökkenti, de a pontos atomicitási garancia
  implementációs kérdés (ISL-005).
- **`pipeline/telegramBot.ts` vs. `telegram/telegramService.ts`
  duplikáció:** két, feltehetően egymást átfedő Telegram-integrációs modul
  létezik — melyik aktív, melyik legacy, ez launch-authority hatályon
  kívüli, önálló kód-higiéniai kérdés (javasolt: külön hygiene-task vagy
  ISL-016 dokumentációs felmérés keretében tisztázandó, nem ez az ADR
  dönti el).
- **`pipeline/taskEscalation.ts` és az ADR-079 lease-fencing pontos
  integrációja** — melyik komponens (escalation logika vagy a reaper)
  legyen a végső döntéshozó egy elakadt session megölésekor, ISL-005/013
  implementációs kérdés.
- **A hívásgráf-audit gépi megismételhetősége (4. kör):** a 2026-07-21-i
  audit kézi, Grep-alapú hívásgráf-bejárás — ISL-016/017 keretében érdemes
  TypeScript-AST-alapú (pl. ts-morph) reachability-ellenőrzéssé
  automatizálni, hogy egy új launch-képes függvény bevezetése CI-szinten
  bukjon meg, ne egy következő kézi audit találja meg. A review-launch
  (`watchDone`→`terminalReviewer`) kapuzás alatti átmenetére (mi történjen
  a folyamatban lévő review-kkal az átállás pillanatában) ISL-013 ad
  implementációs tervet.
