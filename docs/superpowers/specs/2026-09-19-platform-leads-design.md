# Captação e acompanhamento de leads no /platform

Data: 2026-09-19. Aprovado em conversa ("aprovo").

## Objetivo

O painel do dono do SaaS (`/platform`) hoje só mostra a lista de contas de clientes — sem
nenhum destaque para o que é novo. Duas fontes de interesse comercial já existem no banco mas
são invisíveis: submissões do formulário `/contato` (`contact_submissions`, gravadas mas nunca
lidas por nenhuma tela) e novas contas trial criadas via `/signup`. Este projeto cria uma visão
unificada de "leads" dessas duas fontes, com status simples e alerta push quando um lead novo
chega — sem precisar abrir o painel toda hora para descobrir.

Decisões já tomadas com o usuário (não reabrir):
- Leads = submissões de `/contato` **e** novas contas trial de `/signup`.
- Alerta: notificação push (reaproveitando o sistema já existente no produto), não e-mail
  (não existe capacidade de envio de e-mail no sistema — confirmado, ver Não-objetivos).
- Acompanhamento: status simples por lead — `novo` → `em_contato` → `convertido` /
  `descartado`.
- Sem atualização "ao vivo" da tela (sem Supabase Realtime) — o alerta push já cobre a
  necessidade de ser avisado sem estar com a tela aberta.
- Sem histórico de mudança de status — só o status atual.

## Não-objetivos

Não criar capacidade de envio de e-mail (fora de escopo — confirmado que não existe nenhuma
infraestrutura de e-mail transacional no projeto). Não modificar o fluxo de cadastro
(`handle_new_user`) nem a tabela `accounts` em si — a captura de lead observa essas tabelas por
fora, via trigger `AFTER INSERT`, sem alterar o que já existe. Não adicionar preferências de
notificação por admin (só existe hoje um conceito de "platform admin", tratado como lista única
de destinatários — se um dia houver múltiplos admins com preferências diferentes, fica para
depois). Não adicionar Realtime nem histórico de auditoria de mudança de status.

## Modelo de dados

Nova migration `045_leads.sql`, seguindo a convenção das migrations existentes (cabeçalho
`-- ====...====`, `CREATE TABLE IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`,
`uuid_generate_v4()`, `Idempotente` no rodapé):

```
leads
  id uuid pk default uuid_generate_v4(),
  kind text not null check (kind in ('contato', 'cadastro')),
  status text not null default 'novo' check (status in ('novo', 'em_contato', 'convertido', 'descartado')),
  name text not null, email text not null, company text null,
  contact_submission_id uuid null references contact_submissions(id) on delete set null,
  account_id uuid null references accounts(id) on delete set null,
  notified_at timestamptz null,  -- quando o push foi realmente enviado (claim column)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now().
Constraint: `CHECK ((kind = 'contato' AND contact_submission_id IS NOT NULL AND account_id IS
  NULL) OR (kind = 'cadastro' AND account_id IS NOT NULL AND contact_submission_id IS NULL))` —
  reforça no banco a mesma regra que os dois triggers já garantem por construção (defesa em
  profundidade, mesmo espírito dos CHECKs em `042_account_registration.sql`).
Índices: (status, created_at desc), (kind).
RLS: enabled, ZERO políticas de INSERT (só as duas funções SECURITY DEFINER abaixo escrevem,
  rodando como dono da tabela — bypassam RLS). SELECT e UPDATE liberados só para
  is_platform_admin() (mesmo padrão de accounts_platform_select, migration 025).
```

### Triggers de captura (não tocam nas tabelas de origem)

Dois triggers `AFTER INSERT`, cada um numa função `SECURITY DEFINER` própria, envoltos em
`EXCEPTION WHEN OTHERS` (mesmo padrão defensivo de `handle_new_user` — uma falha aqui nunca pode
bloquear um cadastro real ou uma submissão de contato):

- **`on_contact_submission_created_lead`** (`AFTER INSERT ON contact_submissions`): insere um
  lead com `kind='contato'`, `name/email/company` copiados da linha, `contact_submission_id`
  apontando para ela.
- **`on_account_created_lead`** (`AFTER INSERT ON accounts`): insere um lead com
  `kind='cadastro'`, `name` = `NEW.name` (nome da conta), `company` = `NEW.legal_name`,
  `account_id` apontando para ela, e `email` resolvido via `SELECT email FROM auth.users WHERE
  id = NEW.owner_user_id` (a conta em si não tem garantia de e-mail preenchido — `accounts.email`,
  da migration 043, é o e-mail de contato da empresa, opcional; o e-mail de login do dono é o dado
  confiável). Dispara em qualquer INSERT em `accounts`, incluindo os feitos por
  `handle_new_user()` — não precisa alterar essa função.

### RPCs de leitura/escrita (mesmo padrão de `platform_list_accounts`/`platform_update_account`)

- `platform_list_leads()` — `SECURITY DEFINER`, checa `is_platform_admin()`, retorna todos os
  leads ordenados por `created_at DESC`.
- `platform_update_lead_status(p_lead_id uuid, p_status text)` — `SECURITY DEFINER`, checa
  `is_platform_admin()`, valida `p_status` contra os 4 valores permitidos, `UPDATE ... SET
  status = p_status, updated_at = now()`.

## Alerta push

Reaproveita 100% a infraestrutura existente (`src/lib/push/send.ts` `sendPushToUsers()`,
VAPID já configurado) — nenhuma peça nova de infraestrutura de push, só uma nova função de
notificação e um novo resolvedor de destinatários.

- **`src/lib/push/notify.ts`**: nova função `notifyNewLeads(admin, now)`, seguindo exatamente o
  padrão de `notifyTasksDueSoon` (linhas 225-289 do arquivo atual): busca até 200 leads com
  `notified_at IS NULL`, para cada um faz um "claim" via `UPDATE ... SET notified_at = now()
  WHERE id = ? AND notified_at IS NULL` (evita envio duplicado se dois ticks do cron rodarem
  quase juntos), resolve destinatários com `SELECT user_id FROM platform_admins` (sem
  filtro de preferência — não existe esse conceito para platform admin), e chama
  `sendPushToUsers(admin, recipients, { title, body, url: '/platform/leads', tag: `lead:${id}` })`.
  Título: `"Novo lead: {name}"` (kind='contato') ou `"Novo cadastro: {name}"` (kind='cadastro').
  Corpo: `company` se houver, senão `email`. Textos direto em pt-BR (sem passar pelo helper
  `tr()` do arquivo, que serve o sistema de tradução do produto para clientes — este alerta é só
  para o dono do SaaS).
- **Ponto de disparo**: chamada adicionada dentro do handler `GET` já existente em
  `src/app/api/automations/cron/route.ts` (mesmo arquivo que já chama `notifyTasksDueSoon` e
  `notifyCalendarReminders` — não é preciso criar rota nova, nem mexer em
  `scripts/cron-tick.mjs` ou no `ecosystem.config.cjs` do PM2, já rodando a cada tick de
  `CRON_INTERVAL_MS`, default 60s). Atraso esperado do alerta: até ~1 minuto após o lead
  aparecer — aceitável, já que o requisito era "ser avisado sem precisar checar o painel", não
  "instantâneo".

## Tela em `/platform`

- **Navegação**: `platform-header.tsx` ganha uma barra de abas simples "Contas" / "Leads"
  (hoje não existe nenhuma navegação lá, só o título). A aba "Leads" mostra um contador em
  destaque com a quantidade de leads com `status='novo'`.
- **Nova rota `/platform/leads`** (`src/app/platform/leads/page.tsx`): tabela no mesmo padrão
  visual de `accounts-table.tsx` — colunas: tipo (ícone/etiqueta "Contato" ou "Cadastro"), nome,
  e-mail, empresa, status (chip clicável com as 4 opções, mesmo padrão de `plan-status-chip.tsx`
  mas para o novo enum), data de criação. Busca por nome/e-mail, filtro por status e por tipo.
- **Mudança de status**: `PATCH /api/platform/leads/[id]` (rota fina, só valida e chama
  `platform_update_lead_status` — mesmo padrão de `PATCH /api/platform/accounts/[accountId]`,
  mas sem log de auditoria, já que leads não pertencem a nenhuma conta de cliente e não existe
  hoje um log de auditoria "global" do sistema).
- **Leitura da lista**: `src/lib/platform/server.ts` ganha `listPlatformLeads()`, espelhando
  `getPlatformAccount`/o uso de `platform_list_accounts()` já existente.

## Segurança

- `leads`: RLS habilitado, zero políticas de INSERT (só os triggers `SECURITY DEFINER`
  escrevem, contornando RLS como dono da tabela); SELECT/UPDATE só para `is_platform_admin()`.
  Nenhum dado de lead é acessível por `anon` ou por um `authenticated` comum.
  Sem política de DELETE — sem exclusão de leads pela UI nesta primeira versão.
- RPCs `platform_list_leads`/`platform_update_lead_status`: `SECURITY DEFINER`, auto-checagem
  de `is_platform_admin()` (`RAISE EXCEPTION ... 42501` se não for), `REVOKE ALL FROM PUBLIC` +
  `GRANT EXECUTE TO authenticated` — mesmo padrão de `platform_update_account`.
- `notifyNewLeads()` roda com o client admin (service role) já usado por todo o cron —
  não expõe nada a mais.

## Tratamento de erros

- Falha no trigger de captura nunca bloqueia o INSERT original (`EXCEPTION WHEN OTHERS`,
  `RAISE WARNING`, `RETURN NEW`).
- Falha ao enviar push para um lead específico não interrompe o processamento dos demais
  (mesmo padrão de `notifyTasksDueSoon`: `try/catch` por item, log e continua).
- Sem VAPID configurado (`isPushConfigured()` retorna falso): `notifyNewLeads` não tenta
  enviar nada — mesmo comportamento silencioso já usado pelas outras funções de notificação.

## Testes

- Migration idempotente, testada localmente com `supabase db push` duas vezes seguidas.
- Vitest: nenhuma lógica pura nova o suficiente para justificar teste isolado além do que o
  `notify.ts` já teria por convenção — se `notifyNewLeads` ganhar alguma lógica de formatação de
  texto não trivial, mover para uma função pura testável (mesmo padrão de `status.ts`/helpers já
  vistos em outros módulos).
- QA manual/navegador ao final: preencher `/contato` → conferir que aparece em `/platform/leads`
  como `kind='contato'`, `status='novo'`; criar uma conta de teste via `/signup` → conferir que
  aparece como `kind='cadastro'`; mudar o status pela UI → conferir que persiste após recarregar;
  disparar `GET /api/automations/cron` manualmente com o `x-cron-secret` correto → conferir que
  `notified_at` é preenchido e (se houver um dispositivo com push já ativado durante o teste) que
  a notificação chega.

## Entrega

Ao final: lista de arquivos criados/modificados, migration aplicada, capturas de tela do painel
(`/platform/leads`) desktop e mobile, teste de ponta a ponta (contato → lead → status → push),
e a lista de itens que dependem do usuário (nenhum item bloqueante identificado até agora — a
notificação push só funciona nos dispositivos onde o dono já ativou push no produto, que é
comportamento existente, não algo novo a configurar).
