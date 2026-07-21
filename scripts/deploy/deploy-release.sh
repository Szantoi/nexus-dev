#!/usr/bin/env bash
# scripts/deploy/deploy-release.sh — PRODUCTION DEPLOY kész release-artifactból.
#
# CSAK a build-release.sh által készített, azonosítható artifactot telepít.
# Nem buildel, nem tesztel, nem commitol, nem tagel, nem pushol — a
# release-előkészítés a build-release.sh dolga, a publikálás emberi döntés.
#
# Folyamat (élő mód):
#   1. konfig betöltése + szigorú validálás (hiba → exit 2, semmi nem változik)
#   2. artifact ellenőrzése (tar-integritás, RELEASE_ID, manifest)
#   3. emberi kapu: --confirm kapcsoló + interaktív "yes" megerősítés
#   4. backup-ellenőrzés: a jelenlegi release sértetlen-e (rollback-célpont)
#   5. kicsomagolás releases/<RELEASE_ID>-be + opcionális POST_UNPACK_CMD
#      (a service EDDIG a pontig zavartalanul fut; bármely hiba ártalmatlan)
#   6. service stop → current átállítása → service start
#   7. health-check; hibánál AUTOMATIKUS ROLLBACK az előző release-re,
#      majd a visszaállított verzió health-checkje is KÖTELEZŐ és naplózott
#
# Dry-run mód (--dry-run): az 1–2. lépés (csak olvasás) + a teljes terv
# kiírása. SEMMILYEN fájlt nem módosít, service-t nem állít le/indít.
#
# Használat:
#   bash scripts/deploy/deploy-release.sh --config <konfigfájl> --artifact <tar.gz> --confirm
#   bash scripts/deploy/deploy-release.sh --config <konfigfájl> --artifact <tar.gz> --dry-run
#
# Exit code-ok:
#   0  siker | 2 konfig/használat/megerősítés hiánya | 11 artifact/backup-hiba
#   12 service-stop hiba | 20 deploy sikertelen, rollback SIKERES
#   21 deploy sikertelen ÉS rollback sikertelen/lehetetlen (KÉZI BEAVATKOZÁS)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
Használat: deploy-release.sh --config <konfigfájl> --artifact <tar.gz> (--confirm | --dry-run)

  --config <fájl>    Kötelező. Sablon: scripts/deploy/deploy.config.example.sh
  --artifact <fájl>  Kötelező. A build-release.sh által készített .tar.gz.
  --confirm          Élő deployhoz kötelező; utána interaktív "yes" is kell.
  --dry-run          Terv kiírása; SEMMIT nem módosít, service-hez nem nyúl.
EOF
}

CONFIG_FILE=""
ARTIFACT=""
CONFIRM=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      [ $# -ge 2 ] || die 2 "A --config kapcsolóhoz fájlnév kell."
      CONFIG_FILE="$2"; shift 2 ;;
    --artifact)
      [ $# -ge 2 ] || die 2 "Az --artifact kapcsolóhoz fájlnév kell."
      ARTIFACT="$2"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 2 "Ismeretlen argumentum: $1" ;;
  esac
done

load_config "$CONFIG_FILE" deploy
[ -n "$ARTIFACT" ] || die 2 "Az --artifact <tar.gz> megadása kötelező (a build-release.sh kimenete)."

# --- 2. Artifact-ellenőrzés (csak olvasás) ----------------------------------
[ -f "$ARTIFACT" ] || die 11 "Az artifact nem található: $ARTIFACT"
tar -tzf "$ARTIFACT" >/dev/null 2>&1 || die 11 "Az artifact nem érvényes tar.gz: $ARTIFACT"
NEW_ID="$(tar -xzOf "$ARTIFACT" ./RELEASE_ID 2>/dev/null || tar -xzOf "$ARTIFACT" RELEASE_ID 2>/dev/null || true)"
NEW_ID="$(printf '%s' "$NEW_ID" | tr -d '\r\n ')"
[ -n "$NEW_ID" ] || die 11 "Az artifactból hiányzik a RELEASE_ID — nem a build-release.sh készítette? ($ARTIFACT)"
tar -tzf "$ARTIFACT" 2>/dev/null | grep -q 'manifest\.json' || die 11 "Az artifactból hiányzik a manifest.json: $ARTIFACT"

# A jelenlegi állapot felmérése (csak olvasás — dry-runban is biztonságos).
PREV_ID=""
if [ -f "$DEPLOY_ROOT/current.release-id" ]; then
  PREV_ID="$(tr -d '\r\n ' < "$DEPLOY_ROOT/current.release-id")"
fi

# --- Dry-run: terv, aztán kilépés MINDEN módosítás előtt --------------------
if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN — a deploy terve (SEMMILYEN fájl nem módosul, service-hez nem nyúlunk):"
  log "  service:        $SERVICE_NAME"
  log "  artifact:       $ARTIFACT (ellenőrizve: tar OK, RELEASE_ID + manifest megvan)"
  log "  új release:     $NEW_ID"
  log "  deploy-gyökér:  $DEPLOY_ROOT (mód: $SWITCH_MODE)"
  if [ -n "$PREV_ID" ]; then
    log "  jelenlegi:      $PREV_ID → health-hiba esetén erre állnánk vissza automatikusan"
  else
    log "  jelenlegi:      (nincs — ez ELSŐ deploy lenne, rollback-célpont nélkül!)"
  fi
  [ -n "${POST_UNPACK_CMD:-}" ] && log "  unpack után:    $POST_UNPACK_CMD"
  log "  stop:           $SERVICE_STOP_CMD"
  log "  start:          $SERVICE_START_CMD"
  log "  health:         $HEALTH_URL (várt minta: '$HEALTH_EXPECT', ${HEALTH_RETRIES}x, ${HEALTH_TIMEOUT_SECONDS}s timeout)"
  log "DRY-RUN vége — semmi nem változott."
  exit 0
fi

# --- 3. Emberi kapu ---------------------------------------------------------
if [ "$CONFIRM" -ne 1 ]; then
  die 2 "Éles deployhoz kötelező a --confirm kapcsoló (terv megtekintése: --dry-run)."
fi
echo ""
echo "=================================================================="
echo "  ÉLES DEPLOY MEGERŐSÍTÉSE"
echo "  service:   $SERVICE_NAME"
echo "  release:   $NEW_ID"
echo "  cél:       $DEPLOY_ROOT"
if [ -n "$PREV_ID" ]; then
  echo "  rollback:  $PREV_ID (automatikus, health-hiba esetén)"
else
  echo "  rollback:  NINCS — ez az első deploy ebben a gyökérben!"
fi
echo "=================================================================="
printf 'Írd be, hogy "yes" a folytatáshoz: '
ANSWER=""
read -r ANSWER || die 2 "Nincs megerősítés (stdin lezárult) — deploy megszakítva, semmi nem változott."
[ "$ANSWER" = "yes" ] || die 2 "Deploy megszakítva (válasz: '$ANSWER') — semmi nem változott."

# --- Napló és könyvtárak ----------------------------------------------------
mkdir -p "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/logs" || die 2 "A DEPLOY_ROOT nem hozható létre/írható: $DEPLOY_ROOT"
LOG_FILE="$DEPLOY_ROOT/logs/deploy-$(date -u +%Y%m%d-%H%M%S)-${NEW_ID}.log"
: > "$LOG_FILE" || die 2 "A deploy-napló nem írható: $LOG_FILE"
log "deploy indul — artifact: $ARTIFACT, új release: $NEW_ID, napló: $LOG_FILE"

# --- 4. Backup-ellenőrzés (a rollback-célpont sértetlensége) ----------------
if [ -n "$PREV_ID" ]; then
  PREV_DIR="$DEPLOY_ROOT/releases/$PREV_ID"
  [ -d "$PREV_DIR" ] || die 11 "Backup-ellenőrzés SIKERTELEN: a jelenlegi release ($PREV_ID) könyvtára hiányzik: $PREV_DIR — rollback nem lenne lehetséges, deploy MEGTAGADVA."
  PREV_MARK="$(tr -d '\r\n ' < "$PREV_DIR/RELEASE_ID" 2>/dev/null || true)"
  [ "$PREV_MARK" = "$PREV_ID" ] || die 11 "Backup-ellenőrzés SIKERTELEN: $PREV_DIR/RELEASE_ID tartalma ('$PREV_MARK') nem egyezik a nyilvántartott azonosítóval ($PREV_ID) — deploy MEGTAGADVA."
  log "backup ellenőrizve: az előző release ($PREV_ID) sértetlen, rollback-célpontként elérhető."
  [ "$NEW_ID" = "$PREV_ID" ] && die 11 "Ez a release ($NEW_ID) már az aktív verzió — nincs mit telepíteni."
else
  log_warn "ELSŐ DEPLOY ebben a gyökérben: nincs korábbi release — health-hiba esetén automatikus rollback NEM lesz lehetséges."
fi
[ -d "$DEPLOY_ROOT/releases/$NEW_ID" ] && die 11 "A releases/$NEW_ID könyvtár már létezik — ez az azonosító már telepítve volt. Készíts új artifactot."

# --- 5. Kicsomagolás (a service még zavartalanul fut) -----------------------
INCOMING="$DEPLOY_ROOT/releases/.incoming-$NEW_ID"
rm -rf "$INCOMING"
mkdir -p "$INCOMING" || die 11 "A kicsomagoló könyvtár nem hozható létre: $INCOMING"
if ! tar -xzf "$ARTIFACT" -C "$INCOMING"; then
  rm -rf "$INCOMING"
  die 11 "Az artifact kicsomagolása sikertelen — a futó service érintetlen."
fi
if [ -n "${POST_UNPACK_CMD:-}" ]; then
  if ! run_step "post-unpack" "$POST_UNPACK_CMD" "$INCOMING"; then
    rm -rf "$INCOMING"
    die 11 "A POST_UNPACK_CMD hibázott — deploy megszakítva, a futó service érintetlen."
  fi
fi
mv "$INCOMING" "$DEPLOY_ROOT/releases/$NEW_ID" || die 11 "A release véglegesítése (mv) sikertelen."
log "release kicsomagolva: $DEPLOY_ROOT/releases/$NEW_ID"

# --- Rollback-eljárás (health- vagy indítási hiba esetén hívjuk) ------------
do_rollback() {
  local reason="$1"
  log_err "DEPLOY SIKERTELEN ($reason) — release: $NEW_ID"
  if [ -z "$PREV_ID" ]; then
    log_err "KRITIKUS: nincs korábbi release, automatikus rollback NEM lehetséges. A service-t leállítom, hogy hibás verzió ne fusson tovább."
    run_step "service-stop(vész)" "$SERVICE_STOP_CMD" "$DEPLOY_ROOT" || log_err "A vész-leállítás is hibázott — ellenőrizd kézzel a service állapotát!"
    echo "RESULT=failed-no-rollback"
    exit 21
  fi
  log_warn "AUTOMATIKUS ROLLBACK indul: vissza a(z) $PREV_ID release-re."
  run_step "service-stop(rollback)" "$SERVICE_STOP_CMD" "$DEPLOY_ROOT" || log_warn "A leállítás hibát jelzett — a visszaállítást ettől még megkísérlem."
  if ! switch_current "$PREV_ID"; then
    log_err "KRITIKUS: a rollback-váltás sikertelen — KÉZI BEAVATKOZÁS SZÜKSÉGES. Az előző release itt van sértetlenül: $DEPLOY_ROOT/releases/$PREV_ID"
    echo "RESULT=rollback-failed"
    exit 21
  fi
  if ! run_step "service-start(rollback)" "$SERVICE_START_CMD" "$DEPLOY_ROOT"; then
    log_err "KRITIKUS: a visszaállított release ($PREV_ID) indítása sikertelen — KÉZI BEAVATKOZÁS SZÜKSÉGES."
    echo "RESULT=rollback-failed"
    exit 21
  fi
  [ "$START_GRACE_SECONDS" -gt 0 ] && sleep "$START_GRACE_SECONDS"
  # A visszaállított verzió health-checkje KÖTELEZŐ és naplózott (QC-004 6. pont).
  if health_check "rollback"; then
    log "ROLLBACK SIKERES: a korábbi release ($PREV_ID) fut és egészséges. A hibás release megőrizve vizsgálatra: $DEPLOY_ROOT/releases/$NEW_ID"
    echo "RESULT=rolled-back"
    echo "RELEASE_ID=$PREV_ID"
    exit 20
  fi
  log_err "KRITIKUS: a ROLLBACK UTÁNI health-check IS SIKERTELEN ($PREV_ID) — KÉZI BEAVATKOZÁS SZÜKSÉGES. Napló: $LOG_FILE"
  echo "RESULT=rollback-unhealthy"
  exit 21
}

# --- 6. Stop → váltás → start -----------------------------------------------
run_step "service-stop" "$SERVICE_STOP_CMD" "$DEPLOY_ROOT" \
  || die 12 "A service leállítása sikertelen — a release-váltás NEM történt meg, a korábbi fájlok érintetlenek. Ellenőrizd kézzel a service állapotát."

if ! switch_current "$NEW_ID"; then
  do_rollback "a current átállítása az új release-re sikertelen"
fi

if ! run_step "service-start" "$SERVICE_START_CMD" "$DEPLOY_ROOT"; then
  do_rollback "a service indítása az új release-zel sikertelen"
fi

# --- 7. Health-check + döntés -----------------------------------------------
[ "$START_GRACE_SECONDS" -gt 0 ] && sleep "$START_GRACE_SECONDS"
if health_check "deploy"; then
  log "DEPLOY SIKERES: $NEW_ID éles és egészséges. Napló: $LOG_FILE"
  echo "RESULT=deployed"
  echo "RELEASE_ID=$NEW_ID"
  exit 0
fi

do_rollback "az új release health-checkje sikertelen"
