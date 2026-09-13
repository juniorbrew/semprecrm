# Módulo de Tarefas

Data: 2026-09-13. Aprovado em conversa.

## Objetivo

Tarefas livres ou vinculadas a contato / conversa / negócio, usadas tanto como lembrete de venda quanto como
registro de atendimento simples aberto a partir da conversa. Status padrão simples, mas configurável por
empresa (como os funis).

## Dados (migration 027_tasks.sql, idempotente, estilo 017/020/025)

```
task_statuses
  id uuid pk, account_id → accounts (cascade), name text, color text, position int,
  kind text check in ('open','in_progress','done'), is_default boolean default false,
  created_at, updated_at. UNIQUE(account_id, position) deferrable.
  Seed por conta: "A fazer" (open, default), "Em andamento" (in_progress), "Concluída" (done).
  Backfill para contas existentes na migration; trigger handle_new_user (redefinir a partir da 025)
  cria os três para contas novas. Regra: a conta precisa manter ao menos um status de cada kind
  (validado no app; a exclusão de status reatribui as tarefas para o padrão do mesmo kind).

tasks
  id uuid pk, account_id → accounts, status_id → task_statuses (restrict),
  title text not null, description text null,
  priority text not null default 'normal' check in ('low','normal','high','urgent'),
  assignee_user_id uuid null → auth.users, created_by uuid null → auth.users,
  contact_id uuid null → contacts (set null), conversation_id uuid null → conversations (set null),
  deal_id uuid null → deals (set null),
  due_at timestamptz null, completed_at timestamptz null, position int default 0,
  created_at, updated_at.
  Índices: (account_id, status_id, position), (account_id, assignee_user_id, due_at), (contact_id), (deal_id).

task_comments
  id uuid pk, account_id, task_id → tasks (cascade), user_id → auth.users, body text, created_at.

RLS: viewer+ lê, agent+ escreve tasks/task_comments, admin+ escreve task_statuses (padrão is_account_member).
Realtime: tasks e task_comments adicionadas à publicação como messages.
Trigger: ao mover para status kind='done' preenche completed_at; ao sair, limpa.
```

## Direitos

Novo módulo `tasks` em `src/lib/plans.ts` (MODULES, OPTIONAL_MODULES, incluído em todos os planos).
Rota /tasks com ModuleGuard; sidebar; painel master já lista automaticamente.

## Telas

- **/tasks** (`src/app/(dashboard)/tasks/page.tsx`, componentes em `src/components/tasks/`):
  - Cabeçalho: título, contadores (abertas, atrasadas), busca, botão "Nova tarefa".
  - Filtros: chips Minhas / Hoje / Atrasadas / Todas; select de responsável; select de status; prioridade.
  - Alternância Lista | Quadro (persistida em localStorage).
  - Lista: linhas com checkbox de concluir (move para o status done padrão), título, chips de prioridade e
    status, vínculo (avatar/nome do contato ou título do negócio, clicável para /inbox ou /pipelines),
    responsável, prazo relativo com cor (vermelho atrasada, âmbar hoje).
  - Quadro: colunas = task_statuses na ordem; drag-and-drop com @dnd-kit (já é dependência) atualizando
    status_id e position; contagem por coluna.
  - Drawer de tarefa (abre ao clicar): edição inline de título, descrição (textarea), status, prioridade,
    responsável (membros da conta), prazo (date+time), vínculos (busca de contato; negócio do contato),
    comentários com autor e hora, "Concluir" primário, excluir com confirmação. Criar usa o mesmo drawer.
- **Inbox**: botão "Criar tarefa" no menu de ações do cabeçalho do thread (prefill contato + conversa +
  título "Atendimento: <nome>"); seção "Tarefas" no painel do contato com abertas (checkbox, título,
  prazo) e "+" inline (título + prazo). Pill de evento `task_created` no stream não é necessária.
- **Pipelines**: seção "Tarefas" no deal-details (abertas do negócio) com "+" inline (prefill deal + contato).
- **Dashboard**: card "Tarefas de hoje" (minhas: hoje + atrasadas, até 6, link para /tasks?filter=today);
  contador de atrasadas no item Tarefas do sidebar (badge), atualizado via realtime.
- **Configurações → Tarefas** (`task-statuses-settings.tsx`): lista ordenável, renomear, cor, kind, padrão,
  adicionar, excluir (com reatribuição).
- **Automações**: novo step `create_task` em src/lib/automations (engine + validate + trigger-meta +
  templates se aplicável) com config { title (com variáveis {{contact.name}}), description?, priority,
  assignee_user_id?, due_in_hours? } — vincula contato e conversa do gatilho; inspetor no builder.

## Lib

`src/lib/tasks/` — types, queries (list com filtros, counts, byContact, byDeal), mutations
(create/update/move/complete/delete/comment), `due.ts` (isOverdue, isToday, label relativo pt-BR),
`statuses.ts` (default por kind, validação "um de cada kind"). Testes unitários em due.ts, statuses.ts e
no filtro de lista.

## i18n

Todas as strings via t() com entradas pt-BR/en-US em src/lib/i18n-extra.ts.

## Fora de escopo

Lembretes por e-mail/WhatsApp, recorrência, anexos, subtarefas.

## Verificação

typecheck, lint 0 erros, vitest verde; manual: criar tarefa da conversa, vê-la no painel do contato, no
/tasks (lista e quadro), arrastar de coluna, concluir pelo checkbox, comentar; card do dashboard; status
renomeado em Configurações refletido no quadro; automação com create_task disparando em mensagem recebida.
