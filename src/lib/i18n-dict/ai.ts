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

  // ---- knowledge base (migration 063) ------------------------------------
  'Knowledge base': 'Base de conhecimento',
  "Questions and answers, texts and files the assistant looks up before suggesting a reply — prices, opening hours, policies. Only the snippets that match the customer's latest messages are sent to the AI provider.":
    'Perguntas e respostas, textos e arquivos que o assistente consulta antes de sugerir uma resposta — preços, horários, políticas. Só os trechos que combinam com as últimas mensagens do cliente são enviados ao provedor de IA.',
  'Add question': 'Adicionar pergunta',
  'Add text': 'Adicionar texto',
  'Upload file': 'Enviar arquivo',
  'Reading file…': 'Lendo arquivo…',
  'Files: .txt, .md, .csv or .pdf with text (scanned PDFs are not read), up to 5 MB.':
    'Arquivos: .txt, .md, .csv ou .pdf com texto (PDFs digitalizados não são lidos), até 5 MB.',
  'Could not load the knowledge base': 'Não foi possível carregar a base de conhecimento',
  'The knowledge base is empty. Add your most frequent questions first.':
    'A base de conhecimento está vazia. Comece pelas perguntas mais frequentes.',
  FAQ: 'Pergunta',
  characters: 'caracteres',
  'Use in suggestions': 'Usar nas sugestões',
  'Delete this item from the knowledge base?': 'Excluir este item da base de conhecimento?',
  'Item deleted': 'Item excluído',
  'Knowledge base updated': 'Base de conhecimento atualizada',
  'File added to the knowledge base': 'Arquivo adicionado à base de conhecimento',
  'Test the search': 'Testar busca',
  'Type a question as a customer would, e.g.: how much is delivery?':
    'Digite uma pergunta como o cliente faria, ex.: quanto custa a entrega?',
  'Shows the snippets that would go to the AI with this question. Nothing is sent to the provider here.':
    'Mostra os trechos que iriam para a IA com esta pergunta. Nada é enviado ao provedor aqui.',
  'Nothing found — the suggestion would rely only on the instructions and the conversation.':
    'Nada encontrado — a sugestão usaria só as instruções e a conversa.',
  'Edit knowledge item': 'Editar item da base',
  'New question': 'Nova pergunta',
  'New text': 'Novo texto',
  'Write the question the way customers ask it, and the answer the assistant should use.':
    'Escreva a pergunta do jeito que os clientes perguntam e a resposta que o assistente deve usar.',
  'Short, factual texts work best: one subject per item.': 'Textos curtos e objetivos funcionam melhor: um assunto por item.',
  Question: 'Pergunta',
  Answer: 'Resposta',
  Content: 'Conteúdo',
  'E.g.: Do you deliver on Sundays?': 'Ex.: Vocês entregam aos domingos?',
  'E.g.: Delivery policy': 'Ex.: Política de entrega',
  // API errors (src/lib/ai/knowledge.ts, knowledge-extract.ts, /api/ai/knowledge*)
  'Unknown knowledge item type': 'Tipo de item desconhecido',
  'The title is required (up to 200 characters).': 'O título é obrigatório (até 200 caracteres).',
  'The question is required (up to 1000 characters).': 'A pergunta é obrigatória (até 1000 caracteres).',
  'The content is required (up to 20,000 characters).': 'O conteúdo é obrigatório (até 20.000 caracteres).',
  'The text is too long (up to 200,000 characters).': 'O texto é longo demais (até 200.000 caracteres).',
  'The knowledge base is full (up to 500 items). Remove items you no longer need.':
    'A base de conhecimento está cheia (até 500 itens). Remova itens que não usa mais.',
  'Knowledge item not found': 'Item da base de conhecimento não encontrado',
  'Type a question to search.': 'Digite uma pergunta para buscar.',
  'Failed to save the knowledge item': 'Não foi possível salvar o item da base de conhecimento',
  'Unsupported file type. Send a .txt, .md, .csv or .pdf file.':
    'Tipo de arquivo não suportado. Envie um arquivo .txt, .md, .csv ou .pdf.',
  'The file is too large (maximum 5 MB).': 'O arquivo é grande demais (máximo 5 MB).',
  'The file has no text.': 'O arquivo não tem texto.',
  'The file has too much text (maximum 200,000 characters). Split it into smaller files.':
    'O arquivo tem texto demais (máximo 200.000 caracteres). Divida em arquivos menores.',
  'This PDF has no selectable text (it looks scanned). Send a PDF with text, or paste the content as a text item.':
    'Este PDF não tem texto selecionável (parece digitalizado). Envie um PDF com texto ou cole o conteúdo como um item de texto.',
  'Could not read this PDF. It may be damaged or password-protected.':
    'Não foi possível ler este PDF. Ele pode estar corrompido ou protegido por senha.',
  'This file does not look like text. Send a plain-text .txt, .md or .csv file.':
    'Este arquivo não parece texto. Envie um arquivo de texto simples .txt, .md ou .csv.',
  'This PDF has too many pages (maximum 300). Split it into smaller files.':
    'Este PDF tem páginas demais (máximo 300). Divida em arquivos menores.',
  'This PDF is too heavy to read. Split it into smaller files or paste the text as a text item.':
    'Este PDF é pesado demais para ler. Divida em arquivos menores ou cole o texto como um item de texto.',
  'Reading this PDF took too long. Split it into smaller files or paste the text as a text item.':
    'A leitura deste PDF demorou demais. Divida em arquivos menores ou cole o texto como um item de texto.',
  'Could not load the item': 'Não foi possível carregar o item',
  'Could not delete the item': 'Não foi possível excluir o item',
  'The search failed': 'A busca falhou',

  // ---- contact memory + AI agents (migration 064) ------------------------
  'Contact memory': 'Memória do contato',
  'Add fact': 'Adicionar fato',
  Approve: 'Aprovar',
  Reject: 'Rejeitar',
  'Extract facts': 'Extrair fatos',
  'Extracting…': 'Extraindo…',
  'Fact about the contact': 'Fato sobre o contato',
  'E.g.: Prefers delivery in the afternoon': 'Ex.: Prefere entrega à tarde',
  'New facts to review': 'Novos fatos para revisar',
  'No new facts found in this conversation': 'Nenhum fato novo encontrado nesta conversa',
  'No facts saved yet. Approved facts are used in AI suggestions.':
    'Nenhum fato salvo ainda. Fatos aprovados são usados nas sugestões da IA.',
  'Reads this conversation and proposes facts for you to review. Uses the AI budget.':
    'Lê esta conversa e propõe fatos para você revisar. Usa o orçamento de IA.',
  'Suggested by AI — review': 'Sugerido pela IA — revise',
  'Could not extract facts': 'Não foi possível extrair fatos',
  'Could not save the fact': 'Não foi possível salvar o fato',
  'Could not delete the fact': 'Não foi possível excluir o fato',
  // API errors (src/lib/ai/memory.ts)
  'The fact is required (up to 300 characters).': 'O fato é obrigatório (até 300 caracteres).',
  'This looks like sensitive personal data (documents, card numbers, passwords, health). Do not store it in the contact memory.':
    'Isso parece dado pessoal sensível (documentos, números de cartão, senhas, saúde). Não guarde na memória do contato.',
  "'status' must be 'active' or 'rejected'": "'status' deve ser 'active' ou 'rejected'",
  'Memory not found': 'Fato não encontrado',
  'This contact already has too many facts (up to 100). Remove the ones that no longer apply.':
    'Este contato já tem fatos demais (até 100). Remova os que não valem mais.',
  'This fact is already in the contact memory.': 'Este fato já está na memória do contato.',
  'The AI returned an invalid answer. Try again.': 'A IA devolveu uma resposta inválida. Tente de novo.',
  // Agents (Settings → IA → Agentes)
  'AI agents': 'Agentes de IA',
  "Different instructions per team or number. The account instructions above always apply; the agent's instructions are added after them. The suggestion uses the agent linked to one of the contact's tags; otherwise the one linked to the conversation's WhatsApp number; otherwise the default agent.":
    'Instruções diferentes por equipe ou número. As instruções da conta, acima, valem sempre; as do agente são acrescentadas depois delas. A sugestão usa o agente ligado a uma das etiquetas do contato; senão, o ligado ao número de WhatsApp da conversa; senão, o agente padrão.',
  'Turned on': 'Ativado',
  'AI calls': 'Chamadas de IA',
  'conversation of': 'conversa de',
  'New agent': 'Novo agente',
  'Edit agent': 'Editar agente',
  'Agent saved': 'Agente salvo',
  'Could not load the AI agents': 'Não foi possível carregar os agentes de IA',
  'No agents yet — suggestions use the instructions above.': 'Nenhum agente ainda — as sugestões usam as instruções acima.',
  Default: 'Padrão',
  'Without knowledge base': 'Sem base de conhecimento',
  'Official WhatsApp number': 'Número do WhatsApp oficial',
  'WhatsApp QR number': 'Número do WhatsApp QR',
  'Delete this AI agent?': 'Excluir este agente de IA?',
  'Could not save the agent': 'Não foi possível salvar o agente',
  'Could not delete the agent': 'Não foi possível excluir o agente',
  'Test an agent': 'Testar um agente',
  'Sends this message to the AI provider as if a customer wrote it and shows the suggestion. It is a real call and counts toward the monthly budget.':
    'Envia esta mensagem ao provedor de IA como se um cliente a tivesse escrito e mostra a sugestão. É uma chamada real e conta no orçamento mensal.',
  Test: 'Testar',
  'Suggestion (test)': 'Sugestão (teste)',
  'Too many requests. Wait a minute and try again.': 'Muitas solicitações. Aguarde um minuto e tente de novo.',
  "Uses the account's provider, API key and budget.": 'Usa o provedor, a chave de API e o orçamento da conta.',
  'E.g.: Sales': 'Ex.: Vendas',
  'Tone (optional)': 'Tom de voz (opcional)',
  'E.g.: friendly and short': 'Ex.: simpático e curto',
  'Model (optional)': 'Modelo (opcional)',
  'Account model': 'Modelo da conta',
  'Use this agent for': 'Usar este agente para',
  'Contacts with these tags (takes priority over the number):':
    'Contatos com estas etiquetas (tem prioridade sobre o número):',
  'Default agent (when no tag or number matches)': 'Agente padrão (quando nenhuma etiqueta ou número combina)',
  'Use the knowledge base': 'Usar a base de conhecimento',
  // API errors (src/lib/ai/agents.ts)
  'The name is required (up to 80 characters).': 'O nome é obrigatório (até 80 caracteres).',
  'The instructions are required (up to 4000 characters).': 'As instruções são obrigatórias (até 4000 caracteres).',
  'The tone must be at most 200 characters.': 'O tom de voz deve ter no máximo 200 caracteres.',
  "'knowledge_enabled', 'is_default' and 'enabled' must be true or false":
    "'knowledge_enabled', 'is_default' e 'enabled' devem ser true ou false",
  "'channels' must be a list of 'official' and/or 'qr'": "'channels' deve ser uma lista com 'official' e/ou 'qr'",
  "'tag_ids' must be a list of up to 50 tag ids": "'tag_ids' deve ser uma lista de até 50 etiquetas",
  'AI agent not found': 'Agente de IA não encontrado',
  'This account already has the maximum of 20 AI agents.': 'Esta conta já tem o máximo de 20 agentes de IA.',
  'Another agent became the default at the same time. Reload and try again.':
    'Outro agente virou o padrão ao mesmo tempo. Recarregue e tente de novo.',
  'Type a customer message to test (up to 1000 characters).':
    'Digite uma mensagem de cliente para testar (até 1000 caracteres).',
};
