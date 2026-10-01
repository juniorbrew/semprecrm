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

mkdir -p volumes/db/data volumes/storage volumes/functions
echo ">> Supabase preparado em $DEST. Próximo: editar $DEST/.env (segredos) e rodar:"
echo "   cd $DEST && docker compose pull && docker compose up -d"
