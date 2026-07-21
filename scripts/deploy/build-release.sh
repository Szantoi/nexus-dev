#!/usr/bin/env bash
# scripts/deploy/build-release.sh — RELEASE-ELŐKÉSZÍTÉS (build, NEM deploy).
#
# Feladata: futtatja a négy minőségi kaput (typecheck → teszt → audit → build),
# és sikerük esetén azonosítható release-artifactot készít:
#   $ARTIFACT_DIR/<SERVICE_NAME>-<RELEASE_ID>.tar.gz
# ahol RELEASE_ID = UTC időbélyeg + git commit hash (pl. 20260718-093012-482-g5074441).
#
# Amit SZÁNDÉKOSAN NEM csinál (a régi deploy-to-prod.sh-val ellentétben):
#   - nem commitol, nem tagel, nem pushol (release-publikálás = emberi döntés);
#   - nem nyúl a futó szolgáltatáshoz és a deploy-célkönyvtárhoz;
#   - egyetlen kapu-hibát sem nyel le (nincs `|| echo`, nincs 2>/dev/null).
#
# Használat:
#   bash scripts/deploy/build-release.sh --config <konfigfájl> [--dry-run]
#
# Kimenet (géppel parszolható zárósorok sikernél):
#   ARTIFACT=<tar.gz teljes útvonala>
#   RELEASE_ID=<azonosító>
#
# Exit code-ok: 0 siker | 2 konfig/használati hiba | 10 kapu- vagy csomagolási hiba.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
Használat: build-release.sh --config <konfigfájl> [--dry-run]

  --config <fájl>  Kötelező. Sablon: scripts/deploy/deploy.config.example.sh
  --dry-run        Csak a tervet írja ki; SEMMIT nem futtat és nem ír.
EOF
}

CONFIG_FILE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      [ $# -ge 2 ] || die 2 "A --config kapcsolóhoz fájlnév kell."
      CONFIG_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 2 "Ismeretlen argumentum: $1" ;;
  esac
done

load_config "$CONFIG_FILE" build

# --- Release-azonosító: UTC időbélyeg (ms-felbontás) + git commit hash ------
TS="$(date -u +%Y%m%d-%H%M%S-%3N)"
GITHASH=""
if GITHASH="$(git -C "$SERVICE_DIR" rev-parse --short HEAD 2>/dev/null)"; then
  GITHASH="g${GITHASH}"
else
  GITHASH="nogit"
  log_warn "A SERVICE_DIR nem git-munkakönyvtár — a release-azonosítóban 'nogit' szerepel (hermetikus tesztkörnyezetben ez normális)."
fi
RELEASE_ID="${TS}-${GITHASH}"
ARTIFACT_PATH="$ARTIFACT_DIR/${SERVICE_NAME}-${RELEASE_ID}.tar.gz"

# --- Dry-run: terv kiírása, semmilyen írás/futtatás -------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN — a release-készítés terve (SEMMI nem fut le, SEMMI nem íródik):"
  log "  service:      $SERVICE_NAME"
  log "  forrás:       $SERVICE_DIR"
  log "  release id:   $RELEASE_ID"
  log "  1. kapu:      typecheck: $BUILD_TYPECHECK_CMD"
  log "  2. kapu:      teszt:     $BUILD_TEST_CMD"
  log "  3. kapu:      audit:     $BUILD_AUDIT_CMD"
  log "  4. kapu:      build:     $BUILD_CMD"
  log "  artifact-tartalom: $ARTIFACT_INCLUDE (+ RELEASE_ID, manifest.json)"
  log "  artifact:     $ARTIFACT_PATH"
  log "DRY-RUN vége — kapu nem futott, artifact nem készült."
  exit 0
fi

# --- Élő build: napló + kapuk sorban, bármely hiba azonnali stop ------------
mkdir -p "$ARTIFACT_DIR/logs" || die 2 "Az ARTIFACT_DIR nem hozható létre: $ARTIFACT_DIR"
LOG_FILE="$ARTIFACT_DIR/logs/build-${RELEASE_ID}.log"
: > "$LOG_FILE" || die 2 "A build-napló nem írható: $LOG_FILE"
log "release-készítés indul — id: $RELEASE_ID, napló: $LOG_FILE"

run_step "typecheck" "$BUILD_TYPECHECK_CMD" "$SERVICE_DIR" \
  || die 10 "A typecheck kapu hibázott — release-készítés MEGSZAKÍTVA, artifact nem készült."
run_step "teszt" "$BUILD_TEST_CMD" "$SERVICE_DIR" \
  || die 10 "A teszt kapu hibázott — release-készítés MEGSZAKÍTVA, artifact nem készült."
run_step "audit" "$BUILD_AUDIT_CMD" "$SERVICE_DIR" \
  || die 10 "Az audit kapu hibázott — release-készítés MEGSZAKÍTVA, artifact nem készült."
run_step "build" "$BUILD_CMD" "$SERVICE_DIR" \
  || die 10 "A build kapu hibázott — release-készítés MEGSZAKÍTVA, artifact nem készült."

# --- Artifact összeállítása (staging → tar.gz) ------------------------------
STAGE="$(mktemp -d)" || die 10 "Ideiglenes staging-könyvtár nem hozható létre."
trap 'rm -rf "$STAGE"' EXIT

for item in $ARTIFACT_INCLUDE; do
  src="$SERVICE_DIR/$item"
  [ -e "$src" ] || die 10 "Az artifact-összetevő hiányzik a build után: $src (ARTIFACT_INCLUDE: '$ARTIFACT_INCLUDE')"
  mkdir -p "$STAGE/$(dirname "$item")" || die 10 "Staging-alkönyvtár nem hozható létre: $item"
  cp -a "$src" "$STAGE/$(dirname "$item")/" || die 10 "Másolás sikertelen: $src"
done

printf '%s\n' "$RELEASE_ID" > "$STAGE/RELEASE_ID" || die 10 "RELEASE_ID fájl írása sikertelen."
cat > "$STAGE/manifest.json" <<EOF || die 10 "manifest.json írása sikertelen."
{
  "release_id": "$RELEASE_ID",
  "service_name": "$SERVICE_NAME",
  "git_commit": "$GITHASH",
  "created_utc": "$(_log_ts)",
  "built_on": "$(uname -s)/$(uname -m)",
  "artifact_include": "$ARTIFACT_INCLUDE"
}
EOF

tar -czf "$ARTIFACT_PATH" -C "$STAGE" . || die 10 "Az artifact csomagolása (tar) sikertelen: $ARTIFACT_PATH"
SHA256="$(sha256sum "$ARTIFACT_PATH" | cut -d' ' -f1)" || SHA256="(sha256 nem elérhető)"

log "release-artifact KÉSZ: $ARTIFACT_PATH"
log "  sha256: $SHA256"
log "  napló:  $LOG_FILE"
echo "ARTIFACT=$ARTIFACT_PATH"
echo "RELEASE_ID=$RELEASE_ID"
exit 0
