# Retomada dos lembretes da agenda

> Execução: Superpowers, com testes de regressão e revisão independente.

**Objetivo:** concluir a validação da entrega B e corrigir os problemas encontrados, sem publicar.

**Arquitetura:** preservar o envio compartilhado do WhatsApp, a fila PostgreSQL e as RPCs exclusivas do servidor. Interpretar respostas somente dentro da conta e do contato; reservar cota antes de cada envio.

**Tecnologias:** Next.js 16.4.2, TypeScript, Vitest, Supabase/PostgreSQL.

**Especificação:** `docs/superpowers/specs/2026-10-24-agenda-inteligente.md`, entrega B.

## Estado recuperado

- Branch `feat/agenda-lembretes`, em `C:/SempreCRM-lembretes`.
- `888d66b6`: implementação inicial; `e6603f9c`: rodada das 15 correções do histórico.
- A branch estava sem alterações pendentes ao iniciar a retomada.
- O banco local já registrava 097. Os testes reaplicam as definições atuais dentro de uma transação e desfazem tudo; não atualizam permanentemente esse banco.

## Escopo e etapas

- [x] Conferir histórico, especificação, chamadores e testes; revisar o commit recuperado.
- [x] Reproduzir e corrigir a identidade JWT remanescente na preparação do teste SQL de justiça entre contas.
- [x] Reproduzir respostas citadas que selecionavam outro agendamento; filtrar pelo id citado antes do limite e não usar alternativa para citações inválidas.
- [x] Reproduzir o lembrete bloqueando a própria resposta vaga; excluir sua mensagem e manter mensagens posteriores do atendente, inclusive com id de provedor nulo.
- [x] Substituir contagem seguida de envio por reserva transacional por conta; falhar sem enviar quando a reserva estiver indisponível.
- [x] Manter horário conservador para interpretar respostas, separado do horário de conclusão usado na cota.
- [x] Concluir testes completos, tipos, lint, build e revisão final; registrar resultados.

Arquivos de implementação: `src/lib/agenda/reminder-reply.ts`, `reminders.ts` e respectivos testes; migration, rollback e smoke SQL 097. Manter grants de servidor, isolamento entre contas, limites de 10 por claim e 200 por janela móvel de 24 horas.

## Verificação e limites

- SQL: testar a 097 atual com `agenda_reminders.sql` e `agenda_booking.sql`, sempre com ROLLBACK; testar também rollback 097 seguido de `agenda_booking.sql`.
- TypeScript: regressões devem falhar antes da correção e passar depois; executar a suíte completa com concorrência reduzida se houver disputa de recursos.
- Navegador (`agent-browser`): aplicação local abre e as três rotas de configuração/cron recusam acesso anônimo com 401. Não havia sessão autenticada; a tela de configurações após login não foi revalidada nesta retomada.
- Não houve envio real de WhatsApp, implantação, alteração de `.env` ou migração permanente. A corrida de duas sessões PostgreSQL não foi executada; testes SQL cobrem reservas e testes TypeScript intercalam dois despachantes.
- Antes de usar o aplicativo com um banco que já aplicou a versão antiga da 097, atualizar também as definições SQL: o código novo recusa enviar sem a RPC de reserva.

## Resultados finais

- `npm test -- --maxWorkers=2`: 334 arquivos aprovados, um ignorado; **4.707 testes aprovados, um ignorado, nenhuma falha**.
- Agenda e rotas: **217 testes aprovados**.
- `npm run typecheck` e build de produção: aprovados; o build final também executou a checagem TypeScript.
- `npm run lint`: zero erros e 14 avisos preexistentes; lint final dos quatro arquivos TypeScript alterados sem avisos.
- `node scripts/i18n-split.mjs --check`: arquivos atualizados.
- PostgreSQL: `agenda_reminders: ALL OK`, `agenda_booking: ALL OK`; rollback 097 seguido de reservas 096 também `ALL OK`. Nenhuma definição ou dado ficou persistido.
- Revisão independente final: aprovada, sem achados pendentes dentro do escopo.
- Uma repetição com quatro workers durante o build teve três timeouts em testes de interface de outras telas. Eles passaram isoladamente e a suíte completa final passou com dois workers, sem mudar timeouts nem código dessas telas.
- Banco local confirmado ainda na versão 097 antiga, sem `quota_reserved_at`; nenhum deploy, push ou PR foi realizado nesta retomada.

Recursos usados: Superpowers (depuração, regressões e verificação), especialistas delegados de segurança/banco e revisão independente, `agent-browser` para o smoke anônimo.
