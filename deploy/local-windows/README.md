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

## Acesso pela rede local e como o container fala com o Supabase do PC

`NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SITE_URL` no `.env.local` apontam para o IP do PC na rede
(`http://192.168.1.10:56021` / `http://192.168.1.10:3101`), para que outros computadores consigam
logar — o navegador fala direto com o Supabase. Reserve esse IP no roteador (DHCP) para ele não mudar;
se mudar, troque nos dois arquivos `.env`, em `supabase/config.toml` (`site_url`,
`additional_redirect_urls`) e reconstrua.

De dentro dos containers o IP da rede do próprio PC não é alcançável (Docker Desktop no Windows), por
isso o servidor usa `SUPABASE_INTERNAL_URL=http://host.docker.internal:56021` e o gateway grava as URLs
de mídia com `SUPABASE_PUBLIC_URL` (o endereço dos navegadores). O `entrypoint.sh` ainda encaminha
`127.0.0.1:56021` → host por `socat`, para o caso de alguém voltar a usar `127.0.0.1` no `.env.local`.

## Desenvolvimento com hot reload

Para trabalhar no código com recarga automática, rode `npx next dev -p 3102` no PC apontando para o
mesmo Supabase; o container em 3101 continua servindo a versão estável.
