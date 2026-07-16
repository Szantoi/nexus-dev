---
domain: infra
title: VPS-hozzáférés modell — SSH-kulcsok, Tailscale, tűzfal-rétegek
updated: 2026-07-16
---

# VPS-hozzáférés modell

> Oktató anyag arról, hogyan jutnak be a projektek a VPS-re, miért így,
> és mit kell tudni ahhoz, hogy magabiztosan lehessen bővíteni/hibázni benne.
> A konkrét gép: `109.122.222.198` (Debian 13), user `gabor`.

---

## 1. A probléma, amit megold

Több projekt (nexus-dev, joinerytech, doorstar…) szeretne **automatizáltan**
dolgozni a szerveren: kódot húzni, buildelni, service-t újraindítani.
Ehhez be kell tudniuk lépni — **emberi jelenlét nélkül**, mert egy agent nem tud
jelszót begépelni.

Ebből három követelmény adódik:

1. **Jelszó nélküli belépés** — de úgy, hogy ne legyen gyengébb, mint a jelszavas.
2. **Visszavonhatóság** — ha egy gép/projekt kompromittálódik, azt az egy
   hozzáférést lehessen megszüntetni, ne az összeset.
3. **Kis támadási felület** — ne lógjon ki fölöslegesen semmi a nyílt internetre.

---

## 2. Hogyan működik az SSH kulcs-alapú belépés

### A mentális modell

Egy kulcspár két fájl:

| Fájl | Hol él | Mit csinál |
|---|---|---|
| `~/.ssh/valami_key` | **csak a kliensen** (privát) | ezzel *aláír* |
| `~/.ssh/valami_key.pub` | a **szerveren** is (publikus) | ezzel *ellenőriz* |

Belépéskor **a privát kulcs sosem megy át a hálózaton**. A szerver küld egy
véletlen kihívást, a kliens aláírja a privát kulccsal, a szerver a publikus
kulccsal ellenőrzi az aláírást. Ezért erősebb, mint a jelszó: nincs mit
lehallgatni, és nincs mit „kitalálni".

### Hol dől el, hogy kit enged be

A szerveren, a **belépő user** home-jában:

```
/home/gabor/.ssh/authorized_keys
```

Ez egy egyszerű szövegfájl: **soronként egy publikus kulcs**. Aki olyan privát
kulcsot tud felmutatni, amelynek a párja szerepel itt, az bejut `gabor`-ként.

**Kulcs hozzáadása = egy sor beírása ebbe a fájlba. Visszavonás = a sor törlése.**
Ennyi. Nincs adatbázis, nincs varázslat.

### Amit a szerver megkövetel (és csendben megbüntet)

Az sshd (a szerver-oldali SSH démon) **StrictModes** alatt fut: ha a
jogosultságok túl lazák, **szó nélkül figyelmen kívül hagyja** az
`authorized_keys`-t — a belépés `Permission denied (publickey)`-vel elszáll,
és semmi nem árulja el, hogy a kulcs valójában ott van.

Elvárt jogosultságok:

```bash
chmod 700 ~/.ssh                  # csak a tulajdonos járhat bele
chmod 600 ~/.ssh/authorized_keys  # csak a tulajdonos olvashatja/írhatja
chmod g-w,o-w ~                   # a HOME sem lehet írható másnak!
```

> A home-könyvtár írhatósága a leggyakoribb néma hiba: ha más is írhatja,
> elvileg kicserélhetné az `.ssh` mappát — az sshd ezért nem bízik benne.

---

## 3. Miért projektenként külön kulcs

Csábító lenne egy kulcsot használni mindenhez. Nem tesszük, mert:

- **Robbanási sugár.** Ha egy projekt gépe/kulcsa kikerül, csak azt az egy
  hozzáférést kell visszavonni — a többi érintetlen marad.
- **Nyomonkövethetőség.** A kulcs végén lévő címke (`joinerytech-deploy`)
  megmondja, melyik sor kihez tartozik. Egy közös kulcsnál nem tudnád, mit
  törölsz.
- **Önálló életciklus.** Egy projekt lezárul → a kulcsa törölhető anélkül,
  hogy bárki mást zavarna.

Ez a klasszikus **least privilege** elv gyakorlati alakja.

### A jelenlegi térkép

| SSH-alias | Kulcs | Mihez |
|---|---|---|
| `nexus-vps` | `~/.ssh/nexus_deploy_key` | nexus-dev (/opt/nexus-dev) |
| `joinerytech-vps` | `~/.ssh/joinerytech_deploy_key` | joinerytech (/opt/joinerytech) |
| `doorstar-vps` | `~/.ssh/doorstar_deploy_key` | doorstar (/opt/doorstar) |

Mind ugyanoda (`gabor@109.122.222.198`) lép be — a szeparáció **nem** a
jogosultságokban van, hanem a **visszavonhatóságban**. (Erről lásd a
7. pont figyelmeztetését.)

---

## 4. Az SSH-config alias — mire jó

A kliensen a `~/.ssh/config` fájl névvel köti össze a beállításokat:

```
Host joinerytech-vps
    HostName 109.122.222.198
    User gabor
    IdentityFile C:\Users\szant\.ssh\joinerytech_deploy_key
    IdentitiesOnly yes
```

Ettől ez a két parancs ekvivalens:

```bash
ssh -i ~/.ssh/joinerytech_deploy_key gabor@109.122.222.198 'uptime'
ssh joinerytech-vps 'uptime'          # ugyanaz, olvashatóan
```

**`IdentitiesOnly yes` — ez fontos.** Nélküle az SSH sorra próbálgatja az
összes ismert kulcsodat. Ha 6-nál több van, a szerver **túl sok sikertelen
kísérlet** miatt kidob, még mielőtt a jó kulcshoz érne. Ezzel a kapcsolóval
csak a megadott kulcsot ajánlja fel.

---

## 5. A Tailscale réteg — mit ad hozzá

A Tailscale egy **privát hálózat** (WireGuard-alapú „mesh VPN"): a felvett
gépek kapnak egy `100.x.y.z` címet, és **közvetlenül, titkosítva** látják
egymást — akkor is, ha NAT/tűzfal van közöttük.

| Gép | Tailnet-cím |
|---|---|
| VPS (`nexus-vps`) | `100.82.133.87` |
| Windows dev (`nexus-dev-win`) | `100.78.193.104` |

### Miért jó ez nekünk

A knowledge-service így indul a VPS-en:

```
HOST=100.82.133.87   # a tailnet-interfészre köt, NEM 0.0.0.0-ra
```

Vagyis a szolgáltatás **fizikailag nem is figyel** a publikus interfészen.
A nyílt internetről nem „tiltott", hanem **nem is létezik** — nincs mit
támadni. Aki a tailneten van, annak viszont természetesen elérhető.

> **Rétegzett védelem:** a tailnet a *hálózati* réteg, a token-auth
> (`AUTH_MODE=required`) az *alkalmazás* réteg. Ha az egyik hibázik, a másik
> még tart. A tailnetre bejutás önmagában még nem ad hozzáférést az API-hoz.

---

## 6. Tűzfal-rétegek — és a Docker-csapda

A gépen **ufw** fut (egyszerűsített iptables-frontend). Ez engedi be:
22 (SSH), 80/443 (web) és néhány továbbit.

### A csapda, amibe élesben belefutottunk

A ChromaDB (8001) **elérhető volt a nyílt internetről, autentikáció nélkül** —
noha az ufw-ben **nem szerepelt engedélyezve**. Hogyan?

**A Docker megkerüli az ufw-t.** Amikor egy konténer így publikál portot:

```yaml
ports:
  - "8001:8000"        # = 0.0.0.0:8001 !
```

a Docker **saját iptables-szabályt** ír a NAT-táblába, ami *előbb* fut le,
mint az ufw szabályai. Az ufw úgy tesz, mintha zárva lenne — közben nyitva van.

### A helyes rétegek

Docker-publikált portot **három** helyen lehet zárni:

1. **`DOCKER-USER` iptables-lánc** — kifejezetten erre való, a Docker
   szabályai *előtt* fut:
   ```bash
   iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 8001 -j DROP
   ```
   Az `-i eth0` a lényeg: csak a **publikus** interfészről érkezőt dobja —
   a localhost és a tailnet érintetlen marad.

2. **A publikálás loopbackre kötése** (a legtisztább, végleges megoldás):
   ```yaml
   ports:
     - "127.0.0.1:8001:8000"
   ```

3. **Sehol nem publikálni**, csak a Docker-hálózaton belül elérni.

> **Tanulság:** az `ufw status` NEM mondja meg az igazat Docker-portokról.
> Amit tényleg hinni lehet: `sudo ss -tlnp` (mi figyel valójában) és egy
> **kívülről** indított próba.

### Perzisztencia

Az iptables-szabályok **újraindításkor eltűnnek**. Ezért készült egy systemd
unit (`nexus-chroma-firewall.service`), ami bootkor visszateszi. Egy
tűzfalszabály, ami reboot után eltűnik, nem védelem — csak látszat.

---

## 7. Amit érdemes tudni a jogosultságokról

A `gabor` usernek **passwordless sudo** van a gépen. Ez kényelmes (az agentek
tudnak service-t újraindítani), de őszintén ki kell mondani:

> **Minden `authorized_keys`-be tett kulcs gyakorlatilag root-hozzáférést ad**,
> mert `gabor`-ként jelszó nélkül `sudo`-zni lehet.

Vagyis a projektenkénti kulcs **visszavonhatóságot** ad, **nem elszigetelést**.
Ha valódi elszigetelés kell (egy projekt tényleg csak a saját mappájához
férjen hozzá), az külön user + korlátozott sudoers-szabályok kérdése — ez ma
nincs megcsinálva, tudatos kompromisszum a kényelem javára.

---

## 8. Receptek

### Új projekt hozzáadása (kb. 1 perc)

```bash
# 1) Kulcs a kliensen (jelszó nélküli, mert agent használja)
ssh-keygen -t ed25519 -N '' -C ujprojekt-deploy -f ~/.ssh/ujprojekt_deploy_key

# 2) A publikus kulcs a szerverre (meglévő hozzáférésen át)
ssh nexus-vps "echo '$(cat ~/.ssh/ujprojekt_deploy_key.pub)' >> ~/.ssh/authorized_keys"

# 3) Alias a kliens configjába
cat >> ~/.ssh/config <<'EOF'

Host ujprojekt-vps
    HostName 109.122.222.198
    User gabor
    IdentityFile C:\Users\szant\.ssh\ujprojekt_deploy_key
    IdentitiesOnly yes
EOF

# 4) Próba
ssh ujprojekt-vps 'echo OK; whoami'
```

### Hozzáférés visszavonása

```bash
# A címke alapján töröljük a sort (a -C címke ezért fontos!)
ssh nexus-vps "sed -i '/ujprojekt-deploy$/d' ~/.ssh/authorized_keys"
ssh nexus-vps 'cut -d" " -f3 ~/.ssh/authorized_keys'   # ellenőrzés: ki maradt
```

### Ki fér ma hozzá?

```bash
ssh nexus-vps 'cut -d" " -f3 ~/.ssh/authorized_keys'
```

A harmadik mező a címke (`nexus-runner-deploy`, `joinerytech-deploy`, …).
Ha ismeretlen címkét látsz, az kérdés.

---

## 9. Hibakeresés: `Permission denied (publickey)`

Ez a leggyakoribb hiba, és **nem mondja meg, mi a baj**. Ellenőrzési sorrend:

```bash
# 1) Melyik kulcsot ajánlja fel egyáltalán a kliens?
ssh -v ujprojekt-vps 'true' 2>&1 | grep -E 'Offering|identity file'

# 2) Tényleg a jó gépre megyünk? (a cím változhatott!)
ssh <barmelyik-mukodo-alias> 'curl -s ifconfig.me; echo'

# 3) Szerver-oldali jogosultságok (StrictModes!)
ssh <mukodo-alias> 'ls -ld ~ ~/.ssh ~/.ssh/authorized_keys'

# 4) Az IGAZSÁG: a szerver naplója megmondja az okot
ssh <mukodo-alias> 'sudo tail -5 /var/log/auth.log'
```

Valós eset innen: a régi `spaceos_key` egyszer csak nem működött — a kulcs
egyszerűen **lekerült** az `authorized_keys`-ből (újratelepítés/takarítás).
A kliens-oldali hibaüzenet ilyenkor félrevezet: úgy néz ki, mintha a kulcssal
lenne baj, pedig a szerveren nem volt ott a párja.

---

## 10. Csapdák, amiket élesben megtanultunk

| Csapda | Mit tanultunk |
|---|---|
| **Docker megkerüli az ufw-t** | Egy publikált konténer-port nyitva lehet akkor is, ha az ufw szerint zárva. Mindig `ss -tlnp` + kívülről próba. |
| **`ufw allow` ≠ tényleg nyitva** | A Postgres 5432 „ALLOW Anywhere" volt az ufw-ben, de csak `127.0.0.1`-re kötött → sosem volt kívülről elérhető. A tűzfal-lista nem mondja meg a valós bind-címet. |
| **Az iptables nem túléli a rebootot** | Perzisztencia nélkül (systemd unit) a lyuk újranyílik. |
| **Bennragadt processz** | Egy régi processz fogva tarthatja a portot, így a frissen indított service *nem* azt szolgálja ki, amit hiszel — a régi kód fut tovább, „fantom" bugokkal. Deploy után: a port-PID egyezzen a service MainPID-jével. |
| **StrictModes néma** | Túl laza home/`.ssh` jogosultságnál az sshd indoklás nélkül ignorálja a kulcsot. |
| **`kill %1` SSH-n át** | Nem megbízható a job-control távoli parancsban; PID szerint ölj. |

---

## Összefoglalás — a védelem rétegei

```
  Internet
     │
     ├─ ufw: csak 22/80/443 …            (hálózati szűrés)
     ├─ DOCKER-USER: a Docker-lyukak zárása
     │
     ├─ Tailscale (100.x): privát háló   (a service ide köt, nem 0.0.0.0-ra)
     │
     └─ Alkalmazás: AUTH_MODE=required   (token → identitás → jogosultság)
```

Egyik réteg sem tökéletes önmagában — együtt viszont ahhoz, hogy valaki bejusson,
mindegyiken át kellene jutnia.

Kapcsolódó: `docs/knowledge/nexus-dev-workshop.md`
