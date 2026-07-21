# ADR-080: Egységes autorizációs policy és döntési sorrend

- **Státusz:** proposed
- **Dátum:** 2026-07-18
- **Döntéshozó(k):** architect terminál (TASK-ISL-001), review-ra vár
- **Rekonstruált:** nem — új tervezési döntés, a `tokenAuth.ts` mintájára épül

## Kontextus

SZIGET-02 szerint az izoláció nem egységes minden interfészen. 2026-07-18-i
kódfelderítés ezt HÁROM, EGYMÁSTÓL FÜGGETLENÜL implementált autorizációs
réteggel igazolta, a 2026-07-19-i független review pedig egy NEGYEDIKET
talált (lásd 4. pont) — a jelen ADR mind a négyet lefedi:

1. `auth/tokenAuth.ts`: `requireRoot`/`requireRootForMutations` —
   route-szintű, `mcpTerminal === 'root'` stringösszehasonlítás.
2. `mcp.ts` `canUseTool(terminal, toolName)` — YAML-vezérelt
   (`config/tool-permissions.yaml`), de HARDCODOLT fallback objektummal, ha a
   YAML betöltése elsőre elbukik.
3. `mcp.ts` `authorizeMailboxRest` — kézzel írt, teljesen configon kívüli
   szabálykészlet (`terminal === 'root' || terminal === 'conductor'` → teljes
   hozzáférés stb.), és ez **sosem nézi meg `req.mcpIsland`-et** — a mailbox
   REST hozzáférés kizárólag terminálnév alapján dől el, sziget-izoláció
   nélkül.
4. **`task-audit/auth.ts` `verifyToken`/`authorizeScope`** — egy TELJESEN
   KÜLÖN, negyedik autorizációs mechanizmus: SHA-256 hashelt tokenek
   `config/tokens.yaml`-ból, `holder` + `scopes` (wildcard-mintás,
   pl. `task:create:*`) modellel, saját LRU cache-sel (100 kulcs, 30 perc
   TTL). Nincs semmilyen kapcsolata a `tokenAuth.ts` `(island_id,
   terminal_id)` modelljével — teljesen más azonosító-fogalom (`holder`
   string, nem sziget/terminál pár). Ha a `config/tokens.yaml` nem
   található, HARDCODOLT fallback-tokenekre vált (`dev-token-root-2026`
   → `root` holder, teljes `session:*` scope; `dev-token-conductor-2026`
   → `conductor` holder) — ugyanaz a "config-hiánynál csendes hardcoded
   fallback" mintázat, mint amit a `canUseTool` YAML-fallbackjánál már
   azonosítottunk (2. pont), most egy MÁSIK modulban megismételve. A modul
   emellett saját, ötödik terminál-listát is definiál (`VALID_TERMINALS`:
   `backend, frontend, designer, architect, librarian, explorer,
   conductor` — hiányzik belőle `root`, `nexus`, `monitor`, `reviewer`,
   `federation`, `chat-root`, `backend-2`, `frontend-2`), ami az ADR-077
   SZIGET-09 megállapítását (két/három párhuzamos terminálkonfig) tovább
   súlyosbítja — ez a lista a NEGYEDIK, egymástól eltérő terminálhalmaz a
   kódbázisban.
   Ma ez a mechanizmus `control.routes.ts`-ben a route-szintű `requireAuth()`
   helperen keresztül fut, ÉS UGYANAZON útvonalak felett ott van az
   `app.ts`-ben mountolt `requireRootForMutations` is (két, egymásra
   rétegezett, egymástól független auth-ellenőrzés ugyanazon endpointon,
   lásd ADR-081 kiegészített launch-authority audit) — ma emiatt nem
   önmagában bypass, de egy jövőbeli route, amely ezt a mintát másolja az
   app-szintű kapu NÉLKÜL, defense-in-depth nélküli, hamis biztonságérzetet
   adó auth-ot hozhat létre.

Ezzel egyidejűleg a `tokenAuth.ts` saját, helyesen dokumentált invariánsa
("a sziget sosem kliens-inputból jön, csak szerver-oldali configból") NEM
érvényesül a federation route-on: `federation.routes.ts` `POST /send` a
`from_island`/`to_island` mezőket közvetlenül `req.body`-ból olvassa,
`GET /inbox` az `island`-ot `req.query`-ből — egyik sem veti össze
`req.mcpIsland`-del. Konkrét, súlyosabb megállapítás: az `island`
KONTEXTUS a transzportrétegen tovább is jut (`ToolContext.island` végigmegy
`authenticateMcp → dispatchToolCall → handler(args, context)`), de a
`task-message-box.tools.ts` regisztrációja `async (args) =>
handleTaskMessageBoxTool(def.name, args)` alakú — **eldobja a
`context`-et**. A kanonikus üzenet-store MCP toolja tehát ma egyáltalán nem
kapja meg a sziget-információt, holott a vezetékrendszer megvan hozzá.

## Döntés

### Egyetlen policy-pipeline, minden belépési ponton

```text
hitelesített identitás (token → {island_id, terminal_id, runner_id?})
  → terminál szerep/jogosultság feloldása az island_id-n belül (ADR-077 config)
  → a kért erőforrás saját (island_id, terminal_id)-jának feloldása KIZÁRÓLAG
    szerveroldali lookupból (sosem kliensmezőből)
  → policy-döntés: azonos sziget kötelező? cross-island explicit engedélyezett
    (kizárólag federation-relay, ADR-083, allow-list alapján)? a szerep
    engedélyezi a műveletet?
  → allow/deny + EGY strukturált audit-naplósor
```

Döntési sorrend (explicit):

1. Token érvényes? (`AUTH_MODE` fail-closed, `tokenAuth.ts` alapja
   megmarad) — egyébként 401/503.
2. Az identitás pontosan egy `(island_id, terminal_id)` párra oldódik fel —
   egyébként 403.
3. Runner-hívásoknál extra ellenőrzés: a `runner_id` regisztrálva és
   jogosult-e az adott `(island_id, terminal_id)` kiszolgálására
   (ADR-077/ISL-006 runner registry) — egyébként 403.
4. A művelet engedélyezett a terminál szerepének (a config `can_control`,
   `tool-permissions.yaml`) — egyébként 403.
5. Az erőforrás SAJÁT, tárolt `(island_id, terminal_id)`-je (nem a
   kérésből!) megegyezik a hívóéval, KIVÉVE explicit, allow-listázott
   cross-island műveletet (federation relay, root/coordinator emelt szintű
   akció) — egyébként 403 + audit "cross-island denied".
6. Minden feltétel teljesül → engedély + EGY strukturált audit-sor
   (ki/mit/melyik erőforráson/eredmény).

### Egységesítés a jelenlegi négy réteg helyett

- `requireRoot`/`requireRootForMutations` **megmarad**, de a policy-motor
  EGYIK ESETeként (root = egy terminál, akinek szerepkonfigja
  `can_control: "*"`-ot ad) — nem külön, párhuzamos string-összehasonlítás.
- `canUseTool` hardcodolt fallbackja megszűnik: config-betöltési hiba esetén
  FAIL-CLOSED (deny-all), nem egy régi, karbantartatlan hardcodolt lista.
- `authorizeMailboxRest` kézzel írt szabályai a közös policy-motorba
  költöznek, config-vezérelt formában, és KÖTELEZŐEN figyelembe veszik
  `req.mcpIsland`-et.
- Minden regisztrált MCP tool handler aláírása kötelezően `(args, context)`
  — a registry elutasítja azt a toolt, amelyik sziget-szkópolt adatot
  érint, de a `context`-et nem használja (ISL-003 implementációs
  ellenőrzés, pl. lint-szabály vagy contract-teszt).
- Federation: `from_island` MINDIG a hívó saját, hitelesített identitásából
  (`req.mcpIsland`) származik, felülírva bármely kliensmezőt; `to_island`
  a hívó sziget federation-partner allow-listájával validált
  (config-vezérelt, ADR-083).
- **`task-audit/auth.ts` kivezetése:** a `holder`/`scopes` modell beolvad a
  közös policy-motorba — a `scopes` (pl. `task:create:*`) a szerep-alapú
  engedélyek (4. döntési lépés) egyik bemenetévé válik, nem külön,
  párhuzamosan ellenőrzött hitelesítési réteggé. A `config/tokens.yaml`
  hardcodolt fallback-tokenjei megszűnnek — hiányzó config esetén
  FAIL-CLOSED, ugyanúgy, mint a `canUseTool`-nál. A modul saját
  `VALID_TERMINALS` listája kivezetendő, a kanonikus terminálconfig
  (ADR-077) váltja fel.

## Design intent

Egyetlen, tesztelhető, in-process TypeScript policy-modul — nem
route-onként újraírt, egymástól eltérő szabály. A cél, hogy a jövőbeli
drift (mint amit a federation route-on találtunk) STRUKTURÁLISAN
kizárt legyen: ha csak egyetlen belépési pont hívhatja meg a döntést, egy
új route/tool nem "felejtheti el" az izolációt.

## Alternatívák

- **Route-onkénti egyedi ellenőrzés (jelenlegi állapot)** — elvetve:
  bizonyítottan elsodródik (federation-rés).
- **Külső policy-motor (OPA/Casbin)** — elvetve MOST: aránytalan a jelenlegi
  méretskálán (KISS, QUALITY.md 8. egyszerűség elve); egy egyszerű,
  unit-tesztelt in-process modul arányos.

## Következmények

- Minden REST/MCP/TMB/federation belépési pont migrálandó a közös
  policy-modulra (ISL-003 hatálya).
- A `task-message-box.tools.ts` `context`-eldobó regisztrációs mintája
  javítandó (konkrét, azonosított hiba).
- A root token továbbra is egyetlen, katasztrofális-hatású escape hatch —
  ez a döntés nem növeli, de nem is oldja meg ezt a koncentrált kockázatot
  (lásd a taskfájl adverzáriális szakaszát).

## Biztonsági hatás

Ez az ADR maga egy biztonsági döntés: megszünteti a bizonyított
cross-island federation-rést és a config-hiba esetén hardcodolt fallback
kockázatát; fail-closed alapállást ír elő minden ágon.

## Kapcsolódó kód

- `knowledge-service/src/auth/tokenAuth.ts`
- `knowledge-service/src/mcp.ts` (`canUseTool`, `authorizeMailboxRest`,
  `dispatchToolCall`)
- `knowledge-service/src/interfaces/mcp/tools/base-tool.ts` (`ToolContext`)
- `knowledge-service/src/interfaces/mcp/tools/task-message-box.tools.ts`
- `knowledge-service/src/interfaces/http/routes/federation.routes.ts`
- `knowledge-service/config/tool-permissions.yaml`
- `knowledge-service/src/task-audit/auth.ts` (`verifyToken`, `authorizeScope`,
  `VALID_TERMINALS`) — negyedik, be nem vont autorizációs mechanizmus
- `knowledge-service/src/interfaces/http/routes/control.routes.ts`
  (`requireAuth` helper, 62-78. sor) — a `task-audit/auth.ts` egyik hívója
- `knowledge-service/config/tokens.yaml` (a `task-audit/auth.ts` saját,
  `agents.yaml`-tól független tokenforrása)

## Bizonyíték

- Kód-felderítés 2026-07-18: `tokenAuth.ts:150-153` invariáns-kommentek;
  `federation.routes.ts` `POST /send` (33. sor) és `GET /inbox` (55. sor)
  kliensmező-olvasás; `mcp.ts:87-100` hardcodolt fallback, `mcp.ts:161`
  `authorizeMailboxRest`; `task-message-box.tools.ts:11-17` context-eldobás
  (grep: `context.island` nulla találat az `interfaces/mcp/tools/` alatt).
- Független review 2026-07-19: `task-audit/auth.ts:113-141`
  (`loadTokensConfig` hardcodolt fallback `dev-token-root-2026`/
  `dev-token-conductor-2026` tokenekkel), `:255-263` (`VALID_TERMINALS`
  7 elemű, negyedik terminál-lista), `control.routes.ts:62-78`
  (`requireAuth` helper, `verifyToken`-t hívja) és `:211`/`app.ts:211`
  (`requireRootForMutations` UGYANAZON route-ok felett, rétegezve).
- `docs/knowledge/terminal-agent-sziget-mukodes-ertekeles.md` SZIGET-02.

## Nyitott kérdések

- A root token oszthatóságát szigetenként (jelenleg egyetlen globális
  root) ez az ADR nem dönti el — jelezve az ISL-003 implementálóinak
  mérlegelésre, nem blokkoló ezen taskra nézve.
- A `tool-permissions.yaml` és a `can_control` közötti pontos viszony
  (egy modell vagy kettő, egyeztetve) implementációs részlet.
