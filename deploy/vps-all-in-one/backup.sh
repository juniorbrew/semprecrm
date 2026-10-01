#!/usr/bin/env bash
# Backup diário: dump do Postgres do Supabase self-hosted, tar do Storage e das
# sessões do wa-gateway. Agende no cron do root SEMPRE chamando o bash (não
# dependa do bit de execução do arquivo, que um checkout pode perder):
#   0 3 * * * /bin/bash /var/www/semprecrm/deploy/vps-all-in-one/backup.sh >> /var/log/semprecrm/backup.log 2>&1
# Confira com backup-check.sh (mesma pasta). Runbook: README.md, "Backups".
#
# Configuração opcional em /etc/semprecrm/backup.env (root, chmod 600) ou no
# ambiente:
#   BACKUP_AGE_RECIPIENT  chave pública age (age1...). Com ela tudo sai cifrado
#                         (.age) e nenhum arquivo em texto puro é gravado. A
#                         chave privada NUNCA fica na VPS.
#   BACKUP_RCLONE_REMOTE  destino rclone (ex.: b2:semprecrm-backup/vps). Exige
#                         BACKUP_AGE_RECIPIENT: só arquivos cifrados saem da VPS.
#   BACKUP_DEST           pasta local (padrão /var/backups/semprecrm)
set -euo pipefail
umask 077

ENV_FILE="${BACKUP_ENV_FILE:-/etc/semprecrm/backup.env}"
# shellcheck disable=SC1090
if [ -f "$ENV_FILE" ]; then . "$ENV_FILE"; fi

DEST="${BACKUP_DEST:-/var/backups/semprecrm}"
KEEP_DAYS=14
STAMP=$(date +%F_%H%M)
STORAGE_DIR="${BACKUP_STORAGE_DIR:-/opt/supabase/volumes/storage}"  # montado no container como /var/lib/storage
WA_DIR="${BACKUP_WA_DIR:-/var/lib/semprecrm/wa}"  # WA_DATA_DIR do wa-gateway (PM2)
AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
EXT=""

fail() { echo "BACKUP FALHOU $STAMP: $*" >&2; exit 1; }

# Qualquer saída diferente de 0 (set -e, pipefail, set -u) apaga os parciais
# desta rodada e deixa uma mensagem clara no log. Backups antigos ficam intactos.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$DEST"/*_"$STAMP".*.part 2>/dev/null || true
    echo "BACKUP FALHOU $STAMP (código $rc): nada foi rotacionado; veja as linhas acima" >&2
  fi
}
trap on_exit EXIT

if [ -n "$AGE_RECIPIENT" ]; then
  command -v age >/dev/null || fail "BACKUP_AGE_RECIPIENT definido mas o 'age' não está instalado (apt install age)"
  EXT=".age"
fi
if [ -n "$RCLONE_REMOTE" ]; then
  [ -n "$AGE_RECIPIENT" ] || fail "BACKUP_RCLONE_REMOTE exige BACKUP_AGE_RECIPIENT (não enviamos backup sem cifrar)"
  command -v rclone >/dev/null || fail "BACKUP_RCLONE_REMOTE definido mas o 'rclone' não está instalado"
fi
[ -d "$STORAGE_DIR" ] || fail "pasta do Storage não encontrada: $STORAGE_DIR"

mkdir -p "$DEST"
chmod 700 "$DEST"

# Cifra (age) ou repassa. Tudo é gravado como .part e só ganha o nome final
# quando TODAS as etapas terminaram bem.
seal() { if [ -n "$AGE_RECIPIENT" ]; then age -r "$AGE_RECIPIENT"; else cat; fi; }
# Storage e sessões do WhatsApp estão em uso: um arquivo alterado durante a
# leitura faz o GNU tar sair com 1 ("file changed as we read it"). Isso é
# aceitável para um backup a quente; 2 ou mais continua sendo erro.
tar_live() { tar --warning=no-file-changed "$@" || [ "$?" -eq 1 ]; }

docker exec supabase-db pg_dumpall -U postgres --clean --if-exists \
  | gzip -9 | seal > "$DEST/db_$STAMP.sql.gz$EXT.part"
tar_live -C "$(dirname "$STORAGE_DIR")" -czf - "$(basename "$STORAGE_DIR")" \
  | seal > "$DEST/storage_$STAMP.tar.gz$EXT.part"
# Credenciais das sessões WhatsApp por QR (wa-gateway). Sem elas, cada conta
# precisa escanear o QR de novo depois de restaurar a VPS.
if [ -d "$WA_DIR" ]; then
  tar_live -C "$(dirname "$WA_DIR")" -czf - "$(basename "$WA_DIR")" \
    | seal > "$DEST/wa_sessions_$STAMP.tar.gz$EXT.part"
fi

# Um dump vazio (container parado, senha errada...) não conta como backup.
[ -s "$DEST/db_$STAMP.sql.gz$EXT.part" ] || fail "dump do banco vazio"

for part in "$DEST"/*_"$STAMP".*.part; do
  chmod 600 "$part"
  mv "$part" "${part%.part}"
done

if [ -n "$RCLONE_REMOTE" ]; then
  rclone copy "$DEST" "$RCLONE_REMOTE" --include "*_$STAMP.*.age"
fi

date -Is > "$DEST/LAST_OK"
chmod 600 "$DEST/LAST_OK"

# Rotação só depois de um backup completo: se esta rodada falhou, o script já
# saiu acima e nenhum backup antigo é apagado.
find "$DEST" -maxdepth 1 -type f \( -name 'db_*' -o -name 'storage_*' -o -name 'wa_sessions_*' \) \
  -mtime +"$KEEP_DAYS" -delete
echo "backup ok $STAMP${EXT:+ (cifrado)}${RCLONE_REMOTE:+ + offsite}: $(du -sh "$DEST" | cut -f1) em $DEST"
