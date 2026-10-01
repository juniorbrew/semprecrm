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

O Nginx da API deixa públicos só `/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`, `/functions/v1`,
`/graphql/v1` (e `/mail/`, seção 8). O Studio (`/` e o resto) responde 403 para a internet; ele ainda pede
o `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` do `.env`, mas só senha não basta para um painel com acesso total
ao banco. Para abrir o Studio use um túnel SSH a partir do seu computador:

```bash
ssh -L 8000:127.0.0.1:8000 semprecrm     # e abra http://localhost:8000
```

ou, se tiver IP fixo, acrescente-o no bloco `geo $semprecrm_studio_allowed` do topo do arquivo. Os
endpoints de login/cadastro/recuperação (`/auth/v1/token`, `signup`, `recover`, `otp`…) têm um
`limit_req` de 30/min por IP (rajada 20), além dos limites do próprio GoTrue.

### 5. Migrations do SempreCRM

As 25 migrations em `supabase/migrations/` criam as tabelas do CRM. Aplique direto no Postgres da VPS:

```bash
cd /var/www/semprecrm
npx supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/postgres"
```

A porta 5432 do host é o Supavisor (usuário `postgres.<POOLER_TENANT_ID>`); se ele recusar, aponte para
o IP do container do banco: `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' supabase-db`
e acrescente `?sslmode=disable` na URL.

Para o `deploy.sh` aplicar as migrations sozinho a cada deploy, grave a mesma URL em
`/var/www/semprecrm/.env.production` como `SUPABASE_DB_URL=...` (o arquivo já é `chmod 600`). Sem a
variável o deploy avisa e segue sem migrar.

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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` | opcional — Agenda sincronizada com Google Agenda / Outlook; siga `docs/integracoes-agenda.md` e registre `https://crm.SEU.DOMINIO/api/integrations/google/callback` e `/api/integrations/microsoft/callback` no provedor. O `semprecrm-cron` chama `POST /api/integrations/calendar/sync` a cada 5 min (`CALENDAR_SYNC_INTERVAL_MS`) |

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
# 0 3 * * * /bin/bash /var/www/semprecrm/deploy/vps-all-in-one/backup.sh >> /var/log/semprecrm/backup.log 2>&1
```

Chame sempre com `/bin/bash` na frente: sem isso o cron depende do bit de execução do arquivo, e um
checkout sem ele faz o cron falhar com "Permission denied" todas as noites, em silêncio.

Gera em `/var/backups/semprecrm` (pasta 700, arquivos 600) o dump completo do Postgres (`db_*`), um tar do
Storage (`/opt/supabase/volumes/storage`, que o container monta em `/var/lib/storage`) e um tar das
sessões do wa-gateway (`/var/lib/semprecrm/wa`), mantendo 14 dias. Se qualquer etapa falhar o script sai
com código diferente de 0, escreve `BACKUP FALHOU` no log, apaga os parciais e **não** apaga nenhum
backup antigo. Cada backup completo atualiza o arquivo `LAST_OK`.

Backup só na própria máquina não protege contra perda da VPS: ative a cifragem e a cópia externa abaixo.

## Backups: como conferir, restaurar e trocar as chaves

### Conferir

```bash
sudo bash /var/www/semprecrm/deploy/vps-all-in-one/backup-check.sh   # código 0 = ok
sudo tail -n 20 /var/log/semprecrm/backup.log
```

O `backup-check.sh` falha quando o `db_*` mais novo tem mais de 26 h (`BACKUP_MAX_AGE_H`) ou menos de
50 KB (`BACKUP_MIN_BYTES`). Rode-o pelo menos uma vez por mês (ver `docs/runbooks/ops-checklist.md`) ou
pendure-o num monitor que avise quando sair com erro.

### Cifrar (age) e copiar para fora da VPS (rclone)

1. **No seu computador, nunca na VPS**, gere o par de chaves age (Windows: `winget install FiloSottile.age`;
   macOS: `brew install age`; Linux: `apt install age`):

   ```bash
   age-keygen -o semprecrm-backup.key
   # imprime "Public key: age1..." — só essa linha pública vai para o servidor
   ```

   Guarde `semprecrm-backup.key` (a chave privada) no cofre de senhas e numa cópia offline. Sem ela os
   backups cifrados são irrecuperáveis; com ela na VPS, quem invadir a VPS lê os backups.

2. Na VPS: `sudo apt install -y age rclone`, configure o destino com `sudo rclone config` (B2, S3, Drive…;
   de preferência uma credencial que só consiga gravar, sem apagar) e crie o arquivo de configuração:

   ```bash
   sudo install -d -m 700 /etc/semprecrm
   sudo install -m 600 /dev/null /etc/semprecrm/backup.env
   sudo tee /etc/semprecrm/backup.env >/dev/null <<'EOF'
   BACKUP_AGE_RECIPIENT=age1...sua.chave.publica...
   BACKUP_RCLONE_REMOTE=b2:semprecrm-backup/vps
   EOF
   sudo bash /var/www/semprecrm/deploy/vps-all-in-one/backup.sh && sudo ls -l /var/backups/semprecrm
   ```

   Com `BACKUP_AGE_RECIPIENT` os arquivos saem como `*.age` e nada em texto puro é gravado. O
   `BACKUP_RCLONE_REMOTE` só é aceito junto com a chave (nunca enviamos backup sem cifrar). O `rclone copy`
   não apaga nada no destino: configure a retenção (lifecycle) no próprio bucket.

3. Depois do primeiro backup cifrado, apague os backups antigos em texto puro:
   `sudo find /var/backups/semprecrm -maxdepth 1 -type f -name '*.gz' -delete`.

### Restaurar

Pare o app antes (`pm2 stop semprecrm semprecrm-cron wa-gateway`) e suba de novo no fim.

```bash
# Sem cifragem, na VPS:
zcat /var/backups/semprecrm/db_X.sql.gz | docker exec -i supabase-db psql -U postgres
sudo tar -C /opt/supabase/volumes -xzf /var/backups/semprecrm/storage_X.tar.gz
sudo tar -C /var/lib/semprecrm -xzf /var/backups/semprecrm/wa_sessions_X.tar.gz

# Cifrado: decifre no SEU computador (onde está a chave privada) e mande o fluxo para a VPS.
scp semprecrm:/var/backups/semprecrm/db_X.sql.gz.age .     # ou baixe do bucket com rclone
age -d -i semprecrm-backup.key db_X.sql.gz.age | ssh semprecrm "gunzip | docker exec -i supabase-db psql -U postgres"
age -d -i semprecrm-backup.key storage_X.tar.gz.age | ssh semprecrm "sudo tar -C /opt/supabase/volumes -xzf -"
age -d -i semprecrm-backup.key wa_sessions_X.tar.gz.age | ssh semprecrm "sudo tar -C /var/lib/semprecrm -xzf -"
```

Teste a restauração de vez em quando num Postgres descartável; backup que nunca foi restaurado não é
backup confirmado.

### Trocar as chaves

1. Gere um par novo no seu computador (`age-keygen -o semprecrm-backup-AAAA.key`).
2. Troque `BACKUP_AGE_RECIPIENT` em `/etc/semprecrm/backup.env` pela chave pública nova e rode o backup
   uma vez para conferir.
3. Mantenha a chave privada **antiga** no cofre até expirarem todos os backups cifrados com ela (14 dias
   na VPS e a retenção do bucket). Só então descarte.

Se a chave privada vazou, faça os passos 1 e 2 já e apague do bucket os backups cifrados com a chave
antiga depois que houver backups novos válidos.

## Operação

| Tarefa | Comando |
|---|---|
| Ver serviços do Supabase | `cd /opt/supabase && docker compose ps` |
| Logs de um serviço | `docker compose logs -f auth` (ou `db`, `rest`, `realtime`, `storage`) |
| Reiniciar o Supabase | `docker compose restart` |
| Redeploy do app | `bash /var/www/semprecrm/deploy/contabo/deploy.sh main` |
| Atualizar o Supabase | trocar `UPSTREAM_SHA` no `install-supabase.sh`, ler o changelog da pasta `docker/` do repositório supabase/supabase, rodar o instalador de novo e `docker compose up -d` |
| Conferir / restaurar backup | ver "Backups: como conferir, restaurar e trocar as chaves" acima |

## Quando vale a pena voltar para o Supabase Cloud

Se a equipe crescer ou o número de mensagens subir muito, o custo de operar Postgres, backups e
atualizações na mão passa a pesar mais que a mensalidade do plano Pro. O app não muda: basta trocar as
três variáveis `SUPABASE_*` do `.env.production` e rodar `supabase db push` no projeto novo.

### 8. E-mails do Supabase Auth em português

O GoTrue manda confirmação de cadastro, recuperação de senha, convite, troca de e-mail e link mágico em
inglês por padrão. Os modelos em pt-BR ficam em `deploy/vps-all-in-one/mail-templates/*.html` (os links
apontam para `/auth/callback?token_hash=…`, que verifica no servidor e funciona em qualquer navegador — não
use `{{ .ConfirmationURL }}`, que depende do navegador que iniciou o fluxo); o GoTrue
busca cada um por URL na hora de enviar, então o Nginx da API os serve em `https://api.SEU.DOMINIO/mail/`:

```bash
sudo mkdir -p /var/www/mail-templates && sudo cp /var/www/semprecrm/deploy/vps-all-in-one/mail-templates/*.html /var/www/mail-templates/
# no bloco 443 de /etc/nginx/sites-available/semprecrm-api, antes de "location /":
#   location /mail/ { alias /var/www/mail-templates/; default_type text/html; }
sudo nginx -t && sudo systemctl reload nginx
```

Em `/opt/supabase/.env` (e repasse no serviço `auth` do compose, como no MFA):

```bash
MAILER_TEMPLATES_CONFIRMATION=https://api.SEU.DOMINIO/mail/confirmation.html
MAILER_TEMPLATES_RECOVERY=https://api.SEU.DOMINIO/mail/recovery.html
MAILER_TEMPLATES_INVITE=https://api.SEU.DOMINIO/mail/invite.html
MAILER_TEMPLATES_EMAIL_CHANGE=https://api.SEU.DOMINIO/mail/email_change.html
MAILER_TEMPLATES_MAGIC_LINK=https://api.SEU.DOMINIO/mail/magic_link.html
MAILER_SUBJECTS_CONFIRMATION="Confirme seu e-mail no SempreCRM"
MAILER_SUBJECTS_RECOVERY="Redefinir sua senha do SempreCRM"
MAILER_SUBJECTS_INVITE="Você foi convidado para o SempreCRM"
MAILER_SUBJECTS_EMAIL_CHANGE="Confirme seu novo e-mail no SempreCRM"
MAILER_SUBJECTS_MAGIC_LINK="Seu link de acesso ao SempreCRM"
```

Variáveis do serviço `auth`: `GOTRUE_MAILER_TEMPLATES_<TIPO>` e `GOTRUE_MAILER_SUBJECTS_<TIPO>`. Os e-mails só
saem de fato com um SMTP real em `SMTP_*` (Brevo, Resend, SES…); o instalador deixa um remetente falso.
