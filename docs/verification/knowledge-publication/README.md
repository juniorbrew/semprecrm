# Entrega 4, parte B — conhecimento revisado e publicado

## Contrato e auditoria

A parte A (#98) já tinha categorias, snapshots imutáveis e restauração. Porém, `ai_knowledge_save_item` substituía os trechos usados pela IA em cada edição. Nenhuma nova base ou novo laboratório foi criado.

Agora criação, edição, upload e restauração salvam **rascunhos**. O administrador abre o histórico, revisa a prévia completa e publica explicitamente a última versão. A IA usa os trechos e título da versão publicada; o interruptor controla sua disponibilidade. Restaurar uma versão antiga gera um novo rascunho e exige nova publicação. Não há alteração automática das instruções do agente nem chamada paga de IA.

API: `PATCH /api/ai/knowledge/:id` com apenas `{ "publish_version": 2 }`. Autenticação, papel admin, módulo AI e conta da sessão permanecem obrigatórios. Versão desatualizada retorna 409; recurso de outra conta retorna 404. Uma mesma publicação é idempotente. Auditoria contém operação, versão e tipo, sem conteúdo ou segredos.

## Alterações e segurança

- Migration 088 mantém item editável e trechos de rascunho separados dos trechos publicados, sem apagar o histórico. Referências compostas vinculam a versão ao próprio item.
- Escrita direta de conteúdo/trechos e metadados de publicação é bloqueada para authenticated; somente as RPCs autorizadas salvam/publicam. Agentes não leem trechos de rascunho.
- Save e publish bloqueiam a mesma linha. A publicação verifica a versão depois de adquirir o bloqueio e troca os trechos atomicamente.
- Cada trecho deve pertencer ao texto canônico revisado, com prefixo FAQ contendo a pergunta exata. Isso garante procedência, não cobertura integral ou ausência de trechos fora de contexto escolhidos por um administrador.
- O helper compartilhado de associação à conta e as novas funções definer colocam `pg_temp` por último, impedindo falsificação por tabelas temporárias.
- Conteúdo legado válido é publicado sem mudar sua disponibilidade. Alterações diretas anteriores geram snapshot do estado atual, preservando versões antigas. Itens sem trechos continuam sem publicação. Trechos incompatíveis com o item interrompem a migração para reconciliação; nenhum conteúdo é aprovado silenciosamente. Publicações legadas usam horário da migração e autor NULL.
- Sem dependências novas e sem código copiado do Vocero. A referência continua registrada na auditoria existente.

## Evidências e classificação

| Verificação | Resultado |
|---|---|
| Suite Vitest | PASS — 3.838 testes, 1 ignorado preexistente |
| API e interface após validação de inteiro PostgreSQL | PASS — 31 testes focados |
| TypeScript | PASS |
| ESLint | PASS — zero erros; 14 avisos existentes |
| PostgreSQL: publicação, drafts, permissões, tenant, prefixo FAQ, assinatura dos trechos, falhas e tabelas temporárias | PASS — `supabase/tests/ai_knowledge_publication.sql` |
| PostgreSQL: versões, restauração, exclusão e constraints diferidas | PASS — `supabase/tests/ai_knowledge_versions.sql` |
| PostgreSQL: regressão de busca e RLS | PASS — `supabase/tests/ai_knowledge_base.sql` |
| Migração: drift de histórico, falta de versões/trechos e item desabilitado e rejeição de trechos incompatíveis | PASS — `supabase/tests/ai_knowledge_publication_backfill.sql` |
| Duas sessões reais: save/publish nas duas ordens, saves concorrentes, busca coerente com múltiplos trechos e publish/delete | PASS — `scripts/verify-knowledge-publication-concurrency.mjs` |
| API autenticada local: criação de rascunho e exclusão da busca | PASS — Next 16.4.0 + Supabase local |
| Navegador desktop/mobile | PASS funcional — sessão local retomada em 11/10/2026; criação, revisão, publicação, edição e restauração verificadas com conta sintética |
| Acessibilidade automatizada | PARTIAL — axe 4.12.1 detectou contraste 3,31:1 no link existente “Abrir agentes de IA”; duas verificações exigem revisão manual |
| Build Next 16.4.0 | PASS |
| VPS/integração externa de IA | Não executado |

**Fluxo de publicação: PASS local. Acessibilidade: PARTIAL.** Produção e provedor externo continuam sem validação nesta entrega.

### Retomada visual — 11/10/2026

Verificação com `agent-browser`, Next 16.4.0 e Supabase local na migration 088, sem chave de provedor. Conta temporária no plano Pro, removida ao terminar. Nenhum deploy foi executado. Capturas inspecionadas em desktop (1262 × 568) e viewport de celular (390 × 844); não houve teste em aparelho físico.

- Criação pela interface: FAQ “Qual o prazo entrega verificacao?” com resposta de cinco dias. Exibiu “Rascunho” e interruptor desabilitado. Busca autenticada: HTTP 200, `hits: []`.
- Histórico: botão de publicação apareceu somente após revisar a versão 1. Publicação retornou HTTP 200; busca encontrou um trecho com a resposta de cinco dias.
- Edição pela interface: resposta alterada para dez dias e salva como versão 2. Busca continuou retornando os cinco dias publicados.
- No viewport de celular, revisão da versão 2 exibiu conteúdo completo e botão “Publicar versão 2”. Restauração da versão 1 criou a versão 3. Banco confirmou `latest_version=3`, `published_version=1` e `restored_from=1`; busca continuou usando a publicação original.
- Nenhum erro JavaScript registrado (`browser-errors.json`). Capturas: `review-desktop.png`, `review-mobile.png`, `restored-mobile.png`.
- Auditoria axe: uma violação de contraste no link existente `/ai/agents`, fora do fluxo novo. Os itens incompletos de foco em conteúdo inerte e contraste de conteúdo parcialmente oculto não são classificados como PASS. Evidência em `a11y-mobile.json`.

Os testes automatizados da tabela acima pertencem à implementação do #99; não foram repetidos nesta retomada, que altera apenas evidências. A sessão anterior travava ao aguardar o fechamento dos pipes de subprocesso. Nesta sessão, chamadas diretas do CLI e autenticação temporária em memória permitiram concluir o fluxo; esperas por textos de toast já expirados foram descartadas em favor do estado persistido e das respostas da API.

### Correção de contraste — 12/10/2026

O link “Abrir agentes de IA” passou a usar `text-foreground` e sublinhado permanente, preservando destino, texto e navegação. Verificação autenticada local com conta temporária removida ao terminar: axe 4.12.1, escopo exclusivo `a[href="/ai/agents"]`, zero violações e zero verificações incompletas em claro e escuro. Resultados: `link-contrast-light.json`, `link-contrast-dark.json`; capturas inspecionadas: `link-contrast-mobile.png` (390 × 844) e `link-contrast-desktop.png` (1262 × 568). Isso resolve o contraste registrado anteriormente, sem declarar a página inteira aprovada em acessibilidade. ESLint do componente passou; detector Impeccable não encontrou ocorrências. Nenhuma alteração de comportamento, dependência ou banco.

## Reprodução local

Com a migration 088 aplicada ao container local `supabase_db_semprecrm`, os testes SQL são executados dentro de transações e terminam com ROLLBACK. Prefixar `BEGIN;` em publicação/versões; base já abre a transação. Para backfill, prefixar `BEGIN;` e substituir o marcador `-- APPLY_MIGRATION_088` pelo arquivo de migração antes de enviar ao psql. O backfill reconstrói a forma anterior apenas dentro da transação de teste.

Executar `node scripts/verify-knowledge-publication-concurrency.mjs` somente no banco de desenvolvimento. Ele cria dados sintéticos, usa sessões reais e remove suas próprias contas/usuários ao terminar. Não aponta para produção. Executar também testes, typecheck, lint e build do projeto.

## Homologação, backup e rollback

Antes de produção: verificar backup recuperável do banco, reconciliar eventuais trechos legados incompatíveis, verificar CI/revisão, validar desktop/mobile autenticados, conferir que snapshots e busca usam somente a publicação e obter autorização de deploy. Coordenar migration 088 e aplicação na mesma janela; código antigo continua salvando rascunhos mas não oferece botão de publicação.

Preferir rollback da aplicação mantendo a migration e bloquear edições de conhecimento enquanto a UI de publicação estiver indisponível. Uma reversão completa do schema exige janela própria e autorização: preservar rascunhos no histórico, restaurar o snapshot publicado no item e seus trechos como conteúdo ativo, restaurar funções/grants/index anteriores e remover colunas/referências novas. Nunca promover automaticamente o rascunho pendente ao reverter.

Impacto: até duas coleções de trechos por item (rascunho e publicação), usando os índices existentes. A busca não percorre todo o histórico. Não foi realizado benchmark de carga nem teste de provedor externo.

Git: branch `codex/kb-publication`, baseada em `66d1a17` (merge #98). Implementação e evidências em commits separados; sem deploy de produção.
