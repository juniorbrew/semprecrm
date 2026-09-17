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

## Acesso pela rede local (e por qualquer endereço)

Só a porta **3101** é publicada. O container `edge` (nginx) recebe tudo: `/supabase/*` vai para o
Supabase do PC (REST, auth, storage e o WebSocket do realtime) e o resto vai para o app. Por isso
`NEXT_PUBLIC_SUPABASE_URL=/supabase` no `.env.local`: o navegador fala com o Supabase pelo mesmo endereço
em que abriu o app — `http://localhost:3101`, `http://192.168.1.10:3101` ou pela VPN — sem porta extra
nem IP fixo. As URLs de mídia são gravadas relativas (`/supabase/storage/...`) pelo mesmo motivo.

Dentro dos containers o servidor usa `SUPABASE_INTERNAL_URL=http://host.docker.internal:56021`
(o Docker no Windows não alcança o IP de rede do próprio PC). `NEXT_PUBLIC_SITE_URL` é o endereço que
aparece em links compartilháveis (convites, URL das fontes de lead): use o IP da rede.

Se as portas do Supabase mudarem (`supabase/config.toml`), ajuste `nginx.conf`, `SUPABASE_INTERNAL_URL`
no compose e `SUPABASE_URL` do gateway.
