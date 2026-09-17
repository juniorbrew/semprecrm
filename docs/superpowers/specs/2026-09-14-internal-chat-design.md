# Chat interno entre usuários da conta

Data: 2026-09-14. Aprovado em conversa ("Sim, pode seguir" + fase 2 logo depois).

## Objetivo

Chat entre os usuários de uma mesma conta (tenant), dentro da ferramenta, vendido como módulo: o painel
master liga por conta. Histórico, presença online, entrega para quem está offline (recebe ao voltar) e
status enviado / entregue / lido. Fase 1: conversas 1‑a‑1. Fase 2: grupos, anexos, reações, editar e
excluir mensagem.

Convenções: migrations idempotentes (estilo 027–037), RLS via `is_account_member()`, `t()` com pt-BR/en-US
em `i18n-extra.ts`, vitest na lógica pura, verificação no navegador.

## Módulo

`internal_chat` em `src/lib/plans.ts` (OPTIONAL_MODULES; planos trial, pro, empresa; básico não), label
"Chat interno", `platform_update_account` aceita a chave (migration redefine a função como 037 fez).
Rota `/chat` com ModuleGuard; item "Chat" no sidebar (ícone MessagesSquare) com badge de não lidas; sem o
módulo o item some e a rota redireciona para `/dashboard`.

## Dados — fase 1 (migration 038_internal_chat.sql)

```
chat_threads
  id uuid pk, account_id → accounts (cascade), kind text not null default 'direct' check in ('direct','group'),
  title text null (só grupos), created_by uuid null, created_at, updated_at,
  last_message_at timestamptz null, last_message_preview text null.
chat_thread_members
  thread_id → chat_threads (cascade), user_id → auth.users (cascade), joined_at, last_read_at timestamptz null,
  pk (thread_id, user_id).
  Regra 1‑a‑1: função SECURITY DEFINER `chat_get_or_create_direct_thread(other_user_id)` que valida que
  ambos são membros da conta corrente, procura thread kind='direct' com exatamente esses dois membros e cria
  se não existir. Índice único parcial por par (colunas user_a/user_b ordenadas em chat_threads ou tabela
  auxiliar) para impedir duplicidade.
chat_messages
  id uuid pk, account_id, thread_id → chat_threads (cascade), sender_id → auth.users, body text not null,
  created_at, delivered_at timestamptz null, read_at timestamptz null,
  edited_at timestamptz null, deleted_at timestamptz null (fase 2), attachment jsonb null (fase 2).
  Índices: (thread_id, created_at desc), (account_id, created_at desc).
chat_message_receipts (fase 2, grupos): message_id, user_id, delivered_at, read_at, pk (message_id, user_id).
  Na fase 1 (1‑a‑1) `delivered_at`/`read_at` da própria mensagem bastam.
profiles + last_seen_at timestamptz null
RLS: SELECT/INSERT em chat_messages só para membros da thread (EXISTS em chat_thread_members); UPDATE de
delivered_at/read_at só pelo destinatário (trigger impede alterar body/sender nesse caminho); threads e
membros legíveis pelos membros. Trigger em chat_messages AFTER INSERT atualiza last_message_at/preview.
Realtime: chat_messages e chat_threads na publicação.
```

## Presença

- Canal de presença do Supabase por conta (`presence:account:<id>`) ligado no `dashboard-shell` enquanto o
  módulo está ativo; `track({ user_id, at })` ao entrar, sai ao fechar a aba. Online = presente no canal.
- Reserva: heartbeat `profiles.last_seen_at` a cada 30 s (só quando a aba está visível); rótulo
  "visto por último há X" quando offline.
- "digitando…": broadcast no mesmo canal (`typing`, thread_id) com expiração de 3 s no receptor.

## Entrega e leitura (1‑a‑1)

- Enviado: linha gravada (✓ cinza). Entregue: o cliente do destinatário, ao receber o INSERT por realtime
  ou ao carregar mensagens pendentes no login/abertura do chat, faz `update delivered_at = now()` nas
  mensagens da thread onde `sender_id ≠ eu` e `delivered_at is null` (✓✓ cinza). Lido: ao abrir a
  conversa com a aba visível, `update read_at = now()` nas não lidas e `last_read_at` do membro (✓✓ azul).
- Não lidas por thread = mensagens com `sender_id ≠ eu` e `read_at is null`; badge global = soma.
- Lib pura `src/lib/chat/status.ts` (ícone e rótulo por estado, cálculo de não lidas), `src/lib/chat/
  queries.ts` (threads da conta com último preview, mensagens paginadas por cursor `created_at`),
  `mutations.ts` (enviar, marcar entregue/lida, thread direta). Testes em status e paginação.

## Telas (fase 1)

`/chat` (`src/app/(dashboard)/chat/page.tsx`, componentes em `src/components/chat/`):

- Coluna esquerda: busca; lista de pessoas da conta (membros ativos, menos eu) com avatar, ponto verde
  online / cinza offline ("visto há X"), última mensagem em prévia, hora, badge de não lidas; ordenada por
  última atividade, depois nome. Clicar abre (ou cria) a conversa.
- Painel: cabeçalho (nome, estado online/visto por último), histórico com separadores por dia, bolhas
  próprias à direita com ✓/✓✓/✓✓ azul e hora, rolagem para cima carrega página anterior (50 por página),
  "digitando…", compositor (textarea auto‑cresce; Enter envia, Shift+Enter quebra; botão enviar).
- Layout responsivo: no celular a lista e a conversa alternam (botão voltar).
- Sidebar: item Chat com badge (realtime em chat_messages). Push: novo tipo `chat_message` no
  `src/lib/push` (respeita `notification_prefs`, ignora quem está com a thread aberta via `/api/push/seen`).
- Configurações → Notificações ganha o toggle "Mensagens do chat interno".

## Fase 2 (após a fase 1 verificada)

- **Grupos**: criar grupo (título, membros), adicionar/remover membros (criador ou admin), sair; recibos por
  membro em `chat_message_receipts`; status da bolha = entregue quando todos receberam, lido quando todos
  leram, com popover "lido por". Lista mostra grupos junto com pessoas.
- **Anexos**: imagem, áudio, vídeo, documento até 25 MB no bucket privado `chat-internal` (URL assinada
  por 1 h ao renderizar; path `account-<id>/chat/<thread>/<uuid>-<nome>`), pré‑visualização inline,
  colar imagem no compositor, gravar áudio reutilizando o gravador do inbox.
- **Reações**: `chat_message_reactions (message_id, user_id, emoji, pk)`; seletor rápido (👍 ❤️ 😂 😮 😢 🙏)
  ao passar o mouse; chips agregados sob a bolha.
- **Editar/excluir**: menu na própria mensagem; editar até 15 min (marca "editada"); excluir vira
  "mensagem apagada" (`deleted_at`, corpo esvaziado, anexo removido do bucket).

## Fora de escopo

Chat entre contas diferentes, chamadas de voz/vídeo, integração com o inbox de clientes, busca no corpo
das mensagens (fica para depois).

## Verificação

typecheck, lint 0, vitest verde. Manual com dois usuários (demo + segundo membro) em duas janelas: presença
muda ao fechar/abrir; mensagem para usuário online chega em tempo real e vira ✓✓; para usuário offline fica
✓ e vira ✓✓ quando ele entra; ✓✓ azul ao abrir a conversa; badge do menu; módulo desligado no painel master
esconde tudo; push com a aba fechada.
