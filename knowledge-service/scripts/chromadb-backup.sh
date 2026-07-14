#!/usr/bin/env bash
# ChromaDB Backup Script
# Runs daily via cron: 0 3 * * * /opt/spaceos/spaceos-nexus/knowledge-service/scripts/chromadb-backup.sh

set -euo pipefail

BACKUP_DIR="/opt/spaceos/backups/chromadb"
CHROMA_DATA="/var/lib/chromadb"
RETENTION_DAYS=7
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/chromadb_${TIMESTAMP}.tar.gz"

# Telegram notification (optional)
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-}"

notify() {
  local msg="$1"
  if [[ -n "$TELEGRAM_TOKEN" && -n "$TELEGRAM_CHAT" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT}" \
      -d "text=${msg}" \
      -d "parse_mode=Markdown" > /dev/null 2>&1 || true
  fi
  echo "$msg"
}

# Create backup directory if not exists
mkdir -p "$BACKUP_DIR"

# Check if ChromaDB data exists
if [[ ! -d "$CHROMA_DATA" ]]; then
  notify "⚠️ ChromaDB backup: Data directory not found: $CHROMA_DATA"
  exit 1
fi

# Create backup
echo "Creating ChromaDB backup..."
tar -czf "$BACKUP_FILE" -C "$(dirname "$CHROMA_DATA")" "$(basename "$CHROMA_DATA")" 2>/dev/null

# Get backup size
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

# Clean up old backups
echo "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "chromadb_*.tar.gz" -mtime +${RETENTION_DAYS} -delete

# Count remaining backups
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "chromadb_*.tar.gz" | wc -l)

notify "✅ ChromaDB backup completed
📦 Size: ${BACKUP_SIZE}
📁 File: $(basename "$BACKUP_FILE")
🗂️ Retained: ${BACKUP_COUNT} backups"

echo "Backup completed: $BACKUP_FILE"
