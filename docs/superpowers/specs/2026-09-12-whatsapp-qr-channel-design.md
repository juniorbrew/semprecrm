# Canal WhatsApp por QR code (WhatsApp Web) ao lado da API oficial

Data: 2026-09-12. Parte 2 do plano de plataforma (parte 1: planos e painel master). Aprovado em conversa.

## Aviso de risco

O protocolo do WhatsApp Web é usado por engenharia reversa (biblioteca Baileys). Não é oficial, viola os
termos do WhatsApp e o número pode ser banido, sobretudo com envio em massa. Por isso:
disparos (broadcasts) e templates ficam exclusivos da API oficial; o canal QR serve o atendimento 1:1 e as
automações de resposta. O aviso aparece na tela de conexão.

## Componentes

### 1. `services/wa-gateway` (Node 20, pacote próprio, sem dependência do app)

- Dependências: `@whiskeysockets/baileys`, `@hapi/boom`, `pino`, `qrcode`, `hono` (HTTP), `@supabase/supabase-js`.
- Um processo, várias sessões, chave = `account_id`. Estado de autenticação do Baileys em disco:
  `WA_DATA_DIR/<account_id>/` (`useMultiFileAuthState`). Backup do diretório documentado.
- Reconecta sozinho em queda de rede; em `loggedOut` apaga o estado e marca `disconnected`.
- HTTP interno, porta `WA_GATEWAY_PORT` (3201), todo request exige header `x-gateway-secret: WA_GATEWAY_SECRET`:
  - `GET  /health`
  - `POST /sessions/:accountId/connect` → inicia (ou retoma) a sessão; resposta `{ status }`.
  - `GET  /sessions/:accountId` → `{ status: 'disconnected'|'qr'|'connecting'|'connected', qr?: dataUrl, phone?, name?, connected_at? }`. O QR é gerado a cada ~20 s pelo WhatsApp; o gateway guarda só o último em memória.
  - `POST /sessions/:accountId/logout` → encerra e apaga o estado.
  - `POST /sessions/:accountId/send` → `{ to: "5511999999999", text? , media?: { url, mimetype, filename?, caption? , ptt? } }` → `{ message_id }`.
- Eventos para o app (HTTP, com o mesmo secret, retry com backoff, fila em memória):
  - `POST {APP_URL}/api/channels/qr/inbound` — `{ account_id, message_id, from: "5511...", push_name, timestamp, type: text|image|audio|video|document|sticker|location, text?, media?: { url, mimetype, filename? }, quoted_message_id? }`. Mídia é baixada pelo gateway e enviada ao bucket `chat-media` (path `account-<id>/qr/<ts>-<name>`) com a service role key; o app recebe a URL pública.
  - `POST {APP_URL}/api/channels/qr/status` — `{ account_id, status, phone?, name?, error? }` a cada mudança de sessão.
  - `POST {APP_URL}/api/channels/qr/ack` — `{ account_id, message_id, status: sent|delivered|read }`.
- Ignora mensagens de grupos, status/stories e newsletters nesta versão (log em debug).

### 2. Banco (migration 026)

```
wa_qr_sessions
  account_id     uuid pk → accounts on delete cascade
  status         text not null default 'disconnected' check in (disconnected, qr, connecting, connected)
  phone_number   text null
  display_name   text null
  connected_at   timestamptz null
  last_error     text null
  updated_at     timestamptz default now()
RLS: membros leem (viewer+), admin+ escreve; service role tudo.

conversations + channel text not null default 'official' check in ('official','qr')
messages      + channel text not null default 'official' check in ('official','qr')
```

`max_channels` passa a contar `whatsapp_config` (oficial) + `wa_qr_sessions` com status ≠ disconnected.

### 3. App (Next.js)

- **Ingestão compartilhada**: extrair de `src/app/api/whatsapp/webhook/route.ts` a lógica "mensagem recebida → contato (dedupe) → conversa (upsert, unread, last_message) → messages → automações → resposta de broadcast" para `src/lib/whatsapp/inbound.ts` com a função `ingestInboundMessage({ accountId, channel, from, pushName, messageId, type, text, mediaUrl, quotedMessageId, timestamp })`. O webhook da Meta e o endpoint do QR chamam a mesma função. Testes unitários da função com mock do Supabase.
- **Rotas** `src/app/api/channels/qr/`:
  - `connect`, `status`, `logout` (sessão do usuário, admin+ da conta, módulo `channel_qr`, limite `max_channels`): fazem proxy para o gateway com o secret e espelham o status em `wa_qr_sessions`.
  - `inbound`, `ack`, `status-event` (secret do gateway, sem sessão): gravam via service role.
- **Envio**: em `/api/whatsapp/send` e nas ações do inbox, se `conversation.channel === 'qr'` → `POST gateway /send`; senão fluxo Meta atual. Templates e broadcasts continuam exigindo oficial; interativos (botões/listas) não existem no QR: o fluxo/automação que os usar cai para texto simples.
- **Configurações → WhatsApp**: seletor "Como conectar" com duas opções, cada uma visível só se o módulo estiver ligado (`channel_official`, `channel_qr`). Painel QR: estado, botão Conectar, imagem do QR com polling de 2 s em `status`, "Conectado como <nome> · <número>", botão Desconectar, e o aviso de risco. Se nenhum módulo estiver ligado, mensagem "Nenhum canal incluído no seu plano".
- **Inbox**: selo do canal na linha da conversa e no cabeçalho; o banner de janela de 24 h e o botão de modelos só aparecem para `official`.
- **Env**: `WA_GATEWAY_URL` (ex.: `http://127.0.0.1:3201`), `WA_GATEWAY_SECRET`. Sem eles, a opção QR aparece desabilitada com a explicação "Gateway não configurado".

### 4. Execução

- Local: `npm run dev` em `services/wa-gateway` (porta 3201), entrada `wa-gateway` em `.claude/launch.json`, `.env.local` com as duas variáveis; `services/wa-gateway/.env` com `APP_URL=http://localhost:3101`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WA_GATEWAY_SECRET`, `WA_DATA_DIR`.
- VPS: segundo app no `deploy/contabo/ecosystem.config.cjs` (`wa-gateway`), `WA_DATA_DIR=/var/lib/semprecrm/wa` incluído no backup.

## Fora de escopo

Grupos, stories, reações via QR, múltiplos números QR por conta, migração de conversas entre canais.

## Testes

- Gateway: `session-manager.test.ts` (máquina de estados com Baileys mockado), `inbound-mapper.test.ts` (mensagem Baileys → payload do app).
- App: `inbound.test.ts` (ingestão compartilhada), testes das rotas `channels/qr/*` (auth, módulo, limite, proxy), `send` escolhendo o canal.
- Manual: conectar por QR na máquina local com um número real, receber e responder uma mensagem no inbox, ver a automação de boas-vindas disparar, reiniciar o gateway e confirmar que continua conectado.
