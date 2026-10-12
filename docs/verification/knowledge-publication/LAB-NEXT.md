# Próxima entrega: histórico de avaliações do Laboratório de IA

Auditoria de 12/10/2026, sem chamada paga nem acesso à produção.

## Preservar

- `src/lib/ai/lab-scenarios.ts`: dez cenários e critérios explícitos.
- `src/components/ai-agents/agent-test-panel.tsx`: mensagem sintética, resposta, conhecimento utilizado, tokens, custo e latência.
- `src/app/api/ai/agents/[id]/test/route.ts`: administrador, plano AI, limite de requisições, filtro por conta e chamada real ao modelo. Não envia WhatsApp; atualmente persiste consumo, sem histórico da resposta.
- Testes focados de interface e API: 17 PASS nesta auditoria. Não equivalem a validação com provedor real.

## Menor evolução completa

1. Migration aditiva para avaliações vinculadas à conta e ao agente, com RLS e snapshot das instruções/configuração e referências das versões publicadas de conhecimento. Preservar dados atuais; preparar backup e rollback antes da homologação.
2. Guardar resultado de teste explicitamente escolhido pelo administrador, cenário, resposta, métricas e avaliação humana. Registrar idempotência para impedir gravações duplicadas; salvar não chama novamente o modelo nem cobra novamente.
3. Histórico dentro da aba de teste existente e comparação de duas avaliações do mesmo tenant, com diferenças de resposta, configuração e métricas. Não criar outro laboratório.
4. Pontuação humana por critérios com fórmula publicada; não apresentar detecção automática de alucinação ou segurança como fato verificado. Nenhuma publicação automática de instruções ou conhecimento.
5. Testar acesso cruzado por ID, papel sem permissão, plano sem AI, agente excluído, retry duplicado, falha ao salvar e preservação do orçamento. Homologar comparação em desktop e celular.

## Limites e dependências

Esta entrega futura exige cuidado com retenção de respostas e conteúdo de teste, pois podem conter dados pessoais. Não ampliar retenção silenciosamente nem armazenar segredos. Teste de modelo depende de credenciais e autorização de custo. Handoff e reserva de horário reais precisam de validações próprias: uma resposta correta no laboratório não prova que essas operações aconteceram. API externa, cobrança e integração Meta permanecem fora deste PR.
