# Deploy do SempreCRM em uma VPS (Contabo)

Nada no app depende do Hostinger. É um Next.js 16 comum com Supabase; roda em qualquer VPS Linux.
Este guia assume Ubuntu 22.04/24.04, um domínio apontando para o IP da VPS e um projeto Supabase Cloud.

## 1. Servidor (uma vez)

```bash
# Node 20 LTS + PM2 + Nginx + Certbot
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
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
| `AUTOMATION_CRON_SECRET` | só se usar etapas "Aguardar" nas automações |

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
