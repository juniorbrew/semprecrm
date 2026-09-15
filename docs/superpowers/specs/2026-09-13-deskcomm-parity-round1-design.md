# Paridade com o DeskcommCRM — rodada 1

Data: 2026-09-13. Aprovado em conversa ("autorizo fazer o que vc recomendar").

Origem: análise do repositório melgarafael/DeskcommCRM (CRM open-source para vendas via WhatsApp, mesma base
técnica). O SempreCRM já cobre inbox, contatos, funis, automações, disparos, flows, dois canais WhatsApp,
planos/painel master e tarefas. Esta rodada traz as seis peças que faltam e cabem na arquitetura atual.
Rodada 2 (spec separado, depois): auditoria de ações administrativas, LGPD (exportar/anonimizar contato),
métricas por atendente, MFA. Agente de IA com RAG fica como projeto próprio a desenhar com o cliente.

Convenções comuns: migrations idempotentes no estilo 017/020/025; RLS por `is_account_member()` (viewer+ lê,
agent+ escreve dados operacionais, admin+ escreve configuração); todo texto via `t()` com pt-BR/en-US em
`src/lib/i18n-extra.ts`; testes unitários em vitest para a lógica pura; verificação manual no navegador.

---

## 1. Respostas rápidas (migration 028)

Biblioteca por conta de textos prontos com atalho, inseridos no compositor do inbox. Sempre ligada (faz parte
do inbox), funciona nos dois canais.

```
quick_replies
  id uuid pk, account_id → accounts (cascade), shortcut text not null (sem espaços, minúsculo, único por conta),
  title text not null, body text not null, created_by uuid null → auth.users, created_at, updated_at.
  UNIQUE(account_id, shortcut). RLS: viewer+ lê, agent+ escreve.
```

- **Compositor** (`message-composer.tsx`): ao digitar `/` no início do texto (ou `/` após espaço) abre um
  popover ancorado acima do textarea com a lista filtrada por atalho/título (até 8), navegação por ↑/↓, Enter
  ou clique insere o `body` no lugar do `/termo`, Esc fecha. Botão ⚡ ao lado do emoji abre a mesma lista para
  quem não conhece o atalho. Ao inserir, resolve variáveis: `{{contato.nome}}`, `{{contato.primeiro_nome}}`,
  `{{atendente.nome}}`, `{{empresa}}` (nome da conta). Variável sem valor vira vazio.
- **Configurações → Respostas rápidas** (`quick-replies-settings.tsx`, seção `quick_replies`, grupo
  workspace, ícone Zap): tabela (atalho, título, prévia), criar/editar em dialog (atalho, título, corpo com
  botões para inserir variáveis, contador), excluir com confirmação, busca. Validação: atalho `^[a-z0-9_-]{1,30}$`.
- Lib `src/lib/quick-replies/` — `render.ts` (substituição de variáveis, testado), `match.ts` (filtro e
  ranking: atalho começa com > título contém, testado), `queries.ts`, `mutations.ts`.

## 2. Captura de leads por webhook (migration 029, módulo `lead_capture`)

Endpoint público por fonte que recebe leads de landing pages, formulários, Zapier e n8n e os coloca em contato
+ negócio + etiquetas, disparando automações.

```
lead_sources
  id uuid pk, account_id → accounts (cascade), name text not null, token text not null unique (32 bytes hex,
  gerado no servidor), is_active boolean default true,
  pipeline_id uuid null → pipelines (set null), stage_id uuid null → pipeline_stages (set null),
  tag_ids uuid[] not null default '{}', assignee_user_id uuid null → auth.users (set null),
  field_map jsonb not null default '{}'   -- ex.: {"name":"nome","phone":"telefone","email":"email",
                                           --       "company":"empresa","custom":{"<custom_field_id>":"origem"}}
  received_count int not null default 0, last_received_at timestamptz null,
  created_by uuid null, created_at, updated_at.
  RLS: viewer+ lê, admin+ escreve (token nunca vai para o cliente além do admin).

lead_source_events
  id uuid pk, account_id, source_id → lead_sources (cascade), status text check in ('ok','duplicate','error'),
  error text null, contact_id uuid null, deal_id uuid null, payload jsonb not null, created_at.
  Índice (source_id, created_at desc). RLS: viewer+ lê; escrita só service role. Retenção: o cron apaga
  eventos com mais de 90 dias.
```

- **Rota** `POST /api/v1/webhooks/in/[token]` (`src/app/api/v1/webhooks/in/[token]/route.ts`): pública,
  sem sessão, usa service role. Aceita `application/json` e `application/x-www-form-urlencoded`
  (também `multipart/form-data` simples). Rate limit por token com `src/lib/rate-limit.ts` (60/min).
  Passos: acha a fonte ativa pelo token (404 se não) → checa módulo `lead_capture` da conta (403) → aplica
  `field_map` (chaves ausentes no mapa caem no padrão `name/phone/email/company`; aceita caminhos com ponto
  `lead.telefone`) → normaliza telefone com `src/lib/whatsapp/phone-utils` (400 se ausente/inválido) → dedupe
  por `phone_normalized` com `src/lib/contacts/dedupe.ts` (existente: atualiza nome/e-mail/empresa vazios;
  novo: cria) → grava campos personalizados mapeados → aplica `tag_ids` → se `stage_id`: cria deal
  `title = "<nome ou telefone> · <fonte>"`, `assigned_to = assignee_user_id`, sem duplicar se já houver deal
  aberto do contato no mesmo funil → incrementa contador, grava evento → dispara automações:
  `new_contact_created` quando o contato é novo e sempre o novo gatilho `lead_captured`
  (`context.vars.source_id`, `source_name`). Resposta `200 { ok: true, contact_id, deal_id, duplicate }`.
  Lógica pura em `src/lib/lead-capture/` (`map-fields.ts`, `parse-body.ts`, `ingest.ts`) com testes (mapa
  padrão, caminho com ponto, form-urlencoded, telefone inválido, dedupe).
- **Gatilho de automação** `lead_captured`: `AutomationTriggerType` + `trigger-meta` + `validate` (config
  opcional `source_id`: só essa fonte) + inspetor no builder.
- **Configurações → Integrações** (nova seção `integrations`, grupo workspace, ícone Webhook,
  `lead-sources-settings.tsx`): lista de fontes (nome, ativa, recebidos, último), criar/editar em dialog
  (nome, funil → etapa, etiquetas, responsável, mapeamento de campos com linhas "campo do CRM ← chave do
  payload" incluindo campos personalizados), painel da fonte com URL completa (`NEXT_PUBLIC_SITE_URL`),
  botão copiar, exemplo `curl` e exemplo de formulário HTML, botão "Gerar novo token", e a lista dos últimos
  50 recebimentos (status, contato, hora, payload expansível). Só admin+ vê a seção.
- Módulo `lead_capture` em `src/lib/plans.ts`: OPTIONAL_MODULES; planos trial/pro/empresa. Painel master já
  lista. Sem módulo, a rota responde 403 e a seção mostra "não incluído no plano".

## 3. Radar e follow-up (migration 030)

Identifica conversas em risco e permite retomar automaticamente as que esfriaram.

```
conversations
  + last_customer_message_at timestamptz null
  + last_agent_message_at    timestamptz null
  Trigger AFTER INSERT em messages: sender_type='customer' → last_customer_message_at = created_at;
  'agent' ou 'bot' → last_agent_message_at. Backfill na migration a partir de messages.
  Índice (account_id, status, last_customer_message_at).

accounts
  + preferences jsonb not null default '{}'
  chaves usadas nesta rodada: inbox_sla_minutes (padrão 15), cooling_hours (padrão 24),
  opt_out_keywords (padrão ["parar","sair","stop","cancelar"]). Acesso tipado em
  src/lib/account-preferences.ts (defaults + parse, testado). Admin+ edita.

automation_inactivity_fires
  automation_id uuid → automations (cascade), conversation_id uuid → conversations (cascade),
  fired_for timestamptz not null, pk (automation_id, conversation_id).
```

Definições (`src/lib/radar/classify.ts`, puro, testado):

- **Aguardando atendimento**: status ≠ closed e `last_customer_message_at > coalesce(last_agent_message_at,
  '-infinity')` e `now - last_customer_message_at > inbox_sla_minutes`.
- **Sem responsável**: status = open e `assigned_agent_id is null` e há mensagem do cliente.
- **Esfriando**: status ≠ closed, última mensagem foi do atendente, `now - last_agent_message_at >
  cooling_hours` (cliente não respondeu).

Telas:

- **Dashboard**: card "Radar" com os três contadores e frase de tempo do caso mais antigo; cada contador
  abre `/inbox?radar=waiting|unassigned|cooling`.
- **Inbox** (`conversation-list.tsx`): novo grupo de chips "Radar" (Aguardando · Sem responsável ·
  Esfriando) acima das abas de triagem, ligado ao query param `radar`, com contagem; a linha da conversa
  mostra um relógio vermelho com "há Xmin" quando está aguardando além do SLA.
- **Configurações → Atendimento** (nova seção `inbox`, grupo workspace, ícone Timer,
  `inbox-settings.tsx`): SLA em minutos, horas para "esfriando", palavras de opt-out (item 5).

Follow-up:

- Novo gatilho `conversation_inactive` com config `{ hours: number (decimal permitido, 0.05–720), last_from: 'agent' | 'customer' |
  'any', statuses: ('open'|'pending')[] }`. Label pt-BR "Conversa sem resposta há X horas".
- `src/lib/automations/inactivity.ts`: `scanInactiveConversations(db, now)` — para cada automação ativa
  desse gatilho, busca conversas da conta que satisfazem (`last_message_at <= now - hours`, filtro de origem
  pelas duas colunas novas, status) e que não têm linha em `automation_inactivity_fires` com
  `fired_for >= last_message_at`; para cada uma chama `runAutomationsForTrigger` (contactId, context
  conversation_id) e faz upsert do fire com `fired_for = now`. Lote de 200 por chamada. Uma conversa dispara
  uma vez por "silêncio"; nova mensagem reinicia a contagem. Testes com mock do Supabase.
- `/api/automations/cron` passa a chamar o scan depois de drenar os pendentes, e a apagar
  `lead_source_events` com mais de 90 dias.
- Inspetor do gatilho no builder e template pronto "Retomar conversa fria" (gatilho 24h, last_from agent,
  passo send_message "Oi {{contact.name}}, ficou alguma dúvida?…").

## 4. Agendador interno (`scripts/cron-tick.mjs`)

Hoje os passos "aguardar", os gatilhos por horário e (a partir desta rodada) os gatilhos de inatividade só
rodam quando algo externo chama `/api/automations/cron` e `/api/flows/cron`. O script fecha esse buraco sem
depender da Vercel:

- Node puro, sem dependências. Lê `APP_URL` (padrão `http://127.0.0.1:3100`), `AUTOMATION_CRON_SECRET`,
  `CRON_INTERVAL_MS` (padrão 60000). A cada intervalo faz `GET` nos dois endpoints com `x-cron-secret`,
  loga uma linha por chamada (`processed`), tolera falha de rede (próximo tick), encerra limpo em SIGTERM.
- Local: entrada `cron-tick` em `.claude/launch.json` (`node scripts/cron-tick.mjs`, lendo `.env.local` via
  `--env-file`), `AUTOMATION_CRON_SECRET` gerado e gravado em `.env.local`.
- VPS: terceiro app em `deploy/contabo/ecosystem.config.cjs` (`semprecrm-cron`) e nota no README dos dois
  guias de deploy. `.env.example` documenta `AUTOMATION_CRON_SECRET`.

## 5. Opt-out (PARAR/SAIR) — mesma migration 030

```
contacts + opted_out_at timestamptz null
conversation_events: novo event_type 'contact_opted_out' | 'contact_opted_in'
```

- `src/lib/whatsapp/opt-out.ts`: `isOptOutMessage(text, keywords)` — mensagem inteira, sem acentos, sem
  pontuação, minúscula, igual a uma palavra da lista (testado). `ingestInboundMessage` chama após gravar a
  mensagem: marca `opted_out_at = now()`, grava o evento no stream da conversa, não dispara automações de
  envio para essa mensagem (`context.vars.opted_out = true`; o engine pula `send_message`/`send_template`
  quando o contato está descadastrado, registrando `skipped`).
- **Disparos**: `POST /api/whatsapp/broadcast` e `step2-select-audience.tsx` excluem contatos com
  `opted_out_at`, mostrando "N contatos descadastrados excluídos".
- **Contato**: selo "Descadastrado" no painel do inbox e na lista de contatos; admin+ pode reverter
  ("Reativar", grava `contact_opted_in`). Filtro "Descadastrados" na lista de contatos.

## 6. Motivo de perda (migration 031)

```
deal_loss_reasons
  id uuid pk, account_id → accounts (cascade), name text not null, position int not null,
  is_active boolean default true, created_at. UNIQUE(account_id, position) deferrable.
  Seed por conta (backfill + handle_new_user): Preço, Sem resposta, Escolheu concorrente, Sem interesse, Outro.
deals + loss_reason_id uuid null → deal_loss_reasons (set null), + lost_note text null
```

- Marcar "Perdido" em `deal-details.tsx` / `deal-drawer.tsx` abre dialog `lost-deal-dialog.tsx` (motivo
  obrigatório em select, nota opcional); reabrir o negócio limpa os dois campos. Card e detalhes mostram o
  motivo.
- `pipeline-analytics.tsx`: bloco "Motivos de perda" (barras horizontais, contagem e valor por motivo no
  período).
- **Configurações → Negócios e moeda**: lista de motivos (renomear, reordenar, ativar/desativar, adicionar;
  excluir só se nenhum negócio usa, senão desativar).
- `src/lib/pipelines/loss-reasons.ts` (agregação para o gráfico, testado).

---

## Ordem de execução e independência

Quatro entregas paralelizáveis, cada uma com sua migration e commit:

| Entrega | Itens | Migration |
|---|---|---|
| A | Respostas rápidas | 028 |
| B | Captura de leads + gatilho `lead_captured` | 029 |
| C | Radar + follow-up + agendador + opt-out | 030 |
| D | Motivo de perda | 031 |

Arquivos compartilhados (`src/types/index.ts`, `src/lib/i18n-extra.ts`, `settings-sections.ts`,
`src/lib/plans.ts`, `trigger-meta.ts`, `validate.ts`): cada entrega só acrescenta blocos próprios e relê o
arquivo antes de editar.

## Fora de escopo

Agente de IA, agenda pública, catálogo de produtos, Nuvemshop, Ads Meta, auditoria, LGPD, métricas por
atendente, MFA (rodada 2), confirmação automática de opt-out por mensagem, follow-up por canal oficial com
template (o passo `send_template` já existe e pode ser usado na automação).

## Verificação

typecheck, lint 0 erros, vitest verde. Manual: `/atalho` no compositor insere texto com nome do contato;
`curl -d "nome=Ana&telefone=5511999990000"` na URL da fonte cria contato+negócio e aparece no log; card Radar
com contagens coerentes e chips do inbox filtrando; automação "Retomar conversa fria" disparando via
`cron-tick` numa conversa antiga (ajustar `hours` para 0.05 no teste); cliente enviando "PARAR" fica
descadastrado e some da audiência do disparo; marcar negócio perdido pede motivo e o gráfico mostra.
