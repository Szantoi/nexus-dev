#!/usr/bin/env bash
# scripts/deploy/deploy.config.example.sh — DEPLOY-KONFIG SABLON (verziókezelt).
#
# Használat:
#   cp scripts/deploy/deploy.config.example.sh scripts/deploy/deploy.config.sh
#   # töltsd ki a célkörnyezet értékeivel — a deploy.config.sh gitignore-olt!
#
# Minden kulcs felülírható NEXUS_DEPLOY_<KULCS> környezeti változóval is
# (pl. NEXUS_DEPLOY_HEALTH_RETRIES=10). Hiányzó/érvénytelen érték esetén a
# scriptek azonnal, érthető hibával leállnak (exit 2).
#
# Az alábbi példaértékek a VPS-en futó nexus-dev knowledge-service-hez
# igazodnak (systemd: nexus-dev-ks, tailnet-only bind) — ÁLLÍTSD BE a saját
# célkörnyezetedre!

# --- Azonosítás -------------------------------------------------------------

# A szolgáltatás neve — naplókban és az artifact fájlnevében jelenik meg.
SERVICE_NAME="nexus-dev-ks"

# --- Build / release-előkészítés (build-release.sh) -------------------------

# A forráskönyvtár, amiben a kapuk (typecheck/teszt/audit/build) futnak.
SERVICE_DIR="/opt/nexus-dev/knowledge-service"

# Ide kerülnek a kész, azonosítható release-artifactok (<SERVICE_NAME>-<RELEASE_ID>.tar.gz)
# és a build-naplók (logs/build-<RELEASE_ID>.log).
ARTIFACT_DIR="/opt/nexus-dev/deploy-artifacts"

# A négy minőségi kapu parancsai — BÁRMELYIK hibája azonnal leállítja a
# release-készítést (nincs lenyelt exit code). A parancsok a SERVICE_DIR-ben,
# bash -c alatt futnak.
BUILD_TYPECHECK_CMD="npm run typecheck"
BUILD_TEST_CMD="npm test"
BUILD_AUDIT_CMD="npm audit --omit=dev --audit-level=high"
BUILD_CMD="npm run build"

# Mi kerüljön az artifactba (a SERVICE_DIR-hez képest, szóközzel elválasztva).
# A node_modules szándékosan NINCS benne: a deploy oldalon a POST_UNPACK_CMD
# telepíti a production függőségeket (natív modulok miatt a célgépen kell).
ARTIFACT_INCLUDE="dist package.json package-lock.json"

# --- Deploy (deploy-release.sh) ---------------------------------------------

# A verziózott release-fa gyökere a célgépen:
#   $DEPLOY_ROOT/releases/<RELEASE_ID>/  — minden telepített release megmarad
#   $DEPLOY_ROOT/current                 — az aktív release (symlink vagy másolat)
#   $DEPLOY_ROOT/current.release-id      — az aktív release azonosítója
#   $DEPLOY_ROOT/logs/deploy-*.log       — deploy-naplók
# A systemd unit WorkingDirectory-ja a $DEPLOY_ROOT/current-re mutasson
# (egyszeri kézi előkészítés a célgépen — lásd scripts/deploy/README.md).
DEPLOY_ROOT="/opt/nexus-dev/ks-deploy"

# Service leállítás/indítás — a célgép service-kezelőjéhez igazítva.
SERVICE_STOP_CMD="sudo systemctl stop nexus-dev-ks"
SERVICE_START_CMD="sudo systemctl start nexus-dev-ks"

# Opcionális: a frissen kicsomagolt release-könyvtárban, MÉG a service
# leállítása ELŐTT fut (hibája ártalmatlanul megszakítja a deployt).
# Tipikusan a production függőségek telepítése. Üres = kihagyva.
POST_UNPACK_CMD="npm ci --omit=dev"

# --- Health-check -----------------------------------------------------------

# A health-endpoint URL-je a célgépről nézve (tailnet-bind esetén a tailnet-cím!).
HEALTH_URL="http://127.0.0.1:3466/health"

# Ezt a fix stringet keressük a válasz-body-ban (nem regex).
HEALTH_EXPECT="\"status\":\"ok\""

# Kérésenkénti timeout, próbálkozások száma, köztük várakozás (másodperc).
HEALTH_TIMEOUT_SECONDS="5"
HEALTH_RETRIES="5"
HEALTH_RETRY_DELAY_SECONDS="3"

# Ennyit várunk a service-indítás után az első health-próba előtt (másodperc).
START_GRACE_SECONDS="3"

# --- Release-váltás módja ---------------------------------------------------

# symlink — Linux célgépen ez az ajánlott (atomikus, gyors); a scriptek
#           readlinkkel IGAZOLJÁK, hogy valódi symlink jött létre.
# copy    — symlinket nem támogató fájlrendszerhez (pl. Windows Git Bash teszt).
SWITCH_MODE="symlink"
