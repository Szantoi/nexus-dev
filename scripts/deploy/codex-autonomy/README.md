# Codex-autonómia VPS rollout

Ez a bundle a régi JoineryTech knowledge-service teljes frissítése nélkül ad
Codex-elsődleges, headless autonóm futtatást.

- A knowledge-service inbox watchere csak SSE-ébresztővé válik.
- A régi Nightwatch/AutonomousDev/AutoRestart launcherek kikapcsolódnak.
- A külön runner `codex exec --json --ephemeral` folyamatokat indít,
  terminálonként egyet, terminal-specifikus MCP hitelesítéssel.
- Az első runner-indulás karanténba helyezi a teljes korábbi UNREAD backlogot.
- A systemd timer csak akkor tesz fel új Conductor-taskot, ha az előző ciklus
  befejeződött, nincs aktív runner marker, nincs claimelt Conductor-task, és a
  Conductor `state.md` fájlja nem jelez `blocked` állapotot. A root döntésére
  váró blokk így nem indít ismétlődő, költséges sessionöket; egy célzott új
  inbox-task ettől még felébreszti a runnert.

A `configure.mjs` minden módosított fájlt timestampes backupba ment, és nem
ír tokent stdout/stderr-re. A visszaállítás a backup könyvtárral:

A runner lokális `-c` felülírással a `127.0.0.1:3458/mcp` végpontot használja;
így nem függ a VPS saját Tailscale-címének visszahurkolásától, miközben a felhasználói
Codex-konfiguráció többi része változatlan marad.
Az autonóm child explicit `approval_policy="never"` beállítást kap, mert nincs
interaktív jóváhagyási UI; ezt a szűk sandbox, a helyi allowlist és a
terminál-specifikus MCP-token korlátozza.
Ugyanezért a két helyi MCP-bejegyzés `default_tools_approval_mode="approve"`
felülírást kap; enélkül a `codex exec` headless módban `user cancelled MCP tool
call` eredménnyel áll le. A szerveroldali termináljogosultság továbbra is
kötelező és minden hívásnál érvényesül.

```bash
sudo systemctl disable --now joinerytech-autonomy-enqueue.timer
sudo systemctl disable --now joinerytech-codex-runner.service
node scripts/codex-autonomy/rollback.mjs /opt/joinerytech/backups/codex-autonomy-<timestamp>
sudo systemctl restart spaceos-knowledge.service
```

Élesítés előtt kötelező: typecheck/teszt, Linux read-only Codex smoke,
egyterminálos inbox→SSE→runner→Codex→MCP canary, majd csak ezután
`node scripts/codex-autonomy/promote-workspace-write.mjs`, runner restart és a
timer engedélyezése. A production config nem használ `--ignore-user-config`
kapcsolót, mert a terminál-specifikus MCP konfigurációt be kell tölteni.

Az ütemezett Conductor-ciklus legfeljebb 30 perces munkakeretet és műveletenként
legfeljebb két újrapróbálást ír elő. Nagy fájloknál célzott keresést és korlátozott
szakaszolvasást kér, hogy az autonóm felderítés tokenigénye kontrollálható maradjon.
