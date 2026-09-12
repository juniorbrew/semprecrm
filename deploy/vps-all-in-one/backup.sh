#!/usr/bin/env bash
# Dump diário do Postgres do Supabase self-hosted + tar do Storage.
# Agende no cron do root:  0 3 * * * /var/www/semprecrm/deploy/vps-all-in-one/backup.sh
set -euo pipefail
DEST=/var/backups/semprecrm
KEEP_DAYS=14
STAMP=$(date +%F_%H%M)
mkdir -p "$DEST"
docker exec supabase-db pg_dumpall -U postgres --clean --if-exists | gzip -9 > "$DEST/db_$STAMP.sql.gz"
tar -C /opt/supabase/volumes -czf "$DEST/storage_$STAMP.tar.gz" storage
# Credenciais das sessões WhatsApp por QR (wa-gateway). Sem elas, cada conta
# precisa escanear o QR de novo depois de restaurar a VPS.
if [ -d /var/lib/semprecrm/wa ]; then
  tar -C /var/lib/semprecrm -czf "$DEST/wa_sessions_$STAMP.tar.gz" wa
fi
find "$DEST" -type f -mtime +"$KEEP_DAYS" -delete
echo "backup ok $STAMP: $(du -sh "$DEST" | cut -f1) em $DEST"
# Copie $DEST para fora da VPS (rclone para um bucket S3/B2/Drive) — backup na
# mesma máquina não protege contra perda da VPS.
