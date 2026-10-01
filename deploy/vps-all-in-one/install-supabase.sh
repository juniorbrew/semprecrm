#!/usr/bin/env bash
# Instala o Supabase self-hosted oficial em /opt/supabase, numa versão fixada,
# e aplica as configurações do SempreCRM. Rode como root, uma vez.
#   sudo bash deploy/vps-all-in-one/install-supabase.sh api.seudominio.com.br crm.seudominio.com.br
set -euo pipefail
API_HOST="${1:?uso: install-supabase.sh <host da api> <host do app>}"
APP_HOST="${2:?uso: install-supabase.sh <host da api> <host do app>}"
# Commit do repositório supabase/supabase cuja pasta docker/ foi testada com este guia.
# Para atualizar: escolha um commit novo, leia o CHANGELOG da pasta docker e troque aqui.
UPSTREAM_SHA="26585dd4a4d6db8910a595214c9f6e8fdd206768"
DEST=/opt/supabase

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -d "$DEST/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/supabase/supabase.git "$DEST/.upstream"
  git -C "$DEST/.upstream" sparse-checkout set docker
  git -C "$DEST/.upstream" checkout -q "$UPSTREAM_SHA"
  mkdir -p "$DEST"
  cp -a "$DEST/.upstream/docker/." "$DEST/"
  git -C "$DEST" init -q && git -C "$DEST" add -A && git -C "$DEST" -c user.name=setup -c user.email=setup@local commit -qm "upstream docker @ $UPSTREAM_SHA"
fi

cd "$DEST"
if [ ! -f .env ]; then
  cp .env.example .env
  echo ">> .env criado a partir do exemplo. Agora cole a saída do gen-keys.mjs nele:"
  echo "   node /var/www/semprecrm/deploy/vps-all-in-one/gen-keys.mjs"
fi

# URLs públicas: o navegador fala direto com a API, então precisam ser https e o host real.
sed -i \
  -e "s#^SUPABASE_PUBLIC_URL=.*#SUPABASE_PUBLIC_URL=https://${API_HOST}#" \
  -e "s#^API_EXTERNAL_URL=.*#API_EXTERNAL_URL=https://${API_HOST}#" \
  -e "s#^SITE_URL=.*#SITE_URL=https://${APP_HOST}#" \
  -e "s#^ADDITIONAL_REDIRECT_URLS=.*#ADDITIONAL_REDIRECT_URLS=https://${APP_HOST}/**#" \
  -e "s#^ENABLE_EMAIL_AUTOCONFIRM=.*#ENABLE_EMAIL_AUTOCONFIRM=true#" \
  -e "s#^ENABLE_PHONE_SIGNUP=.*#ENABLE_PHONE_SIGNUP=false#" \
  -e "s#^ENABLE_PHONE_AUTOCONFIRM=.*#ENABLE_PHONE_AUTOCONFIRM=false#" \
  -e "s#^API_GW_HTTP_PORT=.*#API_GW_HTTP_PORT=127.0.0.1:8000#" \
  -e "s#^KONG_HTTP_PORT=.*#KONG_HTTP_PORT=127.0.0.1:8000#" \
  .env
# A porta 8000 fica só em loopback; o Nginx faz o HTTPS na frente.
# ENABLE_EMAIL_AUTOCONFIRM=true evita depender de SMTP para o primeiro login;
# desligue depois de configurar SMTP_* se quiser confirmação por e-mail.

# Postgres/Supavisor só em loopback. O compose oficial publica o pooler em
# 0.0.0.0:5432 e 0.0.0.0:6543, e o Docker abre essas portas por iptables
# ANTES do ufw: "ufw deny 5432" não protege nada. POSTGRES_PORT não aceita
# "IP:porta" (também entra nas URLs internas de conexão), então a troca vai num
# arquivo extra de compose. "!override" exige Docker Compose >= 2.24.4.
cat > docker-compose.semprecrm.yml <<'YAML'
# Gerado por deploy/vps-all-in-one/install-supabase.sh (SempreCRM): publica o
# Supavisor só em 127.0.0.1. Não apague; está em COMPOSE_FILE no .env.
services:
  supavisor:
    ports: !override
      - "127.0.0.1:${POSTGRES_PORT}:5432"
      - "127.0.0.1:${POOLER_PROXY_PORT_TRANSACTION}:6543"
YAML
# O .env oficial fixa COMPOSE_FILE=docker-compose.yml, o que desliga a leitura
# automática de overrides; acrescenta o nosso arquivo à lista.
if grep -q '^COMPOSE_FILE=' .env; then
  grep -q '^COMPOSE_FILE=.*docker-compose.semprecrm.yml' .env ||
    sed -i 's#^COMPOSE_FILE=.*#&:docker-compose.semprecrm.yml#' .env
else
  echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.semprecrm.yml' >> .env
fi
if [ "$(docker compose config supavisor 2>/dev/null | grep -c 'host_ip: 127.0.0.1')" -lt 2 ]; then
  echo "ERRO: o supavisor não ficou só em 127.0.0.1 em 'docker compose config' (Docker Compose >= 2.24.4?)" >&2
  exit 1
fi

mkdir -p volumes/db/data volumes/storage volumes/functions
echo ">> Supabase preparado em $DEST. Próximo: editar $DEST/.env (segredos) e rodar:"
echo "   cd $DEST && docker compose pull && docker compose up -d"

# Conferência: com o stack no ar (reexecução do instalador ou depois do
# "up -d"), nenhuma porta do Supabase pode escutar fora do loopback.
# Rode de novo depois de qualquer "docker compose up":
#   ss -ltnH '( sport = :5432 or sport = :6543 or sport = :8000 )'
#   (todas as linhas devem ser 127.0.0.1; 0.0.0.0, [::] ou * = exposto)
exposed=$(ss -ltnH '( sport = :5432 or sport = :6543 or sport = :8000 )' 2>/dev/null |
  awk '{print $4}' | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)
if [ -n "$exposed" ]; then
  echo "ATENÇÃO: portas do Supabase expostas fora do loopback: $exposed" >&2
  echo "         rode 'cd $DEST && docker compose up -d' para aplicar docker-compose.semprecrm.yml" >&2
  exit 1
fi
echo ">> Depois do 'up -d', confira: ss -ltn | grep -E ':(5432|6543|8000) ' (só 127.0.0.1)"
