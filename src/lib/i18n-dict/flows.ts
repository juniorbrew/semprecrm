/** pt-BR copy for the "flows" area — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_FLOWS: Record<string, string> = {
  // ---------------------------------------------------------------
  // Flow editor — palette, header, list view, canvas
  // ---------------------------------------------------------------
  'Collect input': 'Coletar resposta',
  Nodes: 'Nós',
  "Add a Start node, then a Send buttons node, then a Handoff — that's the classic welcome-menu shape.":
    'Adicione um nó Início, depois um Enviar botões e por fim um Transferir para um responsável — é o formato clássico de menu de boas-vindas.',
  'support, help, hi': 'suporte, ajuda, oi',
  'First inbound message from the customer': 'Primeira mensagem recebida do cliente',
  'Manual only (no automatic trigger)': 'Somente manual (sem gatilho automático)',
  Entry: 'Entrada',
  'Set as entry': 'Definir como entrada',
  'Remove node': 'Remover nó',
  'Node key (internal identifier — keep it stable for analytics)':
    'Chave do nó (identificador interno — mantenha estável para análises)',
  'Hide advanced': 'Ocultar avançado',
  'Show advanced': 'Mostrar avançado',
  True: 'Verdadeiro',
  False: 'Falso',
  Canvas: 'Tela',
  Edited: 'Editado',
  Runs: 'Execuções',
  Archived: 'Arquivado',
  'Flow archived.': 'Fluxo arquivado.',
  'Saved.': 'Salvo.',
  "Any active runs end immediately. This can't be undone.":
    'Todas as execuções ativas serão encerradas imediatamente. Esta ação não pode ser desfeita.',
  'Jump to node': 'Ir para o nó',
  error: 'erro',
  errors: 'erros',
  warning: 'aviso',
  warnings: 'avisos',

  // ---------------------------------------------------------------
  // Node config forms
  // ---------------------------------------------------------------
  '— None —': '— Nenhum —',
  Option: 'Opção',
  'Option 1': 'Opção 1',
  'See options': 'Ver opções',
  'Remove button': 'Remover botão',
  'Add button': 'Adicionar botão',
  Section: 'Seção',
  'title (optional)': 'título (opcional)',
  'Remove row': 'Remover linha',
  'Add row': 'Adicionar linha',
  'Add section': 'Adicionar seção',
  'Variable name': 'Nome da variável',
  'e.g. email': 'ex.: email',
  equals: 'é igual a',
  'File is': 'O arquivo possui',
  'limit is 16 MB.': 'o limite é 16 MB.',
  'Document (PDF, Word, Excel, PowerPoint, TXT)': 'Documento (PDF, Word, Excel, PowerPoint, TXT)',
  'Click to upload (max 16 MB)': 'Clique para enviar (máx. 16 MB)',
  'Filename shown to the customer (documents only)':
    'Nome do arquivo exibido ao cliente (somente documentos)',
  'invoice.pdf': 'fatura.pdf',

  // Collapsed-card / canvas tile previews (summarizeNode)
  option: 'opção',
  options: 'opções',
  section: 'seção',
  sections: 'seções',
  '(no file uploaded)': '(nenhum arquivo enviado)',
  'has tag': 'possui a etiqueta',
  exists: 'existe',
  missing: 'ausente',
  '(none picked)': '(nenhuma escolhida)',

  // ---------------------------------------------------------------
  // Validator messages (static ones; interpolated ones live in
  // src/components/flows/issue-messages.ts)
  // ---------------------------------------------------------------
  'Flow name is required.': 'O nome do fluxo é obrigatório.',
  'Pick an entry node before activating.': 'Escolha um nó de entrada antes de ativar.',
  'A flow needs at least one node before activation.':
    'Um fluxo precisa de pelo menos um nó antes de ser ativado.',
  'Keyword triggers need at least one keyword.':
    'Gatilhos por palavra-chave precisam de pelo menos uma palavra-chave.',
  'Start node must point to a next node.': 'O nó Início precisa apontar para um próximo nó.',
  'Send-message node needs a text body.': 'O nó Enviar mensagem precisa de um texto.',
  'Send-message node must point to a next node.':
    'O nó Enviar mensagem precisa apontar para um próximo nó.',
  'Send-media node needs a media type (image, video, or document).':
    'O nó Enviar mídia precisa de um tipo de mídia (imagem, vídeo ou documento).',
  'Send-media node needs a file (upload one before activating).':
    'O nó Enviar mídia precisa de um arquivo (envie um antes de ativar).',
  'Send-media node must point to a next node.':
    'O nó Enviar mídia precisa apontar para um próximo nó.',
  'Send-buttons node needs a text body.': 'O nó Enviar botões precisa de um texto.',
  'Send-buttons needs at least one button.': 'O nó Enviar botões precisa de pelo menos um botão.',
  'Send-list node needs a text body.': 'O nó Enviar lista precisa de um texto.',
  'Send-list needs a button label (the tap-to-expand text).':
    'O nó Enviar lista precisa de um texto para o botão (o texto que expande a lista).',
  'Send-list needs at least one row.': 'O nó Enviar lista precisa de pelo menos uma linha.',
  'Collect-input needs a prompt to send the customer.':
    'O nó Coletar resposta precisa de uma pergunta para enviar ao cliente.',
  'Collect-input needs a var_key to store the answer under.':
    'O nó Coletar resposta precisa de uma chave de variável para guardar a resposta.',
  'Collect-input must point to a next node.':
    'O nó Coletar resposta precisa apontar para um próximo nó.',
  'Condition needs a subject (var / tag / contact_field).':
    'A condição precisa de um assunto (variável, etiqueta ou campo do contato).',
  'Condition needs a subject_key (var name, tag id, or field name).':
    'A condição precisa de um valor para comparar (nome da variável, etiqueta ou campo).',
  'Condition needs an operator.': 'A condição precisa de um operador.',
  'Set-tag needs a mode (add or remove).':
    'O nó Etiquetar contato precisa de uma ação (adicionar ou remover).',
  'Set-tag needs a tag to apply.': 'O nó Etiquetar contato precisa de uma etiqueta.',
  'Set-tag must point to a next node.':
    'O nó Etiquetar contato precisa apontar para um próximo nó.',

  // ---------------------------------------------------------------
  // Flows list + templates gallery
  // ---------------------------------------------------------------
  'New flow': 'Novo fluxo',
  'Start from a template or build from scratch.': 'Comece com um modelo ou crie do zero.',
  'Start with a template': 'Começar com um modelo',
  'Or start blank': 'Ou começar em branco',
  'e.g. Welcome menu': 'ex.: Menu de boas-vindas',
  'No flows yet': 'Ainda não há fluxos',
  node: 'nó',
  nodes: 'nós',
  run: 'execução',
  runs: 'execuções',
  'Welcome menu': 'Menu de boas-vindas',
  'FAQ bot': 'Bot de perguntas frequentes',
  'Lead capture': 'Captura de leads',

  // ---------------------------------------------------------------
  // Runs page
  // ---------------------------------------------------------------
  'Handed off': 'Transferida',
  'at node': 'no nó',
  Started: 'Iniciada em',
  'ran for': 'durou',
  're-prompt': 'nova tentativa',
  're-prompts': 'novas tentativas',
  'Captured variables': 'Variáveis capturadas',
  'No events recorded for this run.': 'Nenhum evento registrado nesta execução.',

  // ---------------------------------------------------------------
  // Automations — list, editor, logs
  // ---------------------------------------------------------------
  'Failed to load': 'Falha ao carregar',
  'Failed to load automations': 'Falha ao carregar as automações',
  'Build automations that react to WhatsApp® events on their own.':
    'Crie automações que reagem automaticamente a eventos do WhatsApp®.',
  'Pick a template above or start from scratch.': 'Escolha um modelo acima ou crie um do zero.',
  'This permanently removes': 'Isso removerá permanentemente',
  'and its execution history. This cannot be undone.':
    'e seu histórico de execução. Esta ação não pode ser desfeita.',
  'last:': 'última:',
  'View logs': 'Ver registros',
  step: 'etapa',
  steps: 'etapas',
  unknown: 'desconhecido',
  'not in the approved list': 'fora da lista aprovada',
  'e.g. price': 'ex.: preço',

  // Activation validator (src/lib/automations/validate.ts) — surfaced in
  // the save toast when the API blocks activation
  'active automations need at least one step':
    'Automações ativas precisam de pelo menos uma etapa',
  'message text is required': 'O texto da mensagem é obrigatório',
  'template name is required': 'O nome do modelo é obrigatório',
  'tag is required': 'A etiqueta é obrigatória',
  'agent is required when mode is "specific"':
    'Escolha o responsável quando o modo é “responsável específico”',
  'field name is required': 'O nome do campo é obrigatório',
  'field value is required': 'O valor do campo é obrigatório',
  'pipeline is required': 'O funil é obrigatório',
  'stage is required': 'A etapa é obrigatória',
  'title is required': 'O título é obrigatório',
  'wait amount must be greater than 0': 'O tempo de espera deve ser maior que 0',
  'wait unit must be minutes, hours, or days':
    'A unidade de espera deve ser minutos, horas ou dias',
  'condition subject is required': 'O assunto da condição é obrigatório',
  'condition operand is required': 'O valor da condição é obrigatório',
  'webhook URL is required': 'A URL do webhook é obrigatória',
  'webhook URL must use http or https': 'A URL do webhook deve usar http ou https',
  'webhook URL is not a valid URL': 'A URL do webhook não é válida',
  'task title is required': 'O título da tarefa é obrigatório',
  'task priority must be low, normal, high or urgent':
    'A prioridade da tarefa deve ser baixa, normal, alta ou urgente',
  'due in hours must be a number of hours (0 or more)':
    'O prazo deve ser um número de horas (0 ou mais)',
  'at least one keyword is required': 'Informe pelo menos uma palavra-chave',
  'keywords cannot be empty strings': 'As palavras-chave não podem estar em branco',
  'match type must be "exact" or "contains"':
    'O tipo de correspondência deve ser “exata” ou “contém”',
  'schedule is required': 'O agendamento é obrigatório',
  'source must be a valid id': 'A fonte deve ser um ID válido',
  'last_from must be "agent", "customer" or "any"':
    'O último remetente deve ser “responsável”, “cliente” ou “qualquer um”',
  'statuses must list at least one of "open", "pending"':
    'Selecione pelo menos um status: “aberta” ou “pendente”',

  // Engine errors surfaced verbatim in the automation log rows
  'send_message needs a contact': 'Enviar mensagem precisa de um contato',
  'send_message has empty text': 'Enviar mensagem está sem texto',
  'send_template needs a contact': 'Enviar modelo precisa de um contato',
  'send_template needs template_name': 'Enviar modelo precisa do nome do modelo',
  'add_tag needs contact + tag_id': 'Adicionar etiqueta precisa de contato e etiqueta',
  'remove_tag needs contact + tag_id': 'Remover etiqueta precisa de contato e etiqueta',
  'assign_conversation needs a contact': 'Atribuir conversa precisa de um contato',
  'update_contact_field needs a contact': 'Atualizar campo do contato precisa de um contato',
  'create_deal needs pipeline + stage': 'Criar negócio precisa de funil e etapa',
  'send_webhook needs url': 'Enviar webhook precisa de uma URL',
  'close_conversation needs a contact': 'Resolver conversa precisa de um contato',
  'create_task needs a title': 'Criar tarefa precisa de um título',
  'tasks module is not enabled for this account':
    'O módulo de tarefas não está ativado nesta conta',
  'account has no task statuses': 'A conta não possui status de tarefa',
  'cannot resolve conversation: no contact': 'Não foi possível localizar a conversa: sem contato',
  'no conversation for contact': 'Nenhuma conversa para o contato',

  // ---------------------------------------------------------------
  // Round 2 — canonical glossary (Responsável, Resolver, Tela) and the
  // React Flow chrome (Controls / minimap / keyboard hints)
  // ---------------------------------------------------------------
  'Canvas controls': 'Controles da tela',
  'Zoom in': 'Aumentar zoom',
  'Zoom out': 'Diminuir zoom',
  'Fit view': 'Ajustar à tela',
  'Toggle interactivity': 'Ativar ou desativar interação',
  'Flow overview map': 'Mapa geral do fluxo',
  'Connection handle': 'Ponto de conexão',
  'Press Enter or Space to select a node. Press Delete to remove it and Escape to cancel.':
    'Pressione Enter ou Espaço para selecionar um nó. Pressione Delete para removê-lo e Esc para cancelar.',
  'Press Enter or Space to select a node. You can then use the arrow keys to move the node around. Press Delete to remove it and Escape to cancel.':
    'Pressione Enter ou Espaço para selecionar um nó. Depois, use as setas do teclado para movê-lo. Pressione Delete para removê-lo e Esc para cancelar.',
  'Press Enter or Space to select a connection. You can then press Delete to remove it or Escape to cancel.':
    'Pressione Enter ou Espaço para selecionar uma conexão. Depois, pressione Delete para removê-la ou Esc para cancelar.',
  'Moved selected node': 'Nó selecionado movido',
  'New position': 'Nova posição',

  // Node summaries / config (names instead of ids, no DB columns)
  variable: 'variável',
  field: 'campo',
  'unnamed tag': 'etiqueta sem nome',
  'Captured variable': 'Variável capturada',
  'Pick a media type…': 'Escolha um tipo de mídia…',
  'Variable name (letters, numbers and underscore)':
    'Nome da variável (letras, números e sublinhado)',
  'No tags yet — create one in Contacts': 'Ainda não há etiquetas — crie uma em Contatos',
  'Internal note (for the assignee picking up)':
    'Nota interna (para o responsável que assumir)',
  'Interpolate in downstream prompts and handoff notes with':
    'Utilize em perguntas posteriores e notas de transferência com',
  'Handoff to agent': 'Transferir para um responsável',
  "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.":
    'Receba clientes que digitam uma palavra-chave e encaminhe-os ao responsável certo conforme sejam novos ou já clientes.',
  'Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.':
    'Receba quem escreve pela primeira vez, capture nome, e-mail e empresa e transfira para vendas com as respostas na nota.',
  'No errors found. Ready to activate.': 'Nenhum erro encontrado. Pronto para ativar.',
  'Build your first conversation — a welcome menu, an order lookup, an FAQ bot. Customers tap buttons; the bot routes them to the right answer (or the right agent).':
    'Crie sua primeira conversa — menu de boas-vindas, consulta de pedido ou bot de perguntas frequentes. Os clientes tocam nos botões e o bot os encaminha para a resposta certa (ou o responsável certo).',

  // Automations — assignee wording, resolve, active rule
  'When should this rule be executed?': 'Quando esta regra deve ser executada?',
  'Resolve conversation': 'Resolver conversa',
  'Marks the conversation as resolved. No configuration needed.':
    'Marca a conversa como resolvida. Nenhuma configuração é necessária.',
  'When the conversation gets an assignee': 'Quando a conversa recebe um responsável',
  'Assignee id': 'ID do responsável',
  'Select an assignee…': 'Selecione um responsável…',
  '(removed team member)': '(membro removido da equipe)',
  '(deleted tag)': '(etiqueta excluída)',
  '(deleted field)': '(campo excluído)',
  '(deleted pipeline)': '(funil excluído)',
  '(deleted stage)': '(etapa excluída)',
  'Select a pipeline…': 'Selecione um funil…',
  'Select a stage…': 'Selecione uma etapa…',
  'Specific assignee': 'Responsável específico',
  'The assignee (customer went quiet)': 'O responsável (cliente ficou em silêncio)',
  'Active rule': 'Automação ativa',
  'Conversation Inactive': 'Conversa sem resposta',
  'Check the highlighted step and try again.': 'Verifique a etapa destacada e tente novamente.',
  'Hi! Thanks for getting in touch…': 'Olá! Agradecemos o contato…',
  'Follow up with {{ contact.name }}': 'Retomar contato com {{ contact.name }}',
  'Last message was from': 'Última mensagem enviada por',
  'The customer (nobody replied)': 'O cliente (ninguém respondeu)',
  'Decimals allowed — 0.05 is 3 minutes, 24 is one day, 720 is the maximum (30 days).':
    'Aceita decimais — 0,05 são 3 minutos, 24 é um dia e 720 é o máximo (30 dias).',
};
