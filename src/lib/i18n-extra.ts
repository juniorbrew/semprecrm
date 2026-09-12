/** Additional app-owned UI copy kept separate so the core locale file stays navigable. */
export const EN_TO_PT_EXTRA: Record<string, string> = {
  // WhatsApp connection and setup
  'WhatsApp connection': 'Conexão com o WhatsApp',
  'Connect your Meta WhatsApp Business API. Credentials, webhook, and setup steps all live here.':
    'Conecte sua API do WhatsApp Business da Meta. Credenciais, webhook e instruções de configuração ficam aqui.',
  'Not Connected': 'Não conectado',
  'Configure your Meta API credentials below to connect your WhatsApp Business account.':
    'Configure abaixo suas credenciais da API da Meta para conectar sua conta do WhatsApp Business.',
  'Enter your Meta WhatsApp Business API credentials.':
    'Informe suas credenciais da API do WhatsApp Business da Meta.',
  'Phone Number ID': 'ID do número de telefone',
  'WhatsApp Business Account ID': 'ID da conta do WhatsApp Business',
  'Permanent Access Token': 'Token de acesso permanente',
  'Enter your access token': 'Digite seu token de acesso',
  'Webhook Verify Token': 'Token de verificação do webhook',
  'Create a custom verify token': 'Crie um token de verificação personalizado',
  'A custom string you create. Must match the token you set in Meta webhook settings.':
    'Uma sequência personalizada criada por você. Ela deve ser igual ao token definido nas configurações do webhook da Meta.',
  'Two-step verification PIN (optional)':
    'PIN da verificação em duas etapas (opcional)',
  '6-digit PIN from Meta WhatsApp Manager':
    'PIN de 6 dígitos do Gerenciador do WhatsApp da Meta',
  'Webhook Configuration': 'Configuração do webhook',
  'Use this URL as your webhook callback in the Meta App Dashboard.':
    'Use esta URL como callback do webhook no painel do aplicativo da Meta.',
  'Webhook Callback URL': 'URL de callback do webhook',
  'Test API Connection': 'Testar conexão com a API',
  'Setup Instructions': 'Instruções de configuração',
  'Follow these steps to connect your WhatsApp Business API.':
    'Siga estas etapas para conectar sua API do WhatsApp Business.',
  'Create a Meta App': 'Criar um aplicativo na Meta',
  'Go to developers.facebook.com': 'Acesse developers.facebook.com',
  'Click "My Apps" and then "Create App"':
    'Clique em “Meus aplicativos” e depois em “Criar aplicativo”',
  'Select "Business" as the app type':
    'Selecione “Empresa” como o tipo do aplicativo',
  'Fill in app details and create':
    'Preencha os dados do aplicativo e conclua a criação',
  'Add WhatsApp Product': 'Adicionar o produto WhatsApp',
  'In your app dashboard, click "Add Product"':
    'No painel do aplicativo, clique em “Adicionar produto”',
  'Find "WhatsApp" and click "Set Up"':
    'Encontre “WhatsApp” e clique em “Configurar”',
  'Follow the setup wizard to link your business':
    'Siga o assistente para vincular sua empresa',
  'Get API Credentials': 'Obter credenciais da API',
  'Go to WhatsApp > API Setup': 'Acesse WhatsApp > Configuração da API',
  'Copy your': 'Copie seu',
  'Generate a': 'Gere um',
  'from Business Settings > System Users':
    'em Configurações da empresa > Usuários do sistema',
  'Configure Webhooks': 'Configurar webhooks',
  'Go to WhatsApp > Configuration': 'Acesse WhatsApp > Configuração',
  'Click "Edit" on the Webhook section': 'Clique em “Editar” na seção Webhook',
  'Enter the same': 'Informe o mesmo',
  'you set here': 'definido aqui',
  'Subscribe to "messages" webhook field':
    'Assine o campo “messages” do webhook',
  'Meta WhatsApp API Documentation': 'Documentação da API do WhatsApp da Meta',
  'Token is hidden for security. Re-enter it to update configuration.':
    'O token fica oculto por segurança. Digite-o novamente para atualizar a configuração.',
  "Stored token can't be decrypted":
    'O token armazenado não pôde ser descriptografado',
  'Last attempt failed with:': 'A última tentativa falhou com:',
  'Diagnostic — last run:': 'Diagnóstico — última execução:',
  'Number is fully wired — Meta is delivering events.':
    'O número está totalmente conectado — a Meta está entregando os eventos.',
  'Number is not fully registered. See the checks below for which step failed.':
    'O número não está totalmente registrado. Veja abaixo qual etapa falhou.',
  'Could not reach the verification endpoint.':
    'Não foi possível acessar o endpoint de verificação.',
  'Configuration cleared. You can now re-enter your credentials.':
    'Configuração removida. Agora você pode informar novamente suas credenciais.',
  'Webhook URL copied to clipboard': 'URL do webhook copiada',
  'Failed to load WhatsApp configuration':
    'Falha ao carregar a configuração do WhatsApp',
  'Phone Number ID is required': 'O ID do número de telefone é obrigatório',
  'Access Token is required for initial setup':
    'O token de acesso é obrigatório na configuração inicial',
  'Please re-enter the Access Token to save changes':
    'Digite novamente o token de acesso para salvar as alterações',
  'Failed to save configuration': 'Falha ao salvar a configuração',
  'Connection test failed. Check network and try again.':
    'O teste de conexão falhou. Verifique a rede e tente novamente.',
  'Failed to reset configuration': 'Falha ao redefinir a configuração',

  // Dashboard and top-level pages
  'Live analytics across conversations, contacts, deals, broadcasts, and automations.':
    'Análises em tempo real de conversas, contatos, negócios, disparos e automações.',
  'Open Deals Value': 'Valor dos negócios abertos',
  'Manage your contact list.': 'Gerencie sua lista de contatos.',
  'add or import contacts': 'adicionar ou importar contatos',
  'Search by name, phone, or email...':
    'Pesquisar por nome, telefone ou e-mail...',
  'delete contacts': 'excluir contatos',
  'Select all contacts on this page':
    'Selecionar todos os contatos desta página',
  'Loading contacts...': 'Carregando contatos...',
  'Are you sure you want to delete': 'Tem certeza de que deseja excluir',
  '? This action cannot be undone.': '? Esta ação não pode ser desfeita.',
  'Failed to delete contact': 'Falha ao excluir o contato',
  'Failed to delete contacts': 'Falha ao excluir os contatos',
  'Send bulk messages to your contacts using approved templates.':
    'Envie mensagens em massa aos seus contatos usando modelos aprovados.',
  'Create your first broadcast to reach your contacts at scale.':
    'Crie seu primeiro disparo para alcançar seus contatos em escala.',
  'Create and send a broadcast message to your contacts.':
    'Crie e envie uma mensagem em massa para seus contatos.',
  'Give the broadcast a name before saving a draft.':
    'Dê um nome ao disparo antes de salvar o rascunho.',
  'Delete this broadcast?': 'Excluir este disparo?',
  'No templates available.': 'Nenhum modelo disponível.',
  'Create a template in Settings first.':
    'Primeiro crie um modelo nas Configurações.',
  'All Contacts': 'Todos os contatos',
  'Send to every contact in your database':
    'Enviar para todos os contatos do banco de dados',
  'Target contacts with specific tags':
    'Selecionar contatos com etiquetas específicas',
  'Filter by a custom field value':
    'Filtrar pelo valor de um campo personalizado',
  'Upload a list of phone numbers': 'Enviar uma lista de números de telefone',
  'Custom Field Filter': 'Filtro de campo personalizado',
  'Custom Field': 'Campo personalizado',
  'Select field…': 'Selecione um campo…',
  'Select field...': 'Selecione um campo...',
  'No tags available.': 'Nenhuma etiqueta disponível.',
  'Contact Name': 'Nome do contato',
  'Phone Number': 'Número de telefone',
  'Map template variables to contact fields, custom fields, or static values.':
    'Associe as variáveis do modelo a campos do contato, campos personalizados ou valores fixos.',
  'Contact Field': 'Campo do contato',
  'Enter value...': 'Digite um valor...',
  'You are about to send this broadcast to':
    'Você está prestes a enviar este disparo para',
  'contacts using the': 'contatos usando o modelo',
  'template. This action cannot be undone.': 'Esta ação não pode ser desfeita.',

  // Pipelines and deals
  'Create a pipeline to start tracking deals':
    'Crie um funil para começar a acompanhar negócios',
  'Default stages (New Lead → Won) will be created automatically.':
    'As etapas padrão (Novo lead → Ganho) serão criadas automaticamente.',
  'New Deal': 'Novo negócio',
  'Failed to move deal': 'Falha ao mover o negócio',
  'Failed to create pipeline': 'Falha ao criar o funil',
  'Title, contact, and stage are required':
    'Título, contato e etapa são obrigatórios',
  'Failed to save deal': 'Falha ao salvar o negócio',
  'Not signed in': 'Usuário não autenticado',
  'Your profile is not linked to an account.':
    'Seu perfil não está vinculado a uma conta.',
  'Failed to create deal': 'Falha ao criar o negócio',
  'Failed to update deal status': 'Falha ao atualizar o status do negócio',
  'Failed to delete deal': 'Falha ao excluir o negócio',
  'Select a contact': 'Selecione um contato',
  'Link to Conversation': 'Vincular à conversa',
  'Add notes...': 'Adicionar observações...',
  'Delete this deal?': 'Excluir este negócio?',
  'Pipeline Value': 'Valor do funil',
  'Drop a deal here': 'Solte um negócio aqui',
  'Failed to save pipeline': 'Falha ao salvar o funil',
  'Failed to add stage': 'Falha ao adicionar a etapa',
  'Move or delete deals in this stage first':
    'Primeiro mova ou exclua os negócios desta etapa',
  'Failed to delete stage': 'Falha ao excluir a etapa',
  'Failed to delete pipeline': 'Falha ao excluir o funil',
  'Manage Pipeline': 'Gerenciar funil',
  'This will archive all deals in this pipeline. This cannot be undone.':
    'Isso arquivará todos os negócios deste funil. Esta ação não pode ser desfeita.',
  'Pipeline Name': 'Nome do funil',
  'New stage name': 'Nome da nova etapa',
  'Create a new pipeline': 'Criar um novo funil',
  // Pipelines — deal drawer (read view first, edit second)
  'Deal details': 'Detalhes do negócio',
  'Edit deal': 'Editar negócio',
  'Back to deal': 'Voltar ao negócio',
  'Open deal': 'Em aberto',
  Timeline: 'Linha do tempo',
  'No contact': 'Sem contato',
  'Last update': 'Última atualização',
  'Expected close': 'Fechamento previsto',
  Closes: 'Fecha em',
  'Add a note': 'Adicionar uma observação',
  'No conversation with this contact yet':
    'Ainda não há conversa com este contato',
  'No contact linked to this deal': 'Nenhum contato vinculado a este negócio',
  'Last message': 'Última mensagem',
  'Deal moved': 'Negócio movido',
  'Mark as Won': 'Marcar como ganho',
  'Mark as Lost': 'Marcar como perdido',
  'Advance stage': 'Avançar etapa',
  'Deal title': 'Título do negócio',
  'Expected close date': 'Data prevista de fechamento',
  'Assigned to': 'Atribuído a',
  'Save changes': 'Salvar alterações',
  'Saving...': 'Salvando...',
  'Deleting...': 'Excluindo...',
  'Create deal': 'Criar negócio',
  Confirm: 'Confirmar',
  'Currently in': 'Atualmente em',
  'Last stage': 'Última etapa',
  'Next stage': 'Próxima etapa',
  'Contact deleted': 'Contato excluído',
  unread: 'não lida',
  'Days in pipeline': 'Dias no funil',
  'Deal value': 'Valor do negócio',
  'Start a conversation': 'Iniciar conversa',
  Overdue: 'Atrasado',
  'Due today': 'Vence hoje',

  // Inbox
  'Search conversations...': 'Pesquisar conversas...',
  'Nothing to copy': 'Não há nada para copiar',
  'Copy failed': 'Falha ao copiar',
  "Voice recording isn't supported in this browser.":
    'Este navegador não oferece suporte à gravação de voz.',
  '24-hour session expired. Use a template to re-engage.':
    'A sessão de 24 horas expirou. Use um modelo para retomar o contato.',
  'Stop and attach': 'Parar e anexar',
  'Add a caption…': 'Adicionar uma legenda…',
  'Wait for the message to finish sending':
    'Aguarde o envio da mensagem terminar',
  'Back to conversations': 'Voltar para as conversas',
  'No approved templates': 'Nenhum modelo aprovado',
  'Approve a template in Meta WhatsApp Manager, then sync it from Settings → Templates.':
    'Aprove um modelo no Gerenciador do WhatsApp da Meta e sincronize em Configurações → Modelos.',
  'Value for the header variable': 'Valor da variável do cabeçalho',
  'Cancel reply': 'Cancelar resposta',
  'No deals': 'Nenhum negócio',

  // Contacts and dashboard widgets
  'Write a note...': 'Escreva uma observação...',
  'No deals yet': 'Ainda não há negócios',
  'Phone number is required': 'O número de telefone é obrigatório',
  'A contact with this phone number already exists':
    'Já existe um contato com este número de telefone',
  'Failed to update contact': 'Falha ao atualizar o contato',
  'Failed to add note': 'Falha ao adicionar a observação',
  'Failed to delete note': 'Falha ao excluir a observação',
  'Failed to save custom fields': 'Falha ao salvar os campos personalizados',
  'Define extra contact fields (e.g. ZIP code, lead source). They appear on every contact and in the “Update Contact Field” automation action.':
    'Defina campos adicionais do contato (por exemplo, CEP e origem do lead). Eles aparecem em todos os contatos e na ação “Atualizar campo do contato”.',
  'Could not create field. You may not have permission.':
    'Não foi possível criar o campo. Talvez você não tenha permissão.',
  'Could not rename field.': 'Não foi possível renomear o campo.',
  'Could not delete field.': 'Não foi possível excluir o campo.',
  'New field name…': 'Nome do novo campo…',
  'No custom fields yet.': 'Ainda não há campos personalizados.',
  'Delete field': 'Excluir campo',
  'No valid rows found. Ensure CSV has a "phone" column header.':
    'Nenhuma linha válida encontrada. Verifique se o CSV possui a coluna “phone”.',
  'Contacts imported, but some tag assignments failed.':
    'Os contatos foram importados, mas algumas etiquetas não puderam ser atribuídas.',
  'Upload a CSV with a required': 'Envie um CSV contendo a coluna obrigatória',
  'Click to choose a CSV file': 'Clique para escolher um arquivo CSV',
  'Activity from messages, deals, broadcasts, and automations will appear here.':
    'Atividades de mensagens, negócios, disparos e automações aparecerão aqui.',
  'Daily message volume by direction': 'Volume diário de mensagens por direção',
  'No message activity in this range':
    'Nenhuma atividade de mensagens neste período',
  'Send or receive messages to start populating this chart.':
    'Envie ou receba mensagens para começar a preencher este gráfico.',
  'Conversations per day': 'Conversas por dia',
  'No open deals yet': 'Ainda não há negócios abertos',
  'Create deals in Pipelines to see stage breakdowns here.':
    'Crie negócios nos Funis para ver aqui a divisão por etapas.',
  'Pipeline value by stage': 'Valor do funil por etapa',
  'Incoming': 'Recebidas',
  'Outgoing': 'Enviadas',
  'View all →': 'Ver tudo →',
  'Refresh': 'Atualizar',
  'Refresh dashboard data': 'Atualizar os dados do painel',
  'Open deals by stage': 'Negócios abertos por etapa',
  'This chart fills in as you reply to customer messages.':
    'Este gráfico será preenchido conforme você responder às mensagens dos clientes.',

  // Flows
  'Flow not found.': 'Fluxo não encontrado.',
  '← Back to flows': '← Voltar para fluxos',
  'Paused by agent': 'Pausado pelo agente',
  "Couldn't create flow.": 'Não foi possível criar o fluxo.',
  "Couldn't delete flow.": 'Não foi possível excluir o fluxo.',
  'A message contains a keyword': 'Uma mensagem contém uma palavra-chave',
  'Pick the first node…': 'Escolha o primeiro nó…',
  'Pick a next node…': 'Escolha o próximo nó…',
  'Text sent to the customer': 'Texto enviado ao cliente',
  'Prompt sent to the customer': 'Pergunta enviada ao cliente',
  'e.g. name, email, company': 'ex.: nome, e-mail, empresa',
  'After capturing, advance to': 'Após capturar, avançar para',
  'Internal note (for the agent picking up)':
    'Observação interna (para o agente que assumir)',
  'Terminal node. When the runner reaches this node the run is marked complete. No config needed.':
    'Nó terminal. Quando a execução chega a este nó, o fluxo é concluído. Nenhuma configuração é necessária.',
  'Body text': 'Texto do corpo',
  'Tap-to-expand button label (≤20 chars)':
    'Texto do botão para expandir (até 20 caracteres)',
  'Footer (optional, 60 chars)': 'Rodapé (opcional, 60 caracteres)',
  'Contact has tag': 'O contato possui a etiqueta',
  'Pick a field…': 'Escolha um campo…',
  'If true → advance to': 'Se verdadeiro → avançar para',
  'If false → advance to': 'Se falso → avançar para',
  'Remove tag': 'Remover etiqueta',
  'Pick a tag…': 'Escolha uma etiqueta…',
  'Remove file': 'Remover arquivo',
  'Caption (optional, shown under the media)':
    'Legenda (opcional, exibida abaixo da mídia)',
  'After sending, advance to': 'Após enviar, avançar para',
  'Unsaved changes — hit Save to persist':
    'Alterações não salvas — clique em Salvar para mantê-las',
  "Optional description (internal — customers don't see this)":
    'Descrição opcional (interna — os clientes não veem)',
  'If / else': 'Se / senão',
  'Tag contact': 'Etiquetar contato',
  'Handoff to agent': 'Transferir para agente',

  // Account, team and security
  'The currency used for new deals and for pipeline and dashboard totals.':
    'A moeda usada em novos negócios e nos totais do funil e do painel.',
  'New deals default to this currency, and pipeline and dashboard totals are shown in it. Existing deals keep the currency they were saved with.':
    'Novos negócios usam esta moeda por padrão, assim como os totais do funil e do painel. Negócios existentes mantêm a moeda em que foram salvos.',
  'Only account admins can change the default currency.':
    'Somente administradores da conta podem alterar a moeda padrão.',
  'Two ways to organize contacts: colour-coded tags for quick grouping, and custom fields for structured data.':
    'Duas formas de organizar contatos: etiquetas coloridas para agrupamento rápido e campos personalizados para dados estruturados.',
  'Could not reach the server. Try again?':
    'Não foi possível acessar o servidor. Tentar novamente?',
  'Clipboard blocked — copy the link manually':
    'A área de transferência foi bloqueada — copie o link manualmente',
  'Save this link now.': 'Salve este link agora.',
  'Link valid for': 'Link válido por',
  'Helps you remember who you sent the link to in the pending list below.':
    'Ajuda a lembrar para quem o link foi enviado na lista de pendências abaixo.',
  'Manage members + everything': 'Gerenciar membros e todos os recursos',
  'Use features; no settings': 'Usar recursos; sem acesso às configurações',
  'Read-only across the app': 'Somente leitura em todo o sistema',
  'People with access to this account. Roles control what each teammate can do.':
    'Pessoas com acesso a esta conta. As funções controlam o que cada membro pode fazer.',
  'No pending invitations.': 'Nenhum convite pendente.',
  'Remove member': 'Remover membro',
  'Cannot change password without a current email':
    'Não é possível alterar a senha sem um e-mail atual',
  'Current password is incorrect': 'A senha atual está incorreta',
  'Use at least': 'Use pelo menos',
  'characters. You will stay signed in on this device after changing it.':
    'caracteres. Você continuará conectado neste dispositivo após a alteração.',
  'Use PNG, JPG, WebP, or GIF.': 'Use PNG, JPG, WebP ou GIF.',
  'Image is too large': 'A imagem é muito grande',
  'Display name is required': 'O nome de exibição é obrigatório',
  'Enter a valid email address': 'Digite um endereço de e-mail válido',
  'How you show up across the app. Your avatar and name appear in the header, sidebar, and anywhere your teammates see you.':
    'Como você aparece no sistema. Seu avatar e nome são exibidos no cabeçalho, na barra lateral e para seus colegas de equipe.',
  'Loading your profile…': 'Carregando seu perfil…',
  'Change your password and sign out of your devices. These keep your account safe.':
    'Altere sua senha e encerre sessões em seus dispositivos para manter sua conta segura.',
  "Sign out of every device where you're logged in — including this one. Useful if you lost a laptop or shared your password.":
    'Saia de todos os dispositivos conectados — incluindo este. Útil se você perdeu um dispositivo ou compartilhou sua senha.',
  'Sign out of all devices': 'Sair de todos os dispositivos',
  'Every device logged into this account will be signed out and will need to log in again. You will be redirected to the login page.':
    'Todos os dispositivos conectados serão desconectados e precisarão entrar novamente. Você será redirecionado para o login.',
  'Tag name is required': 'O nome da etiqueta é obrigatório',
  'Failed to load tags': 'Falha ao carregar etiquetas',
  'Failed to create tag': 'Falha ao criar a etiqueta',
  'Failed to delete tag': 'Falha ao excluir a etiqueta',
  'Colour-coded labels for grouping and filtering contacts.':
    'Etiquetas coloridas para agrupar e filtrar contatos.',
  'No tags yet — create your first one below.':
    'Ainda não há etiquetas — crie a primeira abaixo.',
  'Add tag': 'Adicionar etiqueta',
  'Delete tag': 'Excluir etiqueta',

  // Message templates
  'Failed to load templates': 'Falha ao carregar modelos',
  'Message templates': 'Modelos de mensagem',
  'Pull approved templates from your Meta WhatsApp Business Account':
    'Importe modelos aprovados da sua conta do WhatsApp Business da Meta',
  'New Template': 'Novo modelo',
  'No templates yet.': 'Ainda não há modelos.',
  'Create your first message template to get started.':
    'Crie seu primeiro modelo de mensagem para começar.',
  'Editing triggers Meta re-review — status flips to PENDING.':
    'A edição inicia uma nova análise da Meta — o status muda para PENDENTE.',
  'Edit template': 'Editar modelo',
  'Edit the template and resubmit to Meta for review.':
    'Edite o modelo e reenvie-o para análise da Meta.',
  'Edit and resubmit template': 'Editar e reenviar modelo',
  'Template Name': 'Nome do modelo',
  'Header text': 'Texto do cabeçalho',
  'Header text (max 60 chars, optional {{1}})':
    'Texto do cabeçalho (máx. 60 caracteres, {{1}} opcional)',
  'Sample value for header variable':
    'Valor de exemplo da variável do cabeçalho',
  'Sample value for {{1}} (required for Meta review)':
    'Valor de exemplo para {{1}} (obrigatório para análise da Meta)',
  'Upload image': 'Enviar imagem',
  'Body Text': 'Texto do corpo',
  'Sample values (Meta uses these to review your template)':
    'Valores de exemplo (a Meta os utiliza para analisar seu modelo)',
  'Footer (optional)': 'Rodapé (opcional)',
  'Optional footer text (max 60 chars)':
    'Texto opcional do rodapé (máx. 60 caracteres)',
  'Add Button': 'Adicionar botão',
  'Delete template?': 'Excluir modelo?',
  'create automations': 'criar automações',
  'create flows': 'criar fluxos',
  'create deals': 'criar negócios',
  'Not signed in.': 'Usuário não autenticado.',
  "The 50 most recent times this flow ran. Expand a row to see the engine's per-step log.":
    'As 50 execuções mais recentes deste fluxo. Expanda uma linha para ver o registro de cada etapa.',
  'No runs yet. Trigger the flow from a personal WhatsApp number to see it appear here.':
    'Ainda não há execuções. Acione o fluxo por um número pessoal do WhatsApp para vê-lo aqui.',
  'Build branching, button-driven WhatsApp conversations. Useful for menus, FAQs, and triage before a human steps in.':
    'Crie conversas ramificadas no WhatsApp orientadas por botões. Útil para menus, perguntas frequentes e triagem antes do atendimento humano.',
  'Build your first conversation — a welcome menu, an order lookup, an FAQ bot. Customers tap buttons; the bot routes them to the right answer (or the right agent).':
    'Crie sua primeira conversa — menu de boas-vindas, consulta de pedido ou bot de perguntas frequentes. Os clientes tocam nos botões e o bot os encaminha para a resposta ou agente certo.',
  'Failed to hydrate conversation:': 'Falha ao carregar a conversa:',
  'WhatsApp® is not connected. Go to Settings to connect your account.':
    'O WhatsApp® não está conectado. Acesse Configurações para conectar sua conta.',
  'Failed to seed pipeline:': 'Falha ao preparar o funil:',
  'Welcome to the team': 'Bem-vindo à equipe',
  'Could not sign out. Try refreshing the page.':
    'Não foi possível sair. Tente atualizar a página.',
  "You're invited to": 'Você foi convidado para',
  "You'll join as": 'Você entrará como',
  '. Your empty personal account from signup will be cleaned up.':
    '. Sua conta pessoal vazia criada no cadastro será removida.',
  'with this account': 'com esta conta',
  ", sign out and sign up again with a different email address. The invite link stays valid as long as it hasn't expired.":
    ', saia e cadastre-se novamente com outro endereço de e-mail. O link continuará válido enquanto não expirar.',
  'Create account & join': 'Criar conta e entrar',
  'I already have an account': 'Já tenho uma conta',
  '(unknown tag)': '(etiqueta desconhecida)',
  '(unknown field)': '(campo desconhecido)',
  '(unknown agent)': '(agente desconhecido)',
  ') — not in approved list': ') — não está na lista de aprovados',
  'Text or {{ vars.x }} / {{ message.text }}':
    'Texto ou {{ vars.x }} / {{ message.text }}',
  'is not': 'não é',
  'Map every placeholder before continuing — still missing':
    'Associe todos os campos antes de continuar — ainda faltam',
  '. Otherwise those placeholders will ship to Meta as empty strings.':
    '. Caso contrário, esses campos serão enviados vazios para a Meta.',
  '.csv up to your browser limit': '.csv até o limite do navegador',
  "Minutes to reply to a customer's first unreplied message, by weekday":
    'Minutos para responder à primeira mensagem não respondida do cliente, por dia da semana',
  'Add a': 'Adicione um',
  'node, then a': 'nó e depois um',
  "— that's the welcome-menu shape from the brief.":
    '— esse é o formato do menu de boas-vindas.',
  "Reply IDs for each option are shown inline above. They're returned by WhatsApp when a customer taps; you usually don't need to touch them.":
    'Os IDs de resposta de cada opção aparecem acima. Eles são retornados pelo WhatsApp quando o cliente toca; normalmente você não precisa alterá-los.',
  'Fix the issues below before activating.':
    'Corrija os problemas abaixo antes de ativar.',
  'Interpolate in downstream prompts and handoff notes with':
    'Utilize em perguntas posteriores e observações de transferência com',
  'Failed to fetch conversations:': 'Falha ao buscar as conversas:',
  'Failed to fetch profiles:': 'Falha ao buscar os perfis:',
  'Failed to fetch messages:': 'Falha ao buscar as mensagens:',
  'Failed to fetch reactions:': 'Falha ao buscar as reações:',
  'Failed to reset unread_count:': 'Falha ao redefinir mensagens não lidas:',
  'Failed to send message:': 'Falha ao enviar a mensagem:',
  'Failed to send media:': 'Falha ao enviar a mídia:',
  'Failed to send template:': 'Falha ao enviar o modelo:',
  'Failed to update assignment:': 'Falha ao atualizar a atribuição:',
  'Failed to update assignment': 'Falha ao atualizar a atribuição',
  'CRM Template for WhatsApp': 'CRM para WhatsApp',
  'Extra contact fields (e.g. ZIP code, lead source). They appear on every contact and in the “Update Contact Field” automation action.':
    'Campos adicionais do contato (por exemplo, CEP e origem do lead). Eles aparecem em todos os contatos e na ação “Atualizar campo do contato”.',
  'Failed to save default currency': 'Falha ao salvar a moeda padrão',
  "Share this link with your new teammate. They'll be able to sign up (or sign in) and join the account as":
    'Compartilhe este link com o novo membro. Ele poderá se cadastrar ou entrar e participar da conta como',
  '. The link is valid for': '. O link é válido por',
  'We never store the plaintext — once you close this dialog the URL is gone. To re-share, revoke this invite and create a new one.':
    'O link completo não é armazenado — ao fechar esta janela, a URL desaparece. Para compartilhar novamente, revogue o convite e crie outro.',
  'The plaintext invite URL is only shown once at creation for security — to re-share, revoke the invite below and create a new one.':
    'Por segurança, a URL completa do convite é exibida apenas uma vez. Para compartilhar novamente, revogue o convite abaixo e crie outro.',
  'above to generate a shareable link.':
    'acima para gerar um link compartilhável.',
  "from the account? They'll be signed out of this account and given a fresh personal account on their next sign-in. Their login isn't deleted.":
    'da conta? Ele será desconectado desta conta e receberá uma nova conta pessoal no próximo acesso. O login não será excluído.',
  'PNG, JPG, WebP, or GIF. Up to 2 MB.': 'PNG, JPG, WebP ou GIF. Até 2 MB.',
  'Check the inbox for': 'Verifique a caixa de entrada de',
  '— both need to confirm before the change takes effect.':
    '— os dois endereços precisam confirmar antes que a alteração entre em vigor.',
  'Failed to fetch tags:': 'Falha ao buscar etiquetas:',
  'Create error:': 'Erro ao criar:',
  'Delete the tag "': 'Excluir a etiqueta “',
  '"? This removes it from all contacts and cannot be undone.':
    '”? Isso a removerá de todos os contatos e não poderá ser desfeito.',
  'Failed to fetch templates:': 'Falha ao buscar modelos:',
  'Synced the first 2000 templates only — your account has more. Sync again to continue, or contact support if this persists.':
    'Somente os primeiros 2.000 modelos foram sincronizados — sua conta possui mais. Sincronize novamente ou contate o suporte se isso persistir.',
  'Template sync error:': 'Erro ao sincronizar modelos:',
  'Delete error:': 'Erro ao excluir:',
  'Header image must be a JPEG or PNG.':
    'A imagem do cabeçalho deve ser JPEG ou PNG.',
  'AUTHENTICATION templates have a fixed body + OTP button shape that needs a different builder. Create them in Meta WhatsApp Manager for now and use':
    'Modelos de AUTENTICAÇÃO possuem corpo e botão OTP fixos e precisam de outro editor. Por enquanto, crie-os no Gerenciador do WhatsApp da Meta e use',
  'to bring them in.': 'para importá-los.',
  'Must match the exact code on Meta —':
    'Deve corresponder exatamente ao código na Meta —',
  'Hello {{1}}, your order {{2}} is confirmed.':
    'Olá {{1}}, seu pedido {{2}} foi confirmado.',
  'for variables (must be contiguous starting at':
    'para variáveis (devem ser contínuas começando em',
  'Example value for {{1}} (required when URL has a variable)':
    'Valor de exemplo para {{1}} (obrigatório quando a URL possui uma variável)',
  'Failed to load config row:': 'Falha ao carregar a configuração:',
  'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.':
    'Credenciais salvas e verificadas. O registro de recebimento foi ignorado (sem PIN) — veja o status abaixo.',
  'Save error:': 'Erro ao salvar:',
  'Test connection error:': 'Erro no teste de conexão:',
  'if events stop arriving.': 'se os eventos pararem de chegar.',
  '. Enter (or correct) the 2-step PIN below and click Save Configuration to retry.':
    '. Digite ou corrija o PIN de duas etapas abaixo e clique em Salvar configuração para tentar novamente.',
  'This number was saved before registration tracking existed, or registration was skipped. Enter the 2-step PIN below and click Save Configuration to subscribe it.':
    'Este número foi salvo antes do rastreamento de registro ou o registro foi ignorado. Digite o PIN de duas etapas abaixo e clique em Salvar configuração para assiná-lo.',
  'messages for a': 'mensagens para um',
  'number. Set it in': 'número. Configure-o em',
  'Meta Business Manager → WhatsApp Accounts → Phone Numbers → Two-step verification':
    'Gerenciador de Negócios da Meta → Contas do WhatsApp → Números de telefone → Verificação em duas etapas',
  ', then paste it here so wacrm can subscribe the number — otherwise Meta routes inbound events to whichever app last claimed it (the symptom that hits second numbers under a shared WABA).':
    ', depois cole-o aqui para que o CRM assine o número. Caso contrário, a Meta encaminhará os eventos ao último aplicativo que reivindicou o número.',
  'have no PIN and are pre-registered — leave this blank for them. Leaving it blank also keeps an existing registration untouched.':
    'não possuem PIN e já vêm registrados — deixe este campo vazio nesses casos. Deixá-lo vazio também preserva um registro existente.',
  "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.":
    'Cumprimente clientes que digitarem uma palavra-chave e encaminhe-os ao agente correto conforme sejam novos ou recorrentes.',
  'Answer common questions automatically. Customer picks a topic from a list; the bot replies with the answer and ends.':
    'Responda automaticamente a perguntas frequentes. O cliente escolhe um assunto, o bot responde e encerra.',
  'Talk to a human': 'Falar com uma pessoa',
  'Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.':
    'Cumprimente novos contatos, capture nome, e-mail e empresa e transfira para vendas com as respostas na observação.',
  'New Message': 'Nova mensagem',
  'New Contact': 'Novo contato',
  // Remaining static copy found by the full string-literal audit
  'Failed to load logs': 'Falha ao carregar os registros',
  'Failed to load broadcast': 'Falha ao carregar o disparo',
  'Sent At': 'Enviado em',
  'Delivered At': 'Entregue em',
  'Read At': 'Lido em',
  'Replied At': 'Respondido em',
  'Broadcast not found': 'Disparo não encontrado',
  'Back to Broadcasts': 'Voltar para Disparos',
  'Template:': 'Modelo:',
  'Cannot delete while a broadcast is actively sending':
    'Não é possível excluir enquanto o disparo está sendo enviado',
  'Delete this broadcast': 'Excluir este disparo',
  'No recipients found.': 'Nenhum destinatário encontrado.',
  'No recipients match this filter.':
    'Nenhum destinatário corresponde a este filtro.',
  Send: 'Enviar',
  'Broadcast failed': 'O disparo falhou',
  'Broadcast failed:': 'O disparo falhou:',
  'Draft saved': 'Rascunho salvo',
  'Broadcast in progress': 'Disparo em andamento',
  'No broadcasts yet': 'Ainda não há disparos',
  'create broadcasts': 'criar disparos',
  'No contacts match your search.': 'Nenhum contato corresponde à pesquisa.',
  'No contacts yet.': 'Ainda não há contatos.',
  "Couldn't load flow.": 'Não foi possível carregar o fluxo.',
  'Timed out': 'Tempo limite excedido',
  "Couldn't load runs.": 'Não foi possível carregar as execuções.',
  "Couldn't load flows.": 'Não foi possível carregar os fluxos.',
  'Clone failed': 'Falha ao duplicar',
  'Flow deleted.': 'Fluxo excluído.',
  'Triggers on keyword (none set)':
    'Aciona por palavra-chave (nenhuma definida)',
  "Triggers on a contact's first-ever inbound message":
    'Aciona na primeira mensagem recebida de um contato',
  'Manual trigger': 'Acionamento manual',
  'Triggers on:': 'Aciona com:',
  'New Lead': 'Novo lead',
  'Proposal Sent': 'Proposta enviada',
  'Sales Pipeline': 'Funil de vendas',
  'Pipeline created': 'Funil criado',
  'Select Pipeline': 'Selecionar funil',
  'Manage Pipelines': 'Gerenciar funis',
  'No pipelines yet': 'Ainda não há funis',
  'create pipelines': 'criar funis',
  'Invite not found': 'Convite não encontrado',
  'This link doesn’t match a valid invitation. Double-check the URL or ask the person who invited you to send a new one.':
    'Este link não corresponde a um convite válido. Confira a URL ou peça um novo link à pessoa que convidou você.',
  'Invite already used': 'Convite já utilizado',
  'This invitation has already been accepted. If that wasn’t you, ask the account admin to send a fresh link.':
    'Este convite já foi aceito. Se não foi você, peça um novo link ao administrador da conta.',
  'Invite expired': 'Convite expirado',
  'This invitation has expired. Ask the account admin to send a new one — they take a few seconds to generate.':
    'Este convite expirou. Peça um novo ao administrador da conta — leva apenas alguns segundos para gerar.',
  'We couldn’t verify this invitation right now. Try refreshing the page in a moment.':
    'Não foi possível verificar este convite agora. Atualize a página em alguns instantes.',
  'You are already in another account. Sign in with a different email to join this one.':
    'Você já participa de outra conta. Entre com outro e-mail para participar desta.',
  'Failed to accept invitation': 'Falha ao aceitar o convite',
  'Verifying invitation…': 'Verificando convite…',
  'Accepting moves your login into':
    'Ao aceitar, seu login será transferido para',
  "Can't join": 'Não é possível entrar',
  'To join': 'Para entrar em',
  'Stay signed in': 'Continuar conectado',
  'Sign out & use a different email': 'Sair e usar outro e-mail',
  'e.g. pricing, demo request, talk to sales':
    'ex.: preço, demonstração, falar com vendas',
  'name / email / company': 'nome / e-mail / empresa',
  'tag id': 'ID da etiqueta',
  'no text yet': 'ainda sem texto',
  'pick a template': 'escolha um modelo',
  'no url': 'sem URL',
  'Upload CSV': 'Enviar CSV',
  'Select Audience': 'Selecionar público',
  'Select Tags': 'Selecionar etiquetas',
  'Personalize Message': 'Personalizar mensagem',
  'Static Value': 'Valor fixo',
  'No custom fields': 'Nenhum campo personalizado',
  'Select custom field…': 'Selecione um campo personalizado…',
  'CSV Upload': 'Envio de CSV',
  Custom: 'Personalizado',
  'Review & Send': 'Revisar e enviar',
  'Sending broadcast...': 'Enviando disparo...',
  'Note added': 'Observação adicionada',
  'Note deleted': 'Observação excluída',
  'Custom fields saved': 'Campos personalizados salvos',
  'Update the contact details below.': 'Atualize abaixo os dados do contato.',
  'Fill in the details to create a new contact.':
    'Preencha os dados para criar um novo contato.',
  'A contact with this phone number already exists.':
    'Já existe um contato com este número de telefone.',
  'A contact with a very similar number already exists.':
    'Já existe um contato com um número muito parecido.',
  View: 'Visualizar',
  'Loading tags...': 'Carregando etiquetas...',
  'Import failed': 'A importação falhou',
  'column. Optional:': 'coluna. Opcionais:',
  'Preview · first': 'Prévia · primeiras',
  'more row': 'linha adicional',
  'not shown': 'não exibida',
  'Import complete': 'Importação concluída',
  'No activity yet': 'Ainda não há atividade',
  'Not enough data yet': 'Ainda não há dados suficientes',
  'Avg minutes': 'Média em minutos',
  'This week:': 'Esta semana:',
  'Last week:': 'Semana passada:',
  'No replies recorded yet': 'Ainda não há respostas registradas',
  'Nodes (': 'Nós (',
  'When…': 'Quando…',
  'Entry node:': 'Nó de entrada:',
  Show: 'Mostrar',
  Hide: 'Ocultar',
  'No nodes yet.': 'Ainda não há nós.',
  'Editor view': 'Visualização do editor',
  List: 'Lista',
  'View options': 'Opções de visualização',
  'Save failed': 'Falha ao salvar',
  'Flow activated.': 'Fluxo ativado.',
  'Saved as draft.': 'Salvo como rascunho.',
  'Status update failed': 'Falha ao atualizar o status',
  'Delete failed': 'Falha ao excluir',
  'Advances to': 'Avança para',
  'Visible title (≤20 chars)': 'Título visível (até 20 caracteres)',
  'Remove section': 'Remover seção',
  'Row title (≤24)': 'Título da linha (até 24 caracteres)',
  'Next node…': 'Próximo nó…',
  If: 'Se',
  'var name': 'nome da variável',
  'tag UUID': 'UUID da etiqueta',
  'is present': 'está presente',
  'is absent': 'está ausente',
  'Tag UUID': 'UUID da etiqueta',
  'Then advance to': 'Depois avançar para',
  'File uploaded.': 'Arquivo enviado.',
  'Media type': 'Tipo de mídia',
  'Image (PNG, JPEG, WebP)': 'Imagem (PNG, JPEG, WebP)',
  'Video (MP4, 3GP)': 'Vídeo (MP4, 3GP)',
  File: 'Arquivo',
  'Fix the issues below before activating':
    'Corrija os problemas abaixo antes de ativar',
  Start: 'Início',
  'Send buttons': 'Enviar botões',
  'Send list': 'Enviar lista',
  'Send media': 'Enviar mídia',
  Media: 'Mídia',
  'No tags': 'Nenhuma etiqueta',
  Reply: 'Responder',
  'Failed to load media': 'Falha ao carregar a mídia',
  'Shared image': 'Imagem compartilhada',
  Image: 'Imagem',
  '[Interactive reply]': '[Resposta interativa]',
  '[Unsupported message type]': '[Tipo de mensagem não suportado]',
  'Read-only — viewers can browse but not reply':
    'Somente leitura — visualizadores podem navegar, mas não responder',
  'Session expired - use a template': 'Sessão expirada — use um modelo',
  'Type a message... (Shift+Enter for new line)':
    'Digite uma mensagem... (Shift+Enter para nova linha)',
  "Read-only — your role can't send messages":
    'Somente leitura — sua função não pode enviar mensagens',
  'Remove attachment': 'Remover anexo',
  'send messages': 'enviar mensagens',
  'No customer messages': 'Nenhuma mensagem do cliente',
  Assigned: 'Atribuído',
  'Hide contact panel': 'Ocultar painel do contato',
  'Show contact panel': 'Mostrar painel do contato',
  'Hide contact': 'Ocultar contato',
  'Show contact': 'Mostrar contato',
  'Refresh conversation': 'Atualizar conversa',
  'No messages yet': 'Ainda não há mensagens',
  '[Image]': '[Imagem]',
  '[Video]': '[Vídeo]',
  '[Document]': '[Documento]',
  '[Template]': '[Modelo]',
  '[Message]': '[Mensagem]',
  'Fill in the placeholders to render this template. Meta requires every variable to be set.':
    'Preencha os campos para renderizar este modelo. A Meta exige que todas as variáveis sejam definidas.',
  'Pick an approved WhatsApp template to send to this contact.':
    'Escolha um modelo aprovado do WhatsApp para enviar a este contato.',
  'URL suffix value': 'Valor do sufixo da URL',
  'Deal updated': 'Negócio atualizado',
  'Deal created': 'Negócio criado',
  'Marked as won': 'Marcado como ganho',
  'Marked as lost': 'Marcado como perdido',
  'Deal reopened': 'Negócio reaberto',
  'Deal deleted': 'Negócio excluído',
  Stage: 'Etapa',
  'Reopen deal': 'Reabrir negócio',
  'Total Deals': 'Total de negócios',
  "Count of every deal in this pipeline that isn't marked as Lost. Won deals are still included.":
    'Quantidade de negócios neste funil que não estão marcados como Perdidos. Negócios Ganhos continuam incluídos.',
  'Sum of the dollar values of all deals in this pipeline, excluding deals marked as Lost.':
    'Soma dos valores de todos os negócios deste funil, excluindo os marcados como Perdidos.',
  'Avg Deal Size': 'Valor médio dos negócios',
  'Pipeline Value divided by Total Deals — the average value of a single non-lost deal.':
    'Valor do funil dividido pelo total de negócios — a média de um negócio não perdido.',
  'Weighted Value': 'Valor ponderado',
  "Expected revenue: each open deal's value × its stage probability. First stage ≈ 10%, stages progress up to 90%, Won = 100%. Lost deals are excluded.":
    'Receita esperada: valor de cada negócio aberto × probabilidade da etapa. Primeira etapa ≈ 10%, avançando até 90%; Ganho = 100%. Perdidos são excluídos.',
  'Won This Month': 'Ganhos neste mês',
  'Deals marked as Won since the first day of the current month.':
    'Negócios marcados como Ganhos desde o primeiro dia do mês atual.',
  'Lost This Month': 'Perdidos neste mês',
  'Deals marked as Lost since the first day of the current month.':
    'Negócios marcados como Perdidos desde o primeiro dia do mês atual.',
  'Pipeline saved': 'Funil salvo',
  'Pipeline deleted': 'Funil excluído',
  Stages: 'Etapas',
  Add: 'Adicionar',
  'Save Changes': 'Salvar alterações',
  'Drag to reorder': 'Arraste para reordenar',
  'Change color': 'Alterar cor',
  'Default currency updated': 'Moeda padrão atualizada',
  '1 day': '1 dia',
  '7 days': '7 dias',
  '30 days': '30 dias',
  'Can invite teammates, manage settings, send messages, and edit data.':
    'Pode convidar membros, gerenciar configurações, enviar mensagens e editar dados.',
  'Can use the inbox, contacts, broadcasts, automations, and flows. No settings or member access.':
    'Pode usar caixa de entrada, contatos, disparos, automações e fluxos. Sem acesso às configurações ou membros.',
  'Read-only access across every page. Cannot send or edit anything.':
    'Acesso somente leitura em todas as páginas. Não pode enviar nem editar.',
  'Failed to create invitation': 'Falha ao criar o convite',
  'Invite link copied': 'Link do convite copiado',
  'our wacrm account': 'nossa conta do CRM',
  'Invite link': 'Link do convite',
  'Invite a teammate': 'Convidar um membro',
  'Signing out…': 'Saindo…',
  Enter: 'Inserir',
  '(optional)': '(opcional)',
  'sample data': 'dados de exemplo',
  'Not authenticated': 'Usuário não autenticado',
  Remove: 'Remover',
  You: 'Você',
  'Failed to load members': 'Falha ao carregar os membros',
  'Failed to load invitations': 'Falha ao carregar os convites',
  'Failed to update role': 'Falha ao atualizar a função',
  'Failed to remove member': 'Falha ao remover o membro',
  'Failed to revoke invitation': 'Falha ao revogar o convite',
  'Invitation revoked': 'Convite revogado',
  Member: 'Membro',
  'Pending invitations': 'Convites pendentes',
  Click: 'Clique',
  'Untitled invite': 'Convite sem título',
  'this teammate': 'este membro',
  'New password and confirmation do not match':
    'A nova senha e a confirmação não coincidem',
  'Password updated': 'Senha atualizada',
  'Update password': 'Atualizar senha',
  'Unknown error': 'Erro desconhecido',
  'Unsupported image type': 'Tipo de imagem não suportado',
  'Profile saved': 'Perfil salvo',
  'Profile saved — check your email to confirm the address change':
    'Perfil salvo — verifique seu e-mail para confirmar a alteração do endereço',
  'Upload photo': 'Enviar foto',
  'Sign out everywhere?': 'Sair de todos os dispositivos?',
  'Sign out everywhere': 'Sair de todos os dispositivos',
  'Tag created': 'Etiqueta criada',
  'Tag deleted': 'Etiqueta excluída',
  'Template updated (dry-run — no Meta call)':
    'Modelo atualizado (simulação — sem chamada à Meta)',
  'Template saved (dry-run — no Meta call)':
    'Modelo salvo (simulação — sem chamada à Meta)',
  'Edit submitted — Meta typically reviews within 24 hours.':
    'Edição enviada — a Meta normalmente analisa em até 24 horas.',
  'Submitted to Meta — typical review time is 24 hours. Status updates automatically.':
    'Enviado à Meta — o prazo típico de análise é 24 horas. O status será atualizado automaticamente.',
  'Submit error:': 'Erro no envio:',
  'Failed to submit': 'Falha ao enviar',
  'Failed to sync templates': 'Falha ao sincronizar os modelos',
  'Template deleted': 'Modelo excluído',
  'Failed to delete template': 'Falha ao excluir o modelo',
  'Image uploaded.': 'Imagem enviada.',
  'Create templates and submit them to Meta for approval. Use "Sync from Meta" to pull templates approved elsewhere.':
    'Crie modelos e envie-os à Meta para aprovação. Use “Sincronizar da Meta” para importar modelos aprovados em outro lugar.',
  'Sync from Meta': 'Sincronizar da Meta',
  'Delete template from Meta and locally':
    'Excluir modelo da Meta e localmente',
  'Delete template locally': 'Excluir modelo localmente',
  'Delete from Meta and locally': 'Excluir da Meta e localmente',
  'Delete locally': 'Excluir localmente',
  'Edit Message Template': 'Editar modelo de mensagem',
  'New Message Template': 'Novo modelo de mensagem',
  'Save your changes to re-submit to Meta. Status will flip back to PENDING during review.':
    'Salve as alterações para reenviar à Meta. O status voltará para PENDENTE durante a análise.',
  'Build a template and submit it to Meta for approval. Once approved, you can use it in broadcasts and the inbox.':
    'Crie um modelo e envie-o à Meta para aprovação. Depois de aprovado, ele poderá ser usado em disparos e na caixa de entrada.',
  'Name is fixed once a template exists on Meta — create a new template to change it.':
    'O nome não pode ser alterado depois que o modelo existe na Meta — crie outro modelo para mudá-lo.',
  'Lowercase letters, digits, and underscores only.':
    'Use apenas letras minúsculas, números e sublinhados.',
  'Language is fixed once a template exists on Meta.':
    'O idioma não pode ser alterado depois que o modelo existe na Meta.',
  'are distinct.': 'são diferentes.',
  Header: 'Cabeçalho',
  'JPEG or PNG, ≤5 MB': 'JPEG ou PNG, até 5 MB',
  'Header sample': 'Exemplo do cabeçalho',
  'Upload a JPEG/PNG (≤5 MB, ≥800×418 px recommended) or paste a public HTTPS link — we upload it to Meta for review automatically.':
    'Envie um JPEG/PNG (até 5 MB, recomendado 800×418 px ou mais) ou cole um link HTTPS público — o arquivo será enviado automaticamente à Meta para análise.',
  'Must be a publicly accessible HTTPS link. Meta fetches it once during review, so it needs to stay live for ~24 hrs.':
    'Deve ser um link HTTPS público. A Meta acessa o arquivo durante a análise, então ele precisa ficar disponível por cerca de 24 horas.',
  Use: 'Use',
  'Buttons (optional)': 'Botões (opcionais)',
  'Up to': 'Até',
  'buttons. QUICK_REPLY buttons must come before URL / phone / copy-code buttons.':
    'botões. Botões de RESPOSTA RÁPIDA devem vir antes dos botões de URL, telefone ou copiar código.',
  'Quick Reply': 'Resposta rápida',
  'Copy Code': 'Copiar código',
  'Button label': 'Texto do botão',
  'Save & Resubmit': 'Salvar e reenviar',
  'Submit for Approval': 'Enviar para aprovação',
  'Upload failed.': 'Falha no envio.',
  'Health check failed:': 'A verificação de integridade falhou:',
  "Saved, but Meta couldn't register the number:":
    'Salvo, mas a Meta não conseguiu registrar o número:',
  'WhatsApp connected. Events will start flowing within a minute.':
    'WhatsApp conectado. Os eventos começarão a chegar em até um minuto.',
  'API connection successful': 'Conexão com a API realizada com sucesso',
  'API connection failed': 'A conexão com a API falhou',
  'This will delete the current WhatsApp config so you can re-enter it. Continue?':
    'Isso excluirá a configuração atual do WhatsApp para que você possa informá-la novamente. Continuar?',
  'Reset error:': 'Erro ao redefinir:',
  'Reset Configuration': 'Redefinir configuração',
  'Your access token authenticates with Meta. See Registration status below for whether webhooks are actually wired.':
    'Seu token de acesso autentica na Meta. Veja o status do registro abaixo para confirmar se os webhooks estão conectados.',
  'Registered — Meta will deliver events to wacrm':
    'Registrado — a Meta entregará eventos ao CRM',
  'Not registered — Meta will not deliver events':
    'Não registrado — a Meta não entregará eventos',
  'Verify with Meta': 'Verificar com a Meta',
  'not live': 'inativo',
  'Two-step verification PIN': 'PIN da verificação em duas etapas',
  'Needed only to wire': 'Necessário apenas para conectar',
  'Meta test numbers': 'Números de teste da Meta',
  'Go to': 'Acesse',
  'Paste the': 'Cole o',
  'from above': 'acima',
  // Inbox triage (round 1)
  Assign: 'Atribuir',
  Expired: 'Expirado',
  '(me)': '(eu)',
  'Try another queue tab or status filter.':
    'Tente outra aba da fila ou outro filtro de status.',
  'Contact details will appear here': 'Os detalhes do contato aparecem aqui',
  // Contacts — detail panel (conversation-first)
  'Open conversation': 'Abrir conversa',
  'Start conversation': 'Iniciar conversa',
  'Previous conversations': 'Conversas anteriores',
  'No conversations with this contact yet.':
    'Ainda não há conversas com este contato.',
  'Open in inbox': 'Abrir na caixa de entrada',
  Conversations: 'Conversas',
  Fields: 'Campos',
  Deals: 'Negócios',
  'Editing contact': 'Editando contato',
  'Failed to start conversation': 'Falha ao iniciar a conversa',
  'You do not have permission to start conversations':
    'Você não tem permissão para iniciar conversas',
  'Delete contact': 'Excluir contato',
  'Copy phone': 'Copiar telefone',
  'Add note': 'Adicionar observação',
  'No notes yet.': 'Ainda não há observações.',
  'Delete note': 'Excluir observação',
  'No custom fields defined. Create them in Settings.':
    'Nenhum campo personalizado definido. Crie-os nas Configurações.',
  'Click a tag to add or remove it from this contact.':
    'Clique em uma etiqueta para adicioná-la ou removê-la deste contato.',
  'No tags available. Create tags in Settings.':
    'Nenhuma etiqueta disponível. Crie etiquetas nas Configurações.',
  'Save custom fields': 'Salvar campos personalizados',
  Created: 'Criado em',
  Unnamed: 'Sem nome',
  'View details': 'Ver detalhes',

  // Broadcasts — list / detail / wizard (round 1 localisation pass)
  Recipients: 'Destinatários',
  Delivery: 'Entrega',
  'Total Recipients': 'Total de destinatários',
  Replied: 'Respondeu',
  Responded: 'Responderam',
  Funnel: 'Funil',
  of: 'de',
  'Scheduled for': 'Agendado para',
  'Sent on': 'Enviado em',
  'Not sent yet': 'Ainda não enviado',
  'Broadcast deleted': 'Disparo excluído',
  'Delete broadcast': 'Excluir disparo',
  'Broadcast actions': 'Ações do disparo',
  'This will permanently delete the broadcast and its recipient report. This action cannot be undone.':
    'Isso excluirá permanentemente o disparo e o relatório de destinatários. Esta ação não pode ser desfeita.',
  'Failed to save draft': 'Falha ao salvar o rascunho',
  'Calculating…': 'Calculando…',
  'estimated recipients': 'destinatários estimados',
  Summary: 'Resumo',
  'Live Preview': 'Pré-visualização',
  'e.g. Summer Sale Announcement': 'ex.: Promoção de verão',
  selected: 'selecionadas',
  is: 'é',
  contains: 'contém',
  'CSV list': 'Lista CSV',
  'Manage templates': 'Gerenciar modelos',
  'Search templates…': 'Pesquisar modelos…',
  'No template matches your search.':
    'Nenhum modelo corresponde à pesquisa.',
  'Only approved templates can be used in broadcasts.':
    'Somente modelos aprovados podem ser usados em disparos.',
  'approved templates': 'modelos aprovados',
  'Failed to load broadcasts': 'Falha ao carregar os disparos',
  // Wizard — step indicator, step headings and copy
  Personalize: 'Personalizar',
  Steps: 'Etapas',
  'Choose a template': 'Escolha um modelo',
  'Select an approved message template for the broadcast.':
    'Selecione um modelo de mensagem aprovado para o disparo.',
  'Choose who will receive this broadcast.':
    'Escolha quem receberá este disparo.',
  'Select an audience type to see the estimate.':
    'Selecione um tipo de público para ver a estimativa.',
  'Exclude contacts with these tags': 'Excluir contatos com estas etiquetas',
  'No tags found. Create tags in Settings.':
    'Nenhuma etiqueta encontrada. Crie etiquetas nas Configurações.',
  'No custom fields defined. Create one in Settings → Custom fields.':
    'Nenhum campo personalizado definido. Crie um em Configurações → Campos personalizados.',
  'This template has no variables to personalize.':
    'Este modelo não possui variáveis para personalizar.',
  'Mapping type': 'Tipo de associação',
  Operator: 'Operador',
  'Name the broadcast, review the details and send.':
    'Dê um nome ao disparo, revise os detalhes e envie.',
  'Save as draft': 'Salvar como rascunho',
  'Confirm broadcast': 'Confirmar disparo',
  'contacts using the template': 'contatos usando o modelo',
  // WhatsApp template categories (Meta enum, title-cased in the DB)
  Marketing: 'Marketing',
  Utility: 'Utilidade',
  Authentication: 'Autenticação',
  // Meta template review statuses (src/lib/template-status.ts)
  Approved: 'Aprovado',
  Rejected: 'Rejeitado',
  Disabled: 'Desativado',
  'In Appeal': 'Em recurso',
  'Pending Deletion': 'Exclusão pendente',

  // Automations builder (src/components/automations/automation-builder.tsx)
  'Edit rule': 'Editar regra',
  'New rule': 'Nova regra',
  'Rule name': 'Nome da regra',
  'Unsaved changes': 'Alterações não salvas',
  'Describe what this rule does (optional)':
    'Descreva o que esta regra faz (opcional)',
  'When should this rule run?': 'Quando esta regra deve rodar?',
  Conditions: 'Condições',
  'Only continue when all conditions are true':
    'Só continua quando todas as condições forem verdadeiras',
  'Add condition': 'Adicionar condição',
  'What to do, in order': 'O que fazer, nesta ordem',
  'No conditions — actions run for every trigger event.':
    'Sem condições — as ações rodam para todo evento do gatilho.',
  AND: 'E',
  'Remove condition': 'Remover condição',
  'Removing keeps the actions below it.': 'Remover mantém as ações abaixo dela.',
  'No actions yet. Add the first one.': 'Ainda não há ações. Adicione a primeira.',
  'Add action': 'Adicionar ação',
  Yes: 'Sim',
  No: 'Não',
  'Nothing selected': 'Nada selecionado',
  'Select the trigger, a condition or an action to edit it here.':
    'Selecione o gatilho, uma condição ou uma ação para editar aqui.',
  'Trigger type': 'Tipo de gatilho',
  Tag: 'Etiqueta',
  Schedule: 'Agendamento',
  'Keywords (comma-separated)': 'Palavras-chave (separadas por vírgula)',
  'Match type': 'Tipo de correspondência',
  'Sent to the contact on WhatsApp as a plain text message.':
    'Enviada ao contato no WhatsApp como mensagem de texto simples.',
  'Sets the conversation status to "closed". No configuration needed.':
    'Define o status da conversa como "encerrada". Nenhuma configuração é necessária.',
  Check: 'Verificar',
  'Contact field equals': 'Campo do contato é igual a',
  'Message contains': 'A mensagem contém',
  'Time of day is between': 'Horário do dia está entre',
  'Text to look for': 'Texto a procurar',
  'Start time': 'Início',
  'End time': 'Fim',
  'Overnight windows like 18:00–09:00 are supported.':
    'Janelas que viram a noite, como 18:00–09:00, são aceitas.',
  'The actions only run when this condition is true.':
    'As ações só rodam quando esta condição for verdadeira.',
  'Steps under "Yes" run when true; steps under "No" run otherwise.':
    'As etapas em "Sim" rodam quando verdadeira; as etapas em "Não" rodam caso contrário.',
  'Assign conversation': 'Atribuir conversa',
  'Close conversation': 'Encerrar conversa',
  Messages: 'Mensagens',
  'Flow control': 'Controle de fluxo',
};
