# ADR-060: CLI-agnosztikus Telegram-architektúra

- **Státusz:** accepted
- **Dátum:** 2026-07-04; rekonstruálva: 2026-07-18
- **Döntéshozó(k):** SpaceOS/Nexus architektúra (eredeti ADR az előd-repóban)
- **Rekonstruált:** igen — kód és datált kódkommentek alapján

## Kontextus

A Telegram-integráció (ADR-049 Phase 1 multi-bot alapján) a chat sessionök
identitását hardcodolt promptból adta, a beszélgetés-előzmény nem volt perzisztens,
és az injektálás egy konkrét CLI viselkedésére épült. Több-fordulós beszélgetésben
a kontextus elveszett.

## Döntés

- **Identitás fájlból:** a chat session identitását a terminál `CLAUDE-CHAT.md`
  fájlja adja (a work session identitásától külön), nem hardcodolt prompt.
- **DB-first üzenetrögzítés:** minden bejövő ÉS kimenő Telegram-üzenet a
  `conversation_messages` táblába kerül — a kimenő üzenetek MCP-toolja is mindig rögzít.
- **Teljes beszélgetés-kontextus injektálás:** a contextBuilder formázott
  előzményt épít (be + ki üzenetek, időbélyeggel), és ezt injektálja a CLI-be
  minden új üzenetnél.
- **CLI-agnosztikus injektálás:** a megoldás bármely stdin-t olvasó CLI-vel működik;
  nem függ egy konkrét agent-CLI belső viselkedésétől.

## Design intent

A beszélgetés állapota a DB-ben él, nem a CLI-session memóriájában — így a session
újraindulhat, cserélhető a CLI-eszköz, és az előzmény determinisztikusan
visszaépíthető (QUALITY.md 8.: kontextus véges, tartós állapot fájlban/DB-ben).
Az identitás konfigurációs fájlban él, nem kódban (config-vezéreltség).

## Alternatívák

Az eredeti ADR elveszett. A fejléc-kommentek "changes" listájából kiolvasható, hogy
a korábbi (elvetett) állapot volt az alternatíva: hardcodolt prompt-identitás +
csak bejövő üzenet injektálása előzmény nélkül.

## Következmények

- A multiBotManager és a chatSessionStarter átdolgozásra került; a telegram
  MCP-toolok (mcp.ts) 2026-07-04-én ADR-060-ra frissültek.
- Az üzenetrögzítés kötelező mellékhatás lett a küldő úton is — kihagyása bug.
- A kontextus-injektálás formátuma kontraktus a CLI-agent felé (parszolhatóság).

## Biztonsági hatás

A Telegram-üzenetek tartalma DB-be kerül — titok Telegramon át nem küldhető
(QUALITY.md 7.). A bot-tokenek env/config-ból jönnek, nem kódból.

## Kapcsolódó kód

- `knowledge-service/src/chatSessionStarter.ts` — identitás CLAUDE-CHAT.md-ből, injektálás
- `knowledge-service/src/telegram/multiBotManager.ts` — bejövő üzenet DB-be + kontextus-injektálás
- `knowledge-service/src/telegram/contextBuilder.ts` — beszélgetés-kontextus formázás
- `knowledge-service/src/mcp.ts:4098-4144`, `src/interfaces/mcp/tools/telegram.tools.ts:73`
  — kimenő üzenetek kötelező rögzítése

## Bizonyíték

- Kódkommentek: `chatSessionStarter.ts:1-17`, `multiBotManager.ts:1-11`,
  `contextBuilder.ts:1-20`, `mcp.ts:4098` ("2026-07-04 ADR-060")
- git: 823db70 (Initial commit, 2026-07-14)
