# Agenda interna + sincronização com Google Agenda e Outlook

Data: 2026-09-14. Aprovado em conversa ("Sim, pode seguir"). Sem referência externa (mesmo modelo do chat).

## Objetivo

Agenda nativa por conta (tenant), ligável como módulo no painel master, com compromissos vinculados a
contato, conversa do inbox, negócio, tarefa e conversa do chat interno; criação a partir dessas telas;
lembretes; e, na fase 2, sincronização em dois sentidos com Google Agenda e Outlook por usuário.

Convenções: migrations idempotentes (estilo 027–039), RLS via `is_account_member()`, `t()` com pt-BR/en-US
em `i18n-extra.ts`, vitest na lógica pura, verificação no navegador. Datas com `date-fns` (já é dependência);
fuso da conta = `preferences.business_hours.timezone` (padrão America/Sao_Paulo); tudo gravado em UTC.

## Módulo

`calendar` em `src/lib/plans.ts` (OPTIONAL_MODULES; trial, pro, empresa), label "Agenda";
`platform_update_account` redefinido (como 037/038) aceitando a chave. Rota `/agenda` com ModuleGuard, item
"Agenda" no sidebar (ícone CalendarDays) com badge = compromissos meus nas próximas 2 h.

## Fase 1 — dados (migration 040_calendar.sql)

```
calendar_events
  id uuid pk, account_id → accounts (cascade), owner_user_id → auth.users (set null),
  title text not null, description text null, location text null, color text null,
  starts_at timestamptz not null, ends_at timestamptz not null (check ends_at > starts_at),
  all_day boolean not null default false,
  status text not null default 'confirmed' check in ('confirmed','cancelled'),
  reminder_minutes int null (5, 10, 15, 30, 60, 1440), reminded_at timestamptz null,
  contact_id → contacts (set null), conversation_id → conversations (set null), deal_id → deals (set null),
  task_id → tasks (set null), chat_thread_id → chat_threads (set null),
  -- sincronização (fase 2)
  source text not null default 'internal' check in ('internal','google','microsoft'),
  external_connection_id uuid null, external_id text null, external_etag text null,
  external_updated_at timestamptz null, sync_hash text null,
  created_by uuid null, created_at, updated_at.
  Índices: (account_id, starts_at), (account_id, owner_user_id, starts_at), (contact_id), (deal_id),
  (task_id), unique (external_connection_id, external_id) where external_id is not null.

calendar_event_attendees
  event_id → calendar_events (cascade), user_id → auth.users (cascade),
  response text not null default 'needs_action' check in ('needs_action','accepted','declined'),
  pk (event_id, user_id).

RLS: membros da conta leem tudo (agenda de equipe); agent+ cria; edita/cancela o dono, um participante
(só a própria resposta) ou admin+. Realtime em calendar_events e attendees.
Trigger: ao alterar starts_at/reminder_minutes zera reminded_at.
```

Lib `src/lib/calendar/` — `types.ts`, `range.ts` (grade do mês/semana/dia, expansão de dia inteiro, fuso;
testado), `queries.ts` (eventos por intervalo com filtros mine/team/user, por vínculo, "hoje", "próximas 2 h"),
`mutations.ts` (criar, mover, redimensionar, cancelar, responder), `conflicts.ts` (sobreposição do mesmo
responsável — só aviso, não bloqueia; testado), `links.ts` (rótulo e URL de cada vínculo; testado).

## Fase 1 — telas

- **/agenda** (`src/app/(dashboard)/agenda/page.tsx`, componentes em `src/components/calendar/`):
  cabeçalho (hoje, ‹ ›, título do período, alternância Mês | Semana | Dia persistida em localStorage,
  filtro Minha / Equipe / pessoa, botão "Novo compromisso"). Mês: grade 6×7 com até 3 eventos por dia e
  "+N"; Semana/Dia: colunas por dia com linha do tempo de 06:00–22:00 (rolável para 00–24), linha "agora",
  eventos posicionados por hora, dia inteiro na faixa superior. Clique/arraste num espaço vazio cria
  (quick-create popover: título, horário, vínculo opcional); arrastar move; alça inferior redimensiona (30 min);
  cores por responsável (paleta estável por user_id) ou cor do evento.
- **Drawer do compromisso**: título, data/hora início e fim, dia inteiro, local, descrição, responsável,
  participantes (chips de membros, resposta de cada um), lembrete, cor, vínculos (contato com busca; conversa
  do contato; negócio do contato; tarefa; chat interno) — cada vínculo é clicável e abre a tela
  correspondente; botões Salvar, Cancelar compromisso, Excluir; aviso de conflito de horário do responsável.
- **Integrações nas telas existentes** (componente compartilhado `<LinkedEvents>` + `<ScheduleButton>`):
  inbox: item "Agendar" no menu ⋮ do cabeçalho (prefill contato + conversa) e seção "Agenda" no painel do
  contato (próximos 3, "+" inline: título + data/hora); contato (página): mesma seção; negócio (deal-details):
  seção "Agenda" com "+" (prefill negócio + contato); tarefa (drawer): "Agendar" (prefill tarefa, título e
  contato da tarefa; ao salvar, opcionalmente define o prazo da tarefa = início); chat interno: menu da
  mensagem "Agendar a partir desta mensagem" (prefill título = trecho, chat_thread_id, participantes = membros
  da conversa).
- **Dashboard**: card "Hoje na agenda" (meus compromissos de hoje, próximos primeiro, até 6, link /agenda).
- **Lembretes**: no cron (`/api/automations/cron`), eventos com `reminder_minutes` cujo
  `starts_at - reminder_minutes <= now` e `reminded_at is null` → push `calendar_reminder` para responsável e
  participantes (nova kind em `src/lib/push`, toggle em Configurações → Notificações), marca `reminded_at`.

## Fase 2 — Google Agenda e Outlook (migration 041_calendar_sync.sql)

```
calendar_connections
  id uuid pk, account_id, user_id → auth.users (cascade), provider text check in ('google','microsoft'),
  email text, external_calendar_id text (primary), access_token_enc text, refresh_token_enc text,
  token_expires_at timestamptz, sync_cursor text null (Google syncToken / Graph deltaLink),
  last_sync_at timestamptz null, last_error text null, status text check in ('active','error','revoked'),
  created_at, updated_at. unique (user_id, provider). RLS: só o próprio usuário lê (sem tokens: view
  `calendar_connections_public` sem colunas *_enc); escrita só pelo servidor (service role).
Tokens cifrados com `src/lib/whatsapp/encryption.ts` (ENCRYPTION_KEY).
```

- **Env**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT`
  (padrão `common`). Redirects `${NEXT_PUBLIC_SITE_URL}/api/integrations/google/callback` e
  `/api/integrations/microsoft/callback`. Guia passo a passo em `docs/integracoes-agenda.md` (criar projeto
  no Google Cloud, ativar Calendar API, tela de consentimento, cliente OAuth Web; registrar app no Entra,
  permissões delegadas `Calendars.ReadWrite offline_access User.Read`, segredo). Sem env: a tela mostra
  "Integração não configurada" e o resto da agenda funciona.
- **Rotas** `src/app/api/integrations/{google,microsoft}/{connect,callback,disconnect}` (sessão do usuário;
  `state` assinado com HMAC do ENCRYPTION_KEY; escopos Google `calendar.events` + `calendar.readonly`;
  troca de código, gravação cifrada, sync inicial) e `POST /api/integrations/calendar/sync` (segredo do cron).
- **Sincronização** (`src/lib/calendar/sync/{google,microsoft,engine}.ts`, testada com mocks HTTP):
  - Saída: eventos `source='internal'` do usuário conectado (dono ou participante que optou por espelhar)
    criados/alterados/cancelados → create/patch/delete no calendário externo; guarda `external_id`,
    `external_etag`, `sync_hash` (hash dos campos espelhados para não reenviar sem mudança).
  - Entrada: incremental (Google `syncToken` / Graph `delta`) a cada 5 min pelo cron e ao abrir /agenda se
    `last_sync_at` > 2 min; eventos externos viram `source=google|microsoft` (dono = usuário conectado,
    editáveis aqui e reenviados); exclusão externa cancela aqui; conflito: `updated_at` mais recente vence.
  - Renovação de token; 401/invalid_grant → `status='revoked'` com aviso na tela.
- **Configurações → Agenda** (`calendar-settings.tsx`, seção `calendar`, grupo conta): cartões Google e
  Outlook com Conectar / Desconectar, e-mail conectado, última sincronização, erro; toggle "Espelhar
  compromissos em que sou participante"; botão "Sincronizar agora". Na agenda, ícone do provedor no evento
  externo.

## Fora de escopo

Recorrência, agendamento público pelo cliente, lembrete por WhatsApp para o contato, convites por e-mail a
externos, múltiplos calendários por provedor. O modelo comporta (fase 3).

## Verificação

typecheck, lint 0, vitest verde. Manual: criar compromisso clicando na semana, mover e redimensionar, abrir
o drawer com vínculos e navegar por eles, criar a partir de conversa/contato/negócio/tarefa/chat e vê-los
nas seções "Agenda", card do dashboard, lembrete push via cron; módulo desligado esconde tudo. Fase 2 com
credenciais reais: conectar Google e Outlook, ver eventos externos, criar aqui e ver lá (e vice-versa),
desconectar.
