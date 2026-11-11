/** pt-BR copy for "Avisar a Meta" (migration 110): Configurações -> Integrações card — EN key -> pt-BR.
 *  Keys and values are always more than one word: the translator also maps pt -> en across the page, so a one-word value would leak.
 *  Deal titles and the server error / test messages (already pt-BR) are user data or server text: the card marks them data-no-translate. */
export const DICT_META_CAPI: Record<string, string> = {
  'Tell Meta (ads)': 'Avisar a Meta (anúncios)',
  'Tell Meta which customers from your ads became leads and sales, so it can optimise your ads for sales instead of just conversations.':
    'Avise a Meta quais clientes dos seus anúncios viraram lead e venda, para ela otimizar os anúncios para vendas e não só para conversas.',
  'Could not load the Meta settings.': 'Não foi possível carregar as configurações da Meta.',
  'Try again': 'Tentar de novo',
  'Sending paused.': 'Envio pausado.',
  'Meta says the access key is invalid or expired. Paste a new key below to resume.':
    'A Meta diz que a chave de acesso é inválida ou venceu. Cole uma chave nova abaixo para retomar.',
  'Dataset ID': 'ID do conjunto de dados',
  'Use numbers only.': 'Use só números.',
  'Access key': 'Chave de acesso',
  'Paste the key from Meta': 'Cole a chave da Meta',
  'Saved. Paste a new key only to replace it.': 'Salva. Cole uma chave nova só para trocar.',
  'Stored encrypted. It never comes back to the browser.': 'Guardada criptografada. Ela nunca volta para o navegador.',
  'Paste the whole key, without spaces.': 'Cole a chave inteira, sem espaços.',
  'Test code (optional)': 'Código de teste (opcional)',
  'Only letters, numbers, - and _.': 'Só letras, números, - e _.',
  'Save settings': 'Salvar configurações',
  'Send test event': 'Enviar evento de teste',
  'Meta settings saved.': 'Configurações da Meta salvas.',
  'Could not save.': 'Não foi possível salvar.',
  'The event is back in the queue.': 'O evento voltou para a fila.',
  'Could not retry.': 'Não foi possível tentar de novo.',
  'Integration on': 'Integração ligada',
  'Turn off to stop sending without losing the settings.': 'Desligue para parar de enviar sem perder as configurações.',
  'Send when a lead is created': 'Enviar quando um lead é criado',
  'Send when a deal is won': 'Enviar quando um negócio é ganho',
  'How to set it up': 'Como configurar',
  'In Meta Events Manager, open your dataset and copy its ID.': 'No Gerenciador de Eventos da Meta, abra o seu conjunto de dados e copie o ID.',
  'In Settings, Conversions API, generate an access key and paste it here.': 'Em Configurações, API de Conversões, gere uma chave de acesso e cole aqui.',
  'Optional: copy the test code from Test events, send a test event and check it there.':
    'Opcional: copie o código de teste em Testar eventos, envie um evento de teste e confira lá.',
  'Only customers who came from a Meta ad are sent. Your company is responsible for mentioning this in its privacy policy.':
    'Só são enviados os clientes que vieram de anúncio da Meta. Sua empresa é responsável por informar isso na política de privacidade.',
  'Something went wrong with the test.': 'Algo deu errado com o teste.',
  'Date and time': 'Data e hora',
  'Event type': 'Tipo de evento',
  'Related deal': 'Negócio relacionado',
  'Deal value': 'Valor do negócio',
  'Send status': 'Situação do envio',
  'Latest sends': 'Últimos envios',
  'Nothing sent yet. Events appear here when a deal from a Meta ad is created or won.':
    'Nada enviado ainda. Os eventos aparecem aqui quando um negócio vindo de anúncio da Meta é criado ou ganho.',
  'Lead created': 'Lead criado',
  'Deal won': 'Negócio ganho',
  'Sent to Meta': 'Enviado à Meta',
  'Waiting to send': 'Aguardando envio',
  'Failed to send': 'Falhou ao enviar',
  'Cancelled event': 'Evento cancelado',
}
