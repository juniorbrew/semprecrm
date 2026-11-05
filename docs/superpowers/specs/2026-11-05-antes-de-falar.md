# Spec: resumo antes de falar com o cliente

Status: aprovado pelo dono do produto (2026-11-05). Item 4.5 do roteiro (ideias do Pipedrive, feitas do nosso jeito).

## Objetivo

O vendedor abre um negócio no Funil para ligar ou mandar mensagem. Ele precisa saber em poucos segundos onde a conversa parou e qual é o próximo passo, sem rolar a gaveta inteira.

## Decisões (2026-11-05)

1. **Onde:** só na gaveta do negócio, no topo do corpo, num cartão chamado "Antes de falar".
2. **Sem IA:** é montado na hora, a partir do que a gaveta já carrega (a conversa do contato e as tarefas abertas do negócio). Não usa consulta nova, não tem custo e funciona em todos os planos. O "Resumir com IA" (4.1) continua no atendimento.
3. **Parado há:** conta os dias desde a última mensagem. Não mexe no banco.

## O cartão

- **Onde parou:**
  - Quem falou por último ("O cliente falou por último" ou "Sua equipe falou por último"), comparando `last_customer_message_at` com `last_agent_message_at`, e há quanto tempo.
  - A frase "N dias sem conversa", em destaque laranja a partir de 7 dias.
  - A situação da conversa e quantas mensagens não lidas há.
  - A última mensagem em até 2 linhas. Clicar abre a conversa.
  - O bloco "Conversa" que existia mais abaixo foi incorporado a este cartão.
- **Próximo passo:**
  - Aparece só em negócio aberto e quando o plano tem o módulo de tarefas.
  - Mostra a primeira tarefa aberta do negócio, pela ordem de prazo, com o selo de prazo. Clicar abre a tarefa.
  - Sem tarefa, mostra "Nenhum próximo passo marcado" e o botão "Marcar próximo passo", para quem pode criar tarefas. O botão abre o campo de nova tarefa da seção Tarefas.
- **Texto do cliente:** a última mensagem e o título da tarefa ficam fora do tradutor automático (`data-no-translate`).

## Onde mexe

- `src/lib/pipelines/deal-dates.ts`: a função `lastContact`, com testes em `deal-dates.test.ts`.
- `src/components/pipelines/deal-details.tsx`: o cartão novo.
- `src/lib/i18n-dict/forecast.ts`: os textos novos, mais o `npm run i18n:split`.

## Fora do escopo

- Resumo com IA.
- Ficha do contato.
- Gaveta da tarefa.
- Dias na etapa, que precisaria de uma mudança no banco.
