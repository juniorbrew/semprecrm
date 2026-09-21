# Revisão independente de banco, API e push

Executada em 19/09/2026, no repositório atual. Sem alterações nos arquivos da aplicação. Banco utilizado exclusivamente: `supabase_db_semprecrm-leads-verification`.

## Veredito

APROVADO no escopo inspecionado e executado: banco, RLS, privilégios, contratos de API, claim/retry e performance local. Nenhum achado P1/P2 identificado. A aprovação não substitui os testes de cron/push HTTP, browser, secrets do build e interface, conduzidos separadamente.

## Evidência executada pelo crítico

- `npx vitest run src/lib/push/leads.test.ts src/lib/push/send.test.ts src/app/api/platform/leads/route.test.ts`: 3 arquivos, 50 testes PASS.
- `npm test`: 104 arquivos, 1186 testes PASS, exit 0, duração 3,00s.
- Cópia de `supabase/tests/platform_leads.sql` para `/tmp/leads-test.sql` no container isolado e `psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/leads-test.sql`: PASS, exit 0, ROLLBACK. Inclui signup real via auth.users, contato, snapshots, duplicidade, RLS, tenant A/B, admin, RPCs negadas, status, busca literal, falha não bloqueante, expiração, token obsoleto, backoff e não reenvio. Warnings de captura exibiram somente origem e SQLSTATE P0001.
- Migration045 copiada para `/tmp/leads-migration.sql`, executada duas vezes na mesma transação (`psql ... -c BEGIN -f /tmp/leads-migration.sql -f /tmp/leads-migration.sql -c ROLLBACK`): PASS, exit 0. Relações/índices existentes emitiram NOTICE; nenhum erro.
- Concorrência: criados dois leads sintéticos próprios, UUIDs `cc220000-0000-4000-8000-000000000001` e `cc220000-0000-4000-8000-000000000002`, elegíveis com datas1900-01-01/02. SessãoA fez BEGIN, SET LOCAL ROLE service_role, claim e pg_sleep(4) antes de COMMIT. Após1s, sessãoB executou claim em outra conexão e concluiu em0,503s. A recebeu001; B recebeu002; ambas ficaram com notification_attempts=1. Os dois registros foram removidos por UUID. Nenhum outro lead foi reivindicado ou modificado nessa prova.
- `critic-performance.sql`, executado com psql real no container: PASS, exit 0. Cria10.000 leads adicionais em transação, faz ANALYZE, EXPLAIN ANALYZE e40 medições por cenário usando authenticated/admin; termina com ROLLBACK. Próxima tentativa dos10.000 registros em2099, impedindo participação em push.

## Performance local

| Cenário | Execuções | Média ms | p95 ms | Máximo ms | Maior payload bytes | Máximo de linhas |
|---|---:|---:|---:|---:|---:|---:|
| Primeira página | 40 | 2,110 | 2,95505 | 4,879 | 7233 | 25 |
| Filtro status | 40 | 3,319 | 4,9434 | 6,071 | 7133 | 25 |
| Offset9000 | 40 | 3,793 | 8,1209 | 11,590 | 7426 | 25 |
| Busca seletiva | 40 | 16,859 | 29,8578 | 31,803 | 357 | 1 |

Plano sem filtro: Index Only Scan `leads_created`, 0,047ms. Filtro status: Index Scan `leads_created`, 0,057ms. Busca seletiva após inserção em massa: Seq Scan, 14,883ms; o otimizador não escolheu GIN nesse volume/estado. Estes números medem execução SQL local, sem transporte HTTP, e não garantem capacidade de produção. A projeção continuou limitada a25 linhas.

## Avaliação técnica

Autorização das RPCs verificada internamente, search_path vazio e objetos qualificados. Grants limitam escrita direta e funções do worker. Os triggers não são RPCs públicas, preservam a operação original na falha e não registram valores externos. O worker separa reserva de sucesso, finaliza com token e usa recibos por assinatura. APIs validam UUID, status, campos extras, origem e corpo limitado mesmo sem Content-Length; erros de SQL não são retornados.

Limite inerente: crash entre aceite do provedor e persistência do recibo pode repetir entrega; tag estável ajuda a colapsar a notificação visual. Não declarar exactly-once. A prova de duas sessões demonstra exclusão concorrente do claim; a prova de dois cron ticks e de entrega criptografada exige o harness integrado separado.

## Avaliação de impacto

Primeira impressão: solução consistente e restrita ao propósito. Supera o básico com recibos persistidos e token de finalização. O maior valor é recuperar falhas parciais sem reenviar sucessos já confirmados. O elo mais fraco permanece a dependência da prova integrada/browser externa a esta revisão; não converter a aprovação de banco em aprovação de toda a funcionalidade.

## Reavaliação da correção de origem

O E2E detectou falso403 porque Next normalizava request.url para localhost, mas o navegador enviava Origin127.0.0.1. Revisei independentemente a mudança do PATCH para comparar Origin com Host público e x-forwarded-proto, preservando a autorização e rejeitando sec-fetch-site=cross-site. O navegador não pode escolher livremente Host nem sec-fetch-site; a mudança não remove a proteção da sessão nem as verificações internas da RPC. O proxy de produção deve encaminhar o Host público e normalizar x-forwarded-proto, condição normal dessa comparação de origem.

Reexecutei `npx vitest run src/app/api/platform/leads/route.test.ts`: **31/31 PASS**, exit0, duração801ms. Inclui os três casos novos: loopback normalizado, TLS terminado no proxy e fetch cross-site rejeitado. Nenhum novo achado bloqueante. Aprovação do escopo mantida; o fluxo HTTP/browser continua sendo comprovado no harness E2E separado.
