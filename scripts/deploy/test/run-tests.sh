#!/usr/bin/env bash
# scripts/deploy/test/run-tests.sh — HERMETIKUS teszt-szuite a deploy-scriptekhez.
#
# Semmilyen valós szolgáltatáshoz, VPS-hez vagy a repó fájljaihoz nem nyúl:
#   - minden fájlművelet egy ideiglenes gyökér (mktemp -d) alatt történik;
#   - a "service" leállítás/indítás mock-scriptek (parancsnaplóval);
#   - a health-endpoint egy lokális mock Node HTTP-szerver (véletlen port),
#     amelynek egészségi állapotát egy állapotfájl vezérli — a mock
#     service-start a telepített release health.mode fájljából állítja be,
#     így a "beteg release" életszerűen szimulálható.
#
# Lefedett szcenáriók (TASK-QC-004 "Kötelező ellenőrzés"):
#   S1 sikeres deploy (emberi kapu + első deploy + második deploy + post-unpack)
#   S2 build hiba → nincs artifact, prod érintetlen
#   S3 teszthiba → build nem fut le, nincs artifact, prod fájl nem változik
#   S4 első health-check hiba → automatikus rollback, rollback health OK (exit 20)
#   S5 rollback health-check hiba → kritikus jelzés (exit 21)
#   S6 hiányos/érvénytelen konfiguráció → azonnali, érthető hiba (exit 2)
#   S7 dry-run: sem a build, sem a deploy nem módosít semmit, service nem indul
#   S8 symlink-mód (feltételes: csak valódi symlinket támogató rendszeren;
#      Windows Git Bash alatt SKIP — a célkörnyezet Linux VPS)
#
# Futtatás (Git Bash / Linux):  bash scripts/deploy/test/run-tests.sh
# Kilépés: 0 = minden PASS; 1 = van FAIL.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$HERE/.." && pwd)"
BUILD_SH="$DEPLOY_DIR/build-release.sh"
DEPLOY_SH="$DEPLOY_DIR/deploy-release.sh"

# POSIX-út → a node számára is érthető út (Windows Git Bash: cygpath).
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}
# Bármilyen formátumú út → POSIX-forma (a konfig-validátor abszolút /-es utat vár).
posixpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi
}

ROOT="$(mktemp -d "${QC004_TEST_TMP:-${TMPDIR:-/tmp}}/qc004-XXXXXX")" || { echo "mktemp sikertelen"; exit 1; }
ROOT="$(posixpath "$ROOT")"
MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT

# --- Eredménykönyvelés ------------------------------------------------------
PASS=0; FAIL=0; SKIP=0
RESULTS=()
t_pass() { PASS=$((PASS + 1)); echo "  [PASS] $1"; }
t_fail() { FAIL=$((FAIL + 1)); echo "  [FAIL] $1"; }
t_skip() { SKIP=$((SKIP + 1)); RESULTS+=("SKIP  $1"); echo "  [SKIP] $1"; }
scenario() { echo ""; echo "=== $1 ==="; CURRENT_SCENARIO="$1"; SCENARIO_FAILED=0; }
scenario_end() {
  if [ "${SCENARIO_FAILED:-0}" -eq 0 ]; then RESULTS+=("PASS  $CURRENT_SCENARIO");
  else RESULTS+=("FAIL  $CURRENT_SCENARIO"); fi
}

OUT="$ROOT/last-out.txt"
expect_rc() { # <leírás> <várt exit> <kapott exit>
  if [ "$3" -eq "$2" ]; then t_pass "$1 (exit $3)"; else
    t_fail "$1 — várt exit: $2, kapott: $3"; SCENARIO_FAILED=1
    echo "      --- utolsó kimenet (részlet) ---"; tail -25 "$OUT" | sed 's/^/      | /'
  fi
}
expect() { # <leírás> <parancs...> (igaz = PASS)
  local desc="$1"; shift
  if "$@"; then t_pass "$desc"; else t_fail "$desc"; SCENARIO_FAILED=1; fi
}
expect_out_contains() { # <leírás> <fix string>
  if grep -Fq -- "$2" "$OUT"; then t_pass "$1"; else
    t_fail "$1 — a kimenet nem tartalmazza: '$2'"; SCENARIO_FAILED=1
    tail -25 "$OUT" | sed 's/^/      | /'
  fi
}

# Könyvtárfa + fájltartalmak pillanatképe (módosítás-mentesség bizonyításához).
snapshot() {
  ( cd "$1" 2>/dev/null || exit 0
    find . -print | LC_ALL=C sort
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum )
}

# --- Mock health-szerver indítása -------------------------------------------
STATE_FILE="$ROOT/health-state"
PORT_FILE="$ROOT/mock-port"
echo fail > "$STATE_FILE"
node "$(winpath "$HERE/mock-health-server.mjs")" "$(winpath "$STATE_FILE")" "$(winpath "$PORT_FILE")" &
MOCK_PID=$!
for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.2; done
[ -s "$PORT_FILE" ] || { echo "HIBA: a mock health-szerver nem indult el"; exit 1; }
MOCK_PORT="$(cat "$PORT_FILE")"
MOCK_HEALTH_URL="http://127.0.0.1:$MOCK_PORT/health"
echo "mock health-szerver: $MOCK_HEALTH_URL (pid $MOCK_PID)"

# --- Mock service-kezelő scriptek -------------------------------------------
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/mock-stop.sh" <<EOF
#!/usr/bin/env bash
# mock service stop: csak naplóz — valódi szolgáltatáshoz nem nyúl.
echo "STOP \$1" >> "\$2"
EOF
cat > "$ROOT/bin/mock-start.sh" <<EOF
#!/usr/bin/env bash
# mock service start: naplóz, és a telepített release health.mode fájlja
# alapján állítja a mock health-szerver állapotát (ok/fail) — így a
# health-check azt "látja", amit az adott release élesben produkálna.
echo "START \$1" >> "\$2"
if [ -f "\$1/current/health.mode" ]; then
  cp "\$1/current/health.mode" "$STATE_FILE"
else
  echo fail > "$STATE_FILE"
fi
EOF
chmod +x "$ROOT/bin/mock-stop.sh" "$ROOT/bin/mock-start.sh"

# --- Konfig-generátor a szcenáriókhoz ---------------------------------------
write_config() { # <konfigfájl> <svc_dir> <artifact_dir> <deploy_root> <cmdlog>
  cat > "$1" <<EOF
SERVICE_NAME="qc004-svc"
SERVICE_DIR="$2"
ARTIFACT_DIR="$3"
BUILD_TYPECHECK_CMD="echo typecheck-ok"
BUILD_TEST_CMD="echo tests-ok"
BUILD_CMD="mkdir -p dist && echo server-code > dist/server.js"
BUILD_AUDIT_CMD="echo audit-ok"
ARTIFACT_INCLUDE="dist health.mode"
DEPLOY_ROOT="$4"
SERVICE_STOP_CMD="bash $ROOT/bin/mock-stop.sh $4 $5"
SERVICE_START_CMD="bash $ROOT/bin/mock-start.sh $4 $5"
POST_UNPACK_CMD="touch post-unpack.ran"
HEALTH_URL="$MOCK_HEALTH_URL"
HEALTH_EXPECT="\"status\":\"ok\""
HEALTH_TIMEOUT_SECONDS="3"
HEALTH_RETRIES="2"
HEALTH_RETRY_DELAY_SECONDS="0"
START_GRACE_SECONDS="0"
SWITCH_MODE="copy"
EOF
}

mk_svc_dir() { # <könyvtár> <health.mode tartalma: ok|fail>
  mkdir -p "$1"
  echo "$2" > "$1/health.mode"
}

get_kv() { # <kulcs> — a legutóbbi kimenetből (OUT) olvassa a KULCS=érték sort
  grep "^$1=" "$OUT" | tail -1 | cut -d= -f2-
}

# ===========================================================================
scenario "S1 — sikeres deploy (emberi kapu, első + második release, post-unpack)"
# ===========================================================================
S1="$ROOT/s1"; mk_svc_dir "$S1/svc" ok; mkdir -p "$S1/art"
CMDLOG1="$S1/svc-cmd.log"; : > "$CMDLOG1"
C1="$S1/deploy.config.sh"
write_config "$C1" "$S1/svc" "$S1/art" "$S1/droot" "$CMDLOG1"

bash "$BUILD_SH" --config "$C1" > "$OUT" 2>&1; RC=$?
expect_rc "build-release: sikeres artifact-készítés" 0 "$RC"
ART_A="$(get_kv ARTIFACT)"; REL_A="$(get_kv RELEASE_ID)"
expect "az artifact fájl létezik: $(basename "${ART_A:-nincs}")" test -f "${ART_A:-/nonexistent}"
expect "a build-napló elkészült" test -f "$S1/art/logs/build-${REL_A:-x}.log"

bash "$DEPLOY_SH" --config "$C1" --artifact "$ART_A" < /dev/null > "$OUT" 2>&1; RC=$?
expect_rc "emberi kapu: --confirm nélkül elutasít" 2 "$RC"
expect_out_contains "az elutasítás megnevezi a --confirm kapcsolót" "--confirm"
expect "elutasítás után a deploy-gyökér nem jött létre" test ! -e "$S1/droot"

printf 'no\n' | bash "$DEPLOY_SH" --config "$C1" --artifact "$ART_A" --confirm > "$OUT" 2>&1; RC=$?
expect_rc "emberi kapu: 'no' válaszra megszakít" 2 "$RC"
expect "'no' után a deploy-gyökér nem jött létre" test ! -e "$S1/droot"

printf 'yes\n' | bash "$DEPLOY_SH" --config "$C1" --artifact "$ART_A" --confirm > "$OUT" 2>&1; RC=$?
expect_rc "első deploy 'yes' megerősítéssel sikeres" 0 "$RC"
expect_out_contains "RESULT=deployed a kimenetben" "RESULT=deployed"
expect "current/RELEASE_ID = $REL_A" grep -qx "$REL_A" "$S1/droot/current/RELEASE_ID"
expect "current.release-id = $REL_A" grep -qx "$REL_A" "$S1/droot/current.release-id"
expect "releases/$REL_A megőrizve" test -d "$S1/droot/releases/$REL_A"
expect "POST_UNPACK_CMD lefutott (post-unpack.ran a current-ben)" test -f "$S1/droot/current/post-unpack.ran"
expect "service stop naplózva" grep -q "^STOP" "$CMDLOG1"
expect "service start naplózva" grep -q "^START" "$CMDLOG1"
DLOGS1=("$S1"/droot/logs/deploy-*.log)
expect "deploy-napló készült és rögzíti a sikert" grep -q "DEPLOY SIKERES" "${DLOGS1[0]}"

sleep 1 # a release-id ms-felbontású — biztosan új id-t kapjunk
bash "$BUILD_SH" --config "$C1" > "$OUT" 2>&1; RC=$?
expect_rc "második artifact build" 0 "$RC"
ART_B="$(get_kv ARTIFACT)"; REL_B="$(get_kv RELEASE_ID)"
printf 'yes\n' | bash "$DEPLOY_SH" --config "$C1" --artifact "$ART_B" --confirm > "$OUT" 2>&1; RC=$?
expect_rc "második deploy (van előző release) sikeres" 0 "$RC"
expect_out_contains "backup-ellenőrzés lefutott az előző release-re" "backup ellenőrizve"
expect "current a második release-re áll: $REL_B" grep -qx "$REL_B" "$S1/droot/current.release-id"
expect "az előző release ($REL_A) megmaradt rollback-célpontnak" test -d "$S1/droot/releases/$REL_A"
scenario_end

# ===========================================================================
scenario "S2 — build hiba: azonnali stop, nincs artifact, prod érintetlen"
# ===========================================================================
S2="$ROOT/s2"; mk_svc_dir "$S2/svc" ok; mkdir -p "$S2/art"
C2="$S2/deploy.config.sh"
write_config "$C2" "$S2/svc" "$S2/art" "$S2/droot" "$S2/svc-cmd.log"
echo 'BUILD_CMD="echo build-torik >&2; exit 1"' >> "$C2"

bash "$BUILD_SH" --config "$C2" > "$OUT" 2>&1; RC=$?
expect_rc "build hiba → exit 10" 10 "$RC"
expect_out_contains "a hibaüzenet megnevezi a build kaput" "A build kapu hibázott"
expect "nem készült artifact (nincs .tar.gz)" bash -c "! ls '$S2/art'/*.tar.gz 2>/dev/null | grep -q ."
expect "a deploy-gyökérhez a build hozzá sem nyúlt" test ! -e "$S2/droot"
scenario_end

# ===========================================================================
scenario "S3 — teszthiba: build ki sem próbálkozik, production fájl nem változik"
# ===========================================================================
S3="$ROOT/s3"; mk_svc_dir "$S3/svc" ok; mkdir -p "$S3/art"
C3="$S3/deploy.config.sh"
write_config "$C3" "$S3/svc" "$S3/art" "$S3/droot" "$S3/svc-cmd.log"
{
  echo 'BUILD_TEST_CMD="echo teszt-torik >&2; exit 1"'
  echo 'BUILD_CMD="touch build-ran.marker"'
} >> "$C3"
# "production" előkészítése: létező deploy-fa, amin a változatlanságot mérjük
mkdir -p "$S3/droot/releases/seed"; echo seed > "$S3/droot/releases/seed/RELEASE_ID"
cp -a "$S3/droot/releases/seed" "$S3/droot/current"; echo seed > "$S3/droot/current.release-id"
SNAP_BEFORE="$(snapshot "$S3/droot")"

bash "$BUILD_SH" --config "$C3" > "$OUT" 2>&1; RC=$?
expect_rc "teszthiba → exit 10" 10 "$RC"
expect_out_contains "a hibaüzenet megnevezi a teszt kaput" "A teszt kapu hibázott"
expect "a build lépés NEM futott le a teszthiba után" test ! -e "$S3/svc/build-ran.marker"
expect "nem készült artifact" bash -c "! ls '$S3/art'/*.tar.gz 2>/dev/null | grep -q ."
SNAP_AFTER="$(snapshot "$S3/droot")"
expect "a production fa bitre azonos maradt" test "$SNAP_BEFORE" = "$SNAP_AFTER"
scenario_end

# ===========================================================================
scenario "S4 — health-check hiba az új release-en → automatikus rollback, rollback health OK"
# ===========================================================================
S4="$ROOT/s4"; mk_svc_dir "$S4/svc" ok; mkdir -p "$S4/art"
CMDLOG4="$S4/svc-cmd.log"; : > "$CMDLOG4"
C4="$S4/deploy.config.sh"
write_config "$C4" "$S4/svc" "$S4/art" "$S4/droot" "$CMDLOG4"

bash "$BUILD_SH" --config "$C4" > "$OUT" 2>&1; RC=$?
expect_rc "egészséges release (A) build" 0 "$RC"
ART_A4="$(get_kv ARTIFACT)"; REL_A4="$(get_kv RELEASE_ID)"
printf 'yes\n' | bash "$DEPLOY_SH" --config "$C4" --artifact "$ART_A4" --confirm > "$OUT" 2>&1; RC=$?
expect_rc "egészséges release (A) deploy" 0 "$RC"

echo fail > "$S4/svc/health.mode"   # a következő release "beteg" lesz
sleep 1
bash "$BUILD_SH" --config "$C4" > "$OUT" 2>&1; RC=$?
expect_rc "beteg release (B) build" 0 "$RC"
ART_B4="$(get_kv ARTIFACT)"; REL_B4="$(get_kv RELEASE_ID)"
printf 'yes\n' | bash "$DEPLOY_SH" --config "$C4" --artifact "$ART_B4" --confirm > "$OUT" 2>&1; RC=$?
expect_rc "beteg deploy → rollback után exit 20" 20 "$RC"
expect_out_contains "az automatikus rollback elindult" "AUTOMATIKUS ROLLBACK indul"
expect_out_contains "a rollback utáni health-check lefutott és naplózott" "health-check (rollback) OK"
expect_out_contains "RESULT=rolled-back a kimenetben" "RESULT=rolled-back"
expect "current visszaállt az előző release-re ($REL_A4)" grep -qx "$REL_A4" "$S4/droot/current.release-id"
expect "a visszaállított current egészséges változat" grep -qx "ok" "$S4/droot/current/health.mode"
expect "a hibás release ($REL_B4) megőrizve vizsgálatra" test -d "$S4/droot/releases/$REL_B4"
DLOG4="$(ls -t "$S4"/droot/logs/deploy-*.log | head -1)"
expect "a deploy-napló rögzíti a rollback sikerét" grep -q "ROLLBACK SIKERES" "$DLOG4"
expect "a naplóban a rollback health-check is szerepel" grep -q "health-check (rollback)" "$DLOG4"
scenario_end

# ===========================================================================
scenario "S5 — a rollback utáni health-check is hibázik → kritikus jelzés (exit 21)"
# ===========================================================================
S5="$ROOT/s5"; mk_svc_dir "$S5/svc" fail; mkdir -p "$S5/art"
C5="$S5/deploy.config.sh"
write_config "$C5" "$S5/svc" "$S5/art" "$S5/droot" "$S5/svc-cmd.log"
# Kézzel "telepített" korábbi release, amely maga is beteg (health.mode=fail):
mkdir -p "$S5/droot/releases/relA/dist"
printf 'relA\n' > "$S5/droot/releases/relA/RELEASE_ID"
echo fail > "$S5/droot/releases/relA/health.mode"
cp -a "$S5/droot/releases/relA" "$S5/droot/current"
printf 'relA\n' > "$S5/droot/current.release-id"

bash "$BUILD_SH" --config "$C5" > "$OUT" 2>&1; RC=$?
expect_rc "beteg release (B) build" 0 "$RC"
ART_B5="$(get_kv ARTIFACT)"
printf 'yes\n' | bash "$DEPLOY_SH" --config "$C5" --artifact "$ART_B5" --confirm > "$OUT" 2>&1; RC=$?
expect_rc "deploy + sikertelen rollback-health → exit 21" 21 "$RC"
expect_out_contains "a rollback megtörtént, de a health-check újra hibázott" "ROLLBACK UTÁNI health-check IS SIKERTELEN"
expect_out_contains "kézi beavatkozást kér" "KÉZI BEAVATKOZÁS"
expect_out_contains "RESULT=rollback-unhealthy a kimenetben" "RESULT=rollback-unhealthy"
expect "a current a visszaállított (relA) release-en áll" grep -qx "relA" "$S5/droot/current.release-id"
scenario_end

# ===========================================================================
scenario "S6 — hiányos vagy érvénytelen konfiguráció → azonnali, érthető hiba"
# ===========================================================================
S6="$ROOT/s6"; mk_svc_dir "$S6/svc" ok; mkdir -p "$S6/art"
C6="$S6/deploy.config.sh"

write_config "$C6" "$S6/svc" "$S6/art" "$S6/droot" "$S6/svc-cmd.log"
echo 'HEALTH_URL=""' >> "$C6"
bash "$DEPLOY_SH" --config "$C6" --artifact "$ROOT/nincs.tar.gz" --confirm < /dev/null > "$OUT" 2>&1; RC=$?
expect_rc "hiányzó HEALTH_URL → exit 2" 2 "$RC"
expect_out_contains "a hibaüzenet megnevezi a hiányzó kulcsot" "HEALTH_URL"
expect "hibás konfignál semmi nem jött létre" test ! -e "$S6/droot"

write_config "$C6" "$S6/svc" "$S6/art" "$S6/droot" "$S6/svc-cmd.log"
echo 'HEALTH_RETRIES="sok"' >> "$C6"
bash "$DEPLOY_SH" --config "$C6" --artifact "$ROOT/nincs.tar.gz" --confirm < /dev/null > "$OUT" 2>&1; RC=$?
expect_rc "nem-szám HEALTH_RETRIES → exit 2" 2 "$RC"
expect_out_contains "a hibaüzenet a HEALTH_RETRIES értékét kifogásolja" "HEALTH_RETRIES"

write_config "$C6" "$S6/svc" "$S6/art" "$S6/droot" "$S6/svc-cmd.log"
echo 'SWITCH_MODE="tukor"' >> "$C6"
bash "$DEPLOY_SH" --config "$C6" --artifact "$ROOT/nincs.tar.gz" --confirm < /dev/null > "$OUT" 2>&1; RC=$?
expect_rc "érvénytelen SWITCH_MODE → exit 2" 2 "$RC"
expect_out_contains "a hibaüzenet felsorolja a megengedett értékeket" "symlink copy"

write_config "$C6" "$ROOT/nem-letezo-forras" "$S6/art" "$S6/droot" "$S6/svc-cmd.log"
bash "$BUILD_SH" --config "$C6" > "$OUT" 2>&1; RC=$?
expect_rc "nem létező SERVICE_DIR a buildnél → exit 2" 2 "$RC"

bash "$DEPLOY_SH" --config "$ROOT/nincs-ilyen-konfig.sh" --artifact "$ROOT/nincs.tar.gz" < /dev/null > "$OUT" 2>&1; RC=$?
expect_rc "nem létező konfigfájl → exit 2" 2 "$RC"
expect_out_contains "a hibaüzenet a sablonra mutat" "deploy.config.example.sh"
scenario_end

# ===========================================================================
scenario "S7 — dry-run: semmit nem módosít és nem indít szolgáltatást"
# ===========================================================================
# Az S1 kész deploy-fáját használjuk célpontnak — azon mérjük a változatlanságot.
sleep 1
bash "$BUILD_SH" --config "$C1" > "$OUT" 2>&1; RC=$?
expect_rc "friss artifact a dry-run teszthez" 0 "$RC"
ART_C="$(get_kv ARTIFACT)"

SNAP_DROOT="$(snapshot "$S1/droot")"
SNAP_SVC="$(snapshot "$S1/svc")"
SNAP_ART="$(snapshot "$S1/art")"
CMDLOG_BEFORE="$(cat "$CMDLOG1")"
STATE_BEFORE="$(cat "$STATE_FILE")"

bash "$DEPLOY_SH" --config "$C1" --artifact "$ART_C" --dry-run < /dev/null > "$OUT" 2>&1; RC=$?
expect_rc "deploy --dry-run lefut (megerősítés nélkül is)" 0 "$RC"
expect_out_contains "a kimenet jelzi a dry-run módot" "DRY-RUN"
expect_out_contains "a terv megnevezi a rollback-célpontot" "erre állnánk vissza"

bash "$BUILD_SH" --config "$C1" --dry-run > "$OUT" 2>&1; RC=$?
expect_rc "build --dry-run lefut" 0 "$RC"
expect_out_contains "a build-terv jelzi, hogy semmi nem készült" "artifact nem készült"

expect "a deploy-fa bitre azonos maradt" test "$SNAP_DROOT" = "$(snapshot "$S1/droot")"
expect "a forráskönyvtár változatlan" test "$SNAP_SVC" = "$(snapshot "$S1/svc")"
expect "az artifact-könyvtár változatlan" test "$SNAP_ART" = "$(snapshot "$S1/art")"
expect "service stop/start NEM hívódott" test "$CMDLOG_BEFORE" = "$(cat "$CMDLOG1")"
expect "a health-állapot érintetlen (health-check sem futott)" test "$STATE_BEFORE" = "$(cat "$STATE_FILE")"
scenario_end

# ===========================================================================
scenario "S8 — symlink-mód (csak valódi symlinket támogató rendszeren)"
# ===========================================================================
rm -f "$ROOT/slt"; ln -s "$ROOT/bin" "$ROOT/slt" 2>/dev/null
if [ -h "$ROOT/slt" ]; then
  S8="$ROOT/s8"; mk_svc_dir "$S8/svc" ok; mkdir -p "$S8/art"
  C8="$S8/deploy.config.sh"
  write_config "$C8" "$S8/svc" "$S8/art" "$S8/droot" "$S8/svc-cmd.log"
  echo 'SWITCH_MODE="symlink"' >> "$C8"
  bash "$BUILD_SH" --config "$C8" > "$OUT" 2>&1; RC=$?
  expect_rc "symlink-módú build" 0 "$RC"
  ART_S8="$(get_kv ARTIFACT)"; REL_S8="$(get_kv RELEASE_ID)"
  printf 'yes\n' | bash "$DEPLOY_SH" --config "$C8" --artifact "$ART_S8" --confirm > "$OUT" 2>&1; RC=$?
  expect_rc "symlink-módú deploy sikeres" 0 "$RC"
  expect "a current valódi symlink" test -h "$S8/droot/current"
  expect "a symlink a releases/$REL_S8 könyvtárra mutat" test "$(readlink "$S8/droot/current")" = "releases/$REL_S8"
  scenario_end
else
  t_skip "S8 — symlink-mód: ezen a rendszeren az ln -s nem hoz létre valódi symlinket (Windows Git Bash másolatot készít); a célkörnyezet Linux VPS, ott a symlink-mód él — a váltás-logika többi részét az S1–S7 copy-módban fedi."
fi
rm -rf "$ROOT/slt"

# --- Összegzés --------------------------------------------------------------
echo ""
echo "==================== ÖSSZEGZÉS ===================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "---------------------------------------------------"
echo "  ellenőrzés: $PASS PASS, $FAIL FAIL, $SKIP SKIP"
echo "==================================================="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
