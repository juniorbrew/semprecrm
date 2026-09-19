#!/usr/bin/env bash
# Zero-downtime-ish redeploy on the VPS. Run as the app user from anywhere:
#   bash /var/www/semprecrm/deploy/contabo/deploy.sh [branch]
set -euo pipefail
APP_DIR=/var/www/semprecrm
BRANCH="${1:-main}"

cd "$APP_DIR"
git fetch --prune origin
git checkout -q "$BRANCH"
git pull --ff-only origin "$BRANCH"

npx supabase db push           # applies any new migrations before the build ships code that depends on them

npm ci --include=dev            # build needs devDependencies even if NODE_ENV=production
npm run build                  # .env.production is read at build time for NEXT_PUBLIC_*
pm2 reload semprecrm --update-env || pm2 start deploy/contabo/ecosystem.config.cjs --only semprecrm

# Gateway WhatsApp QR (services/wa-gateway): pacote próprio, build separado.
# Sem .env ele não sobe (falta WA_GATEWAY_SECRET etc.), então só é implantado
# quando o arquivo existe — VPS sem o canal QR continua funcionando.
if [ -f services/wa-gateway/.env ]; then
  (cd services/wa-gateway && npm ci --include=dev && npm run build)
  mkdir -p /var/lib/semprecrm/wa
  pm2 reload wa-gateway --update-env || pm2 start deploy/contabo/ecosystem.config.cjs --only wa-gateway
fi
pm2 save
curl -fsS -o /dev/null http://127.0.0.1:3000/login && echo "deploy ok: $(git rev-parse --short HEAD)"
