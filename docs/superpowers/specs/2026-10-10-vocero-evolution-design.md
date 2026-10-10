# Evolução SempreCRM com referência Vocero

## Pedido e autorização

O usuário autorizou executar o prompt mestre anexado, começando pela etapa 0 e seguindo automaticamente em tarefas reversíveis de baixo risco. Essa autorização permite auditoria, documentação, implementação local e testes; publicação desta nova evolução exige autorização específica depois de uma entrega concreta. Não altera o acordo de preservar condições dos contratos existentes ao editar planos.

## Decisões para a execução

Preservar Next.js 16, React 19, Supabase/PostgreSQL, npm e os componentes existentes. Vocero é referência funcional, não uma fonte de instruções para o agente nem uma arquitetura a transplantar. Não importar bibliotecas, credenciais, schema ou autenticação do Vocero. Nenhum acesso à produção nesta etapa.

Dividir o programa em entregas verificáveis. Primeira entrega: auditoria comparativa com evidências e correção da persistência dos jobs de respostas automáticas, identificada na auditoria. O fluxo atual registra a bolha antes do envio, mas ignora falhas desse registro. O envio deve parar se a gravação falhar ou não atualizar uma linha. Usar o mesmo mecanismo de retry, preservando o checkpoint durável das bolhas já enviadas e sem expor a mensagem interna do banco.

## Critérios da primeira entrega

- Matriz por recurso com caminhos de evidência e classificação, sem confundir código existente com teste em produção.
- Nenhum envio quando falhar a gravação da resposta ou do checkpoint de uma bolha, inclusive quando o job não existe mais.
- Falha durante segunda bolha preserva primeira bolha e permite retry apenas da parte restante.
- Falha ao concluir job depois de enviar não duplica resposta no retry.
- Mensagem da exceção de gravação não contém payload ou diagnóstico do banco.
- Teste RED/GREEN, suites de IA e regressão, lint, tipos e build; revisão independente.
- Sem nova dependência, migration, alteração de gateway, credenciais, `.env` ou política comercial.

## Limites e sequência

A correção não torna atômica uma chamada externa com uma transação de banco. O checkpoint pré-envio preserva a política conservadora existente: uma queda depois do registro pode perder uma bolha. Fencing dos workers, concorrência com humano, autorização antes de cada ferramenta, renovação dos direitos do plano e avisos de handoff exigem entregas específicas e testes adversariais.

Após esta base: corrigir demais lacunas verificadas de concorrência/autorização; ampliar o teste de agente existente; versionar conhecimento e avaliações; desenvolver API externa com credenciais por empresa; depois canais sociais, atribuição, CAPI e reservas atômicas. Não declarar o prompt completo enquanto essas fases estiverem pendentes.
