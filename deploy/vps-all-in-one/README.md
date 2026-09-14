# Tudo em uma VPS: SempreCRM + Supabase self-hosted

Uma única VPS roda o banco, a autenticação, o storage, o realtime (Supabase self-hosted em Docker)
e o app Next.js (PM2). Nenhum serviço pago além da VPS e do domínio.

## Requisitos

| Item | Mínimo | Confortável |
|---|---|---|
| VPS | 4 vCPU, 8 GB RAM, 80 GB SSD (Contabo VPS 2) | 6 vCPU, 16 GB |
| SO | Ubuntu 22.04 ou 24.04 | |
| DNS | dois registros A para o IP da VPS: `crm.seudominio.com.br` (app) e `api.seudominio.com.br` (Supabase) | |
| Portas | 22, 80, 443 abertas; todo o resto fechado | |

O stack do Supabase parado usa 2 a 3 GB de RAM. Com 4 GB a VPS entra em swap sob carga.

## Ordem de instalação

Os passos 1 e 2 são iguais ao guia `deploy/contabo/README.md` (Node 22, PM2, Nginx, Certbot, usuário
`semprecrm`, clone em `/var/www/semprecrm`). Depois:

### 3. Supabase self-hosted

```bash
sudo bash /var/www/semprecrm/deploy/vps-all-in-one/install-supabase.sh api.seudominio.com.br crm.seudominio.com.br
node /var/www/semprecrm/deploy/vps-all-in-one/gen-keys.mjs
```

O `gen-keys.mjs` imprime um bloco de segredos. Cole cada linha no lugar da linha correspondente em
`/opt/supabase/.env` (o instalador já ajustou as URLs públicas e deixou a porta 8000 só em loopback).
A última linha, `ENCRYPTION_KEY_DO_APP`, não vai no Supabase: é a `ENCRYPTION_KEY` do `.env.production`
do app. Guarde o bloco inteiro num cofre de senhas; ele não é reproduzível.

```bash
cd /opt/supabase
docker compose pull
docker compose up -d
docker compose ps        # todos "healthy" em 1 a 2 minutos
```

#### Verificação em duas etapas (MFA TOTP)

O app usa o MFA nativo do Supabase Auth (Configurações → Login e segurança → "Verificação em duas
etapas"; o proprietário pode exigir para admins em Membros). No Supabase local isso é o
`[auth.mfa.totp]` do `supabase/config.toml`; no self-hosted o GoTrue lê as variáveis
`GOTRUE_MFA_TOTP_ENROLL_ENABLED` e `GOTRUE_MFA_TOTP_VERIFY_ENABLED`, que o `docker-compose.yml` oficial
não repassa por padrão. Adicione ao `/opt/supabase/.env`:

```bash
cat >> /opt/supabase/.env <<'EOF'

# MFA TOTP (SempreCRM: verificação em duas etapas)
MFA_TOTP_ENROLL_ENABLED=true
MFA_TOTP_VERIFY_ENABLED=true
EOF
```

e, no serviço `auth` do `/opt/supabase/docker-compose.yml`, dentro de `environment:`:

```yaml
      GOTRUE_MFA_TOTP_ENROLL_ENABLED: ${MFA_TOTP_ENROLL_ENABLED}
      GOTRUE_MFA_TOTP_VERIFY_ENABLED: ${MFA_TOTP_VERIFY_ENABLED}
```

Depois `docker compose up -d auth`. Para desligar novamente sem quebrar quem já ativou, mantenha
`VERIFY_ENABLED=true` e coloque só `ENROLL_ENABLED=false` (o login continua pedindo o código de quem já
tem fator; ninguém novo consegue ativar). Não existem códigos de recuperação: quem perder o celular
precisa que um administrador remova o fator pelo Studio (tabela `auth.mfa_factors`).

### 4. HTTPS para a API

```bash
sudo cp /var/www/semprecrm/deploy/vps-all-in-one/nginx-api.conf /etc/nginx/sites-available/semprecrm-api
sudo sed -i 's/api.seudominio.com.br/api.SEU.DOMINIO/g' /etc/nginx/sites-available/semprecrm-api
sudo ln -s /etc/nginx/sites-available/semprecrm-api /etc/nginx/sites-enabled/
sudo certbot --nginx -d api.SEU.DOMINIO
sudo nginx -t && sudo systemctl reload nginx
curl -s https://api.SEU.DOMINIO/rest/v1/ -H "apikey: <ANON_KEY>" | head -c 200   # deve responder JSON
```

Abra `https://api.SEU.DOMINIO/` no navegador: é o Studio, protegido pelo `DASHBOARD_USERNAME` e
`DASHBOARD_PASSWORD` do `.env`. Se tiver IP fixo, limite o Studio por IP no bloco comentado do Nginx.

### 5. Migrations do SempreCRM

As 25 migrations em `supabase/migrations/` criam as tabelas do CRM. Aplique direto no Postgres da VPS:

```bash
cd /var/www/semprecrm
npx supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/postgres"
```

A porta 5432 do container só é acessível de dentro da VPS. Repita este comando a cada deploy que trouxer
migration nova (o `deploy.sh` não faz isso sozinho, de propósito).

#### Primeiro admin da plataforma (`/platform`)

O painel master em `/platform` (contas, planos, módulos) só abre para usuários listados em
`platform_admins` (migration 025). Crie sua conta normalmente pelo app e depois promova o usuário
direto no Postgres, uma única vez:

```bash
docker exec -it supabase-db psql -U postgres -d postgres   -c "insert into platform_admins (user_id) select id from auth.users where email = 'voce@empresa.com';"
```

O item "Plataforma" passa a aparecer no menu do usuário e `/platform` responde (para os demais a rota
devolve 404). Para revogar: `delete from platform_admins where user_id = '<uuid>'`.

### 6. App

No `/var/www/semprecrm/.env.production`:

| Variável | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://api.SEU.DOMINIO` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `ANON_KEY` gerado |
| `SUPABASE_SERVICE_ROLE_KEY` | `SERVICE_ROLE_KEY` gerado |
| `ENCRYPTION_KEY` | `ENCRYPTION_KEY_DO_APP` gerado |
| `META_APP_SECRET`, `META_APP_ID` | do app na Meta |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.SEU.DOMINIO` |
| `AUTOMATION_CRON_SECRET` | `openssl rand -hex 32` — usado pelo agendador `semprecrm-cron` (ver 6.2 do guia Contabo) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `node scripts/gen-vapid.mjs` — notificações push no navegador (gere uma vez; trocar as chaves invalida as assinaturas) |

Depois siga os passos 4 a 7 do `deploy/contabo/README.md` (build, PM2, Nginx do app, Certbot, webhook
da Meta). O `pm2 start deploy/contabo/ecosystem.config.cjs` sobe também o `semprecrm-cron`
(`scripts/cron-tick.mjs`), o agendador interno que a cada minuto chama `/api/automations/cron` e
`/api/flows/cron` — é ele que faz andar as etapas "Aguardar", os gatilhos por horário e o gatilho
"Conversa sem resposta há X horas". Não é preciso configurar nada no crontab para isso; só o
`AUTOMATION_CRON_SECRET` acima. Crie o primeiro usuário em `https://crm.SEU.DOMINIO/signup`. Com `ENABLE_EMAIL_AUTOCONFIRM=true`
o cadastro entra sem confirmar e-mail; depois de configurar `SMTP_*` no `/opt/supabase/.env` você pode
voltar para `false` e desligar `DISABLE_SIGNUP` para bloquear cadastros abertos (convites continuam
funcionando pelo app).

### 7. Backup

```bash
sudo crontab -e
# 0 3 * * * /var/www/semprecrm/deploy/vps-all-in-one/backup.sh >> /var/log/semprecrm/backup.log 2>&1
```

Gera dump completo do Postgres e um tar do Storage em `/var/backups/semprecrm`, mantendo 14 dias.
Copie essa pasta para fora da VPS (rclone para B2, S3 ou Google Drive). Backup só na própria máquina
não protege contra perda da VPS.

## Operação

| Tarefa | Comando |
|---|---|
| Ver serviços do Supabase | `cd /opt/supabase && docker compose ps` |
| Logs de um serviço | `docker compose logs -f auth` (ou `db`, `rest`, `realtime`, `storage`) |
| Reiniciar o Supabase | `docker compose restart` |
| Redeploy do app | `bash /var/www/semprecrm/deploy/contabo/deploy.sh main` |
| Atualizar o Supabase | trocar `UPSTREAM_SHA` no `install-supabase.sh`, ler o changelog da pasta `docker/` do repositório supabase/supabase, rodar o instalador de novo e `docker compose up -d` |
| Restaurar backup | `zcat db_X.sql.gz \| docker exec -i supabase-db psql -U postgres` |

## Quando vale a pena voltar para o Supabase Cloud

Se a equipe crescer ou o número de mensagens subir muito, o custo de operar Postgres, backups e
atualizações na mão passa a pesar mais que a mensalidade do plano Pro. O app não muda: basta trocar as
três variáveis `SUPABASE_*` do `.env.production` e rodar `supabase db push` no projeto novo.
