#!/bin/bash
# ⚠️ ELAVULT — CSAK DOKUMENTÁLT VÉSZHELYZETI FALLBACK (TASK-QC-004, 2026-07-18).
#
# Ezt a scriptet a scripts/deploy/ alatti biztonságos deploy-lánc váltotta ki:
#   scripts/deploy/build-release.sh   — release-előkészítés (typecheck+teszt+audit+build → artifact)
#   scripts/deploy/deploy-release.sh  — verziózott deploy + automatikus rollback + health-check
# Ismert hibái (ezért NE használd normál esetben): lenyeli a teszthibát
# (`npm test 2>/dev/null || echo`), deploy közben commitol/tagel/pushol,
# hardcodolt útvonalak/port, health-hibánál csak kézi rollback-parancsot ír ki.
# TÖRLÉSÉHEZ KÜLÖN EMBERI JÓVÁHAGYÁS KELL — addig vészhelyzeti tartalék.
#
# MILESTONE DEPLOY - Dev → Production
# CSAK mérföldköveknél használd!

set -e

echo "╔════════════════════════════════════════════╗"
echo "║     NEXUS PRODUCTION DEPLOY                ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# Confirmation
read -p "⚠️  Ez PRODUCTION deploy! Biztos? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo "Megszakítva."
    exit 1
fi

# Version tag
VERSION=$(date +%Y%m%d-%H%M)
echo "📌 Version: $VERSION"

cd /opt/nexus-dev/knowledge-service

# 1. Build
echo ""
echo "📦 Building..."
npm run build

# 2. Tests (ha vannak)
echo ""
echo "🧪 Running tests..."
npm test 2>/dev/null || echo "⚠ No tests or tests skipped"

# 3. Git commit & tag
echo ""
echo "🏷️  Creating release tag..."
git add -A
git commit -m "Release $VERSION" 2>/dev/null || echo "No changes to commit"
git tag -a "v$VERSION" -m "Release $VERSION" 2>/dev/null || true
git push origin main --tags 2>/dev/null || echo "⚠ Push skipped"

# 4. Stop production
echo ""
echo "🛑 Stopping production..."
lsof -i :3456 -t | xargs kill 2>/dev/null || true
sleep 2

# 5. Backup current prod
echo ""
echo "💾 Backing up production..."
BACKUP_DIR="/opt/nexus/backups/$VERSION"
mkdir -p "$BACKUP_DIR"
cp -r /opt/nexus/src/nexus-core/knowledge-service/dist "$BACKUP_DIR/" 2>/dev/null || true
cp -r /opt/nexus/src/nexus-core/knowledge-service/src "$BACKUP_DIR/" 2>/dev/null || true

# 6. Deploy
echo ""
echo "🚀 Deploying to production..."
cp -r dist/* /opt/nexus/src/nexus-core/knowledge-service/dist/
cp -r src/* /opt/nexus/src/nexus-core/knowledge-service/src/

# 7. Restart production
echo ""
echo "▶️  Starting production..."
cd /opt/nexus/src/nexus-core/knowledge-service
nohup node dist/server.js > /opt/nexus/logs/knowledge-service.log 2>&1 &
sleep 3

# 8. Health check
echo ""
if curl -s http://localhost:3456/health | grep -q "ok"; then
    echo "✅ Production HEALTHY on port 3456"
else
    echo "❌ Production health check FAILED!"
    echo "   Rollback: cp -r $BACKUP_DIR/dist/* /opt/nexus/src/nexus-core/knowledge-service/dist/"
    exit 1
fi

echo ""
echo "════════════════════════════════════════════"
echo "✅ Deploy complete: v$VERSION"
echo "   Backup: $BACKUP_DIR"
echo "════════════════════════════════════════════"
