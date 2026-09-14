# Servidor de teste local (Windows + Docker Desktop)

O SempreCRM roda inteiro em containers, ao lado do Supabase local do CLI. Abrir o Docker Desktop
sobe tudo sozinho (`restart: unless-stopped`); nada depende de terminal, PM2 ou sessão aberta.

| Container | O que é | Porta no PC |
|---|---|---|
| `semprecrm-semprecrm-1` | app Next.js (build de produção) | http://localhost:3101 |
| `semprecrm-wa-gateway-1` | gateway do WhatsApp por QR code (Baileys) | interna (3201) |
| `semprecrm-cron-tick-1` | agendador (automações, follow-up, lembretes) | — |
| `supabase_*_semprecrm` | banco, auth, storage, realtime (CLI `npx supabase start`) | 56021 (API), 56022 (DB) |

Segredos ficam em `.env.local` (app e cron) e `services/wa-gateway/.env` (gateway); os containers
os leem em tempo de execução. As credenciais da sessão do WhatsApp ficam em `services/wa-gateway/data`
(montado em `/data`), então rebuilds não pedem QR de novo.

## Comandos (na raiz do repositório)

Subir / reconstruir tudo:

```bash
docker compose --env-file .env.local -f deploy/local-windows/docker-compose.yml up -d --build
```

Depois de mudar código do app (só reconstrói o que mudou):

```bash
docker compose --env-file .env.local -f deploy/local-windows/docker-compose.yml up -d --build semprecrm
```

Logs, status, parar:

```bash
docker compose -f deploy/local-windows/docker-compose.yml logs -f semprecrm
docker compose -f deploy/local-windows/docker-compose.yml ps
docker compose -f deploy/local-windows/docker-compose.yml down
```

Migrations novas continuam sendo aplicadas no Supabase do CLI: `npx supabase migration up --include-all`
(nunca `db reset`: apaga os dados de teste).

## Como o container fala com o Supabase do PC

O navegador e o servidor usam a mesma `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:56021`. Dentro do
container esse endereço não existe, então o `entrypoint.sh` abre um `socat` que encaminha
`127.0.0.1:56021` → `host.docker.internal:56021`. Se as portas do Supabase mudarem
(`supabase/config.toml`), ajuste `SUPABASE_FORWARD_PORTS` no compose.

## Desenvolvimento com hot reload

Para trabalhar no código com recarga automática, rode `npx next dev -p 3102` no PC apontando para o
mesmo Supabase; o container em 3101 continua servindo a versão estável.
