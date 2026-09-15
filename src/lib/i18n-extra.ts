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
  'WhatsApp via QR code is disconnected. Reconnect in Settings.':
    'WhatsApp via QR code desconectado. Reconecte em Configurações.',
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

  // Plans, modules and the platform admin (migration 025)
  Plan: 'Plano',
  Trial: 'Teste',
  Basic: 'Básico',
  Pro: 'Pro',
  Enterprise: 'Empresa',
  'Past due': 'Pagamento pendente',
  Canceled: 'Cancelado',
  Suspended: 'Suspenso',
  'Trial expired': 'Teste expirado',
  'Official WhatsApp API': 'API oficial do WhatsApp',
  'WhatsApp via QR code': 'WhatsApp via QR code',
  'Max users': 'Máx. de usuários',
  'Max channels': 'Máx. de canais',
  Modules: 'Módulos',
  Limits: 'Limites',
  Unlimited: 'Ilimitado',
  'No expiry': 'Sem validade',
  'Valid until': 'Válido até',
  'Trial ends': 'Teste termina em',
  day: 'dia',
  days: 'dias',
  'Module not included in your plan': 'Módulo não incluído no seu plano',
  Loading: 'Carregando',
  // Blocked screen
  'Your trial has ended': 'Seu período de teste terminou',
  'The 14-day trial for this account is over. Choose a plan to keep using SempreCRM — your data is safe and will be right here when you come back.':
    'Os 14 dias de teste desta conta acabaram. Escolha um plano para continuar usando o SempreCRM — seus dados estão seguros e estarão aqui quando você voltar.',
  'Payment past due': 'Pagamento em atraso',
  'We could not confirm the latest payment for this account. Settle the outstanding invoice to restore access.':
    'Não conseguimos confirmar o último pagamento desta conta. Quite a fatura pendente para restaurar o acesso.',
  'Subscription canceled': 'Assinatura cancelada',
  "This account's subscription was canceled. Reactivate it to get back in — nothing has been deleted.":
    'A assinatura desta conta foi cancelada. Reative para voltar a usar — nada foi apagado.',
  'Account suspended': 'Conta suspensa',
  'This account was suspended by the platform team. Get in touch with support to find out why and how to restore access.':
    'Esta conta foi suspensa pela equipe da plataforma. Fale com o suporte para entender o motivo e como restaurar o acesso.',
  'Ask the account owner to review the plan.':
    'Peça ao proprietário da conta para revisar o plano.',
  'Support: ': 'Suporte: ',
  'View plan': 'Ver plano',
  // Settings → Plan panel
  'What your account includes today. To change the plan or add modules, get in touch with the SempreCRM team.':
    'O que sua conta inclui hoje. Para trocar de plano ou adicionar módulos, fale com a equipe do SempreCRM.',
  'Current plan': 'Plano atual',
  'Plan, status and validity for this account.':
    'Plano, status e validade desta conta.',
  'Access to the app is currently blocked. Contact support to restore it.':
    'O acesso ao sistema está bloqueado no momento. Fale com o suporte para restaurá-lo.',
  'Inbox and Contacts are always included.':
    'Caixa de entrada e Contatos estão sempre incluídos.',
  // Platform admin
  Platform: 'Plataforma',
  'Accounts, plans and modules': 'Contas, planos e módulos',
  'Back to app': 'Voltar ao app',
  Accounts: 'Contas',
  account: 'conta',
  accounts: 'contas',
  shown: 'exibidas',
  'Search by name or e-mail': 'Buscar por nome ou e-mail',
  'Search accounts': 'Buscar contas',
  'Filter by status': 'Filtrar por status',
  'All statuses': 'Todos os status',
  Channels: 'Canais',
  'No accounts match the current filters.':
    'Nenhuma conta corresponde aos filtros atuais.',
  'All accounts': 'Todas as contas',
  member: 'membro',
  members: 'membros',
  channel: 'canal',
  channels: 'canais',
  Reactivate: 'Reativar',
  Suspend: 'Suspender',
  'Account updated': 'Conta atualizada',
  'Account reactivated': 'Conta reativada',
  'Failed to save': 'Falha ao salvar',
  'Custom limits must be a number of 0 or more.':
    'Limites personalizados devem ser um número maior ou igual a 0.',
  'The plan sets the default modules and limits; overrides below win over it.':
    'O plano define os módulos e limites padrão; as sobrescritas abaixo têm prioridade.',
  'Only a trial is blocked by the expiry date. Paid plans are blocked by status (past due, canceled, suspended).':
    'Só o teste é bloqueado pela data de validade. Planos pagos são bloqueados pelo status (pagamento pendente, cancelado, suspenso).',
  'Inbox and Contacts are always on. For the rest, "Inherit" follows the plan.':
    'Caixa de entrada e Contatos estão sempre ligados. Para os demais, "Herdar" segue o plano.',
  On: 'Ligado',
  Off: 'Desligado',
  Override: 'Sobrescrita',
  override: 'sobrescrita',
  Inherit: 'Herdar',
  'Force on': 'Forçar ligado',
  'Force off': 'Forçar desligado',
  'Seats count active members plus pending invites. Channels are connected WhatsApp numbers.':
    'Usuários contam membros ativos mais convites pendentes. Canais são números de WhatsApp conectados.',
  'custom value': 'valor personalizado',
  Effective: 'Efetivo',
  'Platform notes': 'Notas da plataforma',
  'Internal only — the customer never sees this.':
    'Uso interno — o cliente nunca vê isto.',
  'Payment references, contact history, special deals…':
    'Referências de pagamento, histórico de contato, condições especiais…',
  'Customer will see': 'O cliente verá',
  'Resolved from the form above, before saving.':
    'Calculado a partir do formulário acima, antes de salvar.',
  Access: 'Acesso',
  Blocked: 'Bloqueado',
  Allowed: 'Liberado',

  // WhatsApp channel chooser + QR panel (migration 026)
  'Choose how this account talks to WhatsApp: the official Meta Business API or a number linked by QR code.':
    'Escolha como esta conta fala com o WhatsApp: a API oficial da Meta ou um número vinculado por QR code.',
  'How to connect': 'Como conectar',
  'Meta Cloud API with templates, broadcasts and the 24-hour window. Recommended for scale.':
    'API Cloud da Meta com modelos, disparos e janela de 24 horas. Recomendada para escala.',
  Recommended: 'Recomendada',
  'Link an existing number by scanning a QR code, like WhatsApp Web. For 1:1 support only.':
    'Vincule um número existente lendo um QR code, como no WhatsApp Web. Só para atendimento 1:1.',
  Unofficial: 'Não oficial',
  'No channel included in your plan': 'Nenhum canal incluído no seu plano',
  'Your current plan does not include a WhatsApp channel. Get in touch with the SempreCRM team to add one.':
    'Seu plano atual não inclui um canal de WhatsApp. Fale com a equipe do SempreCRM para adicionar um.',
  'Unofficial channel — use with care': 'Canal não oficial — use com cuidado',
  'The WhatsApp Web protocol is reverse-engineered (Baileys library). It is not official, it violates WhatsApp’s terms and the number can be banned, especially with bulk sending. Broadcasts and templates therefore stay exclusive to the official API; the QR channel is for 1:1 support and reply automations.':
    'O protocolo do WhatsApp Web é usado por engenharia reversa (biblioteca Baileys). Não é oficial, viola os termos do WhatsApp e o número pode ser banido, sobretudo com envio em massa. Por isso, disparos e modelos ficam exclusivos da API oficial; o canal QR serve o atendimento 1:1 e as automações de resposta.',
  'Gateway not configured': 'Gateway não configurado',
  'The QR channel needs the wa-gateway service. Set WA_GATEWAY_URL and WA_GATEWAY_SECRET on the server and restart the app.':
    'O canal QR precisa do serviço wa-gateway. Defina WA_GATEWAY_URL e WA_GATEWAY_SECRET no servidor e reinicie o app.',
  'Gateway unreachable': 'Gateway fora do ar',
  'Could not talk to the WhatsApp gateway. Check that the wa-gateway service is running.':
    'Não foi possível falar com o gateway do WhatsApp. Verifique se o serviço wa-gateway está em execução.',
  'The QR channel is not part of your current plan. Get in touch with the SempreCRM team to add it.':
    'O canal QR não faz parte do seu plano atual. Fale com a equipe do SempreCRM para adicioná-lo.',
  'WhatsApp Web session': 'Sessão do WhatsApp Web',
  'Scan the QR code with the phone that owns the number: WhatsApp → Linked devices → Link a device.':
    'Leia o QR code com o celular dono do número: WhatsApp → Aparelhos conectados → Conectar um aparelho.',
  'Connected as': 'Conectado como',
  'Unknown name': 'Nome desconhecido',
  'unknown number': 'número desconhecido',
  Since: 'Desde',
  'WhatsApp QR code': 'QR code do WhatsApp',
  'The code refreshes automatically. Waiting for the scan…':
    'O código é renovado automaticamente. Aguardando a leitura…',
  'Reconnecting to WhatsApp…': 'Reconectando ao WhatsApp…',
  'Generating QR code…': 'Gerando QR code…',
  'No number connected. Click Connect to get a QR code.':
    'Nenhum número conectado. Clique em Conectar para gerar um QR code.',
  'Last error': 'Último erro',
  Disconnect: 'Desconectar',
  Disconnected: 'Desconectado',
  Connecting: 'Conectando',
  'Waiting for scan': 'Aguardando leitura',
  Retry: 'Tentar de novo',
  Connect: 'Conectar',
  'Only account admins can connect or disconnect the number.':
    'Só administradores da conta podem conectar ou desconectar o número.',
  'How it works': 'Como funciona',
  'What the QR channel can and cannot do.': 'O que o canal QR faz e não faz.',
  'Receives and sends 1:1 messages (text, images, audio, video, documents).':
    'Recebe e envia mensagens 1:1 (texto, imagens, áudio, vídeo, documentos).',
  'Reply automations work; buttons and lists are sent as numbered text.':
    'Automações de resposta funcionam; botões e listas vão como texto numerado.',
  'Broadcasts and message templates stay on the official API.':
    'Disparos e modelos de mensagem continuam na API oficial.',
  'Keep the phone online — WhatsApp Web depends on it.':
    'Mantenha o celular conectado — o WhatsApp Web depende dele.',
  'Counts as one channel against your plan limit while connected.':
    'Conta como um canal no limite do seu plano enquanto estiver conectado.',
  'WhatsApp connected.': 'WhatsApp conectado.',
  'WhatsApp disconnected.': 'WhatsApp desconectado.',
  'Disconnect this WhatsApp number? You will need to scan a new QR code to reconnect.':
    'Desconectar este número do WhatsApp? Será preciso ler um novo QR code para reconectar.',
  'Plan limit reached': 'Limite do plano atingido',
  'Something went wrong. Please try again.': 'Algo deu errado. Tente novamente.',
  'Could not reach the server. Check your connection and try again.':
    'Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.',
  'Send a message to start the conversation': 'Envie uma mensagem para iniciar a conversa',
  // Inbox contact panel — inline add (custom fields, deals, team notes)
  'New field': 'Novo campo',
  'Custom fields appear on every contact in this account.':
    'Campos personalizados aparecem em todos os contatos desta conta.',
  'Field name': 'Nome do campo',
  'e.g. ZIP code, lead source': 'ex.: CEP, origem do lead',
  'A field with this name already exists.': 'Já existe um campo com este nome.',
  Text: 'Texto',
  'Create field': 'Criar campo',
  'Field created': 'Campo criado',
  'Add custom field': 'Adicionar campo personalizado',
  'Could not save the field value': 'Não foi possível salvar o valor do campo',
  'Click to edit': 'Clique para editar',
  'Create a pipeline first in Pipelines.': 'Crie um funil primeiro em Funis.',
  'Could not load pipelines': 'Não foi possível carregar os funis',
  'Open in Pipelines': 'Abrir em Funis',
  'Add team note': 'Adicionar nota da equipe',
  'Write a note for the team…': 'Escreva uma nota para a equipe…',
  'Team note': 'Nota da equipe',
  'Team only': 'Só para a equipe',
  'Ctrl+Enter to save': 'Ctrl+Enter para salvar',
  'Private note added': 'Nota interna adicionada',
  'Could not save the note': 'Não foi possível salvar a nota',
  // Tasks module
  Priority: 'Prioridade',
  Tasks: 'Tarefas',
  Task: 'Tarefa',
  'New task': 'Nova tarefa',
  'Create task': 'Criar tarefa',
  'Add task': 'Adicionar tarefa',
  'Task title': 'Título da tarefa',
  'What needs to be done?': 'O que precisa ser feito?',
  'Details, context, next steps…': 'Detalhes, contexto, próximos passos…',
  'Task created': 'Tarefa criada',
  'Task completed': 'Tarefa concluída',
  'Task reopened': 'Tarefa reaberta',
  'Task deleted': 'Tarefa excluída',
  'Task title is required': 'O título da tarefa é obrigatório',
  'Failed to create task': 'Não foi possível criar a tarefa',
  'Failed to save task': 'Não foi possível salvar a tarefa',
  'Failed to delete task': 'Não foi possível excluir a tarefa',
  'Failed to move task': 'Não foi possível mover a tarefa',
  'Failed to load tasks': 'Não foi possível carregar as tarefas',
  'Failed to add comment': 'Não foi possível adicionar o comentário',
  'Delete this task? This cannot be undone.':
    'Excluir esta tarefa? Esta ação não pode ser desfeita.',
  Complete: 'Concluir',
  Reopen: 'Reabrir',
  'Complete task': 'Concluir tarefa',
  'Reopen task': 'Reabrir tarefa',
  Assignee: 'Responsável',
  'Any assignee': 'Qualquer responsável',
  'Any status': 'Qualquer status',
  'Any priority': 'Qualquer prioridade',
  Due: 'Prazo',
  Links: 'Vínculos',
  Deal: 'Negócio',
  'No deal': 'Sem negócio',
  'No deals for this contact': 'Este contato não tem negócios',
  'Search contact by name or phone': 'Buscar contato por nome ou telefone',
  'Open contact': 'Abrir contato',
  Unlink: 'Desvincular',
  Comments: 'Comentários',
  'No comments yet.': 'Nenhum comentário ainda.',
  'Write a comment…': 'Escreva um comentário…',
  'Send comment': 'Enviar comentário',
  'Ctrl+Enter to send': 'Ctrl+Enter para enviar',
  Low: 'Baixa',
  Normal: 'Normal',
  High: 'Alta',
  Urgent: 'Urgente',
  Mine: 'Minhas',
  Today: 'Hoje',
  'Overdue tasks': 'Atrasadas',
  'All tasks': 'Todas',
  'Search tasks': 'Buscar tarefas',
  Board: 'Quadro',
  'No tasks here': 'Nenhuma tarefa aqui',
  'Create a task or change the filters.': 'Crie uma tarefa ou altere os filtros.',
  'Drop a task here': 'Solte uma tarefa aqui',
  'open task': 'aberta',
  'open tasks': 'abertas',
  'overdue task': 'atrasada',
  'overdue tasks': 'atrasadas',
  "Read-only — your role can't create tasks":
    'Somente leitura — seu perfil não pode criar tarefas',
  // Settings → Tasks (statuses)
  'Task statuses': 'Status de tarefas',
  'Task statuses for the board': 'Status de tarefas do quadro',
  'The columns of the task board. Every account keeps at least one open, one in-progress and one done status; new tasks land on the default.':
    'As colunas do quadro de tarefas. Cada conta mantém ao menos um status aberto, um em andamento e um concluído; novas tarefas entram no padrão.',
  'Drag to reorder. Names are saved when you leave the field.':
    'Arraste para reordenar. Os nomes são salvos ao sair do campo.',
  'Missing a status of kind:': 'Falta um status do tipo:',
  'Keep at least one status of each kind.': 'Mantenha ao menos um status de cada tipo.',
  'New status': 'Novo status',
  'Status name': 'Nome do status',
  'Status created': 'Status criado',
  'Status deleted': 'Status excluído',
  'Failed to create status': 'Não foi possível criar o status',
  'Failed to delete status': 'Não foi possível excluir o status',
  'Failed to load task statuses': 'Não foi possível carregar os status',
  'Delete status': 'Excluir status',
  'Delete this status? Its tasks move to': 'Excluir este status? As tarefas vão para',
  'Default status for new tasks': 'Status padrão para novas tarefas',
  'Make default': 'Tornar padrão',
  'Only account admins can change task statuses.':
    'Somente administradores da conta podem alterar os status de tarefas.',
  Kind: 'Tipo',
  'In progress': 'Em andamento',
  'Pick color': 'Escolher cor',
  // Tasks — inbox / pipelines panels, dashboard card, sidebar
  'No open tasks': 'Nenhuma tarefa aberta',
  'More actions': 'Mais ações',
  Service: 'Atendimento',
  "Today's tasks": 'Tarefas de hoje',
  'Your tasks due today and overdue': 'Suas tarefas para hoje e as atrasadas',
  'to do': 'a fazer',
  'View all': 'Ver todas',
  'Nothing due today': 'Nada para hoje',
  'Tasks assigned to you that are due today or overdue show up here.':
    'Tarefas atribuídas a você com prazo para hoje ou atrasadas aparecem aqui.',
  'more task': 'outra tarefa',
  'more tasks': 'outras tarefas',
  // Tasks — automation step create_task
  'Follow up with {{ contact.name }}': 'Fazer follow-up com {{ contact.name }}',
  'Variables: {{ contact.name }}, {{ contact.phone }}, {{ message.text }}, {{ vars.x }}':
    'Variáveis: {{ contact.name }}, {{ contact.phone }}, {{ message.text }}, {{ vars.x }}',
  'Description (optional)': 'Descrição (opcional)',
  'Due in (hours)': 'Prazo em (horas)',
  'No due date': 'Sem prazo',
  'The task is linked to the contact and conversation that fired the automation and lands on the default open status.':
    'A tarefa fica vinculada ao contato e à conversa que dispararam a automação e entra no status aberto padrão.',
  // Deals — loss reasons (Entrega D, migration 031)
  'Mark as lost': 'Marcar como perdido',
  'Pick why this deal was lost. The reason feeds the pipeline analytics.':
    'Escolha por que este negócio foi perdido. O motivo alimenta a análise do pipeline.',
  'Loss reason': 'Motivo de perda',
  'Loss reasons': 'Motivos de perda',
  'No active loss reasons': 'Nenhum motivo de perda ativo',
  'Select a reason': 'Selecione um motivo',
  'Add reasons in': 'Adicione motivos em',
  'Settings › Deals and currency': 'Configurações › Negócios e moeda',
  'Ask an account admin to add loss reasons in Settings.':
    'Peça a um administrador da conta para adicionar motivos de perda nas Configurações.',
  'Note (optional)': 'Observação (opcional)',
  'What happened? Anything useful for next time.':
    'O que aconteceu? Algo útil para a próxima vez.',
  'No reason': 'Sem motivo',
  'lost deal': 'negócio perdido',
  'lost deals': 'negócios perdidos',
  'Bar length': 'Tamanho da barra',
  Count: 'Quantidade',
  'Failed to load loss reasons': 'Não foi possível carregar os motivos de perda',
  'Loss reason created': 'Motivo de perda criado',
  'Failed to create loss reason': 'Não foi possível criar o motivo de perda',
  'Loss reason deleted': 'Motivo de perda excluído',
  'Failed to delete loss reason': 'Não foi possível excluir o motivo de perda',
  'What your team picks when a deal is marked as lost. Names are saved when you leave the field; inactive reasons stay on old deals but are no longer offered.':
    'O que sua equipe escolhe ao marcar um negócio como perdido. Os nomes são salvos ao sair do campo; motivos inativos permanecem nos negócios antigos, mas deixam de ser oferecidos.',
  'No loss reasons yet. Add the first one below.':
    'Nenhum motivo de perda ainda. Adicione o primeiro abaixo.',
  'New loss reason': 'Novo motivo de perda',
  'e.g. Budget cut, Timing': 'ex.: Corte de orçamento, Momento errado',
  'Only account admins can change loss reasons.':
    'Somente administradores da conta podem alterar os motivos de perda.',
  'Loss reason name': 'Nome do motivo de perda',
  'Delete loss reason': 'Excluir motivo de perda',
  'Delete this loss reason?': 'Excluir este motivo de perda?',
  "This reason is used by 1 deal and can't be deleted. Deactivate it instead to hide it from the list.":
    'Este motivo é usado por 1 negócio e não pode ser excluído. Desative-o para ocultá-lo da lista.',
  'This reason is used by': 'Este motivo é usado por',
  "deals and can't be deleted. Deactivate it instead to hide it from the list.":
    'negócios e não pode ser excluído. Desative-o para ocultá-lo da lista.',
  Deactivate: 'Desativar',
  'The currency used for new deals and for pipeline and dashboard totals, and the reasons a deal can be marked as lost.':
    'A moeda usada em novos negócios e nos totais do pipeline e do painel, e os motivos pelos quais um negócio pode ser marcado como perdido.',
  // Quick replies (Entrega A) — settings panel + overview tile
  'Quick replies': 'Respostas rápidas',
  'Canned responses for the inbox': 'Respostas prontas para o inbox',
  'Ready-made answers your team inserts in the inbox by typing / followed by the shortcut. Variables fill in the contact, agent and company names.':
    'Respostas prontas que a equipe insere no inbox digitando / seguido do atalho. As variáveis preenchem o nome do contato, do atendente e da empresa.',
  'New quick reply': 'Nova resposta rápida',
  'Edit quick reply': 'Editar resposta rápida',
  Library: 'Biblioteca',
  'Shortcuts are lower-case, without spaces, and unique in the account.':
    'Os atalhos são em minúsculas, sem espaços e únicos na conta.',
  'Search by shortcut or title': 'Buscar por atalho ou título',
  'No quick replies yet': 'Nenhuma resposta rápida ainda',
  'Create the first one — for example /oi with a greeting that uses the contact name.':
    'Crie a primeira — por exemplo /oi com uma saudação que usa o nome do contato.',
  'Nothing matches your search.': 'Nada corresponde à sua busca.',
  Shortcut: 'Atalho',
  Preview: 'Prévia',
  Body: 'Corpo',
  'Only agents and admins can change quick replies.':
    'Somente atendentes e administradores podem alterar respostas rápidas.',
  'Delete quick reply?': 'Excluir resposta rápida?',
  "This can't be undone.": 'Isso não pode ser desfeito.',
  'Quick reply created': 'Resposta rápida criada',
  'Quick reply saved': 'Resposta rápida salva',
  'Quick reply deleted': 'Resposta rápida excluída',
  'Failed to load quick replies': 'Falha ao carregar respostas rápidas',
  'Failed to save quick reply': 'Falha ao salvar resposta rápida',
  'Failed to delete quick reply': 'Falha ao excluir resposta rápida',
  'Type / plus the shortcut in the inbox composer to insert this text.':
    'Digite / mais o atalho no compositor do inbox para inserir este texto.',
  'Use 1–30 lower-case letters, numbers, "_" or "-" — no spaces.':
    'Use de 1 a 30 letras minúsculas, números, "_" ou "-" — sem espaços.',
  'This shortcut is already in use.': 'Este atalho já está em uso.',
  'Letters, numbers, "_" and "-".': 'Letras, números, "_" e "-".',
  'Title is required': 'O título é obrigatório',
  'Body is required': 'O corpo é obrigatório',
  'Body is too long': 'O corpo é muito longo',
  'Welcome message': 'Mensagem de boas-vindas',
  'Hi {{contato.primeiro_nome}}! This is {{atendente.nome}} from {{empresa}}. How can I help?':
    'Oi {{contato.primeiro_nome}}! Aqui é {{atendente.nome}} da {{empresa}}. Como posso ajudar?',
  'Insert variable:': 'Inserir variável:',
  'Contact name': 'Nome do contato',
  'Contact first name': 'Primeiro nome do contato',
  'Agent name': 'Nome do atendente',

  // Lead capture by webhook (migration 029) — Settings → Integrations
  'Lead capture (webhook)': 'Captura de leads (webhook)',
  Integrations: 'Integrações',
  'Lead capture by webhook': 'Captura de leads por webhook',
  'Receive leads from landing pages, forms, Zapier and n8n straight into the CRM.':
    'Receba leads de landing pages, formulários, Zapier e n8n direto no CRM.',
  'Each lead source gets its own webhook URL. Post a form to it and the lead becomes a contact (deduplicated by phone), lands in the pipeline you choose, gets tagged and fires your automations.':
    'Cada fonte de leads tem sua própria URL de webhook. Envie um formulário para ela e o lead vira contato (sem duplicar pelo telefone), entra no funil escolhido, recebe etiquetas e dispara suas automações.',
  'Admins only': 'Somente administradores',
  'Only account admins can manage lead sources — the webhook URL is a credential.':
    'Somente administradores da conta gerenciam fontes de leads — a URL do webhook é uma credencial.',
  'Lead capture by webhook is not part of your current plan. Get in touch with the SempreCRM team to add it.':
    'A captura de leads por webhook não está incluída no seu plano atual. Fale com a equipe do SempreCRM para adicioná-la.',
  'New lead source': 'Nova fonte de leads',
  'Lead sources': 'Fontes de leads',
  'Lead source': 'Fonte de leads',
  'Pick a source to see its URL, examples and the latest submissions.':
    'Escolha uma fonte para ver a URL, exemplos e os últimos recebimentos.',
  'No lead sources yet': 'Nenhuma fonte de leads ainda',
  'Create one per landing page or form — each gets its own URL and counters.':
    'Crie uma por landing page ou formulário — cada uma tem URL e contadores próprios.',
  Received: 'Recebidos',
  'Last received': 'Último recebimento',
  'Paused source': 'Fonte pausada',
  'Source activated': 'Fonte ativada',
  'Source paused': 'Fonte pausada',
  'Failed to load lead sources': 'Falha ao carregar fontes de leads',
  'Failed to save lead source': 'Falha ao salvar fonte de leads',
  'Failed to delete lead source': 'Falha ao excluir fonte de leads',
  'Lead source created': 'Fonte de leads criada',
  'Lead source saved': 'Fonte de leads salva',
  'Lead source deleted': 'Fonte de leads excluída',
  'Delete lead source?': 'Excluir fonte de leads?',
  'Its URL stops working immediately and the submission log is removed. Contacts and deals stay.':
    'A URL para de funcionar na hora e o histórico de recebimentos é removido. Contatos e negócios permanecem.',
  'Deals go to': 'Negócios vão para',
  'No deal is created — the lead becomes a contact only.':
    'Nenhum negócio é criado — o lead vira apenas contato.',
  'Webhook URL': 'URL do webhook',
  'Could not copy': 'Não foi possível copiar',
  'Accepts POST with JSON, form-urlencoded or multipart. Opening it in a browser shows { ok: true }.':
    'Aceita POST com JSON, form-urlencoded ou multipart. Abrir no navegador mostra { ok: true }.',
  'curl example': 'Exemplo com curl',
  'HTML form example': 'Exemplo de formulário HTML',
  'Generating a new token changes the URL. Every form still posting to the old one will get 404.':
    'Gerar um novo token muda a URL. Todo formulário que ainda enviar para a antiga receberá 404.',
  'Generate new token': 'Gerar novo token',
  'Yes, generate new token': 'Sim, gerar novo token',
  'New token generated — update your forms with the new URL.':
    'Novo token gerado — atualize seus formulários com a nova URL.',
  'Failed to generate a new token': 'Falha ao gerar novo token',
  'Latest submissions': 'Últimos recebimentos',
  'The last 50 payloads received, newest first. Click a row to see the payload.':
    'Os últimos 50 envios recebidos, do mais novo para o mais antigo. Clique numa linha para ver o payload.',
  'Failed to load submissions': 'Falha ao carregar recebimentos',
  'Nothing received yet. Try the curl example above.':
    'Nada recebido ainda. Experimente o exemplo com curl acima.',
  When: 'Quando',
  'Contact created': 'Contato criado',
  'Existing contact': 'Contato existente',
  'Phone missing from payload': 'Telefone ausente no payload',
  'Invalid phone number': 'Telefone inválido',
  'Account owner not found': 'Dono da conta não encontrado',
  'Edit lead source': 'Editar fonte de leads',
  'Where leads from this source land and which payload keys feed each CRM field.':
    'Onde os leads desta fonte entram e quais chaves do payload alimentam cada campo do CRM.',
  'e.g. Landing page — winter campaign': 'ex.: Landing page — campanha de inverno',
  "Don't create a deal": 'Não criar negócio',
  'Pick a stage': 'Escolha uma etapa',
  'Pick the stage new deals start in': 'Escolha a etapa em que os negócios começam',
  'No tags yet': 'Nenhuma etiqueta ainda',
  'Field mapping': 'Mapeamento de campos',
  'CRM field ← payload key. Leave blank to use the default key (name/nome, phone/telefone, email, company/empresa). Dotted paths like lead.telefone work.':
    'Campo do CRM ← chave do payload. Deixe em branco para usar a chave padrão (name/nome, phone/telefone, email, company/empresa). Caminhos com ponto como lead.telefone funcionam.',
  'payload key': 'chave do payload',
  'Custom field': 'Campo personalizado',
  'Custom field…': 'Campo personalizado…',
  'Map a custom field': 'Mapear campo personalizado',
  'Create custom fields in Settings → Fields and tags to map extra payload keys.':
    'Crie campos personalizados em Configurações → Campos e etiquetas para mapear outras chaves do payload.',
  // Automation trigger "lead_captured"
  'Lead Captured': 'Lead capturado',
  'When a lead arrives through a webhook source (Settings → Integrations)':
    'Quando um lead chega por uma fonte de webhook (Configurações → Integrações)',
  'Any source': 'Qualquer fonte',
  'Deleted source': 'Fonte excluída',
  paused: 'pausada',
  'No lead sources yet — create one in Settings → Integrations.':
    'Nenhuma fonte de leads ainda — crie uma em Configurações → Integrações.',
  'Fires for every webhook lead, or only for the chosen source.':
    'Dispara para todo lead via webhook, ou só para a fonte escolhida.',

  // ------------------------------------------------------------
  // Radar + follow-up + opt-out (migration 030, spec §3 / §5)
  // ------------------------------------------------------------
  Radar: 'Radar',
  Waiting: 'Aguardando',
  'No owner': 'Sem responsável',
  Cooling: 'Esfriando',
  'Oldest waiting': 'Aguardando há mais tempo',
  'Oldest cooling': 'Esfriando há mais tempo',
  'Conversations at risk right now': 'Conversas em risco agora',
  'Nothing at risk — everyone has been answered.': 'Nada em risco — todo mundo foi respondido.',
  'Open inbox': 'Abrir inbox',
  SLA: 'SLA',
  'Cooling after': 'Esfriando após',
  Adjust: 'Ajustar',
  cooling: 'esfriando',
  // Settings → Atendimento
  'Response-time limits behind the Radar (dashboard and inbox) and the words a customer can send to stop receiving messages.':
    'Limites de tempo de resposta por trás do Radar (dashboard e inbox) e as palavras que um cliente pode enviar para parar de receber mensagens.',
  'Response times': 'Tempos de resposta',
  'A conversation shows up as waiting when the customer has been unanswered for longer than the SLA, and as cooling when the customer has not replied to you for the given hours.':
    'Uma conversa aparece como aguardando quando o cliente fica sem resposta por mais tempo que o SLA, e como esfriando quando o cliente não responde a você pelas horas indicadas.',
  'Reply SLA (minutes)': 'SLA de resposta (minutos)',
  'Customers waiting longer than this appear under “Waiting”.':
    'Clientes esperando mais que isso aparecem em “Aguardando”.',
  'Enter a value between': 'Informe um valor entre',
  and: 'e',
  'Cooling after (hours)': 'Esfriando após (horas)',
  'Silence after your last message for this long marks the conversation as cooling.':
    'Silêncio por esse tempo depois da sua última mensagem marca a conversa como esfriando.',
  'Opt-out words': 'Palavras de descadastro',
  'When a customer sends exactly one of these words (accents and punctuation ignored), the contact is marked as opted out: automations stop messaging them and broadcasts skip them. An admin can reactivate the contact from the inbox panel.':
    'Quando um cliente envia exatamente uma destas palavras (acentos e pontuação ignorados), o contato é marcado como descadastrado: as automações deixam de enviar mensagens e os disparos o pulam. Um administrador pode reativar o contato pelo painel do inbox.',
  'Type a word and press Enter': 'Digite uma palavra e pressione Enter',
  'Add opt-out word': 'Adicionar palavra de descadastro',
  'No words — opt-out by message is off for this account.':
    'Sem palavras — o descadastro por mensagem está desligado nesta conta.',
  'Press Enter or comma to add a word; Backspace removes the last one.':
    'Pressione Enter ou vírgula para adicionar uma palavra; Backspace remove a última.',
  'Only admins can change service settings.':
    'Somente administradores podem alterar as configurações de atendimento.',
  'Keyword limit reached': 'Limite de palavras atingido',
  'Service settings saved': 'Configurações de atendimento salvas',
  'Failed to save service settings': 'Falha ao salvar as configurações de atendimento',
  // Automation trigger: conversation_inactive
  'Conversation Inactive': 'Conversa sem resposta há X horas',
  'When a conversation has had no message for a number of hours (checked every minute by the scheduler)':
    'Quando uma conversa fica sem mensagens por um número de horas (verificado a cada minuto pelo agendador)',
  'Hours without a message': 'Horas sem mensagem',
  'Decimals allowed — 0.05 is 3 minutes, 24 is one day, 720 is the maximum (30 days).':
    'Decimais permitidos — 0.05 são 3 minutos, 24 é um dia, 720 é o máximo (30 dias).',
  'Last message was from': 'Última mensagem foi do',
  'The agent (customer went quiet)': 'Atendente (cliente ficou em silêncio)',
  'The customer (nobody replied)': 'Cliente (ninguém respondeu)',
  'Either side': 'Qualquer lado',
  'Conversation status': 'Status da conversa',
  'Pick at least one status.': 'Escolha pelo menos um status.',
  // Opt-out badges and audience
  'Opted out': 'Descadastrado',
  'Opted-out contacts': 'Descadastrados',
  'Asked to stop receiving messages': 'Pediu para não receber mensagens',
  'No opted-out contacts.': 'Nenhum contato descadastrado.',
  'opted-out contact excluded': 'contato descadastrado excluído',
  'opted-out contacts excluded': 'contatos descadastrados excluídos',
  // Round 2 §1 — Team metrics (dashboard "Equipe")
  Team: 'Equipe',
  'Per-member activity in the period': 'Atividade por membro no período',
  'Your activity in the period': 'Sua atividade no período',
  Period: 'Período',
  Handled: 'Atendidas',
  Resolved: 'Resolvidas',
  '1st response': '1ª resposta',
  'Tasks done': 'Tarefas concluídas',
  'Open now': 'Abertas agora',
  'Conversations with at least one reply from the member in the period':
    'Conversas com pelo menos uma resposta do membro no período',
  'Conversations the member marked as resolved in the period':
    'Conversas que o membro marcou como resolvidas no período',
  'Average (median) time until the first reply, over conversations the member answered first':
    'Tempo médio (mediana) até a primeira resposta, nas conversas em que o membro respondeu primeiro',
  'Tasks assigned to the member completed in the period':
    'Tarefas atribuídas ao membro concluídas no período',
  'Conversations currently open and assigned to the member':
    'Conversas abertas agora atribuídas ao membro',
  median: 'mediana',
  you: 'você',
  'No first response yet': 'Ainda sem primeira resposta',
  'No team activity yet': 'Ainda sem atividade da equipe',
  'Replies, resolutions and completed tasks will show up here per member.':
    'Respostas, resoluções e tarefas concluídas aparecem aqui por membro.',
  // Round 2 §2 — Availability, business hours, round-robin
  Availability: 'Disponibilidade',
  Available: 'Disponível',
  Away: 'Ausente',
  'You are now available': 'Você está disponível',
  'You are now away': 'Você está ausente',
  'Failed to update availability': 'Falha ao atualizar a disponibilidade',
  'Business hours': 'Horário de atendimento',
  'When your team is available. Up to two ranges per day (for a lunch break); a day with no range is closed. Used by the out-of-hours reply below.':
    'Quando sua equipe está disponível. Até duas faixas por dia (para o almoço); um dia sem faixa fica fechado. Usado pela mensagem fora do horário abaixo.',
  Timezone: 'Fuso horário',
  Monday: 'Segunda-feira',
  Tuesday: 'Terça-feira',
  Wednesday: 'Quarta-feira',
  Thursday: 'Quinta-feira',
  Friday: 'Sexta-feira',
  Saturday: 'Sábado',
  Sunday: 'Domingo',
  start: 'início',
  end: 'fim',
  'Add range': 'Adicionar faixa',
  'Remove range': 'Remover faixa',
  'Out-of-hours reply': 'Mensagem fora do horário',
  'When a customer writes outside business hours, send this message automatically — once per conversation per day, through the same channel. On the official channel it is skipped when the 24-hour window is closed.':
    'Quando um cliente escreve fora do horário de atendimento, envia esta mensagem automaticamente — uma vez por conversa por dia, pelo mesmo canal. No canal oficial ela é pulada quando a janela de 24 horas está fechada.',
  Message: 'Mensagem',
  'Enter a message to send outside business hours.':
    'Informe a mensagem a enviar fora do horário de atendimento.',
  'Automatic distribution': 'Distribuição automática',
  'Round-robin: when a new conversation gets its first customer message and has no owner, assign it to the available member with the fewest open conversations. Members marked as away are skipped; with nobody available the conversation stays in the Radar.':
    'Rodízio: quando uma conversa recebe a primeira mensagem do cliente e não tem responsável, atribui ao membro disponível com menos conversas abertas. Membros ausentes são pulados; sem ninguém disponível a conversa fica no Radar.',
  'Response-time limits behind the Radar, business hours, automatic distribution and the words a customer can send to stop receiving messages.':
    'Limites de tempo de resposta do Radar, horário de atendimento, distribuição automática e as palavras que um cliente pode enviar para parar de receber mensagens.',
  // Audit log (round 2 spec §3)
  'Audit log': 'Auditoria',
  'Who changed what, and when': 'Quem alterou o quê, e quando',
  'Only admins can view the audit log.': 'Somente administradores podem ver a auditoria.',
  'Sensitive actions in this workspace — members, channels, contacts, plan — with who did them and when. Entries are kept for 365 days.':
    'Ações sensíveis neste espaço de trabalho — membros, canais, contatos, plano — com quem fez e quando. Os registros são mantidos por 365 dias.',
  'All actions': 'Todas as ações',
  'All members': 'Todos os membros',
  'Last 7 days': 'Últimos 7 dias',
  'Last 30 days': 'Últimos 30 dias',
  'Last 90 days': 'Últimos 90 dias',
  'All time': 'Todo o período',
  'Clear filters': 'Limpar filtros',
  'No entries match these filters.': 'Nenhum registro corresponde a esses filtros.',
  'Nothing recorded yet. Sensitive actions will show up here.':
    'Nada registrado ainda. As ações sensíveis vão aparecer aqui.',
  'Who': 'Quem',
  'Action': 'Ação',
  'Entity': 'Entidade',
  'Details': 'Detalhes',
  'System': 'Sistema',
  'Load more': 'Carregar mais',
  'items': 'itens',
  'Account': 'Conta',
  'Invitation': 'Convite',
  'Official WhatsApp': 'WhatsApp oficial',
  'WhatsApp QR': 'WhatsApp QR',
  'Contact': 'Contato',
  'Automation': 'Automação',
  'Preferences': 'Preferências',
  'Branding': 'Marca',
  'Two-step verification': 'Verificação em duas etapas',
  // LGPD (round 2 spec §4)
  'Privacy': 'Privacidade',
  'Consent': 'Consentimento',
  'Not recorded': 'Não registrado',
  'Consent granted': 'Consentimento concedido',
  'Consent revoked': 'Consentimento revogado',
  'Consent updated': 'Consentimento atualizado',
  'Could not update consent': 'Não foi possível atualizar o consentimento',
  'Updated on': 'Atualizado em',
  'Export data': 'Exportar dados',
  'Contact data exported': 'Dados do contato exportados',
  'Could not export contact data': 'Não foi possível exportar os dados do contato',
  'Anonymize': 'Anonimizar',
  'Anonymized': 'Anonimizado',
  'Anonymize contact?': 'Anonimizar contato?',
  'This permanently removes name, phone, email, company, custom fields, notes, message contents and media. Conversations, deals and tasks stay for statistics. This cannot be undone.':
    'Isso remove permanentemente nome, telefone, e-mail, empresa, campos personalizados, notas, conteúdo das mensagens e mídias. Conversas, negócios e tarefas ficam para estatísticas. Não é possível desfazer.',
  'Type the contact name to confirm': 'Digite o nome do contato para confirmar',
  'Contact anonymized': 'Contato anonimizado',
  'Could not anonymize the contact': 'Não foi possível anonimizar o contato',
  'Personal data removed (LGPD)': 'Dados pessoais removidos (LGPD)',
  'Personal data was removed on': 'Os dados pessoais foram removidos em',
  'Editing and messaging are blocked for this contact.':
    'Edição e envio de mensagens estão bloqueados para este contato.',
  'Anonymized contacts cannot be edited': 'Contatos anonimizados não podem ser editados',
  'Record the consent this contact gave, export everything the workspace holds about them, or remove their personal data for good.':
    'Registre o consentimento dado por este contato, exporte tudo que o espaço de trabalho tem sobre ele ou remova seus dados pessoais em definitivo.',
  // MFA (round 2 spec, section 7)
  'Enter the 6-digit code from your authenticator app':
    'Digite o código de 6 dígitos do seu aplicativo autenticador',
  'Verification code': 'Código de verificação',
  'Verifying…': 'Verificando…',
  'Invalid code. Check the time on your phone and try again.':
    'Código inválido. Confira a hora do seu celular e tente de novo.',
  'Could not start the verification': 'Não foi possível iniciar a verificação',
  'No authenticator is linked to this account. Sign out and sign in again.':
    'Nenhum aplicativo autenticador está vinculado a esta conta. Saia e entre novamente.',
  'Sign in with another account': 'Entrar com outra conta',
  'Enabled': 'Ativada',
  'Besides your password, sign-in asks for a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…).':
    'Além da senha, o login pede um código de 6 dígitos de um aplicativo autenticador (Google Authenticator, Authy, 1Password…).',
  'Not enabled. Anyone with your password can sign in.':
    'Não ativada. Qualquer pessoa com a sua senha consegue entrar.',
  'Enable two-step verification': 'Ativar verificação em duas etapas',
  'Could not start two-step verification': 'Não foi possível iniciar a verificação em duas etapas',
  'Open your authenticator app and scan the QR code (or type the key).':
    'Abra o aplicativo autenticador e escaneie o QR code (ou digite a chave).',
  'Enter the 6-digit code the app shows to confirm.':
    'Digite o código de 6 dígitos que o aplicativo mostra para confirmar.',
  'QR code for the authenticator app': 'QR code para o aplicativo autenticador',
  'Setup key': 'Chave de configuração',
  'Copy setup key': 'Copiar chave de configuração',
  'There are no recovery codes': 'Não existem códigos de recuperação',
  'If you lose the phone with the authenticator app you will not be able to sign in. Keep the app backed up (or save the setup key somewhere safe) before continuing.':
    'Se você perder o celular com o aplicativo autenticador, não conseguirá entrar. Mantenha o backup do aplicativo (ou guarde a chave de configuração em local seguro) antes de continuar.',
  'Confirm and enable': 'Confirmar e ativar',
  'Two-step verification enabled': 'Verificação em duas etapas ativada',
  'Two-step verification disabled': 'Verificação em duas etapas desativada',
  'Your account asks for a code from the authenticator app at every sign-in.':
    'Sua conta pede um código do aplicativo autenticador em todo login.',
  'Enabled on': 'Ativada em',
  'Disable': 'Desativar',
  'Without the phone that has the authenticator app you cannot sign in. If you change phones, disable and enable two-step verification again first.':
    'Sem o celular com o aplicativo autenticador você não consegue entrar. Se trocar de celular, desative e ative a verificação em duas etapas novamente antes.',
  'Disable two-step verification?': 'Desativar a verificação em duas etapas?',
  'Confirm your password. Sign-in will only ask for the password afterwards.':
    'Confirme sua senha. Depois disso, o login pedirá apenas a senha.',
  'Cannot verify the password without a current email':
    'Não é possível verificar a senha sem um e-mail atual',
  'Two-step verification required': 'Verificação em duas etapas obrigatória',
  'This account requires two-step verification for administrators. Enable it to continue using the app.':
    'Esta conta exige verificação em duas etapas para administradores. Ative-a para continuar usando o sistema.',
  'This account requires two-step verification for administrators. Enable it below to continue using the app.':
    'Esta conta exige verificação em duas etapas para administradores. Ative-a abaixo para continuar usando o sistema.',
  'Security policy': 'Política de segurança',
  'Require two-step verification for administrators': 'Exigir duas etapas para admins',
  'Owners and admins without an authenticator app are sent to Login e segurança until they enable it. Agents and viewers are not affected.':
    'Proprietários e admins sem aplicativo autenticador são levados para Login e segurança até ativá-lo. Atendentes e visualizadores não são afetados.',
  'You have not enabled two-step verification yet — this applies to you too.':
    'Você ainda não ativou a verificação em duas etapas — isso vale para você também.',
  'Could not save the setting': 'Não foi possível salvar a configuração',
  'Could not reach the server': 'Não foi possível acessar o servidor',
  'Two-step verification is now required for administrators':
    'Verificação em duas etapas agora é obrigatória para administradores',
  'Two-step verification is no longer required for administrators':
    'Verificação em duas etapas não é mais obrigatória para administradores',
  // Push notifications (round 2 spec §5)
  'Notifications': 'Notificações',
  'Browser push notifications': 'Notificações push no navegador',
  'Get a browser notification when a customer writes, a conversation or task is assigned to you, or a task is about to be due — even with the tab closed.':
    'Receba uma notificação do navegador quando um cliente escrever, uma conversa ou tarefa for atribuída a você ou uma tarefa estiver para vencer — mesmo com a aba fechada.',
  'This browser': 'Este navegador',
  'Notifications are on in this browser.': 'As notificações estão ativas neste navegador.',
  'Notifications are blocked for this site. Allow them in the browser settings, then try again.':
    'As notificações estão bloqueadas para este site. Permita nas configurações do navegador e tente de novo.',
  'This browser does not support push notifications.':
    'Este navegador não suporta notificações push.',
  'Turn on notifications here — the browser will ask for permission.':
    'Ative as notificações aqui — o navegador vai pedir permissão.',
  'Enable in this browser': 'Ativar neste navegador',
  'Turn off here': 'Desativar aqui',
  'Notifications enabled in this browser': 'Notificações ativadas neste navegador',
  'Notifications disabled in this browser': 'Notificações desativadas neste navegador',
  'Permission denied — allow notifications for this site in your browser settings.':
    'Permissão negada — permita notificações para este site nas configurações do navegador.',
  'Could not enable notifications': 'Não foi possível ativar as notificações',
  'Push is not configured on this server.': 'O push não está configurado neste servidor.',
  'Ask the administrator to set the VAPID keys (see .env.local.example).':
    'Peça ao administrador para definir as chaves VAPID (veja .env.local.example).',
  'Devices': 'Dispositivos',
  'Every browser where you turned notifications on. Remove one to stop sending there.':
    'Todos os navegadores em que você ativou as notificações. Remova um para parar de enviar para ele.',
  'No devices yet.': 'Nenhum dispositivo ainda.',
  'this browser': 'este navegador',
  'Added on': 'Adicionado em',
  'last notified': 'última notificação',
  'Remove device': 'Remover dispositivo',
  'Device removed': 'Dispositivo removido',
  'Could not remove the device': 'Não foi possível remover o dispositivo',
  'Unknown browser': 'Navegador desconhecido',
  'What to notify': 'O que notificar',
  'Applies to all your devices. You are never notified about a conversation you have open on screen.':
    'Vale para todos os seus dispositivos. Você nunca é notificado sobre uma conversa que está aberta na tela.',
  'Could not save the preference': 'Não foi possível salvar a preferência',
  'New customer message': 'Nova mensagem de cliente',
  'When a conversation assigned to you (or unassigned) receives a message and you are not looking at it.':
    'Quando uma conversa atribuída a você (ou sem responsável) recebe uma mensagem e você não está olhando para ela.',
  'Task assigned to me': 'Tarefa atribuída a mim',
  'When someone assigns you a task.': 'Quando alguém atribui uma tarefa a você.',
  'Task due soon': 'Tarefa vencendo em breve',
  'Fifteen minutes before one of your tasks is due.':
    'Quinze minutos antes de uma das suas tarefas vencer.',
  'Conversation assigned to me': 'Conversa atribuída a mim',
  'When a conversation is handed to you.': 'Quando uma conversa é passada para você.',
  'New message': 'Nova mensagem',
  'Task assigned to you': 'Tarefa atribuída a você',
  'Task due in': 'Tarefa vence em',
  'Task due now': 'Tarefa vence agora',
  'Conversation assigned to you': 'Conversa atribuída a você',
  'by': 'por',
  // White-label branding (round 2 spec §6)
  'White-label branding': 'Marca própria (white-label)',
  'Your name, logo and colour': 'Seu nome, logo e cor',
  'Not included in your plan': 'Não incluído no seu plano',
  'Your own name, logo and colour across the app for every member of the account.':
    'Seu próprio nome, logo e cor em todo o app, para todos os membros da conta.',
  'Only account admins can change the branding.':
    'Só administradores da conta podem alterar a marca.',
  'White-label branding is not part of your current plan. Get in touch with the SempreCRM team to add it.':
    'A marca própria não faz parte do seu plano atual. Fale com a equipe SempreCRM para adicioná-la.',
  'Restore defaults': 'Restaurar padrão',
  'Branding saved': 'Marca salva',
  'Default branding restored': 'Marca padrão restaurada',
  'Could not save branding': 'Não foi possível salvar a marca',
  'App name': 'Nome do app',
  'Shown in the sidebar, the header and the browser tab title.':
    'Aparece na barra lateral, no cabeçalho e no título da aba do navegador.',
  'Logo': 'Logo',
  'Square works best. PNG, SVG or WebP up to 512 KB; it replaces the default mark in the sidebar.':
    'Quadrado funciona melhor. PNG, SVG ou WebP de até 512 KB; substitui o símbolo padrão na barra lateral.',
  'Upload logo': 'Enviar logo',
  'Replace logo': 'Trocar logo',
  'Remove logo': 'Remover logo',
  'Use a PNG, SVG or WebP image.': 'Use uma imagem PNG, SVG ou WebP.',
  'The logo must be 512 KB or smaller.': 'O logo deve ter no máximo 512 KB.',
  'Primary colour': 'Cor primária',
  'Buttons, links and highlights. Each member keeps their own light or dark mode.':
    'Botões, links e destaques. Cada membro mantém seu próprio modo claro ou escuro.',
  'Palette': 'Paleta',
  'Hex colour': 'Cor em hex',
  'Pick a colour': 'Escolher uma cor',
  'Use theme colour': 'Usar a cor do tema',
  'Enter a colour like #7c3aed.': 'Informe uma cor como #7c3aed.',
  'Overrides the accent theme for everyone in the account.':
    'Substitui o tema de destaque para todos na conta.',
  'Empty keeps the theme each member picked under Appearance.':
    'Vazio mantém o tema que cada membro escolheu em Aparência.',
  'How the sidebar header looks in light and dark mode.':
    'Como o topo da barra lateral fica nos modos claro e escuro.',
  'Primary button': 'Botão primário',
  'Active item': 'Item ativo',
  'Blue': 'Azul',
  'Cyan': 'Ciano',
  'Green': 'Verde',
  'Lime': 'Lima',
  'Orange': 'Laranja',
  'Red': 'Vermelho',
  'Pink': 'Rosa',
  'Slate': 'Cinza',
};
