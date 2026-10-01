#!/usr/bin/env bash
# Confere se o backup da noite existe: sai com código != 0 (e diz o motivo)
# quando o db_* mais novo tem mais de BACKUP_MAX_AGE_H horas (padrão 26) ou é
# pequeno demais (BACKUP_MIN_BYTES, padrão 50000). Sem efeitos colaterais.
#   sudo bash /var/www/semprecrm/deploy/vps-all-in-one/backup-check.sh
# Dá para pendurar num monitor/cron que avise por e-mail quando falhar.
set -euo pipefail
DEST="${BACKUP_DEST:-/var/backups/semprecrm}"
MAX_AGE_H="${BACKUP_MAX_AGE_H:-26}"
MIN_BYTES="${BACKUP_MIN_BYTES:-50000}"

newest=$(find "$DEST" -maxdepth 1 -type f -name 'db_*' ! -name '*.part' -printf '%T@ %s %p\n' 2>/dev/null \
  | sort -n | tail -1 || true)
if [ -z "$newest" ]; then
  echo "FALHA: nenhum backup db_* em $DEST" >&2
  exit 1
fi
read -r mtime size path <<<"$newest"
age_h=$(( ($(date +%s) - ${mtime%.*}) / 3600 ))

rc=0
if [ "$age_h" -ge "$MAX_AGE_H" ]; then
  echo "FALHA: backup mais novo tem ${age_h}h (limite ${MAX_AGE_H}h): $path" >&2
  rc=1
fi
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "FALHA: backup mais novo tem só ${size} bytes (mínimo ${MIN_BYTES}): $path" >&2
  rc=1
fi
[ -f "$DEST/LAST_OK" ] && echo "LAST_OK: $(cat "$DEST/LAST_OK")"
[ "$rc" -eq 0 ] && echo "ok: $path (${size} bytes, ${age_h}h)"
exit "$rc"
