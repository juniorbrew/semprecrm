/** pt-BR copy for "Origem dos clientes" (migration 109): contact panel, deal drawer, contacts filter, Reports section — EN key -> pt-BR.
 *  Keys and values are always more than one word: the translator also maps pt -> en across the page, so a one-word value would leak.
 *  Ad titles, campaign names and hosts are user data: the components mark them data-no-translate. */
export const DICT_ORIGINS: Record<string, string> = {
  // ---- "Came from" line (inbox panel, contact page) ----
  'Came from': 'Veio de',
  'First contact': 'Primeiro contato',
  'Last contact': 'Último contato',
  'Direct or not identified': 'Direto ou não identificado',
  'Ad called': 'Anúncio chamado',
  'Ad without a title': 'Anúncio sem título',
  'Campaign called': 'Campanha chamada',
  'Visit coming from': 'Visita vinda de',
  'See the ad': 'Ver o anúncio',
  'Could not load the origin.': 'Não foi possível carregar a origem.',

  // ---- deal drawer ----
  'Deal origin': 'Origem do negócio',
  'Change origin': 'Trocar a origem',
  'Changed by hand': 'Trocada à mão',
  'Origin changed.': 'Origem trocada.',
  'Could not change the origin.': 'Não foi possível trocar a origem.',

  // ---- contacts list filter ----
  'All origins': 'Todas as origens',
  'Filter by origin channel': 'Filtrar pelo canal de origem',
  'Ad or campaign name': 'Nome do anúncio ou da campanha',

  // ---- Reports -> Customer origins ----
  'Customer origins': 'Origem dos clientes',
  'Filter by pipeline': 'Filtrar pelo funil',
  'All pipelines': 'Todos os funis',
  'Could not load the customer origins.': 'Não foi possível carregar a origem dos clientes.',
  'No customers or deals in this period.': 'Nenhum cliente ou negócio neste período.',
  'Origins that sold the most': 'Origens que mais venderam',
  'Customer origin': 'Origem do cliente',
  'New customers': 'Clientes novos',
  'Deals created': 'Negócios criados',
  'Deals won': 'Negócios ganhos',
  'Conversion rate': 'Taxa de conversão',
  'Average ticket': 'Ticket médio',
};
