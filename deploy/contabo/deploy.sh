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

# Migrations before the build ships code that depends on them. The CLI needs
# an explicit --db-url on a self-hosted stack (there is no linked project), and
# the host port 5432 is Supavisor (user "postgres.<tenant>"), so the URL lives
# in .env.production as SUPABASE_DB_URL. Without it the step is skipped loudly.
DB_URL="${SUPABASE_DB_URL:-$(grep -E '^SUPABASE_DB_URL=' .env.production 2>/dev/null | cut -d= -f2- || true)}"
if [ -n "$DB_URL" ]; then
  npx -y supabase db push --db-url "$DB_URL"
else
  echo "AVISO: SUPABASE_DB_URL n„o definido ó migraÁıes n„o aplicadas" >&2
fi

npm ci --include=dev            # build needs devDependencies even if NODE_ENV=production
npm run build                  # .env.production is read at build time for NEXT_PUBLIC_*
pm2 reload semprecrm --update-env || pm2 start deploy/contabo/ecosystem.config.cjs --only semprecrm

# Gateway WhatsApp QR (services/wa-gateway): pacote pr√≥prio, build separado.
# Sem .env ele n√£o sobe (falta WA_GATEWAY_SECRET etc.), ent√£o s√≥ √© implantado
# quando o arquivo existe ‚Äî VPS sem o canal QR continua funcionando.
if [ -f services/wa-gateway/.env ]; then
  (cd services/wa-gateway && npm ci --include=dev && npm run build)
  mkdir -p /var/lib/semprecrm/wa
  pm2 reload wa-gateway --update-env || pm2 start deploy/contabo/ecosystem.config.cjs --only wa-gateway
fi
pm2 save
curl -fsS -o /dev/null http://127.0.0.1:3000/login && echo "deploy ok: $(git rev-parse --short HEAD)"
