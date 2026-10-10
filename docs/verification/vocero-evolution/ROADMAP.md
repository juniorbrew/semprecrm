# Roteiro incremental da evolução

O prompt mestre define um programa de trabalho, não uma alteração única. Cada entrega deve permanecer revisável, testável e publicável separadamente. Ordem definida pela auditoria; nenhuma funcionalidade existente será recriada.

| Entrega                                     | Escopo                                                                                                      | Critério verificável                                                                              | Dependência/decisão                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0 — Auditoria + checkpoint                  | Matriz, riscos e falha fechado da persistência IA                                                           | RED/GREEN, regressão, revisão, build                                                              | Em execução nesta branch; sem produção                     |
| 1 — Segurança da resposta e das ferramentas | Direitos rechecados, pausa/opt-out/encerramento, módulo pipelines, fencing                                  | Corridas determinísticas e teste banco real com dois workers/tenants; nenhuma ação após revogação | Desenho de concorrência antes de migration                 |
| 2 — Dependências                            | Mapear exposição e atualizar somente pacotes afetados compatíveis                                           | Advisories tratados, lock revisado, regressão/build                                               | Sem atualização forçada ou troca de stack                  |
| 3 — Primeira evolução do laboratório        | Dez cenários selecionáveis no teste de agente existente, critérios esperados, limites explícitos            | Endpoint atual isolado; nenhuma mensagem externa/mutação comercial; UI desktop/mobile             | Sem execução paga automática; reutiliza orçamento atual    |
| 4 — Conhecimento publicado                  | Categorias e versões imutáveis, revisão, publicação e rollback                                              | RLS, mudanças atômicas, versões antigas recuperáveis e prompts somente com versão publicada       | Migration aditiva, plano de backup/rollback                |
| 5 — Histórico e avaliação do laboratório    | Snapshots de agente/KB, runs/casos, comparação, tokens/custo/latência                                       | Execução isolada, cancelamento, falhas explícitas, denominadores e scores explicados              | Definir avaliação; juiz pago exige decisão de custo        |
| 6 — API externa                             | Credenciais por tenant com scopes, hash, rotação/revogação, contexto, ações, eventos assinados, retries/DLQ | Token A não lê/envia em B; revogado negado; idempotência; SSRF; sem resposta dupla                | Contrato e backend isolados; não copiar BOT_API_KEY global |
| 7 — Agenda inteligente                      | Catálogo/serviços, disponibilidade, oferta válida, reserva atômica, cancelamento/reagendamento              | Duas reservas concorrentes: uma confirmação; UTC/fuso tenant; confirmar só após commit            | Preservar agenda livre atual; novo contrato de reserva     |
| 8 — Omnichannel                             | Instagram/Messenger, identidade e capacidades próprias, inbox atual                                         | Assinatura/tenant/roteamento, mídias, erros/janelas, fluxo real autorizado                        | Aplicativo Meta, permissões e canais de homologação        |
| 9 — Atribuição e CAPI                       | Referral real, histórico comercial, event_id estável, outbox por tenant                                     | Repetição não duplica; falha Meta não bloqueia negócio; retry recupera; consentimento             | Documentação oficial vigente e credenciais autorizadas     |
| 10 — Indicadores e monetização              | Dimensões de anúncios/IA, fórmulas, módulos novos, franquia e uso idempotente                               | Agregados reconciliados; retries não cobram duas vezes; backend valida direitos                   | Decisão comercial para novos preços/franquias/gateway      |

## Contrato para cada entrega

1. Ler comportamento, callers, migrations e testes existentes.
2. Descrever uma lacuna concreta com evidência e escolher a menor alteração segura.
3. Registrar contrato, escopo, falhas e forma de validação.
4. Escrever teste que falha antes da correção quando houver lógica nova.
5. Implementar sem alterar credenciais e sem apagar dados.
6. Validar unidade/integração/isolamento proporcionais; testar navegador quando houver UI.
7. Revisão independente de segurança/código; registrar PASS/PARTIAL/BLOCKED/FAIL com limites reais.
8. Commit próprio. Homologar e preparar publicação concreta; pedir autorização específica antes de produção.

## Homologação e publicação

Esta entrega de checkpoint não exige migration. Antes de publicá-la: CI verde, conferir a revisão, SHA de produção e concorrência com outras entregas, backup recuperável do artefato, janela que respeite os jobs em andamento, atualizar somente aplicação e verificar serviços. Rollback por código/artefato anterior; nenhum restore de banco necessário.

Etapas com dados novos exigem migration aditiva, compatibilidade com código anterior, teste de rollback e backup verificável. Etapas com serviços externos exigem sandbox/conta de teste autorizada; mocks permanecem testes de contrato, não evidência de envio real.
