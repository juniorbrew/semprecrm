Trabalhe diretamente no repositório atual do SempreCRM e entregue esta funcionalidade COMPLETA, IMPLEMENTADA, TESTADA E PRONTA PARA USO.

Não quero apenas análise, plano, sugestões ou código parcial.

Quero que você:

- inspecione o projeto real;
- implemente;
- crie/ajuste migrations;
- ajuste banco e RLS;
- implemente backend;
- implemente frontend;
- integre push;
- crie testes;
- execute os testes;
- corrija o que falhar;
- valide segurança;
- valide multitenancy;
- valide desktop/mobile;
- deixe o repositório em estado utilizável ao final.

Não interrompa o trabalho para me pedir confirmação em cada etapa.

Se houver uma decisão técnica pequena necessária, escolha a alternativa mais segura e compatível com a arquitetura existente e documente no relatório final.

Não faça deploy destrutivo em produção sem necessidade.

Antes de mudanças estruturais importantes, faça checkpoint Git.

---

# OBJETIVO

Criar no painel do dono do SaaS (`/platform`) um módulo completo de captação e acompanhamento de leads.

Os leads virão de:

1. submissões de `/contato`;
2. novas contas trial criadas por `/signup`.

Cada lead terá:

- `novo`
- `em_contato`
- `convertido`
- `descartado`

Quando um novo lead surgir, o platform admin deverá receber notificação push usando a infraestrutura de push que já existe no projeto.

Não criar e-mail.
Não adicionar Supabase Realtime.
Não alterar o comportamento normal de `handle_new_user()`.
Não quebrar fluxos existentes.

---

# ETAPA 1 — AUDITAR O PROJETO REAL

Antes de modificar qualquer coisa, localize e revise:

- migrations;
- `accounts`;
- `contact_submissions`;
- `platform_admins`;
- `handle_new_user`;
- `is_platform_admin`;
- RLS atual;
- RPCs do `/platform`;
- `/platform`;
- `/api/platform`;
- `src/lib/platform/server.ts`;
- `src/lib/push/send.ts`;
- `src/lib/push/notify.ts`;
- `src/app/api/automations/cron/route.ts`;
- cron atual;
- PM2/configuração de execução;
- testes existentes;
- componentes de tabela/status;
- autenticação/autorização;
- padrões de paginação;
- padrões de API;
- sistema atual de logging/observabilidade.

Não assuma nomes ou contratos sem verificar o código.

Reutilize os padrões existentes quando forem seguros.

---

# ETAPA 2 — BANCO

Criar a próxima migration disponível, respeitando o padrão do projeto.

Criar tabela global:

`leads`

Ela pertence ao dono da plataforma e NÃO é uma tabela interna de tenant.

Campos esperados:

- `id uuid primary key`
- `kind text not null`
- `status text not null default 'novo'`
- `name text not null`
- `email text not null`
- `company text null`
- `contact_submission_id uuid null`
- `account_id uuid null`
- `notification_claimed_at timestamptz null`
- `notified_at timestamptz null`
- `notification_attempts integer not null default 0`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Enums lógicos:

`kind`:
- `contato`
- `cadastro`

`status`:
- `novo`
- `em_contato`
- `convertido`
- `descartado`

Criar CHECKs.

A regra deve garantir que:

- lead `contato` referencia apenas `contact_submission_id`;
- lead `cadastro` referencia apenas `account_id`.

Revise cuidadosamente a relação entre CHECK e `ON DELETE SET NULL`.

Não crie uma modelagem que possa violar a própria constraint quando a origem for excluída.

Se necessário, preserve o lead histórico mesmo que a origem seja removida.

---

# ETAPA 3 — EVITAR DUPLICIDADE

É obrigatório garantir no BANCO:

- no máximo 1 lead por `contact_submission_id`;
- no máximo 1 lead por `account_id`.

Use índices únicos parciais ou solução PostgreSQL equivalente.

Os triggers também devem ser idempotentes.

Se fizer sentido, use:

`ON CONFLICT DO NOTHING`

Não dependa apenas da lógica da aplicação.

---

# ETAPA 4 — ÍNDICES E PERFORMANCE

Adicionar índices necessários para:

- status + data;
- kind + data;
- referências de origem;
- paginação;
- filtros.

Não criar índices redundantes.

A listagem nunca deve baixar todos os leads para o navegador.

---

# ETAPA 5 — RLS

Habilitar RLS em `leads`.

Garantir:

- anon não acessa;
- authenticated comum não acessa;
- tenant A não acessa;
- tenant B não acessa;
- usuário cliente não insere;
- usuário cliente não atualiza;
- usuário cliente não exclui;
- somente platform admin pode consultar/alterar o necessário.

Não confiar apenas em middleware ou frontend.

A proteção deve existir no banco.

---

# ETAPA 6 — SECURITY DEFINER

Para todas as novas funções `SECURITY DEFINER`:

- `search_path` explícito e seguro;
- schemas explícitos quando apropriado;
- mínimo privilégio;
- `REVOKE ALL FROM PUBLIC`;
- grants mínimos;
- checagem interna de `is_platform_admin()`.

Evitar qualquer possibilidade de privilege escalation por resolução de objeto/schema.

Revise também as funções existentes diretamente reutilizadas nesta implementação.

Se encontrar vulnerabilidade relacionada ao escopo, corrija e reporte.

---

# ETAPA 7 — CAPTURA DE LEAD DE CONTATO

Criar trigger:

`AFTER INSERT ON contact_submissions`

Função equivalente a:

`on_contact_submission_created_lead`

Criar lead com:

- `kind='contato'`
- nome
- e-mail
- empresa
- `contact_submission_id`

O trigger NÃO pode bloquear a submissão original.

Se ocorrer erro na criação do lead:

- capturar;
- registrar de forma observável;
- não expor dados sensíveis;
- continuar o INSERT original.

Não esconder erros de forma totalmente silenciosa.

---

# ETAPA 8 — CAPTURA DE LEAD DE CADASTRO

Criar trigger:

`AFTER INSERT ON accounts`

Função equivalente a:

`on_account_created_lead`

Criar:

- `kind='cadastro'`
- `name = NEW.name`
- `company = NEW.legal_name`
- `account_id = NEW.id`

Resolver o e-mail do owner pela fonte confiável do schema real.

Se a origem correta for `auth.users.email` por `owner_user_id`, use isso.

Confirme no projeto antes.

Não altere `handle_new_user()`.

O trigger deve funcionar inclusive para contas criadas por esse fluxo.

Falha na criação do lead nunca pode bloquear o cadastro real.

---

# ETAPA 9 — PUSH ROBUSTO

Não use `notified_at` como claim.

Separar:

- `notification_claimed_at`
- `notified_at`
- `notification_attempts`

Semântica:

`notification_claimed_at`
= processamento temporariamente reservado por um worker.

`notified_at`
= envio confirmado com sucesso.

`notification_attempts`
= tentativas realizadas.

---

# ETAPA 10 — CONCORRÊNCIA

Dois cron ticks simultâneos não podem enviar o mesmo push duas vezes.

O claim deve ser atômico.

Use estratégia segura de PostgreSQL, como:

- UPDATE condicional com RETURNING;
- RPC atômica;
- `FOR UPDATE SKIP LOCKED`;
- outra abordagem equivalente segura.

Não usar padrão vulnerável:

SELECT → UPDATE sem lock/condição atômica.

Claim precisa expirar.

Se o processo morrer entre claim e envio, o lead deve voltar a ser elegível depois de timeout seguro.

---

# ETAPA 11 — RETRY

Se o push falhar:

- NÃO preencher `notified_at`;
- registrar tentativa;
- permitir retry;
- liberar ou deixar claim expirar;
- continuar demais leads.

Se o push funcionar:

- preencher `notified_at`;
- finalizar claim;
- não reenviar novamente.

Não criar loop agressivo de retry.

Se já existir padrão de backoff, reutilize.

---

# ETAPA 12 — INTEGRAÇÃO PUSH

Reutilizar:

- `src/lib/push/send.ts`
- `sendPushToUsers()`
- VAPID atual
- infraestrutura existente

Adicionar função tipo:

`notifyNewLeads(...)`

Destinatários:

platform admins reais do sistema.

Mensagem:

Para contato:

`Novo lead: {name}`

Para cadastro:

`Novo cadastro: {name}`

Body:

empresa, se houver;
senão e-mail.

URL:

`/platform/leads`

Tag:

`lead:{id}`

pt-BR.

Não criar outra infraestrutura.

---

# ETAPA 13 — CRON

Integrar ao cron já existente.

Não criar cron paralelo sem necessidade.

Não alterar PM2/scripts se a infraestrutura atual já atende.

O push pode ter o atraso natural do intervalo existente.

---

# ETAPA 14 — LISTAGEM SERVER-SIDE

Criar listagem paginada.

Suportar:

- `limit`
- offset ou cursor
- status
- kind
- search

Busca por:

- nome;
- e-mail;
- empresa.

Ordenação:

`created_at DESC`

Retornar paginação adequadamente.

Não filtrar milhares de registros no client.

---

# ETAPA 15 — ATUALIZAÇÃO DE STATUS

Criar RPC equivalente a:

`platform_update_lead_status`

Validar:

- autorização;
- UUID;
- lead;
- status permitido.

Atualizar:

- status;
- `updated_at`.

Não permitir campos arbitrários.

---

# ETAPA 16 — INTERFACE

Criar/ajustar navegação do `/platform`:

- Contas
- Leads

Mostrar contador de leads `novo`.

Criar:

`/platform/leads`

Tabela com:

- tipo;
- nome;
- e-mail;
- empresa;
- status;
- data.

Adicionar:

- busca;
- filtro de status;
- filtro de tipo;
- paginação;
- loading;
- vazio;
- erro.

Desktop e mobile.

Use o design system real do projeto.

---

# ETAPA 17 — STATUS NA UI

Permitir alteração direta.

Pode ser:

- chip;
- dropdown;
- menu.

Precisa:

- feedback visual;
- erro tratado;
- evitar duplo submit;
- sincronizar corretamente após sucesso/falha.

---

# ETAPA 18 — DETALHE DO LEAD

Se encaixar sem inflar o escopo, adicionar drawer/modal/painel com:

- origem;
- nome;
- e-mail;
- empresa;
- data;
- status.

Não exibir IDs internos desnecessariamente.

---

# ETAPA 19 — API

Criar API seguindo o padrão real, exemplo:

`PATCH /api/platform/leads/[id]`

A API deve ser fina:

- autenticar;
- autorizar;
- validar;
- chamar RPC/service;
- normalizar resposta.

Nunca retornar:

- SQL bruto;
- stack trace;
- nome interno de tabela sem necessidade;
- secrets;
- service key;
- dados de outro cliente.

---

# ETAPA 20 — MULTITENANCY

Faça testes reais para:

- anon;
- usuário tenant A;
- usuário tenant B;
- platform admin.

Comprovar:

- tenants não veem leads;
- tenant A não vê tenant B;
- usuário comum não chama RPC privilegiada;
- usuário comum não altera status;
- usuário comum não insere lead;
- usuário comum não acessa `/api/platform/leads`;
- platform admin acessa apenas o esperado.

---

# ETAPA 21 — DEVTOOLS / F12 / NETWORK

Audite o sistema assumindo que o usuário consegue ver:

- Sources;
- Network;
- HTML;
- JS;
- localStorage;
- sessionStorage;
- requests;
- headers que o navegador legitimamente possui.

Não tente “proteger” bloqueando F12 ou botão direito.

Frontend não é segredo.

A segurança precisa estar no backend e no banco.

Confirme que NÃO chegam ao client:

- service role;
- VAPID private key;
- cron secret;
- senha de banco;
- secrets de servidor;
- tokens administrativos;
- credenciais internas;
- dados de outras tenants.

Se necessário, analise também o build gerado.

---

# ETAPA 22 — XSS

`name`, `email` e `company` são entrada externa.

Teste valores como:

`<script>alert(1)</script>`

e payloads semelhantes.

Eles devem aparecer apenas como texto.

Não usar `dangerouslySetInnerHTML`.

Validar também atributo/URL injection se houver.

---

# ETAPA 23 — REQUESTS

Auditar a nova tela para evitar:

- polling desnecessário;
- N+1;
- chamada por linha;
- fetch duplicado;
- refetch sem necessidade;
- atualização integral desnecessária;
- realtime.

Se houver double-fetch só em dev por comportamento do framework, documentar corretamente.

---

# ETAPA 24 — TESTES AUTOMATIZADOS

Criar testes suficientes.

Banco:

- migration;
- RLS;
- admin;
- tenant;
- duplicidade;
- triggers;
- status;
- erro não bloqueante.

Push:

- elegibilidade;
- claim;
- concorrência;
- sucesso;
- falha;
- retry;
- claim expirado;
- sem reenvio.

API:

- sem auth;
- tenant;
- admin;
- UUID ruim;
- status ruim;
- ID inexistente.

UI quando a infraestrutura permitir:

- loading;
- vazio;
- erro;
- listagem;
- busca;
- filtros;
- status.

---

# ETAPA 25 — E2E

Executar de verdade.

## Contato

1. enviar `/contato`;
2. confirmar submissão;
3. confirmar exatamente 1 lead;
4. abrir `/platform/leads`;
5. confirmar tipo;
6. confirmar status novo;
7. mudar status;
8. recarregar;
9. confirmar persistência.

## Signup

1. criar conta teste via `/signup`;
2. confirmar conta;
3. confirmar exatamente 1 lead;
4. confirmar `cadastro`;
5. confirmar e-mail correto.

## Push

1. criar lead;
2. executar cron;
3. confirmar claim;
4. confirmar envio;
5. confirmar `notified_at`;
6. executar cron novamente;
7. comprovar ausência de duplicação.

## Falha push

Simular falha controlada e provar:

- `notified_at` continua nulo;
- attempts aumenta;
- claim não fica preso;
- retry posterior funciona.

---

# ETAPA 26 — GAUNTLET DE SEGURANÇA

Depois de tudo funcionando, tente quebrar sua própria implementação.

Testar:

- IDs manipulados;
- chamada manual de API;
- RPC direta;
- token inválido;
- usuário de outro tenant;
- replay de request;
- concorrência;
- cron simultâneo;
- status inválido;
- UUID inválido;
- payload grande;
- SQL injection;
- XSS;
- campos faltantes;
- fetch manual pelo console;
- bypass da UI;
- chamadas curl;
- chamada direta ao Supabase quando aplicável.

Corrija qualquer vulnerabilidade encontrada dentro do escopo.

---

# ETAPA 27 — BUILD E QUALIDADE

Antes de concluir:

- testes atuais PASS;
- novos testes PASS;
- lint PASS;
- typecheck PASS;
- build PASS;
- migrations PASS;
- nenhuma regressão conhecida;
- working tree revisada.

Corrija erros encontrados.

Não entregue com “depois precisa corrigir” algo que possa ser corrigido agora.

---

# ETAPA 28 — SCREENSHOTS

Gerar capturas de:

- `/platform/leads` desktop;
- `/platform/leads` mobile;
- listagem com dados;
- estados importantes quando possível.

---

# ETAPA 29 — GIT

Antes de alterações grandes:

crie checkpoint.

No final informe:

- repo;
- branch;
- HEAD inicial;
- HEAD final;
- commits criados;
- working tree;
- arquivos modificados.

Não fazer push para remoto sem autorização se isso não fizer parte do fluxo já definido.

---

# CRITÉRIO FINAL

Só marque como concluído quando estiver efetivamente pronto.

Tabela obrigatória:

| Gate | Resultado |
|---|---|
| Banco | PASS/FAIL/NÃO VALIDADO |
| Migration | PASS/FAIL/NÃO VALIDADO |
| RLS | PASS/FAIL/NÃO VALIDADO |
| Multitenancy | PASS/FAIL/NÃO VALIDADO |
| APIs | PASS/FAIL/NÃO VALIDADO |
| SECURITY DEFINER | PASS/FAIL/NÃO VALIDADO |
| Lead contato | PASS/FAIL/NÃO VALIDADO |
| Lead cadastro | PASS/FAIL/NÃO VALIDADO |
| Duplicidade | PASS/FAIL/NÃO VALIDADO |
| UI | PASS/FAIL/NÃO VALIDADO |
| Push | PASS/FAIL/NÃO VALIDADO |
| Concorrência | PASS/FAIL/NÃO VALIDADO |
| Retry | PASS/FAIL/NÃO VALIDADO |
| XSS | PASS/FAIL/NÃO VALIDADO |
| Secrets frontend | PASS/FAIL/NÃO VALIDADO |
| Performance | PASS/FAIL/NÃO VALIDADO |
| Mobile | PASS/FAIL/NÃO VALIDADO |
| Testes | PASS/FAIL/NÃO VALIDADO |
| Lint | PASS/FAIL/NÃO VALIDADO |
| Typecheck | PASS/FAIL/NÃO VALIDADO |
| Build | PASS/FAIL/NÃO VALIDADO |

Não marque PASS sem evidência.

Se algo não puder ser validado, marque `NÃO VALIDADO`.

Não invente resultados.

---

# ENTREGA FINAL

Quando terminar, quero um relatório técnico final com:

1. o que foi implementado;
2. arquitetura final;
3. migrations;
4. banco;
5. RLS;
6. funções;
7. triggers;
8. RPCs;
9. endpoints;
10. frontend;
11. push;
12. concorrência;
13. retry;
14. performance;
15. multitenancy;
16. segurança;
17. XSS;
18. DevTools/F12;
19. secrets;
20. testes criados;
21. comandos executados;
22. resultados dos testes;
23. lint;
24. typecheck;
25. build;
26. screenshots;
27. bugs encontrados;
28. bugs corrigidos;
29. riscos restantes;
30. itens não validados;
31. arquivos criados;
32. arquivos modificados;
33. branch;
34. HEAD;
35. working tree;
36. tabela final de gates.

IMPORTANTE:

Não pare depois de implementar uma primeira versão.

Rode os testes, veja o que falhou, corrija e repita até chegar ao melhor estado possível.

O resultado esperado é o recurso funcional e pronto no repositório, não um plano de implementação.