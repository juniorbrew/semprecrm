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
  // Failed outbound: Meta's reason renders after this label (wacrm #535).
  'Not delivered': 'Não entregue',
  // Sender label on outbound bubbles + deleted-for-everyone (migration 059).
  'Mobile phone': 'Celular',
  'Sent from the phone or WhatsApp Web': 'Enviada pelo celular ou pelo WhatsApp Web',
  Bot: 'Bot',
  Survey: 'Pesquisa',
  'Deleted by customer': 'Apagada pelo cliente',
  'Deleted from the phone': 'Apagada pelo celular',

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
  // "Importar CSV" file picker (wacrm #512)
  'A "phone" column is required (with country code, e.g. +55 11 99999-0000); "name" is optional.':
    'A coluna "phone" é obrigatória (com código do país, ex.: +55 11 99999-0000); "name" é opcional.',
  'Choose a CSV file': 'Escolher arquivo CSV',
  'Contacts found in the file': 'Contatos encontrados no arquivo',
  'The CSV needs a "phone" column header.':
    'O CSV precisa de uma coluna com o cabeçalho "phone".',
  'No valid phone numbers found in the CSV.':
    'Nenhum telefone válido encontrado no CSV.',
  'Rows without a valid phone were ignored':
    'Linhas sem telefone válido foram ignoradas',

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
  'Uncertain result': 'Resultado incerto',
  'Old failure (not retryable)': 'Falha antiga (não reenviável)',
  'Close this broadcast': 'Encerrar esta campanha',
  'Nothing is sent: the remaining recipients are marked as uncertain for review and the broadcast status is closed.':
    'Nada é enviado: os destinatários restantes ficam como resultado incerto para revisão e a campanha é encerrada.',
  'Created before this version — cannot be resumed':
    'Criada antes desta versão — não pode ser retomada',
  'Marked failed by the previous version, which failed whole batches even when the server may have sent them — so they are never retried.':
    'Marcadas como falha pela versão anterior, que registrava o lote inteiro como falha mesmo quando o servidor pode ter enviado — por isso nunca são reenviadas.',
  'Meta may or may not have received these messages. They are never resent automatically.':
    'A Meta pode ou não ter recebido estas mensagens. Elas nunca são reenviadas automaticamente.',
  'The connection to Meta failed or the send was interrupted, so these messages may or may not have been delivered. They are never resent automatically — check them before contacting these people again.':
    'A conexão com a Meta falhou ou o envio foi interrompido, então estas mensagens podem ou não ter sido entregues. Elas nunca são reenviadas automaticamente — confira antes de contatar essas pessoas de novo.',
  'Rows interrupted more than 10 minutes ago are marked as uncertain and the broadcast status is settled.':
    'Linhas interrompidas há mais de 10 minutos são marcadas como resultado incerto e o status do disparo é atualizado.',
  'Settle interrupted sends': 'Encerrar envios interrompidos',
  'Broadcast status updated.': 'Status do disparo atualizado.',
  'The broadcast stopped before finishing': 'O disparo parou antes de terminar',
  'Recipients with an uncertain result (not resent)':
    'Destinatários com resultado incerto (não reenviados)',

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

  // ---- List filters, keyboard shortcuts (agilidade) ----
  Filters: 'Filtros',
  Tag: 'Etiqueta',
  Both: 'Ambos',
  Official: 'Oficial',
  QR: 'QR',
  'Clear filters': 'Limpar filtros',
  'Remove filter': 'Remover filtro',
  'Keyboard shortcuts': 'Atalhos do teclado',
  'Next conversation': 'Próxima conversa',
  'Previous conversation': 'Conversa anterior',
  'Open conversation': 'Abrir conversa',
  'Take the conversation': 'Assumir a conversa',
  Resolve: 'Resolver',
  'Search conversations': 'Buscar conversas',
  'Leave the field': 'Sair do campo',
  'Resolve and open the next one': 'Resolver e abrir a próxima',
  'Search or run a command': 'Buscar ou executar um comando',
  'Shortcuts pause while you type in a field or a dialog is open.':
    'Os atalhos ficam pausados enquanto você digita em um campo ou há uma janela aberta.',

  Undo: 'Desfazer',

  // ---- Transfer with a reason ----
  'Transfer conversation': 'Transferir conversa',
  To: 'Para',
  'Reason (optional)': 'Motivo (opcional)',
  'Context for the new owner…': 'Contexto para quem vai assumir…',
  Transfer: 'Transferir',
  'Do not include sensitive personal data in the reason.': 'Não inclua dados pessoais sensíveis no motivo.',

  // ---- Voice player, contact card ----
  Play: 'Reproduzir',
  Seek: 'Posição do áudio',
  'Playback speed': 'Velocidade de reprodução',
  'Save as contact': 'Salvar como contato',
  'Contact saved': 'Contato salvo',
  'Contact already saved': 'Este contato já está salvo',
  'Could not save the contact': 'Não foi possível salvar o contato',
};
