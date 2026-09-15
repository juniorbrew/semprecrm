# Paridade com o DeskcommCRM — rodada 2

Data: 2026-09-13. Aprovado em conversa ("vamos seguir sua sugestão"). Continua a rodada 1
(`2026-09-13-deskcomm-parity-round1-design.md`); mesmas convenções (migrations idempotentes, RLS por
`is_account_member()`, `t()` com pt-BR/en-US em `i18n-extra.ts`, vitest na lógica pura, verificação no navegador).

Sete peças: métricas por atendente, horário de atendimento + disponibilidade (com round-robin de verdade),
auditoria, LGPD, notificações push, marca própria, MFA. Depois desta rodada: agente de IA (spec próprio).

---

## 1. Métricas por atendente (migration 032)

```
conversations + first_response_at timestamptz null, + first_response_seconds int null,
              + first_response_by uuid null
  O trigger de 030 em messages passa a preencher: na primeira mensagem de agent/bot depois de
  last_customer_message_at e com first_response_at nulo → grava os três (by = messages.sender_id).
  Backfill na migration a partir de messages (mesma lógica de loadResponseTime, em SQL).
```

- `src/lib/dashboard/team-metrics.ts` — `loadTeamMetrics(db, accountId, period)` com `period` 7|30|90 dias,
  devolve por membro: conversas atendidas (distinct conversation_id com ≥1 mensagem do usuário no período),
  resolvidas (conversation_events `status_changed` → closed com actor = usuário), tempo médio e mediano de
  1ª resposta (first_response_by = usuário), tarefas concluídas (tasks completed_at no período e
  assignee = usuário), atribuídas abertas agora. Agregação pura em `aggregateTeamMetrics()` testada.
- Dashboard: bloco "Equipe" (`team-metrics.tsx`) abaixo dos cards atuais, tabela ordenável por coluna,
  seletor de período, barra relativa na coluna de 1ª resposta, só para admin+ (agente vê só a própria linha).

## 2. Horário de atendimento e disponibilidade (migration 033)

```
accounts.preferences += business_hours: { timezone: "America/Sao_Paulo",
   days: { mon..sun: [{ start: "09:00", end: "18:00" }] | [] } },
   out_of_hours_enabled: boolean (padrão false), out_of_hours_message: text,
   auto_assign_enabled: boolean (padrão false)
profiles + availability text not null default 'available' check in ('available','away'),
         + availability_changed_at timestamptz, + last_assigned_at timestamptz
conversations + out_of_hours_replied_at timestamptz null
```

- `src/lib/business-hours.ts` — `isWithinBusinessHours(prefs, now)` com fuso via `Intl.DateTimeFormat`
  (testado com fusos e virada de dia), defaults seg–sex 09:00–18:00.
- **Fora do horário**: em `ingestInboundMessage`, se `out_of_hours_enabled`, fora do horário e
  `out_of_hours_replied_at` nulo ou anterior ao início do dia útil corrente → envia
  `out_of_hours_message` pelo canal da conversa (texto simples; no canal oficial fora da janela de 24 h
  o envio não é possível: registra `skipped`) e grava `out_of_hours_replied_at`.
- **Round-robin real** (`src/lib/assignment/round-robin.ts`, testado): candidatos = membros agent+ com
  `availability = 'available'`; escolhe o de menos conversas abertas atribuídas; empate → `last_assigned_at`
  mais antigo (nulo primeiro); grava `last_assigned_at`. Usado pelo passo `assign_conversation` modo
  round_robin (substitui o stub) e pela **distribuição automática**: quando `auto_assign_enabled` e a
  conversa recebe a primeira mensagem do cliente sem responsável → atribui e grava `conversation_events`
  `assigned`. Sem candidato disponível: fica sem responsável (aparece no Radar).
- UI: no menu do usuário (header) alternância "Disponível / Ausente" com ponto verde/cinza; lista de
  membros mostra o estado; Configurações → Atendimento ganha horário por dia da semana (até 2 faixas),
  fuso, mensagem fora do horário e o toggle de distribuição automática.

## 3. Log de auditoria (migration 034)

```
audit_log
  id uuid pk, account_id → accounts (cascade), actor_user_id uuid null, actor_name text,
  action text not null, entity_type text not null, entity_id text null, metadata jsonb default '{}',
  created_at. Índice (account_id, created_at desc). RLS: admin+ SELECT; INSERT só service role
  (sem UPDATE/DELETE para ninguém). Retenção: cron apaga > 365 dias.
```

- `src/lib/audit.ts` — `logAudit(admin, { accountId, actorUserId, action, entityType, entityId?, metadata? })`,
  nunca lança (log em console). Catálogo de ações (constantes + label pt-BR): `member.invited`,
  `member.role_changed`, `member.removed`, `account.renamed`, `account.ownership_transferred`,
  `whatsapp.official_saved`, `whatsapp.official_removed`, `whatsapp.qr_connected`, `whatsapp.qr_logged_out`,
  `contact.deleted`, `contact.exported`, `contact.anonymized`, `deal.deleted`, `automation.activated`,
  `automation.deactivated`, `lead_source.created`, `lead_source.token_rotated`, `preferences.updated`,
  `branding.updated`, `plan.changed` (pelo painel master, actor = platform admin), `mfa.enrolled`,
  `mfa.disabled`. Chamadas inseridas nos handlers/rotas correspondentes (rotas de API já existentes; para
  ações feitas direto do cliente via Supabase — exclusão de contato/negócio, ativar automação — criar
  rotas `POST /api/audit` que só aceitam ações do catálogo e registram com o usuário da sessão).
- Configurações → Auditoria (`audit-log-settings.tsx`, admin, grupo workspace, ícone ScrollText): tabela
  (quando, quem, ação, entidade, detalhes expansíveis), filtros por ação, membro e período, paginação
  por cursor (50 por página).

## 4. LGPD (migration 035)

```
contacts + consent_status text not null default 'unknown' check in ('unknown','granted','revoked'),
         + consent_updated_at timestamptz, + anonymized_at timestamptz null
```

- `GET /api/contacts/[id]/export` (admin+): JSON com contato, campos personalizados, etiquetas,
  conversas e mensagens (texto + URLs de mídia), notas, negócios, tarefas, eventos de consentimento;
  `Content-Disposition: attachment; filename=contato-<id>.json`; auditado.
- `POST /api/contacts/[id]/anonymize` (admin+, body `{ confirm: "<nome do contato>" }`): em
  `src/lib/lgpd/anonymize.ts` (client injetado, testado): name → "Contato anonimizado", phone →
  `anon-<8 hex>` (mantém unicidade), email/company/avatar → null, custom_field_values apagados,
  messages.content → "[conteúdo removido]" e mídia do bucket `chat-media` apagada, notas apagadas,
  `opted_out_at = now()`, `anonymized_at = now()`; conversas, negócios e tarefas ficam (histórico
  estatístico) com o vínculo. Irreversível; auditado.
- Painel do contato (inbox) e página do contato: seção "Privacidade" com select de consentimento,
  botão "Exportar dados" e "Anonimizar" (dialog que exige digitar o nome). Contato anonimizado mostra
  selo e bloqueia edição/envio.

## 5. Notificações push no navegador (migration 036)

```
push_subscriptions
  id uuid pk, account_id, user_id → auth.users (cascade), endpoint text unique, p256dh text, auth text,
  user_agent text, created_at, last_used_at. RLS: o próprio usuário lê/escreve as suas.
tasks + reminded_at timestamptz null
```

- Dependência `web-push`. Env `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
  (`mailto:`); script `scripts/gen-vapid.mjs`; chaves geradas e gravadas em `.env.local`;
  `.env.local.example` e READMEs de deploy documentam.
- `public/sw.js`: `push` → `showNotification(title, { body, icon, data: { url } })`; `notificationclick` →
  foca aba existente ou abre `url`. Registro em `src/lib/push/client.ts` (`subscribePush()`,
  `unsubscribePush()`, estado da permissão).
- `src/lib/push/send.ts` — `sendPushToUsers(admin, userIds, payload)`; remove assinaturas com 404/410.
- Gatilhos: (a) mensagem recebida: para o responsável da conversa, ou, sem responsável, para todos os
  membros agent+ disponíveis; nunca para quem está com a conversa aberta na tela (o cliente envia
  `POST /api/push/seen` ao focar a conversa; guarda `conversation_focus` em memória por 60 s); (b) tarefa
  atribuída a outra pessoa; (c) tarefa vencendo em ≤ 15 min (cron, marca `reminded_at`);
  (d) conversa atribuída a mim.
- Configurações → Notificações (`notifications-settings.tsx`, grupo conta, ícone Bell): botão ativar
  neste navegador (pede permissão), lista dos dispositivos com remover, toggles por tipo (a–d) salvos em
  `profiles.notification_prefs jsonb`.

## 6. Marca própria — white-label (migration 037, módulo `white_label`)

```
accounts + branding jsonb not null default '{}'   -- { app_name, logo_url, primary_color }
bucket público `account-branding` (path account-<id>/logo.<ext>, ≤ 512 KB, png/svg/webp)
```

- Módulo `white_label` em OPTIONAL_MODULES, planos pro/empresa/trial.
- Configurações → Marca (`branding-settings.tsx`, admin, grupo workspace, ícone Paintbrush): nome do
  app, upload do logo (preview claro/escuro), cor primária (paleta + hex), botão restaurar padrão.
- Aplicação: sidebar e header usam `branding.app_name`/`logo_url`; `document.title` = `<página> · <app_name>`;
  `primary_color` sobrescreve as variáveis `--primary`/`--ring` do tema no `dashboard-shell.tsx` via
  style inline (o tema escolhido pelo usuário continua valendo para o resto). Login continua com a marca
  SempreCRM (a conta só é conhecida depois do login).

## 7. MFA para admins (sem migration; Supabase Auth TOTP)

- `supabase/config.toml`: `[auth.mfa.totp] enroll_enabled = true, verify_enabled = true` (documentar o
  mesmo para o self-hosted: `MFA_TOTP_ENROLL_ENABLED`/`MFA_TOTP_VERIFY_ENABLED` no `.env` do Supabase).
- Configurações → Login e segurança: card "Verificação em duas etapas": ativar (enroll → QR + código de
  6 dígitos → verify → códigos… não há recovery codes no Supabase TOTP: avisar para guardar o app),
  desativar (unenroll com senha). Auditado.
- Login: após senha, se `mfa.getAuthenticatorAssuranceLevel()` devolver `nextLevel === 'aal2'`, tela
  `/mfa` com o código (challenge + verify). Middleware: usuário com fator verificado e sessão em `aal1`
  só acessa `/mfa` e logout.
- Configurações → Membros (owner): toggle "Exigir duas etapas para admins" (`accounts.preferences.
  require_mfa_admins`); admin sem MFA ativo é redirecionado para a tela de ativação ao entrar.

---

## Entregas

| Entrega | Itens | Migrations |
|---|---|---|
| E | Métricas por atendente + horário/disponibilidade/round-robin | 032, 033 |
| F | Auditoria + LGPD | 034, 035 |
| G | Push + marca própria | 036, 037 |
| H | MFA | — |

E e F em paralelo; G e H depois. Arquivos compartilhados: mesma regra da rodada 1 (reler antes de editar,
edições pequenas, nunca reescrever o arquivo).

## Fora de escopo

Agente de IA, agenda, produtos, voz, Nuvemshop, Ads, atualização pela tela, recovery codes de MFA,
push em dispositivos iOS sem PWA instalado.

## Verificação

typecheck, lint 0 erros, vitest verde. Manual: bloco Equipe com números coerentes com o inbox; marcar-se
ausente e ver a distribuição pular para outro membro; mensagem fora do horário; auditoria listando uma
troca de papel; exportar e anonimizar um contato de teste; push chegando com a aba fechada; logo e cor
da conta aplicados; ativar MFA e fazer login com o código.
