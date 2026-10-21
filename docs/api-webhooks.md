# API e Webhooks do SempreCRM

Guia para quem vai integrar o SempreCRM com n8n, Zapier, Make ou sistemas próprios.

- **API pública (`/api/v1`)**: envie mensagens de WhatsApp e consulte contatos usando uma chave de API.
- **Webhooks de saída**: o SempreCRM faz um `POST` assinado na sua URL sempre que algo acontece
  (mensagem recebida, mensagem enviada, conversa criada...).

Tudo é configurado em **Configurações → API e Webhooks** (somente administradores da conta).

---

## 1. Autenticação (chaves de API)

1. Em **Configurações → API e Webhooks → Chaves de API**, clique em **Nova chave de API**.
2. Dê um nome (ex.: `n8n produção`) e marque só as permissões necessárias.
3. **Copie a chave na hora**: ela é mostrada uma única vez. O SempreCRM guarda apenas um hash.

Envie a chave no cabeçalho `Authorization`:

```bash
curl https://api.semprecrm.com.br/api/v1/me \
  -H "Authorization: Bearer scrm_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

| Permissão | Para que serve |
|---|---|
| `messages:send` | `POST /api/v1/messages` |
| `contacts:read` | `GET /api/v1/contacts` |

Boas práticas:

- Uma chave por integração, com o mínimo de permissões.
- **Rotação sem downtime**: clique em **Rotacionar**. Uma chave nova é criada e a antiga continua
  funcionando pelo período de transição escolhido (padrão 24 h, até 7 dias). Troque a chave na integração e
  pronto; ao fim do prazo a antiga para de valer sozinha.
- **Revogar** derruba a chave imediatamente.
- A tela mostra o prefixo, os 4 últimos caracteres e quando a chave foi usada pela última vez.
- Nunca coloque a chave em código de navegador ou repositório público.

### Limites e erros

- 120 requisições por minuto **por chave**. Ao estourar: `429` com `Retry-After`.
- Erros seguem sempre o formato `{ "error": { "code": "...", "message": "..." } }`.

| HTTP | `code` | Significado |
|---|---|---|
| 401 | `missing_api_key` | Faltou `Authorization: Bearer ...` ou o formato é inválido |
| 401 | `invalid_api_key` / `api_key_revoked` / `api_key_expired` | Chave desconhecida, revogada ou fora do prazo de transição |
| 403 | `insufficient_scope` | A chave não tem a permissão exigida |
| 429 | `rate_limited` | Limite por minuto atingido |

---

## 2. Endpoints

### `GET /api/v1/me`

Teste barato de autenticação (qualquer permissão).

```json
{ "account_id": "…", "api_key_id": "…", "scopes": ["messages:send"] }
```

### `POST /api/v1/messages` (`messages:send`)

Envia um texto pelo canal do WhatsApp da conta (oficial ou QR). Se o número ainda não é contato, ele é criado;
se não há conversa aberta, uma é aberta. A mensagem aparece no Atendimento com origem "API".

```bash
curl -X POST https://api.semprecrm.com.br/api/v1/messages \
  -H "Authorization: Bearer $SEMPRECRM_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "to": "5511999990000", "text": "Olá! Seu pedido saiu para entrega." }'
```

| Campo | Obrigatório | Descrição |
|---|---|---|
| `to` | sim | Telefone com DDI e DDD, só dígitos (`5511999990000`) |
| `text` | sim | Texto, até 4096 caracteres |
| `channel` | não | `official` ou `qr`. Padrão: o canal da conversa aberta; sem conversa, `official` se a conta tem a API oficial configurada, senão `qr` |

Resposta `201`:

```json
{
  "object": "message",
  "message_id": "uuid da mensagem no SempreCRM",
  "conversation_id": "…",
  "contact_id": "…",
  "channel": "official",
  "whatsapp_message_id": "wamid…"
}
```

Erros específicos: `400 invalid_phone | invalid_text | invalid_channel | invalid_json`,
`403 contact_opted_out` (o contato pediu para não receber mensagens), `409 channel_conflict`,
`422 channel_not_configured`, `502 send_failed`.

Observações do canal oficial: texto livre só chega dentro da janela de 24 h aberta pela última mensagem do
cliente (regra do WhatsApp); fora dela a Meta recusa e a API responde `502 send_failed`. No canal QR os envios
da conta são espaçados (~1,2 s) para proteger o número, então uma rajada pode demorar.

### `GET /api/v1/contacts?phone=5511999990000` (`contacts:read`)

Retorna o contato ou `404 not_found`.

```json
{ "object": "contact", "id": "…", "phone": "5511999990000", "name": "Maria", "email": null, "company": null, "created_at": "…" }
```

---

## 3. Webhooks de saída

Em **Webhooks → Adicionar endpoint** informe:

- **URL** `https` pública (endereços internos/privados são recusados, também no momento do envio);
- **Eventos**: escolha só os que interessam (ou "Todos os eventos");
- uma descrição opcional.

Ao criar, o **segredo de assinatura** (`whsec_...`) é mostrado e pode ser revelado de novo depois na tela
do endpoint.

### Eventos

| Evento | Quando |
|---|---|
| `message.received` | Chegou mensagem de um cliente (qualquer canal) |
| `message.sent` | Mensagem enviada ao cliente: atendente, bot/IA, automação, fluxo, API |
| `message.status` | O status mudou: `sent`, `delivered`, `read`, `failed` |
| `conversation.created` | Nova conversa |
| `conversation.closed` | Conversa resolvida |
| `conversation.reopened` | Conversa resolvida foi reaberta |
| `contact.created` | Novo contato (WhatsApp, formulário, importação, API...) |
| `webhook.test` | Só pelo botão **Enviar evento de teste** |

Os eventos são gravados dentro da mesma transação que grava a mensagem/conversa/contato (gatilhos no banco),
então **todos os caminhos** de entrada e saída são cobertos e nenhum evento se perde.

### Formato

`POST` com `Content-Type: application/json`:

```json
{
  "id": "evt_0b6f6f0c7e6a4f4f9d8d3c1a2b3c4d5e",
  "object": "event",
  "api_version": "2026-10-01",
  "type": "message.received",
  "created": 1790000000,
  "account_id": "…",
  "data": {
    "object": {
      "id": "uuid da mensagem",
      "conversation_id": "…",
      "contact": { "id": "…", "phone": "5511999990000", "name": "Maria" },
      "channel": "official",
      "direction": "inbound",
      "sender_type": "customer",
      "origin": null,
      "content_type": "text",
      "text": "Oi, quero saber o preço",
      "media_url": null,
      "template_name": null,
      "whatsapp_message_id": "wamid…",
      "status": "sent",
      "created_at": "2026-10-20T12:00:00.000Z"
    }
  }
}
```

`data.object` de cada tipo:

- `message.sent`: igual ao acima, com `direction: "outbound"` e `sender_type` `agent` ou `bot` (`origin` diz
  se foi `automation`, `flow`, `ai`, `api`...).
- `message.status`: `id`, `conversation_id`, `contact_id`, `channel`, `whatsapp_message_id`, `status`,
  `previous_status`, `error_code`, `error_title`, `error_details`.
- `conversation.*`: `id`, `contact_id`, `channel`, `status`, `assigned_agent_id`, `resolution`, `created_at`,
  `resolved_at`.
- `contact.created`: `id`, `phone`, `name`, `email`, `company`, `created_at`.

Cabeçalhos úteis em toda entrega:

| Cabeçalho | Conteúdo |
|---|---|
| `SempreCRM-Signature` | `t=<unix>,v1=<hmac>[,v1=<hmac>]` (ver abaixo) |
| `SempreCRM-Event-Id` | O mesmo `id` do corpo |
| `SempreCRM-Delivery-Id` | Id desta entrega |
| `SempreCRM-Attempt` | Número da tentativa (1, 2, 3...) |

### Responda rápido, processe depois

Responda com **2xx em até 10 segundos**. Qualquer outra coisa (inclusive timeout ou redirecionamento sem
destino público) conta como falha e a entrega é repetida. Grave o evento e processe de forma assíncrona.

### Verificando a assinatura

A assinatura é `HMAC-SHA256` da string `"<t>.<corpo bruto>"` usando o segredo do endpoint. Use o **corpo bruto**
(bytes exatos recebidos), não o JSON reencodado. Rejeite requisições com `t` a mais de 5 minutos de diferença
para evitar replay.

Durante uma **rotação de segredo** o cabeçalho traz duas assinaturas `v1` (segredo novo e antigo): basta que uma
confira com algum dos segredos que você conhece.

Exemplo em Node.js (Express):

```js
const crypto = require('node:crypto')
const express = require('express')

const SECRETS = [process.env.SEMPRECRM_WEBHOOK_SECRET] // adicione o antigo durante a rotação
const TOLERANCE_SECONDS = 300

function verify(rawBody, header) {
  let t = NaN
  const signatures = []
  for (const part of String(header || '').split(',')) {
    const [k, v] = part.split('=')
    if (k === 't') t = Number(v)
    if (k === 'v1') signatures.push(v)
  }
  if (!Number.isInteger(t) || signatures.length === 0) return false
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false

  return SECRETS.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
    return signatures.some((sig) => {
      const got = Buffer.from(sig, 'hex')
      return got.length === expected.length && crypto.timingSafeEqual(got, expected)
    })
  })
}

const app = express()
// express.raw preserva o corpo exato
app.post('/webhooks/semprecrm', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8')
  if (!verify(raw, req.get('SempreCRM-Signature'))) return res.sendStatus(400)

  const event = JSON.parse(raw)
  // Deduplique por event.id: a mesma entrega pode chegar mais de uma vez.
  // Os eventos NÃO têm ordem garantida: use created_at/status para ordenar.
  console.log(event.type, event.id)
  res.sendStatus(200)
})
app.listen(3000)
```

No **n8n**, use o nó *Webhook* (método POST, "Raw Body" ligado) e valide a assinatura em um nó *Code* com a
função acima.

### Entrega, tentativas e ordem

- **At-least-once**: um evento pode chegar mais de uma vez. Deduplique por `id` (`evt_...`), que é o mesmo em
  todas as tentativas, em reenvios e em cada endpoint.
- **Sem garantia de ordem**: por exemplo `message.status` pode chegar antes de `message.sent` se a primeira
  tentativa deste falhou. Use os campos de data/status do payload.
- **Reentrega automática** com backoff exponencial e variação de ±10%: 1 min, 5 min, 15 min, 1 h, 3 h, 6 h,
  depois a cada 12 h, até 12 tentativas em cerca de 70 horas (limite de 3 dias). Depois disso a entrega fica
  como **Falhou**.
- Se o endpoint ficar **48 horas sem nenhuma entrega com sucesso**, ele é **desativado automaticamente**
  (aparece o aviso na tela). Corrija a URL e ative de novo.
- A cada tentativa a assinatura recebe um `t` novo; o corpo é o mesmo.
- Eventos e histórico ficam guardados por 30 dias.

### Painel de entregas

Em cada endpoint: **Histórico de entregas** com status (Entregue / Pendente / Falhou), código HTTP, número de
tentativas e próxima tentativa; ao abrir uma linha você vê o corpo enviado e cada tentativa (horário, duração,
código, erro e o começo da resposta do seu servidor). **Reenviar** cria uma nova entrega do mesmo evento (mesmo
`id`) e tenta na hora. **Enviar evento de teste** dispara um `webhook.test` assinado, sem retentativas.

### Rotacionar o segredo

**Rotacionar segredo** gera um segredo novo; por 24 horas as entregas levam duas assinaturas (a nova e a
antiga). Atualize o segredo no seu receptor dentro desse prazo e nada se perde.

---

## 4. Limites e observações

- Até 20 chaves ativas e 10 endpoints por conta.
- O limite de 120 req/min por chave é contado por processo do servidor.
- Os eventos incluem texto de mensagens e telefones: trate o endpoint como dado sensível (LGPD) e use sempre
  `https`.
