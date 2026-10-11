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
| Navegador desktop/mobile | BLOCKED — agent-browser abriu login mas o comando não encerrou; ETIMEDOUT. Não houve validação visual nem captura aprovada |
| Build Next 16.4.0 | PASS |
| VPS/integração externa de IA | Não executado |

**Entrega: PARTIAL para homologação**, pela validação visual pendente. O fluxo de interface está implementado e coberto por testes de componente; isso não substitui o teste real no navegador.

## Reprodução local

Com a migration 088 aplicada ao container local `supabase_db_semprecrm`, os testes SQL são executados dentro de transações e terminam com ROLLBACK. Prefixar `BEGIN;` em publicação/versões; base já abre a transação. Para backfill, prefixar `BEGIN;` e substituir o marcador `-- APPLY_MIGRATION_088` pelo arquivo de migração antes de enviar ao psql. O backfill reconstrói a forma anterior apenas dentro da transação de teste.

Executar `node scripts/verify-knowledge-publication-concurrency.mjs` somente no banco de desenvolvimento. Ele cria dados sintéticos, usa sessões reais e remove suas próprias contas/usuários ao terminar. Não aponta para produção. Executar também testes, typecheck, lint e build do projeto.

## Homologação, backup e rollback

Antes de produção: verificar backup recuperável do banco, reconciliar eventuais trechos legados incompatíveis, verificar CI/revisão, validar desktop/mobile autenticados, conferir que snapshots e busca usam somente a publicação e obter autorização de deploy. Coordenar migration 088 e aplicação na mesma janela; código antigo continua salvando rascunhos mas não oferece botão de publicação.

Preferir rollback da aplicação mantendo a migration e bloquear edições de conhecimento enquanto a UI de publicação estiver indisponível. Uma reversão completa do schema exige janela própria e autorização: preservar rascunhos no histórico, restaurar o snapshot publicado no item e seus trechos como conteúdo ativo, restaurar funções/grants/index anteriores e remover colunas/referências novas. Nunca promover automaticamente o rascunho pendente ao reverter.

Impacto: até duas coleções de trechos por item (rascunho e publicação), usando os índices existentes. A busca não percorre todo o histórico. Não foi realizado benchmark de carga nem teste de provedor externo.

Git: branch `codex/kb-publication`, baseada em `66d1a17` (merge #98). Implementação e evidências em commits separados; sem deploy de produção.
