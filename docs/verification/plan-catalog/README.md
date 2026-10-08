# Catálogo de planos — validação e publicação

## Entrega

Catálogo dos quatro planos existentes com preço mensal anunciado em reais, módulos e limites editáveis. Cada alteração cria uma versão imutável. Empresas já cadastradas mantêm suas condições; novas contratações usam a versão atual. A empresa pode adotar explicitamente novas condições, com prévia das diferenças, aviso de capacidade e preservação das sobrescritas individuais. Não implementa cobrança.

## Evidências e estado em 08/10/2026

- Suíte completa: **3.731 testes passaram**, 271 arquivos; um teste de integração é opt-in e fica pulado na execução normal.
- Após ajustes nos testes de integração/leitura: 71 testes afetados passaram; TypeScript passou.
- Compilação final com ambiente isolado passou; TypeScript e formatação passaram. Permanecem os avisos preexistentes de middleware/Edge Runtime.
- ESLint dos arquivos TypeScript alterados: zero erros, duas advertências preexistentes de navegação em `use-auth.tsx`. Formatação dos arquivos novos e ajustados verificada.
- Revisão independente do conjunto: nenhum defeito acionável restante. Corrigidos dois achados anteriores com regressões RED → GREEN: leitura inicial indisponível deve exibir recuperação; prévia de adoção deve avisar excesso de uso incluindo convites.
- [Resultados do navegador](results.json): 17 grupos de fluxos reais passaram na rodada de 08/10/2026 às 14:12 (Bahia). Incluem dupla autenticação, isolamento, filtros por datas, editor, conflitos, contratos antigos/novos, adoção explícita, aviso de excesso antes de salvar, capacidade real e histórico seguro. Capturas e auditorias acompanham este diretório; editor sem excesso horizontal e sem violações de acessibilidade nos temas claro/escuro em 1440 e 375 pixels.
- Duas suítes SQL (`supabase/tests/plan_catalog.sql`, `plan_account_versions.sql`) passaram no clone local sintético. Sequência 080 → 081 → aplicação → 082 validada localmente; backfill preservou valores anteriores e timestamps.
- Integração real do motor de automações passou novamente com gatilho suportado, comprovando ausência de tarefas/logs quando o módulo está bloqueado e uma tarefa com sobrescrita explícita. Total: 3.731 testes regulares e um teste de integração real aprovados em execuções separadas. Após formatação, os 65 testes afetados também passaram.

**Estado:** validação local concluída. A falha de inicialização do Docker foi resolvida após o usuário reabri-lo. O Windows reservou a antiga porta de teste; somente o stack sintético foi reiniciado com backup preservado nas portas 58021/58022/58023. Os helpers aceitam exclusivamente as duas URLs locais de validação, conferidas por revisão independente complementar. Produção não foi alterada. Publicação aguarda autorização.

## Repetição local

Utilizar o runtime isolado já existente. Não alterar `.env`, usar produção, copiar credenciais ou imprimir a saída de status com chaves. `SUPABASE_CLI` aponta ao executável instalado; `LEADS_TEST_WORKDIR` ao diretório isolado de validação. O helper aceita exclusivamente `http://127.0.0.1:57021` ou `http://127.0.0.1:58021`.

```powershell
npm test
npx tsc --noEmit
$env:PLAN_CATALOG_INTEGRATION = '1'
npx vitest run src/lib/automations/engine.catalog.integration.test.ts
Remove-Item Env:PLAN_CATALOG_INTEGRATION
node scripts/platform-leads-runtime.mjs build
node scripts/platform-leads-runtime.mjs start
```

Em outra sessão com as mesmas variáveis e `AGENT_BROWSER_BIN` configurado, executar `scripts/verify-platform-overview.mjs`, definindo `PLATFORM_VERIFICATION_DIR=docs/verification/plan-catalog`. O roteiro usa sessão própria e identidades sintéticas, limpa seus dados e restaura o catálogo por nova versão, sem apagar versões imutáveis. Executar as suítes SQL no clone sintético com catálogo inicial, pois o roteiro do navegador incrementa revisões.

## Sequência de publicação após validação e autorização

1. Conferir inventário de migrações aplicadas e compatibilidade com o estado até 080. Fazer backup verificável do banco em armazenamento seguro e independente de credenciais pessoais. Não aplicar arquivos já registrados nem executar migrações destrutivas.
2. Pausar edições administrativas de empresas durante a troca: o escritor antigo não conhece a atribuição de versões. Conferir o head revisado, CI e artefato da aplicação.
3. Aplicar **081**: tabelas, sementes, backfill, permissões, RPCs e atribuição no cadastro. Comparar quantidade de contas e campos preservados; confirmar versão válida atribuída a cada empresa.
4. Publicar a aplicação compatível com versões; conferir saúde, leitura pública de preços, login CRM e segunda barreira administrativa. Testar edição/adoção em conta de validação autorizada.
5. Somente com a aplicação saudável, aplicar **082**, que revoga o escritor legado. Confirmar recusa do RPC antigo e funcionamento do novo; reabrir as edições administrativas.
6. Registrar release, migrações, verificações públicas e autenticadas realmente executadas. Testes autenticados deste documento são locais; não equivalem a validação em produção.

## Recuperação

Preferir correção adiante ou artefato anterior **compatível com versões**. Manter edições suspensas enquanto se recupera a aplicação. Preservar tabelas, histórico, atribuições e sobrescritas; não excluir versões nem reabrir o escritor legado automaticamente. Após editar/adotar novas condições, voltar a uma aplicação que calcula permissões pelo catálogo estático pode mudar acessos indevidamente. A recuperação deve continuar respeitando as versões concedidas. Restauração completa de backup exige avaliação e autorização específicas por envolver perda de alterações posteriores.
