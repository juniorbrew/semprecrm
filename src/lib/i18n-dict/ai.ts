/** pt-BR copy for the AI area (migration 058) — EN key → pt-BR. Loaded through ./index.ts. */
// API errors (src/lib/ai/errors.ts, src/lib/ai/settings.ts and the
// /api/ai/* + /api/conversations/:id/ai/suggest routes) must stay
// byte-identical to the strings the routes return.
export const DICT_AI: Record<string, string> = {
  // ---- plan module ------------------------------------------------------
  'AI assistant': 'Assistente de IA',

  // ---- runModelCall / provider errors -----------------------------------
  'The AI assistant is not included in your plan.': 'O assistente de IA não está incluído no seu plano.',
  'AI is not enabled for this account. An admin can turn it on in Settings → Artificial Intelligence.':
    'A IA não está ativada nesta conta. Um administrador pode ativá-la em Configurações → Inteligência Artificial.',
  'No API key is saved for the selected AI provider. An admin can add one in Settings → Artificial Intelligence.':
    'Não há chave de API salva para o provedor de IA escolhido. Um administrador pode adicioná-la em Configurações → Inteligência Artificial.',
  "This month's AI budget has been used up. An admin can raise it in Settings → Artificial Intelligence.":
    'O orçamento de IA deste mês acabou. Um administrador pode aumentá-lo em Configurações → Inteligência Artificial.',
  'The AI provider rejected the API key. An admin needs to check or replace it in Settings → Artificial Intelligence.':
    'O provedor de IA recusou a chave de API. Um administrador precisa conferir ou trocar a chave em Configurações → Inteligência Artificial.',
  'The AI provider account has no credit or quota left. Check the billing with the provider.':
    'A conta no provedor de IA está sem crédito ou cota. Confira o faturamento com o provedor.',
  'The AI provider is limiting requests for this key. Try again in a minute.':
    'O provedor de IA está limitando as chamadas desta chave. Tente de novo em um minuto.',
  'The AI provider took too long to answer. Try again.': 'O provedor de IA demorou demais para responder. Tente de novo.',
  'The configured AI model does not exist or is not available for this key. Pick another model in Settings → Artificial Intelligence.':
    'O modelo de IA configurado não existe ou não está disponível para esta chave. Escolha outro modelo em Configurações → Inteligência Artificial.',
  'The AI provider is unavailable right now. Try again in a few minutes.':
    'O provedor de IA está indisponível no momento. Tente de novo em alguns minutos.',
  'The AI did not return a suggestion. Try again.': 'A IA não retornou uma sugestão. Tente de novo.',
  'The suggestion was cancelled.': 'A sugestão foi cancelada.',
  'Could not generate the suggestion. Try again.': 'Não foi possível gerar a sugestão. Tente de novo.',

  // ---- routes -----------------------------------------------------------
  'Unknown AI provider': 'Provedor de IA desconhecido',
  'This does not look like an API key': 'Isso não parece uma chave de API',
  'Failed to save the AI settings': 'Não foi possível salvar as configurações de IA',
  'This contact was anonymized (LGPD) — AI suggestions are not available.':
    'Este contato foi anonimizado (LGPD) — sugestões de IA não estão disponíveis.',
  'There are no messages in this conversation to reply to yet.':
    'Ainda não há mensagens nesta conversa para responder.',

  // ---- settings validation ----------------------------------------------
  'Invalid model id': 'Identificador de modelo inválido',
  'This model does not belong to the selected provider': 'Este modelo não pertence ao provedor escolhido',
  'Instructions must be text of at most 4000 characters': 'As instruções devem ter no máximo 4000 caracteres',
  'The monthly budget must be a whole number of cents between 0 and 1000000':
    'O orçamento mensal deve ser um valor entre US$ 0,00 e US$ 10.000,00',
  'The number of messages must be between 1 and 50': 'O número de mensagens deve ficar entre 1 e 50',
  "'enabled' must be true or false": "'enabled' deve ser verdadeiro ou falso",
  'Choose a provider before accepting the data-processing notice':
    'Escolha um provedor antes de aceitar o aviso de tratamento de dados',
  'Choose a provider and a model before enabling AI': 'Escolha um provedor e um modelo antes de ativar a IA',
  'Accept the data-processing notice for this provider before enabling AI':
    'Aceite o aviso de tratamento de dados para este provedor antes de ativar a IA',
  'Save a valid API key for this provider before enabling AI':
    'Salve uma chave de API válida para este provedor antes de ativar a IA',

  // ---- Settings → Inteligência Artificial (src/components/settings/ai-settings.tsx)
  'Artificial Intelligence': 'Inteligência Artificial',
  'Reply suggestions with your own AI key': 'Sugestões de resposta com sua própria chave de IA',
  'save an API key': 'salve uma chave de API',
  'choose a model': 'escolha um modelo',
  'accept the data-processing notice': 'aceite o aviso de tratamento de dados',
  'AI settings saved': 'Configurações de IA salvas',
  'API key validated and saved': 'Chave de API validada e salva',
  'The API key works': 'A chave de API está funcionando',
  'Could not save the API key': 'Não foi possível salvar a chave de API',
  'Could not test the API key': 'Não foi possível testar a chave de API',
  'Could not remove the API key': 'Não foi possível remover a chave de API',
  'Remove the saved API key? AI suggestions stop working until a new key is saved.':
    'Remover a chave de API salva? As sugestões de IA param de funcionar até uma nova chave ser salva.',
  'API key removed': 'Chave de API removida',
  'Reply suggestions in the inbox, written by the AI provider you choose with your own API key. Nothing is sent to the customer without an agent reviewing it.':
    'Sugestões de resposta na caixa de entrada, escritas pelo provedor de IA que você escolher, com a sua própria chave de API. Nada é enviado ao cliente sem um atendente revisar.',
  'Only account admins can change the AI settings.':
    'Somente administradores da conta podem alterar as configurações de IA.',
  'Could not load the AI settings': 'Não foi possível carregar as configurações de IA',
  'Suggest replies in the inbox': 'Sugerir respostas na caixa de entrada',
  'Agents get a “Suggest reply” button in the composer. The suggestion fills the text box; the agent edits and sends it as usual.':
    'Os atendentes ganham um botão “Sugerir resposta” no campo de mensagem. A sugestão preenche a caixa de texto; o atendente edita e envia normalmente.',
  'Enable AI suggestions for this account': 'Ativar sugestões de IA nesta conta',
  'Remember to save after changing it.': 'Lembre-se de salvar depois de alterar.',
  'To enable:': 'Para ativar:',
  'Provider and API key': 'Provedor e chave de API',
  'Use your own key: usage is billed by the provider to your account there. The key is stored encrypted and is never shown again — only its last 4 characters.':
    'Use a sua própria chave: o uso é cobrado pelo provedor na sua conta de lá. A chave fica criptografada e nunca é exibida de novo — só os 4 últimos caracteres.',
  'AI provider': 'Provedor de IA',
  'key saved': 'chave salva',
  'Validated on': 'Validada em',
  'Not validated yet': 'Ainda não validada',
  'Test key': 'Testar chave',
  Replace: 'Trocar',
  'API key': 'Chave de API',
  'Validate and save': 'Validar e salvar',
  'Get a key from the provider': 'Gerar uma chave no provedor',
  'Model and assistant': 'Modelo e assistente',
  'A small, fast model is enough for reply suggestions and costs a fraction of a cent per suggestion.':
    'Um modelo pequeno e rápido basta para sugerir respostas e custa uma fração de centavo por sugestão.',
  Model: 'Modelo',
  'Suggested:': 'Sugerido:',
  'You can type any other model id your key has access to.':
    'Você pode digitar o identificador de qualquer outro modelo a que sua chave tenha acesso.',
  'Monthly budget (US$)': 'Orçamento mensal (US$)',
  'Messages of context': 'Mensagens de contexto',
  "Suggestions stop when this month's estimated spend reaches the budget (São Paulo calendar month).":
    'As sugestões param quando o gasto estimado do mês atinge o orçamento (mês do calendário de São Paulo).',
  'Instructions for the assistant': 'Instruções para o assistente',
  'E.g.: Friendly and short tone. We are a bakery in Campinas, open Mon–Sat 7am–7pm. Delivery only in the city. Never quote prices — say an agent will confirm.':
    'Ex.: Tom simpático e curto. Somos uma padaria em Campinas, aberta de seg. a sáb., das 7h às 19h. Entregamos só na cidade. Nunca informe preços — diga que um atendente vai confirmar.',
  'Tone, what the company does, what the assistant may and may not say.':
    'Tom de voz, o que a empresa faz, o que o assistente pode e não pode dizer.',
  'Data processing (LGPD)': 'Tratamento de dados (LGPD)',
  "When an agent asks for a suggestion, the latest messages of that conversation, the contact's name, your company name and the instructions above are sent to the chosen provider, which may process them outside Brazil (international data transfer, LGPD art. 33). The CRM does not store the suggestion text — only usage counters (tokens and cost). Make sure your privacy notice covers this use and that you have a legal basis for it.":
    'Quando um atendente pede uma sugestão, as mensagens mais recentes daquela conversa, o nome do contato, o nome da sua empresa e as instruções acima são enviados ao provedor escolhido, que pode tratá-los fora do Brasil (transferência internacional de dados, art. 33 da LGPD). O CRM não guarda o texto das sugestões — só contadores de uso (tokens e custo). Garanta que o seu aviso de privacidade cubra esse uso e que haja base legal para ele.',
  'I have read the notice and authorise sending conversation data to':
    'Li o aviso e autorizo o envio de dados das conversas para',
  'Accepted by': 'Aceito por',
  'an admin': 'um administrador',
  'Usage this month': 'Uso neste mês',
  "Estimated from the provider's list prices; the provider's invoice is the source of truth.":
    'Estimativa pelos preços de tabela do provedor; a fatura do provedor é que vale.',
  Suggestions: 'Sugestões',
  Errors: 'Erros',
  'Tokens (in / out)': 'Tokens (entrada / saída)',
  'Estimated cost': 'Custo estimado',
  'Budget used': 'Orçamento utilizado',
};
