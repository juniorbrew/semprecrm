# Deploy do SempreCRM em uma VPS (Contabo)

Nada no app depende do Hostinger. É um Next.js 16 comum com Supabase; roda em qualquer VPS Linux.
Este guia assume Ubuntu 22.04/24.04, um domínio apontando para o IP da VPS e um projeto Supabase Cloud.

## 1. Servidor (uma vez)

```bash
# Node 22 LTS + PM2 + Nginx + Certbot (o gateway do WhatsApp exige Node 22+: o supabase-js usa o WebSocket nativo)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx git
sudo npm i -g pm2

# usuário e pastas
sudo useradd -m -s /bin/bash semprecrm || true
sudo mkdir -p /var/www/semprecrm /var/log/semprecrm
sudo chown -R semprecrm:semprecrm /var/www/semprecrm /var/log/semprecrm
```

## 2. Código e variáveis

```bash
sudo -iu semprecrm
git clone https://github.com/juniorbrew/semprecrm.git /var/www/semprecrm
cd /var/www/semprecrm
cp .env.local.example .env.production && chmod 600 .env.production
nano .env.production
```

Preencha no `.env.production` (os nomes vêm de `.env.local.example`):

| Variável | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | do projeto Supabase **de produção** |
| `ENCRYPTION_KEY` | 64 hex, gere com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; não reutilize a de dev |
| `META_APP_SECRET` (e `META_APP_ID` se usar template com imagem) | Meta for Developers → App Settings → Basic |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.seudominio.com.br` |
| `AUTOMATION_CRON_SECRET` | obrigatório para o agendador `semprecrm-cron` (etapas "Aguardar", gatilhos por horário e "Conversa sem resposta há X horas", timeouts dos flows); gere com `openssl rand -hex 32` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | notificações push no navegador; gere uma vez com `node scripts/gen-vapid.mjs` e cole as três linhas (o `VAPID_SUBJECT` é um `mailto:` seu). Trocar as chaves obriga todo mundo a ativar as notificações de novo |

Não defina `WHATSAPP_TEMPLATES_DRY_RUN` em produção.

## 3. Banco (Supabase Cloud)

No seu computador, com o CLI logado no projeto de produção:

```bash
npx supabase link --project-ref <ref-do-projeto>
npx supabase db push        # aplica as migrations pendentes, inclusive 024_conversation_events
```

Confira no painel do Supabase que `conversation_events` existe e que Realtime está ligado para ela
(a migration já adiciona a tabela à publicação `supabase_realtime`).

### 3.1 Primeiro admin da plataforma (`/platform`)

O painel master em `/platform` (contas, planos, módulos) só abre para usuários listados em
`platform_admins`. Não existe senha em variável de ambiente: promova um usuário já cadastrado
pelo SQL Editor do Supabase (ou `psql`), uma única vez:

```sql
-- pegue o id em Authentication → Users, ou:
select id from auth.users where email = 'voce@empresa.com';

insert into platform_admins (user_id) values ('<uuid-do-usuario>');
```

Depois disso o item "Plataforma" aparece no menu do usuário e `/platform` passa a responder
(para qualquer outro usuário a rota devolve 404). Para revogar: `delete from platform_admins where user_id = '<uuid>'`.

## 4. Primeira subida

```bash
cd /var/www/semprecrm
npm ci && npm run build
pm2 start deploy/contabo/ecosystem.config.cjs && pm2 save
pm2 startup systemd -u semprecrm --hp /home/semprecrm   # rode o comando que ele imprimir, como root
```

## 5. Nginx + HTTPS

```bash
sudo cp /var/www/semprecrm/deploy/contabo/nginx.conf /etc/nginx/sites-available/semprecrm
sudo sed -i 's/crm.seudominio.com.br/SEU.DOMINIO/g' /etc/nginx/sites-available/semprecrm
sudo ln -s /etc/nginx/sites-available/semprecrm /etc/nginx/sites-enabled/
sudo certbot --nginx -d SEU.DOMINIO
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Meta / WhatsApp

No app da Meta, configure o webhook para `https://SEU.DOMINIO/api/whatsapp/webhook` com o verify token
que você definir em Configurações do CRM. Depois, em Configurações → WhatsApp dentro do app, cole o
token de acesso e o phone number id. O token é criptografado com a `ENCRYPTION_KEY` desta VPS.

## 6.1 Canal QR (WhatsApp Web, opcional)

O canal "WhatsApp via QR code" usa um segundo processo, `wa-gateway` (Baileys), que roda na mesma VPS
sob o PM2 e conversa com o app por loopback. Passos:

1. Crie `services/wa-gateway/.env` a partir de `services/wa-gateway/.env.example` (`APP_URL`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WA_GATEWAY_SECRET`, `WA_DATA_DIR=/var/lib/semprecrm/wa`).
2. No `.env.local` do app, defina `WA_GATEWAY_URL=http://127.0.0.1:3201` e o **mesmo**
   `WA_GATEWAY_SECRET`. Sem eles a opção QR aparece desabilitada em Configurações → WhatsApp.
3. Rode o `deploy.sh` normalmente — ele faz `npm ci && npm run build` no gateway e sobe/recarrega o app
   `wa-gateway` do `ecosystem.config.cjs` quando o `.env` existe.
4. O estado de autenticação fica em `/var/lib/semprecrm/wa/<account_id>/`; o `backup.sh` já inclui a pasta.
   Perder essa pasta obriga a ler o QR de novo.
5. Libere o módulo `channel_qr` para a conta em `/platform` e conecte em Configurações → WhatsApp →
   "WhatsApp via QR code".

Detalhes do serviço (variáveis, rotas internas, logs, limitações do protocolo) em
`services/wa-gateway/README.md`. Lembre o aviso da tela: o canal não é oficial e o número pode ser banido;
disparos e modelos continuam só na API oficial.

## 6.2 Agendador interno (`semprecrm-cron`)

As etapas "Aguardar", os gatilhos por horário, o gatilho "Conversa sem resposta há X horas" e os
timeouts dos flows só andam quando alguém chama `GET /api/automations/cron` e `GET /api/flows/cron`.
O terceiro app do `ecosystem.config.cjs`, `semprecrm-cron`, faz isso: `scripts/cron-tick.mjs` (Node
puro, sem dependências) chama os dois endpoints a cada minuto por loopback com o header `x-cron-secret`.

- Precisa de `AUTOMATION_CRON_SECRET` no `.env.production` (o mesmo arquivo que o app lê).
- `APP_URL` já vem do `ecosystem.config.cjs` (`http://127.0.0.1:3000`); ajuste se mudar a porta do Next.
- `CRON_INTERVAL_MS` (padrão 60000) controla a frequência. Não rode duas instâncias.
- Logs: `pm2 logs semprecrm-cron` ou `/var/log/semprecrm/cron.*.log` — uma linha por chamada
  (`GET /api/automations/cron 200 85ms processed=0 inactive_fired=2`).
- Se preferir um cron externo (Vercel Cron, UptimeRobot, crontab com `curl -H "x-cron-secret: …"`),
  remova o app `semprecrm-cron` do arquivo antes do `pm2 start`.

## 7. Redeploys

```bash
bash /var/www/semprecrm/deploy/contabo/deploy.sh main
```

## Observações

- Uma instância só (`instances: 1`). O rate limit é em memória de um processo; para escalar em vários
  nós troque o `check` em `src/lib/rate-limit.ts` por Redis.
- Firewall: libere só 22, 80 e 443 (`ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable`).
- Logs: `pm2 logs semprecrm` ou `/var/log/semprecrm/`.
- Backups do banco ficam por conta do Supabase (PITR no plano Pro) ou de um `pg_dump` agendado.
