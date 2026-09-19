/** pt-BR copy for the "inbox" area (inbox, chat, broadcasts) — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_INBOX: Record<string, string> = {
  // ---- Message bubble: media + delivery states ----
  unavailable: 'indisponível',
  'Location shared': 'Localização compartilhada',
  Customer: 'Cliente',
  '[Audio]': '[Áudio]',
  '[Location]': '[Localização]',
  Photo: 'Foto',
  'Voice message': 'Mensagem de voz',

  // ---- Message actions (hover toolbar) ----
  'React with': 'Reagir com',

  // ---- Thread header / status ----
  'Failed to update status': 'Não foi possível atualizar o status',

  // ---- Template picker ----
  'Variable value': 'Valor da variável',
  'URL button': 'Botão de URL',
  'Final URL:': 'URL final:',

  // ---- Private notes: "Nota interna" (overrides i18n-extra) ----
  'Add team note': 'Adicionar nota interna',
  'Team note': 'Nota interna',
  'Write a note for the team…': 'Escreva uma nota interna…',

  // ---- Team chat ----
  'Send (Enter)': 'Enviar (Enter)',
  // "Pesquisar", not "Buscar" (overrides i18n-extra; area dicts load after it)
  'Search people': 'Pesquisar pessoas',
  'Search people and groups': 'Pesquisar pessoas e grupos',

  // ---- Broadcasts: audience step ----
  'Send to every contact in your database':
    'Enviar para todos os contatos da sua base',
  'Import CSV': 'Importar CSV',
  'Import a list of phone numbers': 'Importe uma lista de números de telefone',

  // ---- Role gates (GatedButton tooltips) ----
  "Read-only — your role can't create broadcasts":
    'Somente leitura — seu perfil não pode criar disparos',

  // ---- Supabase Storage / network errors surfaced by upload toasts ----
  'Could not resolve your account.': 'Não foi possível identificar sua conta.',
  'The resource already exists': 'Este arquivo já existe. Tente enviar novamente.',
  'Payload too large': 'O arquivo é grande demais.',
  'The object exceeded the maximum allowed size':
    'O arquivo excede o tamanho máximo permitido.',
  'new row violates row-level security policy':
    'Você não tem permissão para esta ação.',
  'Bucket not found': 'Armazenamento não encontrado. Fale com o administrador.',
  'Failed to fetch': 'Falha de conexão. Verifique sua internet e tente novamente.',
  'Load failed': 'Falha de conexão. Verifique sua internet e tente novamente.',
  'NetworkError when attempting to fetch resource.':
    'Falha de conexão. Verifique sua internet e tente novamente.',
};
