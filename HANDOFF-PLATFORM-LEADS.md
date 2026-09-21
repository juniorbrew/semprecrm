# Handoff final — Leads da Plataforma do SempreCRM

Atualizado em 21/09/2026. Este é o documento principal para outro agente (Claude/Codex) entender o que foi implementado, validado e publicado.

## Estado atual

- Repositório: `C:\SempreCRM`
- Código entregue na `main`: commit `c385cab83166903aba7419c6a64b42b09f53e230`
- PR integrada: `https://github.com/juniorbrew/semprecrm/pull/18`
- Produção correta: VPS `13.140.42.70`, alias SSH `semprecrm`
- Site: `https://www.semprecrm.com.br`
- Supabase de produção: auto-hospedado na mesma VPS (`api.semprecrm.com.br`)
- Página entregue: `https://www.semprecrm.com.br/platform/leads`
- Migration aplicada em produção: `047_platform_leads.sql`
- Processos PM2 do usuário Linux `semprecrm`: `semprecrm`, `semprecrm-cron` e `wa-gateway`, todos online após o deploy

O deploy foi feito na VPS em `/var/www/semprecrm`. O checkout está limpo em `main`, no commit acima. O build de produção concluiu com 74 rotas e a aplicação foi recarregada no PM2.

## O que a funcionalidade faz

Existem duas fontes automáticas de leads, somente para novos registros após a migration:

1. `https://www.semprecrm.com.br/contato`
   - O formulário cria uma linha em `contact_submissions`.
   - Um trigger `AFTER INSERT` cria um lead do tipo `contato`.
2. Cadastro de uma nova conta trial
   - O fluxo existente cria `auth.users` e `accounts`.
   - Um trigger `AFTER INSERT` em `accounts` cria um lead do tipo `cadastro`.

Não existe backfill: contatos e contas anteriores à migration não foram importados.

Cada lead começa com status `novo`. No painel o administrador pode alterar para `em_contato`, `convertido` ou `descartado`. A tela tem busca, filtros por tipo/status, paginação, contador de novos, tabela desktop e cartões mobile.

## Banco e segurança

A migration `supabase/migrations/047_platform_leads.sql` cria:

- `public.leads`
- `public.lead_push_deliveries`
- índices de ordenação, filtros, busca e unicidade por origem
- triggers para contato e cadastro
- RPCs `platform_list_leads` e `platform_update_lead_status`
- RPCs privadas do worker de push `claim_lead_notifications` e `complete_lead_notification`

RLS está ativa. Usuários comuns e tenants não conseguem ler a lista global. Apenas usuários presentes em `platform_admins` podem consultar leads, e a alteração de status ocorre pela RPC validada. Escritas diretas não são concedidas aos clientes.

A VPS foi conferida depois do deploy:

- migration history: versão máxima `047`, 47 registros
- tabela `public.leads` existente
- policy `leads_platform_select` existente
- índices, constraints e FKs existentes
- `GET /api/platform/leads` sem sessão retorna `401`, como esperado

## Painel master

O painel exige duas autenticações:

1. login normal do CRM;
2. usuário e senha separados do painel master em `/platform/login`.

Em 21/09/2026 a credencial antiga do segundo acesso foi resetada porque a senha não era aceita. Antes da remoção foi criado um backup protegido, modo `600`, em:

`/root/platform_gate_credentials-backup-20260921.sql`

O usuário abriu a tela de configuração e depois chegou a `/platform`, indicando que o novo acesso foi configurado. Nunca registrar a nova senha ou hashes em documentação, logs ou commits.

## Push e cron

O cron já existente chama `notifyNewLeads()` e envia Web Push aos administradores inscritos. O worker usa claim atômico, `FOR UPDATE SKIP LOCKED`, token de fencing, lease, retry com backoff e recibos por assinatura para evitar reenvio após sucesso parcial.

Não foi criado cron paralelo. Sem assinatura push válida, o lead permanece pendente para nova tentativa. Web Push não oferece garantia absoluta de exactly-once na janela entre aceitação externa e persistência do recibo.

## Principais arquivos

- `supabase/migrations/047_platform_leads.sql`
- `supabase/tests/platform_leads.sql`
- `src/app/platform/leads/page.tsx`
- `src/components/platform/leads-table.tsx`
- `src/components/platform/platform-navigation.tsx`
- `src/app/api/platform/leads/route.ts`
- `src/app/api/platform/leads/[id]/route.ts`
- `src/lib/platform/leads.ts`
- `src/lib/platform/api.ts`
- `src/lib/push/leads.ts`
- `scripts/verify-platform-leads.mjs`
- `docs/verification/platform-leads/REPORT.md`
- `docs/verification/platform-leads/e2e-results.json`

## Validação concluída antes da publicação

- testes: 107 arquivos e 1209 testes passando
- typecheck: PASS
- lint: exit 0, somente 8 avisos preexistentes
- build Next.js 16.2.6: PASS, 74 rotas
- migrations 045, 046 e 047 em ambiente isolado: PASS
- teste SQL real de leads: PASS
- E2E completo: autenticação/RLS, contato, cadastro, SSR, filtros, status, XSS, mobile, Web Push, concorrência, retry e sucesso parcial: PASS
- scan de secrets no frontend: nenhum valor privado encontrado
- crítica visual e revisão de segurança: aprovadas

As evidências detalhadas e capturas estão em `docs/verification/platform-leads/`.

## Deploy da VPS

O fluxo oficial do repositório é:

```bash
sudo -u semprecrm -H bash /var/www/semprecrm/deploy/contabo/deploy.sh main
```

O script atual solicita confirmação interativa do Supabase CLI antes de aplicar novas migrations. Em execução não interativa, usar `supabase db push --yes` com a `SUPABASE_DB_URL` já existente em `.env.production`. Nunca imprimir essa variável.

Validações externas após o deploy:

- `/`: HTTP 200
- `/contato`: HTTP 200
- `/signup`: HTTP 200
- `/api/platform/leads` sem autenticação: HTTP 401
- processo Next: online e pronto na porta 3000

## Incidente de destino e serviços que não são a produção

Inicialmente o destino foi interpretado de forma incorreta como Netlify + Supabase Cloud. O código também foi publicado automaticamente em `https://semprecrm.netlify.app`, e o projeto Supabase Cloud `kovlrqructtizdgcwtkg` foi reativado e recebeu migrations 001–047. Esse projeto Cloud estava vazio: sem usuários, contas ou contatos.

A produção verdadeira é a VPS descrita acima. Não usar Netlify nem o Supabase Cloud como fonte dos dados reais. Eles ainda não foram removidos ou pausados porque essa limpeza é destrutiva e depende de autorização explícita do proprietário.

## Estado do workspace local

O workspace principal pode estar na branch de outro trabalho, `feat/marketing-landing`, com `.claude/` e `.impeccable/` não rastreados. Não apagar nem incluir esses diretórios sem necessidade. A implementação de leads já está integrada na `main`; antes de editar, conferir branch, `git status` e diferenças contra `origin/main`.

Ao continuar esta funcionalidade, leia também `docs/verification/platform-leads/REPORT.md`. Partes do relatório foram escritas antes do deploy; para o estado de produção, este handoff final tem precedência.
