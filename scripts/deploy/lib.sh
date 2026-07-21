#!/usr/bin/env bash
# scripts/deploy/lib.sh — közös függvénykönyvtár a biztonságos deploy-scriptekhez.
#
# Használói: build-release.sh, deploy-release.sh (source-olják).
# Felelősség: naplózás, konfig-betöltés + validálás, health-check, lépés-futtatás,
#             verziózott release-váltás (symlink vagy copy mód).
#
# Tervezési elvek (QUALITY.md 3., 7.):
#  - Nincs hardcodolt útvonal/port/URL: minden a konfigból jön, env-felülírással.
#  - Hiányzó/érvénytelen konfig → azonnali, érthető hiba (exit 2).
#  - Minden lépés naplózott (stdout + LOG_FILE, ha be van állítva).
#  - Egyetlen exit code sincs lenyelve: a hívó dönt, a lib jelez.
#
# Exit code konvenció (a hívó scriptek is ezt követik):
#   0  — siker
#   2  — konfig- vagy használati hiba (rossz argumentum, hiányzó kulcs, rossz érték)
#   10 — build/typecheck/teszt/audit/csomagolási kapu hibája (build-release.sh)
#   11 — artifact- vagy backup-ellenőrzési hiba (deploy-release.sh, service még érintetlen)
#   12 — service-leállítási hiba (deploy-release.sh, release-váltás még nem történt)
#   20 — deploy sikertelen, automatikus rollback SIKERES (előző verzió fut, health OK)
#   21 — deploy sikertelen ÉS a rollback is sikertelen/lehetetlen — KÉZI BEAVATKOZÁS KELL

# ---------------------------------------------------------------------------
# Naplózás
# ---------------------------------------------------------------------------

_log_ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }

# log <üzenet> — normál naplósor stdout-ra és (ha van) a LOG_FILE-ba.
log() {
  local line="[$(_log_ts)] [deploy] $*"
  printf '%s\n' "$line"
  if [ -n "${LOG_FILE:-}" ]; then printf '%s\n' "$line" >> "$LOG_FILE"; fi
}

log_warn() {
  local line="[$(_log_ts)] [deploy] WARN: $*"
  printf '%s\n' "$line"
  if [ -n "${LOG_FILE:-}" ]; then printf '%s\n' "$line" >> "$LOG_FILE"; fi
}

log_err() {
  local line="[$(_log_ts)] [deploy] ERROR: $*"
  printf '%s\n' "$line" >&2
  if [ -n "${LOG_FILE:-}" ]; then printf '%s\n' "$line" >> "$LOG_FILE"; fi
}

# die <exit_code> <üzenet> — hibaüzenet + azonnali kilépés a megadott kóddal.
die() {
  local code="$1"; shift
  log_err "$*"
  exit "$code"
}

# ---------------------------------------------------------------------------
# Konfiguráció
# ---------------------------------------------------------------------------
# A konfig egy source-olható bash fájl (sablon: deploy.config.example.sh).
# Minden kulcs felülírható NEXUS_DEPLOY_<KULCS> környezeti változóval —
# így CI-ből vagy kézzel is állítható újabb konfigfájl nélkül.

CONFIG_KEYS_ALL=(
  SERVICE_NAME
  SERVICE_DIR ARTIFACT_DIR
  BUILD_TYPECHECK_CMD BUILD_TEST_CMD BUILD_AUDIT_CMD BUILD_CMD ARTIFACT_INCLUDE
  DEPLOY_ROOT SERVICE_STOP_CMD SERVICE_START_CMD POST_UNPACK_CMD
  HEALTH_URL HEALTH_EXPECT HEALTH_TIMEOUT_SECONDS HEALTH_RETRIES
  HEALTH_RETRY_DELAY_SECONDS START_GRACE_SECONDS SWITCH_MODE
)

require_nonempty() {
  local k="$1"
  [ -n "${!k:-}" ] || die 2 "Hiányzó vagy üres konfig kulcs: $k — pótold a konfigfájlban, vagy add meg NEXUS_DEPLOY_$k környezeti változóként. Sablon: scripts/deploy/deploy.config.example.sh"
}

require_number() {
  require_nonempty "$1"
  [[ "${!1}" =~ ^[0-9]+$ ]] || die 2 "Érvénytelen konfig érték: $1='${!1}' — nemnegatív egész szám szükséges."
}

require_abs_path() {
  require_nonempty "$1"
  [[ "${!1}" = /* ]] || die 2 "Érvénytelen konfig érték: $1='${!1}' — abszolút útvonal szükséges (/-rel kezdődjön; Git Bash alatt pl. /c/...)."
}

require_url() {
  require_nonempty "$1"
  [[ "${!1}" =~ ^https?:// ]] || die 2 "Érvénytelen konfig érték: $1='${!1}' — http(s):// URL szükséges."
}

require_enum() {
  local k="$1"; shift
  require_nonempty "$k"
  local v="${!k}" allowed
  for allowed in "$@"; do [ "$v" = "$allowed" ] && return 0; done
  die 2 "Érvénytelen konfig érték: $k='$v' — megengedett: $*"
}

# load_config <konfigfájl> <mód: build|deploy>
# Betölti a konfigot, alkalmazza az env-felülírásokat, majd a mód szerinti
# kulcsokat szigorúan validálja. Bármely hiba → exit 2, semmi nem módosul.
load_config() {
  local file="$1" mode="$2" k ov
  [ -n "$file" ] || die 2 "Konfigfájl nincs megadva (--config <fájl>)."
  [ -f "$file" ] || die 2 "Konfigfájl nem található: $file — másold le a sablont: cp scripts/deploy/deploy.config.example.sh <célfájl>, és töltsd ki."
  # shellcheck source=/dev/null
  source "$file" || die 2 "A konfigfájl betöltése (source) sikertelen: $file"

  # Env-felülírások: NEXUS_DEPLOY_<KULCS>
  for k in "${CONFIG_KEYS_ALL[@]}"; do
    ov="NEXUS_DEPLOY_${k}"
    if [ -n "${!ov:-}" ]; then
      printf -v "$k" '%s' "${!ov}"
      log "konfig felülírás környezeti változóból: $k"
    fi
  done

  # CRLF-védelem: Windows-szerkesztőből bemásolt \r sorvég értelmetlen értékeket ad.
  for k in "${CONFIG_KEYS_ALL[@]}"; do
    if [[ "${!k:-}" == *$'\r'* ]]; then
      die 2 "A konfig érték CR (\\r) karaktert tartalmaz: $k — a konfigfájl sorvégeit állítsd LF-re."
    fi
  done

  require_nonempty SERVICE_NAME
  case "$mode" in
    build)
      require_abs_path SERVICE_DIR
      [ -d "$SERVICE_DIR" ] || die 2 "A SERVICE_DIR nem létező könyvtár: $SERVICE_DIR"
      require_abs_path ARTIFACT_DIR
      require_nonempty BUILD_TYPECHECK_CMD
      require_nonempty BUILD_TEST_CMD
      require_nonempty BUILD_AUDIT_CMD
      require_nonempty BUILD_CMD
      require_nonempty ARTIFACT_INCLUDE
      ;;
    deploy)
      require_abs_path DEPLOY_ROOT
      require_nonempty SERVICE_STOP_CMD
      require_nonempty SERVICE_START_CMD
      # POST_UNPACK_CMD opcionális (üres = nincs unpack utáni lépés)
      require_url HEALTH_URL
      require_nonempty HEALTH_EXPECT
      require_number HEALTH_TIMEOUT_SECONDS
      require_number HEALTH_RETRIES
      [ "$HEALTH_RETRIES" -ge 1 ] || die 2 "Érvénytelen konfig érték: HEALTH_RETRIES='$HEALTH_RETRIES' — legalább 1 szükséges."
      require_number HEALTH_RETRY_DELAY_SECONDS
      require_number START_GRACE_SECONDS
      require_enum SWITCH_MODE symlink copy
      command -v curl >/dev/null 2>&1 || die 2 "A curl nem elérhető, pedig a health-checkhez szükséges."
      ;;
    *)
      die 2 "Belső hiba: ismeretlen load_config mód: $mode"
      ;;
  esac
  log "konfig betöltve és validálva ($mode mód): $file"
}

# ---------------------------------------------------------------------------
# Lépés-futtatás
# ---------------------------------------------------------------------------

# run_step <név> <parancs> <munkakönyvtár>
# A parancsot bash -c-vel futtatja a megadott könyvtárban; a teljes kimenet
# a naplóba is kerül. NEM nyeli le az exit code-ot: hibánál 1-gyel tér vissza,
# a hívó die-jal dönt a következményről.
run_step() {
  local name="$1" cmd="$2" dir="$3" rc=0
  log "LÉPÉS [$name] indul — parancs: $cmd (cwd: $dir)"
  if [ -n "${LOG_FILE:-}" ]; then
    ( cd "$dir" && bash -c "$cmd" ) 2>&1 | tee -a "$LOG_FILE"
    rc=${PIPESTATUS[0]}
  else
    ( cd "$dir" && bash -c "$cmd" ) || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    log_err "LÉPÉS [$name] SIKERTELEN (exit $rc)"
    return 1
  fi
  log "LÉPÉS [$name] kész (exit 0)"
  return 0
}

# ---------------------------------------------------------------------------
# Health-check
# ---------------------------------------------------------------------------

# health_check <címke>
# HEALTH_RETRIES próbálkozás, kérésenként HEALTH_TIMEOUT_SECONDS timeout,
# próbálkozások közt HEALTH_RETRY_DELAY_SECONDS várakozás.
# Siker: a válasz-body tartalmazza a HEALTH_EXPECT mintát (fix string).
# Minden próbálkozás naplózott. Visszatérés: 0 = egészséges, 1 = sikertelen.
health_check() {
  local label="$1" attempt body rc
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    log "health-check ($label) ${attempt}/${HEALTH_RETRIES}: GET $HEALTH_URL (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
    rc=0
    body="$(curl -fsS --max-time "$HEALTH_TIMEOUT_SECONDS" "$HEALTH_URL" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if printf '%s' "$body" | grep -Fq -- "$HEALTH_EXPECT"; then
        log "health-check ($label) OK — válasz: ${body:0:200}"
        return 0
      fi
      log_warn "health-check ($label) a válasz nem tartalmazza a várt mintát ('$HEALTH_EXPECT') — válasz: ${body:0:200}"
    else
      log_warn "health-check ($label) kérés sikertelen (curl exit $rc): ${body:0:200}"
    fi
    if [ "$attempt" -lt "$HEALTH_RETRIES" ] && [ "$HEALTH_RETRY_DELAY_SECONDS" -gt 0 ]; then
      sleep "$HEALTH_RETRY_DELAY_SECONDS"
    fi
  done
  log_err "health-check ($label) VÉGLEG SIKERTELEN ${HEALTH_RETRIES} próbálkozás után: $HEALTH_URL"
  return 1
}

# ---------------------------------------------------------------------------
# Verziózott release-váltás
# ---------------------------------------------------------------------------
# Könyvtárstruktúra a DEPLOY_ROOT alatt:
#   releases/<RELEASE_ID>/   — minden telepített release érintetlenül megmarad
#   current                  — az aktív release (symlink vagy másolat, SWITCH_MODE)
#   current.release-id       — az aktív release azonosítója (szöveges pointer;
#                              mindkét módban ez az autoritatív nyilvántartás)
#   logs/deploy-*.log        — deploy-naplók

# switch_current <release_id>
# Átállítja a current-et a megadott release-re. SWITCH_MODE=symlink módban
# a symlink létrejöttét readlinkkel IGAZOLJA (Git Bash-ben az ln -s némán
# másolatot készít — azt hibaként jelezzük); copy módban óvatos cserét végez
# (current.new felépítés → current lecserélés), hogy fél-kész állapot ne maradjon.
switch_current() {
  local id="$1" rdir="$DEPLOY_ROOT/releases/$1" tgt
  [ -d "$rdir" ] || { log_err "A váltás célja nem létezik: $rdir"; return 1; }
  case "$SWITCH_MODE" in
    symlink)
      ln -sfn "releases/$id" "$DEPLOY_ROOT/current" || { log_err "ln -sfn sikertelen"; return 1; }
      tgt="$(readlink "$DEPLOY_ROOT/current" 2>/dev/null || true)"
      if [ "$tgt" != "releases/$id" ]; then
        log_err "A symlink nem igazolható (readlink eredménye: '$tgt') — ez a rendszer nem támogat valódi symlinket. Használj SWITCH_MODE=copy módot."
        return 1
      fi
      ;;
    copy)
      rm -rf "$DEPLOY_ROOT/current.new" || return 1
      cp -a "$rdir" "$DEPLOY_ROOT/current.new" || { log_err "cp -a sikertelen: $rdir → current.new"; return 1; }
      rm -rf "$DEPLOY_ROOT/current.old" || return 1
      if [ -e "$DEPLOY_ROOT/current" ]; then
        mv "$DEPLOY_ROOT/current" "$DEPLOY_ROOT/current.old" || { log_err "a régi current félreállítása sikertelen"; return 1; }
      fi
      mv "$DEPLOY_ROOT/current.new" "$DEPLOY_ROOT/current" || { log_err "current.new → current átnevezés sikertelen"; return 1; }
      rm -rf "$DEPLOY_ROOT/current.old"
      ;;
    *)
      log_err "Belső hiba: ismeretlen SWITCH_MODE: $SWITCH_MODE"
      return 1
      ;;
  esac
  printf '%s\n' "$id" > "$DEPLOY_ROOT/current.release-id" || { log_err "current.release-id írása sikertelen"; return 1; }
  log "aktív release átállítva: $id ($SWITCH_MODE mód)"
  return 0
}
