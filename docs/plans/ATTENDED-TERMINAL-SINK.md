# Attended Terminal Sink — választható végrehajtási módok (headless | attached)

> **Verzió:** 1.3
> **Dátum:** 2026-07-23
> **Státusz:** 1–2. lépés KÉSZ (`1ac43f6`); 3A+3B lezárva mainen (`e627495`,
> review PASS); 3C P1/P2-javítások után review-2 PASS — részletek:
> [ATTACHED-SINK-STEP-3.md](ATTACHED-SINK-STEP-3.md)
> **Kapcsolódó:** ADR-081 (single launch authority),
> [ADR-087](../architecture/decisions/ADR-087-attached-terminal-lifecycle.md),
> [AttachedSink 3. lépés](ATTACHED-SINK-STEP-3.md), `src/runner/`, `src/pipeline/`

---

## 1. Probléma és használati szempont

### Megvalósítási checkpoint (2026-07-22)

Az 1–2. migrációs lépés a `main` ágon, `1ac43f6` commitban elkészült és CI PASS:
`TerminalSink`, viselkedésazonos headless alias, `mode: headless | attached`,
fail-closed attached preflight, dokumentáció és tesztek. Az `attached` értéket a
config-validáció előkészítésként elfogadja, de valódi sink hiányában a runner
szándékosan nem indul el vele.

A 3. lépés részletes, implementáció előtti szerződése:
[ATTACHED-SINK-STEP-3.md](ATTACHED-SINK-STEP-3.md). Ez pontosítja a mixed-mode
routert, a durable completion-receiptet, a session állapotgépet, az idle-kaput,
a runner-owned dashboardot és a platformteszteket.

A 3A durable completion szelet 2026-07-22-én implementálva és élő DEV-láncon
igazolva; független review előtt még nem lezárt. A `node-pty` dependency és a
lockfile ebben a checkpointban még nem változott.

*(Frissítés 2026-07-23: a 3A három review-kör után PASS és mainen van; a 3B a
`162f7e7` commitban rögzítette a `node-pty@1.1.0` production dependencyt Linux
lockkal és Node 22/24 × Ubuntu/Windows CI-mátrixszal; a 3C lifecycle-implementáció
P1/P2-javítási körei és kapui a
[ATTACHED-SINK-STEP-3.md](ATTACHED-SINK-STEP-3.md) checkpointjaiban.)*

A mai `src/runner/` a feladatokat **headless, egylövetű** CLI-sessionként futtatja
(`claude -p`, prompt stdinre). Ez tökéletes **felügyelet nélküli, autonóm**
munkára (VPS-agy dolgozik, ember nem néz oda). **Hiányzik viszont a
„csapatmunka" élmény**: nincs élő, látható terminál, amit figyelni és amibe
menet közben bele lehet szólni.

**A tapasztalt használati szempont** (Gábor): lokálisan a csapattal együtt
dolgozni = **élő, látható terminálok**, ahova a feladat becsúszik, az agent
munkája követhető, és be lehet avatkozni — miközben **ugyanaz az
infrastruktúra** VPS-központú autonóm üzemben is menjen.

### Döntések (2026-07-22)

1. **Attended mód kell** (látni + beleszólni), a headless mellett.
2. **Terminálonként EGY hosszú életű session** — nyitva marad, sorban kapja a
   feladat-nudge-okat, megtartja a kontextust.
3. **A mód terminálonként választható** (`headless | attached`) — nem globális
   kapcsoló; egy runner egyszerre futtathat autonóm háttér- és élő közös-munka
   terminálokat.

---

## 2. Két deployment-topológia — már megoldott

A runner a szerver **kimenő kliense**; a topológiát egyetlen configsor dönti el:

| Szcenárió | `runner.yaml → server_url` | Runner helye |
|---|---|---|
| VPS-központ | tailnet-cím (pl. `https://100.82.133.87:3466`) | lokális gép |
| Lokális csapat | `http://127.0.0.1:3466` | lokális gép |

A szerver (mailbox/tudás/workflow) és a runner (CLI-futtatás) szétválasztása
kész. Ez a terv **csak a végrehajtási primitívet** bővíti, a topológiát nem.

---

## 3. Architektúra — `TerminalSink` absztrakció

A poll-hurok marad az **egyetlen indítási autoritás** (ADR-081). Csak a „hova
írjunk" cserélhető, a provider-adapter mintájára:

```
pollLoop (VÁLTOZATLAN)  ──dispatch(terminal, messageId, model)──►  TerminalSinkRouter
   claim/release                                                     ├─ HeadlessSink  (mai spawn)
   busy-guard                                                        └─ AttachedSink[] (node-pty, terminálonként)
```

```ts
// A leszállított kontraktus (src/runner/terminalSink.ts, 1ac43f6 + C-szelet):
interface TerminalSink {
  dispatch(req: LaunchRequest): LaunchResult;      // headless: spawn; attached: write a PTY-be
  isBusy(terminal: string): boolean;               // attached: mid-task (nudge → complete_task közt)
  cancel(terminal: string, reason?: string): boolean;
  cancelAll(reason?: string): number;              // runner-szintű leállítás
  activeCount(): number;                           // graceful shutdown számláló
  minimumShutdownGraceMs?(): number;               // natív cleanup grace-igény (budget-kapu)
  ensureReady?(): void | Promise<void>;            // router: minden attached session preflightja
  shutdown?(reason?: string): Promise<void>;       // awaitelhető teljes cleanup
}
```

`SessionLauncher` → `HeadlessSink` (tartalma változatlan). Új: `AttachedSink`.

### Config (`runnerConfig.ts → TerminalEntrySchema` bővítés)

```yaml
terminals:
  conductor:
    workdir: /opt/nexus-dev/terminals/conductor
    provider: claude
    mode: attached          # ÚJ — default: headless (visszafelé kompatibilis)
  nightwatch:
    workdir: /opt/nexus-dev/terminals/nightwatch
    mode: headless
```

`mode: z.enum(['headless','attached']).default('headless')` a `TerminalEntrySchema`-ban.

---

## 4. A két mód specifikációja

### 4.1 `headless` (mai, változatlan)

- `claude -p` / `codex exec --json --ephemeral`, prompt stdinre, egylövetű.
- Completion: **exit 0 + tartós `complete_task`** (`isSuccessfulTaskCompletion`).
- Izolált, jól auditálható; nincs kontextus-átfolyás feladatok közt.

### 4.2 `attached` (új, node-pty)

- **node-pty** perzisztens PTY session **terminálonként** (ConPTY Windowson,
  forkpty Linuxon) — az interaktív CLI-t futtatja (NEM `-p`), az él és vár.
- **Nudge = write a PTY stdin-jébe**: rövid, egy soros utasítás a claimelt
  message id MCP-n történő lekérésére + Enter. A teljes tasktartalom nem kerül
  közvetlenül a PTY-be.
- **Látható + kétirányú**: a PTY kimenete egy **xterm.js dashboardra** streamel,
  a dashboard billentyűi **visszamennek ugyanabba a PTY-be** → **beleszólás =
  beírsz a közös élő sessionbe**. A knowledge-service ma SSE-t ad, de PTY-
  WebSocket gatewayt nem; az MVP gateway a runner mellett, localhost-defaulttal
  épül meg.
- A session **életben marad**, sorban kapja a nudge-okat, megtartja a kontextust.

---

## 5. Completion / idle / concurrency — a hosszú életű session szemantikája

Hosszú életű sessionnél **nincs process-exit feladatonként**, ezért a „kész"
jelet másképp kell venni:

- **Autoritatív kész-jel:** a tartós MCP **`complete_task`**, amelyből a szerver
  terminal/message-id kötött durable receiptet ír. Az SSE csak wake; a runner
  cursoros lekérdezéssel reconciliál.
- **Idle-detektálás:** a PTY kimenete elcsendesedett + a prompt visszatért.
- **Busy-guard:** `attached`-nél a busy = „nudge és `complete_task` közt vagyunk";
  a poll addig nem küld új nudge-ot az adott terminálra. Az egyetlen-autoritás
  elv sértetlen: a poll dönt, a sink csak kézbesít.

> **Újrahasznosítás:** a régi `src/pipeline/` (`watchIdle`, `watchMcpHeartbeat`,
> `watchDone`, `paneState`) ugyanennek több fogalmát kezeli tmux-on. Csak a
> tiszta osztályozási szabályok emelhetők át; az automatikus Enter/kill,
> értesítés és más provider-/tmux-specifikus mellékhatás nem. A PTY-idle csak a
> következő nudge kapuja, üzleti completiont nem bizonyít.

---

## 6. Cross-platform — miért node-pty és nem tmux

| Eszköz | Windows | Linux | Írható (nudge) | Látható | Kétirányú (beleszólás) |
|---|---|---|---|---|---|
| headless spawn | ✅ | ✅ | ❌ egylövetű | ❌ | ❌ |
| tmux send-keys | ❌ | ✅ | ✅ | ✅ | ✅ |
| **node-pty** | ✅ ConPTY | ✅ forkpty | ✅ | ✅ (xterm.js) | ✅ |

A **node-pty az egyetlen**, ami egyszerre ad írható + látható + kétirányú PTY-t
Windowson és Linuxon is. Ezért ez a válasz a „milyen eszközzel írjunk a
terminál CLI-jébe" kérdésre az attended módban. (Új prod-függőség → natív
addon; a `package-lock.json`-t **Linuxon kell regenerálni**, lásd a
platform-optional lock-tanulságot.)

---

## 7. Biztonsági megfontolások

- **Launch authority megőrizve (ADR-081):** a poll marad az egyetlen döntő; az
  `attached` sink nem indít önállóan, csak a poll `dispatch`-ére.
- **Zárt parancskészlet:** a PTY-ben futó CLI ugyanaz a provider-binary +
  allowlistelt argok (`runnerConfig` `providers`), sandbox/permission-flag
   tiltás (`FORBIDDEN_BYPASS`) változatlanul érvényes.
- **Credential:** az `attached` session env-je ugyanúgy a `credential_env`-ből
  jön; a hosszú életű processz miatt a token **a session teljes életére** él a
  memóriában — rotáció/lejárat megfontolandó.
- **Dashboard-hozzáférés:** a PTY-t megjelenítő/vezérlő websocket
  **Bearer-auth** mögött, csak tailnet/localhost — a kétirányú PTY távoli
  billentyű-injektálás, ezt védeni kell.
- **Prompt-injektálás:** a nudge szövege sosem shell-parancsba kerül, csak a CLI
  stdin-jébe (mint ma a headless prompt).

---

## 8. Migrációs sorrend

1. `TerminalSink` interfész + a mai `SessionLauncher` becsomagolása
   `HeadlessSink`-ké (viselkedés változatlan, tesztek zöldek).
2. `mode` mező a `TerminalEntrySchema`-ba (`default: headless` → visszafelé
   kompatibilis; a mai VPS-üzem érintetlen).
3. `AttachedSink` MVP a külön
   [3. lépés al-terve](ATTACHED-SINK-STEP-3.md) szerint: durable completion-
   receipt → mixed-mode router → node-pty lifecycle → idle/heartbeat → helyi
   xterm.js dashboard → Windows + Linux evidence.
4. Idle/done/heartbeat detektálás átemelése a `pipeline`-ból, cross-platform.
5. xterm.js dashboard-panel + autentikált, runner-owned helyi WebSocket gateway.
6. Fokozatos kiterjesztés a többi terminálra; a `pipeline/` tmux-út
   nyugdíjazása, ha az `attached` mindent lefed.

---

## 9. Nyitott kérdések / kockázatok

- **Kontextus-hossz:** a hosszú életű session context-saturationbe fut
  (van `conductor/contextSaturation.ts`) — mikor és hogyan „frissítünk lapot"
  a kontextus elvesztése nélkül? (compaction-integráció.)
- **Több ember:** a „csapat" = ember + agentek egy gépen, vagy több ember? A
  dashboard-hozzáférés és a PTY-megosztás modellje ettől függ.
- **node-pty natív build:** Windows (ConPTY) + Linux prebuild elérhetőség, a
  CI-lock platform-optional kezelése.
- **Crash-recovery:** a PTY nem él túl runner-crasht. Új session indul; a durable
  completion-receipt és claim/state reconciliáció dönti el, hogy retry vagy
  csak session-helyreállítás kell. Külön PTY-host daemon nem MVP-scope.
- **ADR:** az [ADR-087](../architecture/decisions/ADR-087-attached-terminal-lifecycle.md)
  `proposed`; független architecture/security review után fogadható el.
