# Planos, módulos por conta e painel master

Data: 2026-09-12. Status: aprovado em conversa, parte 1 de 2 (a parte 2 é o canal WhatsApp por QR code, spec separado).

## Objetivo

O SempreCRM já é multi-tenant: cada `account` é uma empresa, isolada por RLS, com papéis owner/admin/agent/viewer. Falta a camada de plataforma: um super-admin que vê todas as contas e define, por conta, quais módulos estão ligados e quais limites valem. O desenho deve permitir vender na mão hoje (painel master) e por checkout no site depois (só um webhook de pagamento a mais).

## Decisões

- Cadastro público continua aberto. Conta nova entra no plano `trial` por 14 dias.
- O plano define módulos e limites. O painel master pode sobrescrever módulo ou limite por conta sem trocar o plano.
- Super-admin é um usuário normal marcado como tal no banco (`platform_admins`), não uma senha em variável de ambiente.
- Inbox e Contatos são sempre ligados. Opcionais: `dashboard`, `pipelines`, `broadcasts`, `automations`, `flows`, `channel_official`, `channel_qr`.
- Limites: `max_users` e `max_channels` (números de WhatsApp conectados). `null` = ilimitado.

## Catálogo de planos (código, `src/lib/plans.ts`)

| plan | módulos | max_users | max_channels |
|---|---|---|---|
| trial | todos | 2 | 1 |
| basico | dashboard, pipelines, channel_qr | 3 | 1 |
| pro | todos menos flows | 10 | 2 |
| empresa | todos | null | 5 |

`plan_status`: `trial` | `active` | `past_due` | `canceled` | `suspended`. Com `past_due`, `canceled` ou `suspended`, ou `trial` vencido, o app mostra uma tela de bloqueio com o motivo e contato; só `/settings` (para o owner ver o plano) e logout continuam acessíveis.

## Dados (migration 025)

```
accounts
  + plan               text not null default 'trial'   check in (trial, basico, pro, empresa)
  + plan_status        text not null default 'trial'   check in (trial, active, past_due, canceled, suspended)
  + plan_expires_at    timestamptz null                (trial: now() + 14 dias no trigger de signup)
  + module_overrides   jsonb not null default '{}'     ex.: {"flows": true, "broadcasts": false}
  + limit_overrides    jsonb not null default '{}'     ex.: {"max_users": 5}
  + platform_notes     text null                       (anotações do master, invisível ao cliente)

platform_admins (user_id uuid pk → auth.users, created_at)
```

Função `is_platform_admin()` SECURITY DEFINER. Políticas novas em `accounts`: platform admin pode SELECT/UPDATE todas; membros continuam lendo só a própria (já existe). `platform_admins` só é legível pelo próprio admin. Os RPCs `platform_list_accounts()` e `platform_update_account(...)` são SECURITY DEFINER e checam `is_platform_admin()`, devolvendo contagem de membros e de canais por conta para a listagem.

Trigger `handle_new_user` passa a gravar `plan_expires_at = now() + interval '14 days'`.

## Resolução de direitos (`src/lib/plans.ts`, puro, testado)

`resolveEntitlements(account) → { modules: Record<Module, boolean>, limits: { max_users, max_channels }, blocked: false | { reason } }`. Regra: começa pelo plano, aplica `module_overrides` e `limit_overrides`, força `inbox` e `contacts` = true, calcula `blocked` a partir de `plan_status` e `plan_expires_at`.

## Onde os direitos são aplicados

- **Sidebar** esconde itens de módulos desligados.
- **Layout do dashboard** (`src/app/(dashboard)/layout.tsx`): se `blocked`, renderiza a tela de bloqueio em vez dos filhos, exceto em `/settings`.
- **Páginas de módulo**: guard no topo (server side quando a página é server, hook quando é client) que redireciona para `/dashboard` com toast "Módulo não incluído no seu plano".
- **API**: `POST /api/whatsapp/broadcast` exige `broadcasts`; automations/flows engines checam o módulo antes de executar (uma conta sem `automations` não roda automações mesmo que existam linhas).
- **Limites**: `POST /api/account/invitations` recusa quando `membros ativos + convites pendentes >= max_users`; salvar canal recusa quando `canais >= max_channels`.
- Um hook `useEntitlements()` expõe tudo ao cliente; o valor vem do contexto da conta já carregado no layout.

## Painel master (`/platform`)

Rota fora do grupo `(dashboard)`, com layout próprio simples. Acesso: middleware deixa passar, a página chama `is_platform_admin()` e devolve 404 para quem não é.

- `/platform`: tabela de contas (nome, dono, plano, status, validade, membros/limite, canais/limite, criada em), busca por nome/e-mail, filtro por status.
- `/platform/[accountId]`: editar plano, status, validade, sobrescritas de módulos (toggle por módulo mostrando o valor herdado do plano), sobrescritas de limites, notas; botões Suspender/Reativar. Toda gravação via `platform_update_account`.
- Item "Plataforma" no menu do usuário só para platform admins.

Promover o primeiro admin: `insert into platform_admins (user_id) values ('<uuid>')` via psql/Studio, documentado no README de deploy.

## Fora de escopo agora

Checkout e webhook de pagamento; e-mails de aviso de vencimento; limites de contatos/mensagens. O modelo já os comporta.

## Testes

- `plans.test.ts`: cada plano, overrides, forçamento de inbox/contatos, bloqueio por status e por trial vencido.
- Testes de rota para invitations e whatsapp config respeitando limites (mock do Supabase como os testes existentes fazem).
- Verificação manual: criar conta nova (trial 14 dias), abrir /platform como admin, desligar `pipelines`, confirmar sumiço no menu e redirect na URL direta; suspender e ver a tela de bloqueio.
