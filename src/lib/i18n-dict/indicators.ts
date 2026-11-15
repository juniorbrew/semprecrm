/** pt-BR copy for "Indicadores da empresa" (migration 111): ad spend columns and dialog, "IA" and "Equipe" sections of Reports — EN key -> pt-BR.
 *  Keys and values are more than one word: the translator also maps pt -> en across the page, so a one-word value would leak.
 *  Ad names, people names and handoff reasons are user data: the components mark them data-no-translate. */
export const DICT_INDICATORS: Record<string, string> = {
  // ---- ad spend (origin table + dialog) ----
  'Ad spend': 'Gasto com anúncios',
  'Cost per customer': 'Custo por cliente',
  'Cost per sale': 'Custo por venda',
  'Return on spend': 'Retorno do gasto',
  'Report spend': 'Informar gasto',
  'Spend counts whole months: a period from the 10th to the 20th uses the spend of the entire month.':
    'O gasto conta pelos meses inteiros: um período de 10 a 20 usa o gasto do mês inteiro.',
  'Report ad spend': 'Informar gasto do anúncio',
  'How much was spent on': 'Quanto foi gasto em',
  'Spend month': 'Mês do gasto',
  'Amount spent': 'Valor gasto',
  'The period of the report uses the spend of every month it touches.':
    'O período do relatório usa o gasto de todos os meses que ele toca.',
  'Could not save the spend.': 'Não foi possível salvar o gasto.',
  'Could not load the saved spend.': 'Não foi possível carregar o gasto salvo.',
  'Save spend': 'Salvar gasto',
  'Spend is not shown when filtering by pipeline.': 'O gasto não aparece quando o relatório está filtrado por funil.',

  // ---- AI section ----
  'AI results': 'Resultado da IA',
  'Could not load the AI results.': 'Não foi possível carregar o resultado da IA.',
  'The AI is not turned on for this account.': 'A IA não está ligada nesta conta.',
  'Set up the AI in Settings': 'Configurar a IA em Configurações',
  'Conversations handled by the AI': 'Conversas atendidas pela IA',
  'Handed to a person': 'Passadas para uma pessoa',
  'Most common reason': 'Motivo mais comum',
  'Resolved without a person': 'Resolvidas sem uma pessoa',
  'Messages sent by the AI': 'Mensagens enviadas pela IA',
  'Cost in the period': 'Custo no período',
  'Paid to the AI provider with your own key, not to SempreCRM.':
    'Pago ao provedor da IA com a chave da própria empresa, não ao SempreCRM.',
  'Automatic reply': 'Resposta automática',
  'Reply suggestion': 'Sugestão de resposta',
  'Deal summary': 'Resumo do negócio',
  'Conversation triage': 'Triagem de conversas',
  'Customer memory': 'Memória do cliente',
  'Agent test': 'Teste do agente',

  // ---- team section ----
  'Team performance': 'Desempenho da equipe',
  'Could not load the team performance.': 'Não foi possível carregar o desempenho da equipe.',
  'No team members in this account.': 'Nenhum membro da equipe nesta conta.',
  'Team member': 'Membro da equipe',
  'Without an owner': 'Sem responsável',
  'Conversations handled': 'Conversas atendidas',
  'Conversations resolved': 'Conversas resolvidas',
  'First response time': 'Tempo da primeira resposta',
  'Tasks completed': 'Tarefas concluídas',
  'Open conversations': 'Conversas abertas',
  'Value sold': 'Valor vendido',
  'Win rate': 'Taxa de ganho',
  'Deals are counted for the person responsible for the deal, by the day it was won or lost. Open conversations are the ones open right now.':
    'Os negócios contam para o responsável pelo negócio, pelo dia em que foi ganho ou perdido. Conversas abertas são as que estão abertas agora.',
};
