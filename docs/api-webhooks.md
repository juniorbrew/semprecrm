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
- Uma chave que já está no período de transição não pode ser rotacionada de novo (isso prolongaria a antiga):
  espere o prazo acabar ou revogue.
- A tela mostra o prefixo, os 4 últimos caracteres, a observação, quando e **de qual IP** a chave foi usada
  pela última vez.
- **Observação** (opcional): anote para que serve a chave.
- **IPs permitidos** (opcional, até 10 endereços ou faixas CIDR, ex.: `203.0.113.7`, `198.51.100.0/24`):
  com a lista preenchida, a chave só funciona a partir desses endereços (`403 ip_not_allowed` nos demais).
  Vazio = qualquer endereço. A rotação copia a lista.
  **Como o IP é obtido:** o app lê o endereço do cabeçalho `X-Real-IP` que o Nginx define a partir da conexão real.
  Isso só é confiável se o app for alcançável **exclusivamente pelo proxy**: na VPS padrão o Next escuta apenas em
  `127.0.0.1` (`next start -H 127.0.0.1`, ver `deploy/contabo/README.md`). Se você expuser a porta do app
  diretamente, qualquer um pode forjar `X-Real-IP` e burlar a lista.
- **Requisições**: em cada chave, o botão *Requisições* mostra as últimas 50 chamadas autenticadas dos
  últimos 7 dias (horário, rota, status HTTP e IP). Chamadas recusadas antes de identificar a chave
  (chave inválida) não aparecem aí; as recusas de uma chave conhecida (IP não permitido, conta bloqueada, sem
  permissão, limite excedido) aparecem, no máximo uma por minuto para cada motivo.
- Nunca coloque a chave em código de navegador ou repositório público.

### Limites e erros

- 120 requisições por minuto **por chave** e 300 por minuto **por conta** (somando todas as chaves).
  Ao estourar: `429` com `Retry-After`. **Os limites são contados na memória de cada processo do servidor**: com uma
  única instância (o padrão) valem exatamente isso; com várias instâncias cada uma teria o seu próprio orçamento.
- Erros seguem sempre o formato `{ "error": { "code": "...", "message": "..." } }`.

| HTTP | `code` | Significado |
|---|---|---|
| 401 | `missing_api_key` | Faltou `Authorization: Bearer ...` ou o formato é inválido |
| 401 | `invalid_api_key` / `api_key_revoked` / `api_key_expired` | Chave desconhecida, revogada ou fora do prazo de transição |
| 403 | `insufficient_scope` | A chave não tem a permissão exigida |
| 403 | `ip_not_allowed` | A chave tem lista de IPs e a chamada veio de outro endereço |
| 403 | `account_blocked` | A conta está suspensa ou o plano não está ativo |
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
`403 contact_opted_out` (o contato pediu para não receber mensagens), `403 module_not_included` (o canal usado
não faz parte do plano), `409 channel_conflict`.

Falhas de envio, e o que cada uma garante:

| HTTP | `code` | A mensagem saiu? | O que fazer |
|---|---|---|---|
| 422 | `channel_not_configured`, `channel_not_connected`, `not_on_whatsapp`, `send_rejected` | **Não** | Corrija (conecte o canal, confira o número) e tente de novo |
| 502 | `send_failed` | **Não**: o WhatsApp/Meta recusou com 400, 401, 403, 404 ou 422 | Pode tentar de novo (depois de corrigir a causa) |
| 503 | `temporarily_unavailable` | **Não**: não foi possível registrar o envio com segurança e ele nem começou | Tente de novo com a mesma chave |
| 502 | `send_unknown` | **Não se sabe**: timeout, conexão caiu ou erro do provedor depois que o envio começou | **Não reenvie às cegas.** Veja a conversa no Atendimento |
| 502 | `send_unconfirmed` | **Sim**, mas não foi possível registrá-la | **Não reenvie** |

Só `send_failed`, `temporarily_unavailable` e os `422` garantem que nada foi enviado. Qualquer outro erro depois
do início do envio (inclusive respostas 408, 409, 429 e 5xx do provedor) é tratado como "talvez tenha saído".

#### Evite envio duplicado: `Idempotency-Key`

Se a requisição der timeout, você não sabe se a mensagem saiu. Mande um cabeçalho `Idempotency-Key` (1 a 255
caracteres ASCII, ex.: um UUID ou o id do pedido) e repita a **mesma** requisição com a **mesma** chave:

```bash
curl -X POST https://api.semprecrm.com.br/api/v1/messages \
  -H "Authorization: Bearer $SEMPRECRM_KEY" \
  -H "Idempotency-Key: pedido-8841-saiu-para-entrega" \
  -H "Content-Type: application/json" \
  -d '{ "to": "5511999990000", "text": "Seu pedido saiu para entrega." }'
```

- Mesma chave e mesmo corpo depois de concluída: a resposta guardada volta com o cabeçalho
  `Idempotent-Replayed: true`, **sem enviar de novo**.
- Mesma chave com corpo diferente (`to`, `text` ou `channel`): `422 idempotency_key_reused`.
- Mesma chave enquanto a primeira ainda está sendo processada: `409 idempotency_in_progress`; tente de novo em
  instantes.
- Se a requisição falhou **com garantia de que nada saiu** (validação, plano, canal desconectado, a Meta
  recusou com 4xx: ver a tabela acima), a chave é liberada e você pode corrigir e tentar de novo com a mesma
  chave.
- Se o resultado é **ambíguo** (`send_unknown`, `send_unconfirmed`: timeout, conexão caiu depois do envio), ele
  é guardado e **repetido** nas próximas tentativas com a mesma chave (`Idempotent-Replayed: true`): a API nunca
  reenvia no escuro. Para mandar de novo de propósito, use uma chave nova.
- Se o servidor cair no meio, a requisição fica "em processamento" (`409`) por **10 minutos** (mais que o pior
  caso de um envio: fila anti-banimento do canal QR + timeout do provedor). Depois disso, a próxima tentativa com
  a mesma chave resolve o caso: cada pedido tem um identificador próprio gravado na mensagem que ele envia, então
  só a mensagem **daquele** pedido conta (outra chamada com o mesmo texto não é confundida com ela). Se a
  mensagem existe, a resposta de sucesso original é devolvida; se o envio nem chegou a começar, **uma** das
  tentativas assume a chave e executa; se não dá para saber, vem `502 send_unknown`. Nunca fica travada por 24 h e
  nunca duplica. Se o pedido original terminar depois, o resultado verdadeiro substitui um `send_unknown`
  guardado, mas nunca um sucesso.
- As chaves de idempotência valem por conta (não por chave de API) e são apagadas após 24 h.
- No n8n, ative *Retry On Fail* no nó *HTTP Request* e use um valor estável no cabeçalho (ex.:
  `{{ $execution.id }}-{{ $itemIndex }}`), nunca algo que muda a cada tentativa.

Observações do canal oficial: texto livre só chega dentro da janela de 24 h aberta pela última mensagem do
cliente (regra do WhatsApp); fora dela a Meta recusa e a API responde `502 send_failed` (nada foi enviado). No canal QR os envios
da conta são espaçados (~1,2 s) para proteger o número, então uma rajada pode demorar.

### `GET /api/v1/contacts?phone=5511999990000` (`contacts:read`)

Retorna o contato ou `404 not_found`.

```json
{ "object": "contact", "id": "…", "phone": "5511999990000", "name": "Maria", "email": null, "company": null, "created_at": "…" }
```

---

## 3. Webhooks de saída

Em **Webhooks → Adicionar endpoint** informe:

- **URL** `https` pública na porta padrão (443). Endereços internos/privados, `http` e portas diferentes são
  recusados, no cadastro e a cada envio;
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

Responda com **2xx em até 10 segundos**. Qualquer outra coisa conta como falha e a entrega é repetida:
timeout, erro de conexão e também **redirecionamentos (3xx), que não são seguidos**: cadastre a URL final. Grave o evento e processe de forma assíncrona.

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

### Receitas prontas

**Funções de verificação sem dependências** (copie e cole; testadas contra a assinatura real do servidor):
[`docs/examples/verify-webhook.mjs`](examples/verify-webhook.mjs) (Node),
[`docs/examples/verify_webhook.py`](examples/verify_webhook.py) (Python) e
[`docs/examples/verify-webhook.php`](examples/verify-webhook.php) (PHP). Todas recebem o corpo bruto, o cabeçalho
`SempreCRM-Signature` e a lista de segredos aceitos (o novo e, durante a rotação, o antigo).
Os exemplos em Node e Python são executados nos testes do projeto; o de PHP segue o mesmo algoritmo, mas não é
executado pela nossa suíte.

#### n8n (receita que funciona de primeira)

1. **Nó Webhook**: método `POST`, em *Options* ligue **Raw Body**, *Respond* = `Immediately` (assim você
   responde 200 na hora, sem esperar o resto do fluxo). Copie a *Production URL* (https) para o endpoint no
   SempreCRM. A URL de produção só recebe com o workflow **ativado**.
   Com *Raw Body* o corpo chega como arquivo binário na propriedade `data`, e os cabeçalhos chegam em minúsculas:
   `$json.headers['semprecrm-signature']`.
2. **Nó Code** (*Run Once for All Items*, JavaScript), ligado ao Webhook:

   ```js
   const crypto = require('crypto') // precisa de NODE_FUNCTION_ALLOW_BUILTIN=crypto (veja abaixo)

   const SECRETS = ['whsec_COLE_AQUI'] // inclua o antigo durante uma rotação
   const item = $input.first()
   const raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8')
   const header = item.json.headers['semprecrm-signature'] || ''

   let t = NaN
   const sigs = []
   for (const part of header.split(',')) {
     const i = part.indexOf('=')
     if (i < 0) continue
     const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim()
     if (k === 't') t = Number(v)
     if (k === 'v1') sigs.push(v)
   }
   const fresh = Number.isInteger(t) && Math.abs(Date.now() / 1000 - t) <= 300
   const valid = fresh && SECRETS.some((s) => {
     const exp = crypto.createHmac('sha256', s).update(`${t}.${raw}`).digest()
     return sigs.some((g) => {
       const b = Buffer.from(g, 'hex')
       return b.length === exp.length && crypto.timingSafeEqual(b, exp)
     })
   })

   return [{ json: { valid, event: valid ? JSON.parse(raw) : null } }]
   ```

3. **Nó IF**: `{{ $json.valid }}` é verdadeiro. No ramo *true* use `{{ $json.event.type }}` e
   `{{ $json.event.data.object }}`. Descarte o ramo *false*.
4. **Deduplique** por `{{ $json.event.id }}` (ex.: nó *Remove Duplicates*, ou uma tabela com o id).

`require('crypto')` no nó Code **só funciona** se o n8n for iniciado com a variável de ambiente
`NODE_FUNCTION_ALLOW_BUILTIN=crypto` (no Docker: `-e NODE_FUNCTION_ALLOW_BUILTIN=crypto`). Sem ela o nó acusa
"Module 'crypto' is disallowed". No **n8n Cloud** módulos nativos não são liberados; use o caminho com o nó
**Crypto** abaixo.

*Sem `require`, só com nós nativos:*

1. Webhook com *Raw Body*, como acima.
2. **Extract From File** (operação *Extract From Text File*, *Input Binary Field* = `data`): o corpo bruto vira o
   texto `{{ $json.data }}`.
3. **Edit Fields (Set)**: crie `signed` =
   `{{ $('Webhook').item.json.headers['semprecrm-signature'].match(/t=(\d+)/)[1] + '.' + $json.data }}`.
4. **Crypto**: *Action* `Hmac`, *Type* `SHA256`, *Value* = `{{ $json.signed }}`, *Secret* = seu `whsec_...`,
   *Encoding* `hex`, *Property Name* `hmac`.
5. **IF**: `{{ $('Webhook').item.json.headers['semprecrm-signature'].includes('v1=' + $json.hmac) }}` é
   verdadeiro (e confira também que `t` está a menos de 5 minutos de `{{ Math.floor($now.toSeconds()) }}`).
   Aqui a comparação não é em tempo constante; é aceitável dentro do n8n, mas prefira o nó Code quando puder.

Os nomes exatos das opções podem variar um pouco entre versões do n8n; o que não muda é: corpo **bruto**, texto
assinado `t.corpo`, HMAC-SHA256 em hexadecimal.

**Nunca** monte o texto assinado com `JSON.stringify($json.body)`: o corpo reencodado muda espaços e a assinatura
não confere.

Para **enviar mensagens** pelo n8n use o nó *HTTP Request*: `POST https://api.semprecrm.com.br/api/v1/messages`,
autenticação *Generic Credential Type → Header Auth* (nome `Authorization`, valor `Bearer scrm_live_...`),
corpo JSON `{ "to": "...", "text": "..." }` e o cabeçalho `Idempotency-Key`.

#### Make (Integromat)

O módulo *Webhooks → Custom webhook* entrega o corpo **já interpretado** e não expõe os bytes originais, então
não dá para recalcular o HMAC dentro do Make. Opções:

- Ative **Get request headers** no módulo e proteja o endpoint com um token longo e aleatório na própria URL
  (`https://hook.make.com/xxxx?token=<32+ caracteres>`) conferido por um filtro; combine com a lista de eventos
  mínima. É menos forte que a assinatura (o token pode vazar em logs), mas suficiente para muitos casos.
- Para validar a assinatura de verdade, receba o webhook em um serviço seu pequeno (Cloudflare Worker, Cloud
  Function, Express com `docs/examples/verify-webhook.mjs`) e repasse só os eventos válidos para o Make.
- Deduplique por `id` com um *Data store* (*Add/replace record* usando o id do evento como chave).
- Para enviar mensagens use *HTTP → Make a request* com o cabeçalho `Authorization: Bearer scrm_live_...` e o
  cabeçalho `Idempotency-Key`.

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
- **Janela de duplicidade**: se o servidor cair exatamente entre o envio e o registro do resultado, o evento é
  reenviado depois (mesmo `id`). Por isso o receptor deve ser idempotente.
- Contas suspensas ou com plano inativo não enviam webhooks: as entregas ficam retidas e são tentadas de novo a
  cada hora, expirando após 72 h.
- Eventos e histórico ficam guardados por 30 dias. Quando um contato é anonimizado ou excluído (LGPD), os
  eventos sobre ele são apagados, inclusive os pendentes.
- No histórico, a resposta do seu servidor aparece só se for texto/JSON, truncada em 256 bytes.

### Painel de entregas

Em cada endpoint: **Histórico de entregas** com status (Entregue / Pendente / Falhou), código HTTP, número de
tentativas e próxima tentativa; ao abrir uma linha você vê o corpo enviado e cada tentativa (horário, duração,
código, erro e o começo da resposta do seu servidor). **Reenviar** cria uma nova entrega do mesmo evento (mesmo
`id`) e tenta na hora. **Enviar evento de teste** dispara um `webhook.test` assinado, sem retentativas.

### Rotacionar o segredo

**Rotacionar segredo** gera um segredo novo; durante o período de sobreposição (padrão 24 h, escolha até 7
dias, ou 0 para trocar na hora) as entregas levam duas assinaturas (a nova e a antiga). Atualize o segredo no
seu receptor dentro desse prazo e nada se perde.

---

## 4. Limites e observações

- Até 20 chaves ativas (as que ainda autenticam, incluindo antigas em período de transição) e 10 endpoints por
  conta.
- O limite de 120 req/min por chave é contado por processo do servidor.
- Os eventos incluem texto de mensagens e telefones: trate o endpoint como dado sensível (LGPD) e use sempre
  `https`.
