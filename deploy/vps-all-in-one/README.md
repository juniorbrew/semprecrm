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

Os passos 1 e 2 são iguais ao guia `deploy/contabo/README.md` (Node 20, PM2, Nginx, Certbot, usuário
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

As 24 migrations em `supabase/migrations/` criam as tabelas do CRM. Aplique direto no Postgres da VPS:

```bash
cd /var/www/semprecrm
npx supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/postgres"
```

A porta 5432 do container só é acessível de dentro da VPS. Repita este comando a cada deploy que trouxer
migration nova (o `deploy.sh` não faz isso sozinho, de propósito).

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

Depois siga os passos 4 a 7 do `deploy/contabo/README.md` (build, PM2, Nginx do app, Certbot, webhook
da Meta). Crie o primeiro usuário em `https://crm.SEU.DOMINIO/signup`. Com `ENABLE_EMAIL_AUTOCONFIRM=true`
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
