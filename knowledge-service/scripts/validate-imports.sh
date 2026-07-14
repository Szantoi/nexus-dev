#!/bin/bash
# Validate TypeScript imports - prevent .js/.ts extensions
# Usage: ./scripts/validate-imports.sh

set -e

REPO_ROOT="/opt/spaceos/spaceos-nexus/knowledge-service"
SRC_DIR="$REPO_ROOT/src"

echo "[Import Validator] Checking for .js/.ts extensions in imports..."

# Check for .js or .ts extensions in import/from statements
INVALID_IMPORTS=$(grep -r "from ['\"].*\.\(js\|ts\)['\"]" "$SRC_DIR" --include="*.ts" || true)

if [ -n "$INVALID_IMPORTS" ]; then
  echo "❌ FAIL: Found TypeScript imports with .js/.ts extensions:"
  echo "$INVALID_IMPORTS"
  echo ""
  echo "Fix: Remove .js/.ts extensions from imports:"
  echo "  WRONG: import { foo } from './bar.js';"
  echo "  RIGHT: import { foo } from './bar';"
  exit 1
fi

echo "✅ PASS: No .js/.ts extensions found in imports"
exit 0
