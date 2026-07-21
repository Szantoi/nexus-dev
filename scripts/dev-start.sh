#!/bin/bash
# DEV környezet indítása - izolált a production-től

set -e

cd /opt/nexus-dev/knowledge-service

# Ellenőrzés: production fut-e?
if lsof -i :3456 -t >/dev/null 2>&1; then
    echo "✓ Production fut port 3456-on (nem bántjuk)"
else
    echo "⚠ Production NEM fut - ez OK dev módban"
fi

# Dev data mappa
mkdir -p data

# Dev env betöltése — a .env.dev lokális runtime fájl (gitre nem kerül).
# Ha hiányzik, a verziókezelt sablonból kell létrehozni.
if [ ! -f .env.dev ]; then
    echo "HIBA: .env.dev nem található ebben a mappában: $(pwd)" >&2
    echo "Hozd létre a verziókezelt sablonból:" >&2
    echo "    cp .env.dev.example .env.dev" >&2
    echo "majd igazítsd a lokális értékeket, és indítsd újra." >&2
    exit 1
fi
export $(grep -v '^#' .env.dev | xargs)

echo "🔧 DEV mód indítása..."
echo "   Port: $PORT"
echo "   Data: $DATA_DIR"
echo "   Telegram: DISABLED"
echo "   Nightwatch: DISABLED"
echo ""

# Build ha szükséges
if [ ! -d "dist" ] || [ "src" -nt "dist" ]; then
    echo "📦 Building..."
    npm run build
fi

# Indítás
echo "🚀 Starting dev server on port $PORT..."
node dist/server.js
