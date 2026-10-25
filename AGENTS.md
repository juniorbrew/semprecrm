<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# SempreCRM — regras para os agentes

Este arquivo é lido pelo Claude Code (via `CLAUDE.md`) e pelo Codex. O que estiver aqui vale para os dois.
Guarde aqui só regras do projeto. Andamento e planos ficam em `docs/verification/<tema>/`.
O repositório é **público**: nunca escreva aqui senhas, chaves, IPs, e-mails ou dados de clientes.

## O que é

CRM multiempresa para WhatsApp (API oficial da Meta e conexão por QR via gateway Baileys), em pt-BR.
Next.js 16 (App Router) + React 19 + Supabase (Postgres, Auth, Storage, Realtime). Vitest nos testes.
É um fork de `ArnasDon/wacrm`. Funcionalidades de lá são portadas à mão, nunca por merge (dá ~100 conflitos e
os números das migrations colidem). Não trazer `next-intl`: aqui a tradução é própria (`src/lib/i18n-dict`).

## Mapa

- `src/app/(dashboard)`: app logado. `(marketing)`: site público em `/`. `(auth)`: login.
  `platform`: painel do dono da plataforma (`/platform`). `api`: rotas, e `api/v1` é a API pública (chaves de API).
- `src/lib/<domínio>`: regras de negócio, com o teste ao lado (`*.test.ts`).
- `src/lib/i18n-dict`: dicionários pt-BR. `src/lib/i18n-chunks`: gerado, não editar à mão.
- `services/wa-gateway`: gateway do WhatsApp por QR.
- `supabase/migrations/NNN_nome.sql`: migrations numeradas. `supabase/tests`: testes SQL no Postgres real.
- `deploy/contabo`: produção. `deploy/local-windows`: pilha Docker local. `docs/verification`: auditorias e roteiros.

## Comandos

- `npm test`, `npm run lint`, `npm run typecheck` e `npm run build`. O CI roda os quatro (Node 22) em todo PR para `main`.
- Antes de abrir PR, rode a suíte **inteira**, não só a pasta que mudou. No lint, leia a linha
  `✖ N problems (X errors, Y warnings)`; a última linha sozinha esconde erros.
- Banco local: `npx supabase migration up --include-all`. **Nunca** `supabase db reset` (apaga os dados de teste).

## Banco de dados

- **Número da migration:** confira o último em `origin/main` logo antes do push. Claude e Codex trabalham em
  paralelo e já colidiram duas vezes (085 e 088).
- **Permissões (migration 076):** funções novas não têm EXECUTE por padrão. Toda função usada em policy ou `.rpc()`
  precisa de `GRANT EXECUTE` explícito. Coluna nova em `accounts` ou `whatsapp_config` precisa entrar nos GRANTs de
  SELECT por coluna. Tokens do WhatsApp só são lidos com service role.
- **Isolamento entre contas:** toda tabela nova tem RLS por conta. RPC de relatório ou agregação é SECURITY
  INVOKER (respeita o RLS) e tem `GRANT` explícito.
- **Teste real:** toda migration nova ganha um teste em `supabase/tests` (`BEGIN … ROLLBACK`, rodado no Postgres
  local; o cabeçalho dos testes existentes mostra como). Teste só de texto já deixou passar migration que nem compilava.
- **Conta só leitura (cobrança):** rota que escreve com service role chama `requireWritable`
  (`src/lib/auth/account.ts`), e um teste varre as rotas para garantir isso. A interface usa `useReadOnly`. O banco
  bloqueia por `private.account_is_writable` (094). Mensagens recebidas sempre entram.

## Código

- Textos para o usuário em pt-BR pelo `i18n-dict`. Chave nova → rode `npm run i18n:split` (o CI confere).
  Mensagens de erro em tabelas (tipo `AGENT_ERRORS`) precisam de tradução, e há teste que exige isso.
- Chamadas HTTP para endereços externos passam por `fetchSeguro` (`src/lib/webhooks/ssrf.ts`).
- O repositório mistura finais de linha LF e CRLF (`core.autocrlf=false`). Mantenha o de cada arquivo e confira
  `git diff --stat` antes do commit (diff inflado = arquivo reescrito). `src/lib/i18n-chunks` é sempre LF.
- Testes não dependem do relógio real (já quebraram o CI).
- `next dev` reescreve o bloco `nextjs-agent-rules` no topo deste arquivo. Não versione essa mudança por acidente.

## Git e trabalho em paralelo

- Toda tarefa começa de `origin/main`, numa branch e numa **pasta (worktree) nova, com caminho só dela**.
  Nunca reaproveite a pasta de outro agente. Nunca troque de branch na pasta principal: a pilha Docker local
  depende dos arquivos que estão nela.
- Antes de qualquer `git switch`, rode `git status --short`. Se aparecer mudança que não é sua, pare e avise o dono.
- Um PR por entrega, sempre contra `main` (PR empilhado em outra base nunca chega à `main`).
- `gh` precisa de `--repo juniorbrew/semprecrm` (o fork não tem repositório padrão).
- Push, PR e merge só com autorização do dono.
- Quem faz cada entrega é o dono que decide. Antes de começar, procure branches e PRs abertos do outro agente
  (o Codex usa o prefixo `codex/`) para não pegar o mesmo trabalho.

## Produção

- Deploy: `deploy/contabo/deploy.sh main`. Ele aplica as migrations com `supabase db push`. Um deploy por vez.
- Deploy e qualquer escrita no servidor são feitos pelo dono. Agentes só leem para conferir.
- Há ajustes manuais no servidor fora do repositório. Exemplo: o cluster `rest` em
  `/opt/supabase/volumes/api/envoy/cds.yaml` usa `tcp_health_check` (o padrão derrubava o desempenho).
  Depois de atualizar o Supabase, confira se ele continua lá. Checklist periódico: `docs/runbooks/ops-checklist.md`.

## Falando com o dono

Sempre em português do Brasil simples, sem jargão. Explique o que muda para o negócio, não nomes de arquivo.
Comandos que ele precisa rodar vêm prontos para copiar, com uma linha dizendo o que fazem.
