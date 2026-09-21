# Leads da plataforma — relatório técnico

Repositório: `C:\SempreCRM`. Branch: `main`. Implementação em `/platform/leads`, sem push Git ou deploy remoto. Este relatório acompanha os testes e evidências da entrega; os limites de validação estão explicitados abaixo.

## Arquitetura e comportamento

`/contato → contact_submissions → trigger → leads` e `/signup → auth.users → handle_new_user existente → accounts → trigger → leads`. A tabela é global, exclusiva da administração da plataforma. Não é uma tabela de tenant e não foi adicionada ao CRM dos clientes.

O cron existente busca leads pendentes por RPC atômica, envia usando o Web Push/VAPID existente e registra recibos por assinatura. A interface usa renderização inicial no servidor e APIs paginadas nas interações. Não foram criados emails, Supabase Realtime, polling, cron paralelo ou mudanças em PM2.

### Migration, tabelas e segurança do banco

`045_platform_leads.sql` cria `leads`, com os campos solicitados, tipos/status validados e unicidade parcial por origem. Há índices para data/id, status/data, tipo/data, fila de notificação e busca trigram. As referências únicas já servem de índice para as FKs; não há um segundo índice redundante para cada origem.

Os snapshots de nome/email/empresa sobrevivem à exclusão de contas e submissões. As FKs usam `ON DELETE SET NULL`; o CHECK permite origem removida, sem permitir associação ao tipo errado. Essa escolha evita que a própria exclusão viole o CHECK.

RLS habilitada. `anon` não tem acesso. `authenticated` só recebe SELECT e a policy exige `is_platform_admin()`. Mesmo um admin altera status pela RPC validada; não recebe INSERT/UPDATE/DELETE arbitrários. Tenants A/B não leem leads e continuam vendo apenas suas próprias contas.

`lead_push_deliveries` guarda `(lead_id, subscription_id, delivered_at)`, com RLS e grants somente para o serviço. Os campos extras `notification_claim_token` e `notification_next_attempt_at` suportam fencing de workers e backoff.

### Funções, triggers e RPCs

| Objeto | Responsabilidade e autorização |
|---|---|
| `is_platform_admin()` | Helper existente endurecido com search_path vazio e schemas explícitos; sem mudança na semântica |
| `on_contact_submission_created_lead()` | Captura AFTER INSERT de contato, idempotente; falha não bloqueia origem |
| `on_account_created_lead()` | Captura AFTER INSERT de conta trial; email do owner em `auth.users` |
| `platform_list_leads()` | Checa admin internamente; busca/filtros/paginação server-side, projeção pública |
| `platform_update_lead_status()` | Checa admin, UUID tipado, status e existência; altera somente status/updated_at |
| `claim_lead_notifications()` | SECURITY INVOKER, execute somente service_role; um claim por chamada com SKIP LOCKED |
| `complete_lead_notification()` | SECURITY INVOKER, execute somente service_role; finalização condicionada ao token/lease vigente |

As novas funções SECURITY DEFINER têm search_path vazio, referências qualificadas, owner postgres, REVOKE PUBLIC e grants mínimos. RPCs administrativas checam `is_platform_admin()` internamente. Os triggers não podem exigir identidade de platform admin: executam durante contato público/signup. Por isso não têm EXECUTE concedido aos papéis da API e só são usados no vínculo de trigger. `handle_new_user()` permanece inalterada.

Falhas dos triggers geram WARNING com origem e SQLSTATE, sem SQLERRM, nome, email, mensagem ou credenciais. O INSERT original continua. Não há backfill nem envio retroativo para dados anteriores à migration.

### APIs e frontend

- `GET /api/platform/leads`: `limit`1..100, `offset`0..1.000.000, `status`, `kind`, `search` até200 caracteres. Retorna `{leads,total,new_count,limit,offset}`. Busca literal por nome/email/empresa, inclusive tratando `%` e `_` como dados. Ordenação `created_at DESC,id DESC`.
- `PATCH /api/platform/leads/[id]`: somente `{status}`. Autentica, verifica admin, UUID, origem da requisição e tamanho real do corpo até1KiB; chama RPC com a sessão do usuário. Campos extras são rejeitados.
- Respostas de erro são normalizadas em401/403/400/404/413/500, sem SQL ou stack trace. Cache privado/no-store. Nenhuma API de leads usa service-role para contornar a sessão do chamador.
- Navegação Contas/Leads com contador de novos, tabela desktop/cartões mobile, filtros, paginação25, loading/vazio/erro, feedback de salvamento e bloqueio de submit concorrente. Se o status alterado invalida o filtro, a página é refeita para manter o total e preencher a lista.
- Nenhum fetch por linha. A primeira lista chega no SSR; não existe double-fetch inicial do navegador no build de produção testado. `requirePlatformAdmin()` deduplica a autorização de layout/page via React cache.
- Dados externos são renderizados como texto React, sem HTML dinâmico ou URLs derivadas de nome/email/empresa. Drawer era opcional e não foi adicionado: os campos pedidos já aparecem na listagem/cartões.

### Push, concorrência e retry

`notifyNewLeads()` resolve admins reais e reutiliza `sendPushToUsers()`. Mensagens: `Novo lead: {name}` / `Novo cadastro: {name}`; corpo empresa ou email; URL `/platform/leads`; tag `lead:{id}`. Texto limitado antes do envio.

Cada lead tem claim temporário, token aleatório e contador de tentativas. A seleção/atualização ocorre atomicamente com `FOR UPDATE SKIP LOCKED`. Lease de5min; worker faz um claim por vez, até10 leads e orçamento de35s por tick. Timeout de10s por requisição Web Push. Falha libera o claim e agenda retry de1min até1h. `notified_at` só é preenchido após sucesso confirmado pelo transporte e persistência dos recibos.

Sucesso parcial conserva recibos: o dispositivo já atendido não é reenviado no retry. Sem VAPID ou admins, não reivindica trabalho. Sem assinatura utilizável, não marca sucesso e usa backoff. O cron atual conserva seu intervalo natural (padrão60s) e retorna contadores em `lead_notifications`.

**Limite inerente:** Web Push e PostgreSQL não compartilham uma transação. Crash entre aceitação externa e gravação do recibo ainda pode repetir entrega; a tag estável colapsa a notificação visual. Não há promessa de exactly-once entre esses sistemas.

## Evidências e resultados

### Automatizados e PostgreSQL real

- Suíte completa mais recente: **104 arquivos, 1189 testes PASS** (`npm test`,20/09/2026).
- API:31 testes, incluindo regressões de Host normalizado, HTTPS atrás de proxy e rejeição cross-site.
- Worker/envio: elegibilidade, destinatários, payload, ausência de configuração/assinaturas, falha total/parcial, recibos e fencing. `send.test.ts` testa exclusão dos recibos e falha de persistência.
- SQL real: `supabase/tests/platform_leads.sql` PASS. Exercita signup/auth real, contato, RLS, anon, dois tenants, admin, unicidade, fonte excluída, CHECK, status, busca literal/SQL injection, falha não bloqueante, claim/expiração/backoff/token obsoleto/sucesso/não reenvio. Transação revertida após o teste.
- Migration aplicada no ambiente isolado e reaplicada duas vezes pelo crítico com PASS.
- Concorrência independente: duas conexões service_role, primeira com lock mantido4s; segunda concluiu em0,503s com outro lead. Ambos attempts1. Fixtures próprias removidas.

### Performance com10 mil leads

| Cenário | Execuções | p95 SQL | Máximo de linhas |
|---|---:|---:|---:|
| Primeira página | 40 | 2,96ms | 25 |
| Filtro de status | 40 | 4,94ms | 25 |
| Offset9000 | 40 | 8,12ms | 25 |
| Busca seletiva | 40 | 29,86ms | 1 |

Maior resposta medida:7426bytes. O planner escolheu índice nas consultas de ordenação/filtro e seqscan na busca desse fixture de10k; o índice GIN existe, mas não se deve afirmar que foi usado nessa medição. Valores locais de execução SQL, sem incluir transporte HTTP, não são garantia de capacidade em produção. Comando e resultados em `critic-performance.sql` e `critic-security.md`.

### E2E, UI e segurança de navegador

O harness `scripts/verify-platform-leads.mjs` usa Next, Supabase Auth/REST/Postgres reais e Chromium. O envio push usa VAPID/criptografia/rede HTTPS reais para um receiver local controlado que descriptografa o payload e retorna201/503 conforme o cenário. Não é um mock do helper de envio.

Os resultados da última execução integral ficam em `e2e-results.json`. Incluem `/contato`, `/signup`, status persistido, busca/tipo/status/paginação, falhas controladas da API, loading/vazio/erro, XSS como texto, requests sem duplicação inicial, auth/tenants por HTTP e REST direto, UUID/status/payload grandes/campos extras/replay, dois crons simultâneos, falha503/retry/backoff e sucesso parcial com duas assinaturas.

Capturas: `desktop-light.png`, `desktop-dark.png`, `mobile-light.png`, `mobile-dark.png`, `filtered.png`, `loading.png`, `empty.png`, `list-error.png`, `status-error.png`, `xss-text.png`.

A crítica visual independente aprovou a interface após uma execução própria em quatro combinações de largura/tema, com persistência após reload, sem overflow horizontal e sem erros de console. O parecer, resultados e capturas estão em `critic-ui.md`, `critic-ui-results.json` e `critic-{1440,390}-{light,dark}.png`. Duas observações não bloqueantes permanecem: um erro de listagem após uma busca vazia exibe também o cartão de estado vazio, e emails longos quebram no meio do endereço para caber na tabela.

`verify-platform-leads-secrets.mjs` procura valores privados sem imprimi-los em `.next/static`; inclui valores sintéticos do build e privados do `.env.local`. O resultado fica em `secrets-results.json`. A checagem de DOM/localStorage/sessionStorage está no E2E. A sessão autenticada do próprio usuário é legitimamente acessível ao navegador; ela não é service-role nem credencial de servidor. Não houve bloqueio de F12/botão direito.

### Bugs corrigidos durante a validação

1. Requisição legítima de status recebia403 com Host127.0.0.1/URL interna localhost. Comparação de origem passou a considerar Host público e protocolo encaminhado; três testes e revisão independente cobrem a correção.
2. Hidratação do ícone do tema divergia entre SSR escuro e preferência clara no browser. `ModeToggle` usa snapshot estável durante hidratação e mostra a preferência em seguida.
3. Texto dos status tinha contraste baixo no tema escuro: a aplicação usa `data-mode`, enquanto a variante dark global espera `.dark`. O componente de leads agora usa a variante baseada no atributo real, sem alterar todos os temas do sistema.
4. Erro ao buscar assinaturas podia parecer resultado vazio no helper compartilhado; agora incrementa falha. Timeout explícito impede espera indefinida do envio.
5. O lint percorria checkout e bundles dentro de `.claude/`; esse diretório foi excluído da varredura, preservando seu conteúdo.

Falhas do próprio harness também foram corrigidas: seleção inicial do tema, seletor de alert que colidia com anunciador do Next e filtros identificando fixtures de execuções anteriores.

## Execução e reprodução

Instância de verificação: Supabase57021/DB57022, nome `semprecrm-leads-verification`, diretório de trabalho no TEMP do usuário. Next de teste em3107. Nenhum reset da stack local preexistente56021, nenhum banco remoto utilizado. Após desligamentos, sockets de runtime do Docker foram preservados em diretórios de backup e recriados; volumes/bancos não foram apagados.

Depois dos testes, `supabase migration up --local --workdir C:\SempreCRM --yes` aplicou apenas `045_platform_leads.sql` ao banco local principal56022. Consulta final: `public.leads` existe e `supabase_migrations.schema_migrations` está em045. O container web atualmente ativo na porta3101 aponta para **outro checkout em `.claude/worktrees/...`**; ele não foi substituído, para preservar o trabalho paralelo. O recurso deste repositório foi executado e testado na porta3107; para publicar na porta3101 é necessário construir o container a partir deste checkout no fluxo de implantação escolhido.

Os caminhos locais de SUPABASE_CLI/PLAYWRIGHT_MODULE e os comandos de bootstrap estão em `HANDOFF-PLATFORM-LEADS.md`. Com essas variáveis definidas:

```powershell
npm test
npm run lint
npm run typecheck
node scripts/platform-leads-runtime.mjs build
node scripts/platform-leads-runtime.mjs start
# Outro terminal:
node scripts/verify-platform-leads.mjs
node scripts/verify-platform-leads-secrets.mjs
docker cp supabase/tests/platform_leads.sql supabase_db_semprecrm-leads-verification:/tmp/leads-test.sql
docker exec supabase_db_semprecrm-leads-verification psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/leads-test.sql
```

O build de teste usa chaves sintéticas locais. Não levar `.next` desse teste para produção; gere o build com a configuração do ambiente de destino. A configuração PM2/cron existente não exige alterações para a nova função.

## Limites e estado da entrega

- Entrega a dispositivo real por um provedor externo de push não observada. A integração criptografada, falhas e retries são comprovados em HTTPS local controlado.
- Crash na janela externa/recibo tem a limitação descrita acima.
- Nenhum deploy remoto, push Git ou alteração destrutiva em produção.
- Lint terminou exit0 com8 avisos preexistentes fora do escopo.
- Mudanças de marketing encontradas na retomada de20/09 pertencem a outro trabalho e foram preservadas, sem inclusão nos commits deste módulo.

## Gates finais

| Gate | Resultado |
|---|---|
| Banco | PASS — PostgreSQL local e isolado consultados |
| Migration | PASS — aplicada em ambos; reaplicação2x em transação pelo crítico |
| RLS | PASS — SQL real anon/tenants/admin |
| Multitenancy | PASS — SQL real + HTTP/REST direto de tenant A/B |
| APIs | PASS —31 testes, HTTP E2E e replay/erro |
| SECURITY DEFINER | PASS — search_path/grants/checagem e revisão independente |
| Lead contato | PASS — formulário no browser e SQL real |
| Lead cadastro | PASS — signup no browser e SQL real |
| Duplicidade | PASS — índices únicos e testes SQL |
| UI | PASS — E2E browser,10 capturas e crítica visual independente aprovada com4 capturas próprias |
| Push | PASS — Web Push/VAPID criptografado para receiver HTTPS local; dispositivo real NÃO VALIDADO |
| Concorrência | PASS — duas conexões SQL e dois cron HTTP simultâneos |
| Retry | PASS —503, backoff, sucesso posterior e recibos de2 assinaturas |
| XSS | PASS — payloads script/img permanecem texto em DOM |
| Secrets frontend | PASS —88 assets,10 valores privados, nenhum match; DOM/storage E2E |
| Performance | PASS —10k leads/40 medições por cenário, payload limitado |
| Mobile | PASS — Chromium390, claro/escuro, sem overflow horizontal |
| Testes | PASS —104 arquivos/1189 testes; SQL e E2E completos |
| Lint | PASS — exit0,8 avisos preexistentes |
| Typecheck | PASS — TypeScript no build e comando separado |
| Build | PASS — Next16.2.6/Turbopack;69 páginas |

O critério Push PASS descreve envio HTTP/Web Push real para receiver HTTPS controlado e seus registros de sucesso/falha. A notificação exibida por um provedor externo em um dispositivo administrativo real permanece `NÃO VALIDADO`, pois esse dispositivo/assinatura não fazia parte do ambiente de teste. Isso não altera o resultado local do sender/cron.
