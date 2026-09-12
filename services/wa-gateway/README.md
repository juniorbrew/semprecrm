# wa-gateway — canal WhatsApp por QR code

Serviço Node 20 separado do app que conecta números de WhatsApp pelo protocolo do
WhatsApp Web (biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys),
pacote `@whiskeysockets/baileys`), como um "aparelho conectado" da conta. Um único
processo atende várias contas do SempreCRM: cada `account_id` vira uma sessão com
credenciais em `WA_DATA_DIR/<account_id>/`.

Especificação: `docs/superpowers/specs/2026-09-12-whatsapp-qr-channel-design.md`.

## Aviso de risco

O protocolo do WhatsApp Web é usado por engenharia reversa. Não é oficial, viola os
termos do WhatsApp e **o número pode ser banido**, sobretudo com envio em massa.
Por isso o canal QR serve só o atendimento 1:1 e as automações de resposta; disparos
(broadcasts) e templates continuam exclusivos da API oficial da Meta.

## O que ele faz

- `POST /sessions/:accountId/connect` inicia (ou retoma) a sessão. O WhatsApp gera um
  QR (renovado a cada ~20 s); o gateway guarda só o último em memória como data URL
  e o app o mostra na tela de configurações.
- Depois de pareado, reconecta sozinho em queda de rede/reinício do processo. Se o
  usuário desconectar pelo celular (`loggedOut`), apaga as credenciais e marca a
  conta como `disconnected`.
- Mensagens recebidas (1:1; grupos, status e newsletters são ignorados) viram
  `POST {APP_URL}/api/channels/qr/inbound`. Mídia é baixada, descriptografada e
  enviada ao bucket `chat-media` do Supabase (`account-<id>/qr/<ts>-<nome>`) com a
  service role; o app recebe a URL pública.
- Mudanças de estado da sessão viram `POST {APP_URL}/api/channels/qr/status`; os
  recibos das mensagens que nós enviamos viram `POST {APP_URL}/api/channels/qr/ack`
  (`sent` / `delivered` / `read`).
- `POST /sessions/:accountId/send` envia texto ou mídia por URL.

Todos os requests, nos dois sentidos, levam o header `x-gateway-secret` com o valor
de `WA_GATEWAY_SECRET`. Eventos para o app passam por uma fila em memória com retry e
backoff exponencial (erros 5xx/rede); 4xx são descartados com log.

### Contratos

| Rota (gateway)                      | Corpo / resposta |
| ----------------------------------- | ---------------- |
| `GET /health`                       | `{ ok, sessions, uptime }` |
| `POST /sessions/:id/connect`        | → `{ status }` |
| `GET /sessions/:id`                 | → `{ status: disconnected\|qr\|connecting\|connected, qr?, phone?, name?, connected_at? }` |
| `POST /sessions/:id/logout`         | → `{ status: "disconnected" }` |
| `POST /sessions/:id/send`           | `{ to: "5511999999999", text?, media?: { url, mimetype, filename?, caption?, ptt? } }` → `{ message_id }` |

Erros: `401` sem secret; `400 invalid_request`; `409 not_connected`;
`422 not_on_whatsapp`; `502 send_failed`.

| Evento (app)                        | Corpo |
| ----------------------------------- | ----- |
| `POST /api/channels/qr/inbound`     | `{ account_id, message_id, from, push_name, timestamp, type, text?, media?: { url, mimetype, filename? }, quoted_message_id? }` — `timestamp` em segundos Unix (como no webhook da Meta); `type` ∈ text, image, audio, video, document, sticker, location (localização vira `text` com "nome (lat,lng)") |
| `POST /api/channels/qr/status`      | `{ account_id, status, phone?, name?, error? }` |
| `POST /api/channels/qr/ack`         | `{ account_id, message_id, status: sent\|delivered\|read }` |

## Rodando localmente

```bash
cd services/wa-gateway
cp .env.example .env      # preencha WA_GATEWAY_SECRET (o mesmo do .env.local do app), SUPABASE_*
npm install
npm run dev               # tsx watch, porta 3201
```

No app (`.env.local`): `WA_GATEWAY_URL=http://127.0.0.1:3201` e o mesmo
`WA_GATEWAY_SECRET`. Há também a entrada `wa-gateway` em `.claude/launch.json`.

Teste rápido sem o app:

```bash
S="x-gateway-secret: $(grep WA_GATEWAY_SECRET .env | cut -d= -f2)"
curl -H "$S" localhost:3201/health
curl -X POST -H "$S" localhost:3201/sessions/minha-conta/connect
curl -H "$S" localhost:3201/sessions/minha-conta   # status "qr" com data URL em ~1 s
curl -X POST -H "$S" localhost:3201/sessions/minha-conta/logout
```

Outros scripts: `npm test` (vitest: máquina de estados com Baileys mockado, mapper de
mensagens, retry do cliente do app, rotas HTTP), `npm run build` (→ `dist/`),
`npm start` (`node --env-file=.env dist/index.js`), `npm run typecheck`.

## Produção (VPS com PM2)

O gateway é o segundo app de `deploy/contabo/ecosystem.config.cjs` (`wa-gateway`):
`cwd` em `/var/www/semprecrm/services/wa-gateway`, `script: dist/index.js`, lendo
`services/wa-gateway/.env` via `--env-file` e com `WA_DATA_DIR=/var/lib/semprecrm/wa`.

```bash
# uma vez, como o usuário do app
mkdir -p /var/lib/semprecrm/wa
cp /var/www/semprecrm/services/wa-gateway/.env.example /var/www/semprecrm/services/wa-gateway/.env
chmod 600 /var/www/semprecrm/services/wa-gateway/.env   # edite: secret, APP_URL=http://127.0.0.1:3000, SUPABASE_*
# a cada deploy: deploy/contabo/deploy.sh já faz npm ci + build e `pm2 reload wa-gateway`
pm2 logs wa-gateway
```

Regras:

- **Uma instância só** (`instances: 1`). Cada sessão do WhatsApp vive em um processo;
  dois processos com as mesmas credenciais derrubam um ao outro.
- **Não exponha a porta 3201** no nginx/firewall. Só o app fala com o gateway, pela
  rede local, e o secret é a única autenticação.
- `APP_URL` em produção aponta para o app local (`http://127.0.0.1:3000`), não para o
  domínio público, para não depender do nginx/TLS na entrega dos eventos.

## Backup

As credenciais das sessões ficam em `WA_DATA_DIR` (`/var/lib/semprecrm/wa` na VPS),
uma pasta por `account_id`, com `creds.json` e as chaves do Signal. Sem esse diretório,
cada conta precisa escanear o QR de novo. `deploy/vps-all-in-one/backup.sh` já gera
`wa_sessions_<data>.tar.gz` junto com o dump do banco. Para restaurar: parar o
gateway, extrair o tar em `/var/lib/semprecrm/`, subir o gateway — ele retoma todas as
contas que tiverem `creds.json` (`resumeAll`).

## Estrutura

```
src/index.ts           entrada: config, logger, servidor HTTP, retomada das sessões, shutdown
src/server.ts          rotas Hono + middleware do secret
src/session-manager.ts Map<accountId, sessão>: connect/logout/getStatus/send, reconexão, eventos
src/inbound-mapper.ts  puro: WAMessage do Baileys → payload de /inbound (LID → telefone, mídia, citação)
src/media.ts           download da mídia + upload no bucket chat-media
src/app-client.ts      fila + retry/backoff para os endpoints do app
src/config.ts          variáveis de ambiente
src/types.ts           contratos HTTP compartilhados com o app
```
