/** pt-BR copy for the sales forecast (migration 106) — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_FORECAST: Record<string, string> = {
  // ---- Funil: toggle, stage chance (settings), tooltip ----
  'Forecast view': 'Previsão',
  '% chance to close': '% de chance de fechar',
  'Back to automatic': 'Voltar ao automático',
  'Automatic chance': 'Chance automática',
  'Enter a whole number from 0 to 100, or go back to automatic.': 'Digite um número inteiro de 0 a 100, ou volte ao automático.',
  "Expected revenue: each open deal's value × the chance of its stage. Set the chance of each stage in the pipeline settings; stages left empty use the automatic chance (first stage ≈ 10%, up to 90%, last stage = 100%). Lost deals are excluded.":
    'Receita esperada: o valor de cada negócio aberto × a chance da etapa dele. Defina a chance de cada etapa nas configurações do funil; etapas sem valor usam a chance automática (1ª etapa ≈ 10%, subindo até 90%, última etapa = 100%). Negócios perdidos ficam de fora.',
  // ---- Forecast view ----
  'Sales forecast': 'Previsão de vendas',
  'Won so far plus open deals weighted by the chance of their stage, by expected close month.':
    'O que já foi ganho mais os negócios abertos pesados pela chance da etapa, por mês previsto de fechamento.',
  'Loading the forecast…': 'Carregando a previsão…',
  'Could not load the forecast.': 'Não foi possível carregar a previsão.',
  'Nothing to forecast yet': 'Ainda não há o que prever',
  'Open deals with an expected close date and deals won this month show up here.':
    'Negócios abertos com data prevista de fechamento e os ganhos deste mês aparecem aqui.',
  'Month forecast': 'Previsão do mês',
  'Open value without a date': 'Valor aberto sem data',
  'Fill in the expected close date so these deals enter the forecast.':
    'Preencha a data prevista de fechamento para estes negócios entrarem na previsão.',
  'Loading deals…': 'Carregando negócios…',
  'Could not load the deals.': 'Não foi possível carregar os negócios.',
  'No deals in this column.': 'Nenhum negócio nesta coluna.',
  'Deals behind the forecast numbers': 'Negócios por trás dos números da previsão',
  // ---- Goals card ----
  'of the goal': 'da meta',
};
