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
};
