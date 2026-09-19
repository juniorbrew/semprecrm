# Continuidade — leads da plataforma SempreCRM

Atualizado em 19/09/2026. Trabalho interrompido por desligamento do computador a pedido do usuário. **Implementação presente, validação final ainda incompleta. Não anunciar como concluído.**

## Como retomar

Leia primeiro este arquivo, `docs/verification/platform-leads/REQUEST.md` (pedido integral), `AGENTS.md` e a documentação local pertinente em `node_modules/next/dist/docs/`. Trabalhe diretamente em `C:\SempreCRM`. Não faça push nem deploy remoto. Preserve `.claude/`, que já existia não rastreado antes desta tarefa.

O usuário permite decisões técnicas pequenas, implementação e testes sem confirmações repetidas. Pede checkpoint antes de alterações estruturais. O próximo agente deve completar testes, corrigir falhas, revisar segurança e entregar relatório com os 21 gates do pedido, sem inventar PASS.

## Git

- Branch: `main`.
- HEAD inicial: `2f597ee174532d5298ae181a65a0ed30315d32b4`.
- Checkpoint inicial: `8f6dc2a` — `chore: checkpoint before platform leads implementation`.
- Será criado um segundo checkpoint com esta implementação e este handoff; consulte `git log -3 --oneline` para o hash.
- Não houve push.

## Implementado

### Banco — `supabase/migrations/045_platform_leads.sql`

- Tabela global `leads`, tipos contato/cadastro e quatro status, CHECKs, índices únicos parciais por origem, índices para ordenação/filtros e busca trigram.
- Snapshots de nome/email/empresa preservados quando a origem é excluída. FKs `ON DELETE SET NULL`; CHECK permite a referência nula sem aceitar referência do outro tipo.
- RLS: anon sem grants; authenticated pode SELECT apenas se `is_platform_admin()`; INSERT/UPDATE/DELETE diretos sem grants mesmo para admin. Status muda via RPC restrita.
- `is_platform_admin()` endurecida com search_path vazio e objetos qualificados, mantendo sua semântica.
- Triggers separados em `contact_submissions` e `accounts`, idempotentes, exceções não bloqueantes com WARNING contendo somente origem/SQLSTATE.
- Cadastro só captura conta `plan='trial'`; email vem de `auth.users.email` por owner_user_id. **`handle_new_user()` não foi alterada.**
- `platform_list_leads(p_limit,p_offset,p_status,p_kind,p_search)` retorna JSON `{leads,total,new_count,limit,offset}`, projeção sem estado interno de push. Ordena por data/id DESC. Busca literal com escape de `%`, `_` e barra. Limites 1..100, offset até 1 milhão, busca até 200 caracteres.
- `platform_update_lead_status(p_lead_id,p_status)` valida admin/status/existência e retorna projeção pública.
- Worker RPCs SECURITY INVOKER com grants somente service_role: `claim_lead_notifications(p_limit=1)` usando `FOR UPDATE SKIP LOCKED`; `complete_lead_notification(p_lead_id,p_claim_token,p_success)` com fencing por UUID, expiração de 5 minutos e backoff 1min..1h.
- Extras além do pedido: `notification_claim_token`, `notification_next_attempt_at`, e tabela privada `lead_push_deliveries` para recibos por assinatura, evitando reenvio após sucesso parcial.
- Sem backfill de origens antigas. Sem Realtime. Sem email novo.

### Backend/API

- `src/lib/platform/leads.ts`: contratos compartilhados e parser de filtros.
- `src/lib/platform/api.ts`: autentica getUser, autoriza RPC, erros genéricos por código, cache privado/no-store.
- `GET /api/platform/leads`: listagem filtrada/paginada com sessão do chamador.
- `PATCH /api/platform/leads/[id]`: UUID/status, rejeita campos extras e origem cross-origin, lê no máximo 1KiB inclusive sem Content-Length. Usa RPC, não service-role.
- `requirePlatformAdmin()` em `src/lib/platform/server.ts` agora usa React cache para deduplicar layout/page na mesma renderização.

### Push/cron

- `src/lib/push/leads.ts`: `notifyNewLeads()`, reexportada por `notify.ts`.
- Resolve admins reais uma vez, claim de um lead por envio, até 10/35s por execução, finalização cercada pelo token. Falha não marca notified_at. Sem assinaturas deixa para retry.
- Reutiliza `sendPushToUsers()`, VAPID existente, URL `/platform/leads`, tag `lead:{id}`, texto pt-BR.
- `send.ts`: argumento opcional com IDs já entregues e callback de recibo; timeout de rede de 10s. Falha ao buscar assinaturas agora conta como falha, não sucesso vazio.
- Cron existente `/api/automations/cron` chama o worker e inclui `lead_notifications` na resposta. PM2 e cron-tick não mudaram.
- **Limitação inerente**: Web Push não tem exactly-once transacional. Crash entre aceitação pelo provedor e persistência do recibo pode repetir envio; tag estável colapsa notificação visual. Não prometer ausência absoluta de duplicação nessa janela.

### Frontend

- `/platform/leads` SSR, estados loading/error e componente `PlatformLeadsTable`.
- Navegação Contas/Leads e contador de novos no layout.
- Tabela desktop e cartões mobile; busca, filtros, paginação 25 por página, status inline, bloqueio de duplo submit, feedback/erro.
- Sem polling, Realtime ou fetch por linha. Primeira lista vem do servidor. Alteração com filtro de status refaz a página para preservar composição da lista.
- Entradas externas são texto React; sem dangerouslySetInnerHTML e sem gerar URLs com os dados externos.

## Testes já EXECUTADOS e resultados

1. `npm test`: **104 arquivos / 1184 testes PASS** antes das duas últimas adições ao `send.test.ts`. Os testes de API e worker já estavam incluídos.
2. Primeiro teste focado encontrou expectativa antiga de opções do web-push sem timeout. Corrigida para `{TTL:3600,timeout:10000}`; a suíte completa acima passou depois disso.
3. `npm run typecheck`: PASS em uma etapa anterior; o build posterior também completou TypeScript.
4. `npm run lint`: exit 0, 9 warnings (8 preexistentes e 1 novo `_count` em navigation). O novo warning foi corrigido depois; rerodar. Foi necessário adicionar `.claude/**` ao ignore do eslint, pois havia um checkout inteiro com bundles gerados e o lint estava percorrendo tudo. Nenhum conteúdo de `.claude/` foi modificado.
5. Build de produção: `node scripts/platform-leads-runtime.mjs build`: **PASS**, Next16.2.6/Turbopack, compilação/TypeScript/69 páginas completos. Avisos preexistentes: middleware deprecated e edge/static. **Esse build usa ambiente sintético local; não usar `.next` para produção. Rebuild com env correto antes de deploy.**
6. Migration045 aplicada com `psql -v ON_ERROR_STOP=1` à instância isolada abaixo: PASS. As migrations001..044 haviam sido aplicadas ao criar a instância.
7. `supabase/tests/platform_leads.sql`, executado via psql real: **PASS**. Testa auth/signup real por INSERT auth.users, contato, unicidade de ambas origens, CHECK, RLS anon/tenant A/B/admin, isolamento de accounts, RPCs negadas, status/ID inexistente, literal SQL injection, paginação, captura não bloqueante, preservação após delete, claim ativo, backoff, token stale, claim expirado, sucesso e não reenvio. Tudo em transação com ROLLBACK. Warnings controlados sem dados sensíveis foram observados.
8. E2E Playwright + Supabase local/Next produção: passou realmente por HTTP auth/anon/token inválido/tenants A/B + RLS via Supabase; submissão `/contato` pela UI criou exatamente1 lead; `/signup` pela UI criou conta e exatamente1 lead cadastro com email correto.
9. Primeira execução E2E parou por timeout tentando botão `Switch to dark mode`: app abre dark por padrão, embora contexto Playwright seja light. Harness ajustado para selecionar light antes de capturar. Segunda execução estava em andamento quando computador desligou. **Não existe resultado final E2E; não assumir que o restante passou.**
10. Captura existente `docs/verification/platform-leads/desktop-light.png` é da execução inicial e mostra **dark** apesar do nome. Foi inspecionada: listagem renderizada/25 linhas sem erro visível. Regenerar todas as imagens com nomes corretos. Não há ainda mobile validado.

## Arquivos de verificação

- `src/app/api/platform/leads/route.test.ts`: auth, tenant, token, UUID/status/campos, payload grande, origem, erros normalizados, parâmetros/SQL injection literal.
- `src/lib/push/leads.test.ts`: elegibilidade, destinatários/payload, falha/zero/partial, recibos, finalização/token.
- `src/lib/push/send.test.ts`: expectativa de timeout corrigida; **duas novas provas de recibos/exclusão foram adicionadas após o último npm test completo, ainda não executadas**.
- `supabase/tests/platform_leads.sql`: testes PostgreSQL descritos acima.
- `scripts/platform-leads-runtime.mjs`: carrega status do Supabase isolado, cria VAPID sintética no TEMP, inicia build/dev/start com overrides. Recusa qualquer API_URL diferente de `http://127.0.0.1:57021`. Não imprime credenciais.
- `scripts/verify-platform-leads.mjs`: E2E completo em construção, contém testes browser/API, capturas desktop/mobile claro/escuro/loading/vazio/erro/XSS e cron/push real criptografado com servidor HTTPS controlado. Últimos testes de push **ainda não foram alcançados**.
- `progress.html`: workbench criado inicialmente, **ainda precisa atualização com resultados**.

## Ambiente local e recuperação pós-reinício

Na última checagem após a mensagem do usuário, Docker estava **desligado** e as sessões de processo tinham desaparecido. É preciso iniciar Docker Desktop antes de retomar.

Não misturar as instâncias:

- Aplicação local preexistente: porta3101, Supabase56021, DB56022, containers sufixo `semprecrm`. **Não usamos/aplicamos045 nela.** Há cron preexistente. Não parar/resetar/mutar essa stack por engano.
- Instância descartável desta verificação: Supabase57021, DB57022, Inbucket57024; containers `supabase_*_semprecrm-leads-verification`. Config/migrations em `C:\Users\junio\AppData\Local\Temp\semprecrm-leads-verification\supabase`. Criada sem Realtime/Studio/analytics para testes. Contém apenas fixtures sintéticas.
- Next de teste: porta3107, processo Node próprio usando repositório atual, sem scheduler paralelo (cron invocado manualmente no teste).
- Supabase CLI encontrado: `C:/Users/junio/AppData/Local/npm-cache/_npx/aa8e5c70f9d8d161/node_modules/@supabase/cli-windows-x64/bin/supabase.exe`.
- Playwright encontrado: `C:/Users/junio/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`; Chromium instalado no cache do usuário.
- Certificado/key de teste HTTPS e VAPID ficam apenas em TEMP, não Git. Certificado expira em2 dias; regenerar se necessário.

Exemplos PowerShell (nenhum imprime secrets):

```powershell
$env:SUPABASE_CLI='C:/Users/junio/AppData/Local/npm-cache/_npx/aa8e5c70f9d8d161/node_modules/@supabase/cli-windows-x64/bin/supabase.exe'
$env:PLAYWRIGHT_MODULE='C:/Users/junio/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'
# Após restaurar a stack isolada e conferir as portas:
node scripts/platform-leads-runtime.mjs build
node scripts/platform-leads-runtime.mjs start
# Em outro terminal:
node scripts/verify-platform-leads.mjs

docker cp supabase/tests/platform_leads.sql supabase_db_semprecrm-leads-verification:/tmp/leads-test.sql
docker exec supabase_db_semprecrm-leads-verification psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/leads-test.sql
```

Se precisar recriar o certificado local:

```powershell
& 'C:/Program Files/Git/usr/bin/openssl.exe' req -x509 -newkey rsa:2048 -nodes -keyout "$env:TEMP/semprecrm-leads-verification/push-key.pem" -out "$env:TEMP/semprecrm-leads-verification/push-cert.pem" -days 2 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

O runtime define NODE_EXTRA_CA_CERTS só para esse certificado e processo. Nunca desative validação TLS globalmente.

## Próximos passos obrigatórios

1. Recuperar Docker/stack isolada; confirmar migration045 instalada e schema cache atualizado. Se recriar stack, copiar045 para migrations do diretório TEMP antes de migrar. Não resetar a instância preexistente.
2. Rerodar `npm test`, lint e typecheck depois das últimas mudanças e formatação; corrigir falhas.
3. Completar/debugar harness E2E. Há fixtures deixadas das execuções interrompidas (emails únicos por timestamp, vários admins). Ao testar push, assinaturas antigas com chaves diferentes podem precisar limpeza **somente na stack descartável**, ou adaptar harness para remover as próprias fixtures. O harness atual suspende notificações pendentes antigas com next_attempt_at2099, só no ambiente isolado.
4. Capturar e inspecionar desktop/mobile/light/dark/loading/empty/error/XSS; corrigir UI se necessário. Verificar console, overflow, status e persistência, contagem de requests.
5. Executar concorrência cron, push sucesso/falha/retry de verdade no receiver HTTPS do harness; validar recibos e zero duplicações em ticks simultâneos. Incluir caso de sucesso parcial com duas assinaturas; atualmente só há unit tests desse cenário.
6. Auditar JS/HTML gerados, Network/storage e secrets por valor sem imprimi-los. A checagem DOM/storage está escrita no E2E mas ainda não foi alcançada. Fazer também scan `.next/static` dos valores privados de teste e do ambiente real sem mostrar os valores.
7. Performance: conferir planos/índices e payload paginado com volume representativo. Ainda sem benchmark de10k. Migration idempotência/reapply ainda não testada.
8. Revisão de segurança independente e relatório final. Os subagentes construíram migration/UI e provisionaram o ambiente, mas todos terminaram com limite de uso antes da crítica. **Não houve verdict APPROVED independente Gauntlet.** Não inventar aprovação.
9. Atualizar workbench e documentação final, revisar diff/working tree, criar commit final se adequado, informar HEADs/gates/arquivos/comandos e riscos. Não fazer push.

## Limites a declarar honestamente

- Push aceito em servidor HTTPS controlado não comprova exibição de uma notificação em dispositivo real/provedor externo. Essa validação final requer assinatura real e VAPID compatível; não marcar PASS de entrega no dispositivo sem observar.
- Nenhuma migration/deploy em produção realizada. Repositório não é automaticamente a aplicação Docker preexistente rodando3101.
- UI/status/concorrência/push E2E completo, mobile, secrets do build e performance ainda pendentes, embora implementação e testes unitários/banco tenham avançado.
- Drawer de detalhes era opcional; não foi criado, os campos previstos aparecem na tabela/cartão.
- Lint possuía warnings fora do escopo, não errors; não fazer mudanças amplas sem necessidade.
