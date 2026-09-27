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

  // ---- Broadcasts: personalize step — header media (wacrm #298) ----
  'Header media': 'Mídia do cabeçalho',
  'Media URL': 'URL da mídia',
  'Public URL of the media sent as the message header. Used for every recipient in this broadcast.':
    'URL pública da mídia enviada como cabeçalho da mensagem. Vale para todos os destinatários deste disparo.',
  'Header preview': 'Pré-visualização do cabeçalho',
  'A media URL is required to send this template.':
    'Informe a URL da mídia para enviar este modelo.',
  'Enter a valid http(s) URL.': 'Informe uma URL http(s) válida.',

  // ---- Broadcasts: detail page — resume / retry (wacrm #472) ----
  'This campaign is still sending': 'Este disparo ainda está enviando',
  'This campaign stopped part-way': 'Este disparo parou no meio',
  'Some recipients need another attempt':
    'Alguns destinatários precisam de nova tentativa',
  'Another tab or a background pass is delivering it. Resume and retry unlock when it finishes or stops responding for 10 minutes.':
    'Outra aba ou um envio em segundo plano está entregando. Retomar e reenviar liberam quando ele terminar ou ficar 10 minutos sem responder.',
  'Recipients never sent': 'Destinatários não enviados',
  'The tab running this campaign was closed before it finished. Resuming completes it from the server.':
    'A aba que enviava este disparo foi fechada antes de terminar. Retomar conclui o envio pelo servidor.',
  'Recipients that failed': 'Destinatários com falha',
  'Retrying sends them again from the server.':
    'Reenviar tenta de novo pelo servidor.',
  'Resume sending': 'Retomar envio',
  'Retry failed': 'Reenviar falhas',
  'Could not resume': 'Não foi possível retomar',
  'Sending in the background': 'Enviando em segundo plano',
  'Left for another run': 'Restam para outra rodada',

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
