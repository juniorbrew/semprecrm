/** pt-BR copy for the "settings" area — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_SETTINGS: Record<string, string> = {
  // ---- Appearance --------------------------------------------------
  'Use theme': 'Usar tema',
  'Light mode': 'Modo claro',
  'Dark mode': 'Modo escuro',
  accent: 'destaque',

  // ---- Roles (rendered from data) ----------------------------------
  // "Owner"/"Admin"/"Agent"/"Viewer" live in the base dictionary.
  'Role updated': 'Função atualizada',

  // ---- Members / invitations ---------------------------------------
  Joined: 'Entrou em',
  Revoke: 'Revogar',
  'Removing...': 'Removendo...',
  expired: 'expirado',
  'expires in': 'expira em',
  hour: 'hora',
  hours: 'horas',
  'pending invite': 'convite pendente',
  'pending invites': 'convites pendentes',
  'Click "Invite member" above to generate a shareable link.':
    'Clique em "Convidar membro" acima para gerar um link compartilhável.',
  'from the account? They will be signed out of this account and given a fresh personal account on their next sign-in. Their login is not deleted.':
    'da conta? A pessoa será desconectada desta conta e receberá uma nova conta pessoal no próximo acesso. O login dela não é excluído.',
  Label: 'Rótulo',
  'e.g. Sara — support team': 'ex.: Sara — equipe de suporte',
  'Label must be': 'O rótulo deve ter no máximo',
  'characters or fewer': 'caracteres',
  'Share this link with your new teammate. They will be able to sign up (or sign in) and join the account as':
    'Compartilhe este link com o novo membro da equipe. Ele poderá se cadastrar (ou entrar) e ingressar na conta como',
  'The link is valid for': 'O link é válido por',
  'Join {account} on SempreCRM using this link (valid for {days} days): {url}':
    'Entre em {account} no SempreCRM usando este link (válido por {days} dias): {url}',

  // ---- Profile / security ------------------------------------------
  'Require two-step verification for administrators':
    'Exigir verificação em duas etapas para administradores',
  'User ID': 'ID do usuário',
  'Maximum 2 MB.': 'No máximo 2 MB.',
  'Email change failed': 'Não foi possível alterar o e-mail',
  'Password update failed': 'Não foi possível atualizar a senha',
  'Sign-out failed': 'Não foi possível sair',
  'Updating…': 'Atualizando…',
  'New password should be different from the old password.':
    'A nova senha deve ser diferente da senha atual.',
  'Password should be at least 6 characters.': 'A senha deve ter pelo menos 6 caracteres.',
  'Owners and admins without an authenticator app are sent to Login & security until they enable it. Agents and viewers are not affected.':
    'Proprietários e administradores sem aplicativo autenticador são levados para Login e segurança até ativá-lo. Agentes e visualizadores não são afetados.',

  // ---- Overview tiles ----------------------------------------------
  template: 'modelo',
  templates: 'modelos',
  'pending review': 'em análise',
  tag: 'etiqueta',
  tags: 'etiquetas',
  'custom field': 'campo personalizado',
  'custom fields': 'campos personalizados',

  // ---- Templates ---------------------------------------------------
  // Meta quality rating (GREEN/YELLOW/RED → Alta/Média/Baixa; High/Low
  // live in the base dictionary).
  Medium: 'Média',
  // Header format select ("none" → "Nenhum")
  None: 'Nenhum',
  'Edit failed': 'Falha ao editar',
  'Submit failed': 'Não foi possível enviar',
  'Synced from Meta': 'Sincronizado da Meta',
  new: 'novos',
  updated: 'atualizados',
  'Failed to sync': 'Falha ao sincronizar',
  'Image is': 'A imagem possui',
  "Meta's limit is 5 MB.": 'o limite da Meta é 5 MB.',
  'Syncing…': 'Sincronizando…',
  'Meta quality score': 'Pontuação de qualidade da Meta',
  Resubmit: 'Reenviar',
  'e.g. order_confirmation': 'ex.: confirmacao_pedido',
  'or paste a public link to the': 'ou cole um link público para o',
  'Recommended: MP4 / 3GPP, ≤16 MB, ≤60 seconds.': 'Recomendado: MP4 / 3GPP, ≤16 MB, ≤60 segundos.',
  'Recommended: PDF, ≤100 MB.': 'Recomendado: PDF, ≤100 MB.',
  'Sample value for body variable': 'Valor de exemplo para a variável do corpo',
  'Sample for': 'Exemplo para',
  'https://example.com/path or with {{1}} suffix': 'https://exemplo.com/caminho ou com sufixo {{1}}',
  'Example code (e.g. SUMMER20)': 'Código de exemplo (ex.: VERAO20)',
  'Submitting…': 'Enviando…',
  "will be deleted from Meta and from SempreCRM. Active broadcasts using this template will start failing on their next send. This can't be undone.":
    'será excluído da Meta e do SempreCRM. Disparos ativos que usam este modelo passarão a falhar no próximo envio. Isso não pode ser desfeito.',
  'will be deleted from SempreCRM. It was never submitted to Meta, so no remote cleanup is needed.':
    'será excluído do SempreCRM. Ele nunca foi enviado à Meta, então não há limpeza remota necessária.',

  // ---- WhatsApp (official API) --------------------------------------
  'e.g. 100234567890123': 'ex.: 100234567890123',
  'e.g. 100234567890456': 'ex.: 100234567890456',
  // Registration probe (verify-registration route) — check flags and
  // error prefixes are mapped in whatsapp-config.tsx to these keys.
  'Configuration saved': 'Configuração salva',
  'Access token readable': 'Token de acesso legível',
  'Phone number recognised by Meta': 'Número reconhecido pela Meta',
  'WABA subscribed to the app': 'WABA inscrita no aplicativo',
  'Number registered in SempreCRM': 'Número registrado no SempreCRM',
  'Phone number check failed:': 'Falha ao verificar o número:',
  'WABA subscription check failed:': 'Falha ao verificar a inscrição da WABA:',
  'could not connect to Meta': 'não foi possível conectar à Meta',
  'WABA has no subscribed apps. Re-save the configuration to subscribe.':
    'A WABA não tem aplicativos inscritos. Salve a configuração novamente para inscrever.',
  "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save.":
    'Nenhum ID de WABA salvo — os webhooks não funcionam sem ele. Informe-o no formulário e salve novamente.',
  "Saved, but Meta couldn't register the number": 'Salvo, mas a Meta não conseguiu registrar o número',
  Live: 'No ar',
  'can now receive events.': 'já pode receber eventos.',
  'Connected to': 'Conectado a',
  'Resetting...': 'Redefinindo...',
  'Testing...': 'Testando...',
  'Credentials valid': 'Credenciais válidas',
  'Subscribed since': 'Inscrito desde',
  'Click "Verify with Meta" if events stop arriving.':
    'Clique em "Verificar com a Meta" se os eventos pararem de chegar.',
  'Enter (or correct) the 2-step PIN below and click Save Configuration to retry.':
    'Informe (ou corrija) o PIN de duas etapas abaixo e clique em Salvar configuração para tentar novamente.',
  live: 'ativo',
  'Hide token': 'Ocultar token',
  'Show token': 'Mostrar token',
  'Needed only to wire inbound messages for a production number. Set it in':
    'Necessário apenas para receber mensagens em um número de produção. Defina-o em',
  'then paste it here so SempreCRM can subscribe the number — otherwise Meta routes inbound events to whichever app last claimed it (the symptom that hits second numbers under a shared WABA).':
    'e cole-o aqui para que o SempreCRM possa inscrever o número — caso contrário, a Meta envia os eventos recebidos para o último aplicativo que o reivindicou (o sintoma que afeta segundos números em uma WABA compartilhada).',
  'Meta test numbers have no PIN and are pre-registered — leave this blank for them. Leaving it blank also keeps an existing registration untouched.':
    'Números de teste da Meta não têm PIN e já vêm registrados — deixe em branco para eles. Deixar em branco também mantém um registro existente intacto.',
  'Copy webhook URL': 'Copiar URL do webhook',
  'Verify Token': 'Token de verificação',
  'Subscribe to the "messages" webhook field': 'Assine o campo de webhook "messages"',

  // ---- WhatsApp via QR code ----------------------------------------
  'QR connection not available': 'Conexão por QR code indisponível',
  'The QR code connection has not been set up by the server administrator yet.':
    'A conexão por QR code ainda não foi configurada pelo administrador do servidor.',
  'Could not connect': 'Não foi possível conectar',
  'Could not connect to the WhatsApp service. Try again in a moment; if it keeps failing, contact the server administrator.':
    'Não foi possível conectar ao serviço do WhatsApp. Tente novamente em instantes; se continuar falhando, fale com o administrador do servidor.',

  // ---- Task statuses -----------------------------------------------
  'Completed (task)': 'Concluída',
  // Colour names not already in the base dictionary
  Indigo: 'Índigo',
  Yellow: 'Amarelo',
  Teal: 'Verde-azulado',

  // ---- Fields & tags -----------------------------------------------
  'Use color': 'Usar cor',
  'e.g. Newsletter': 'ex.: Newsletter',
  'Delete the tag': 'Excluir a etiqueta',
  'This removes it from all contacts and cannot be undone.':
    'Isso a remove de todos os contatos e não pode ser desfeito.',

  // ---- Quick replies -----------------------------------------------
  'e.g. welcome': 'ex.: boas-vindas',
  // Glossary: "Caixa de entrada" (never "inbox"), "caixa de resposta"
  // (never "compositor"), "Pesquisar" (never "Buscar"), "responsável"
  // for the person handling a conversation.
  'Canned responses for the inbox': 'Respostas rápidas para a caixa de entrada',
  'Ready-made answers your team inserts in the inbox by typing / followed by the shortcut. Variables fill in the contact, agent and company names.':
    'Respostas prontas que a equipe insere na caixa de entrada digitando / seguido do atalho. As variáveis preenchem o nome do contato, do responsável e da empresa.',
  'Type / plus the shortcut in the inbox composer to insert this text.':
    'Digite / mais o atalho na caixa de resposta para inserir este texto.',
  'Search by shortcut or title': 'Pesquisar por atalho ou título',
  'Assignee name': 'Nome do responsável',
  'Open inbox': 'Abrir caixa de entrada',

  // ---- Inbox / attendance ------------------------------------------
  'When a customer sends exactly one of these words (accents and punctuation ignored), the contact is marked as opted out: automations stop messaging them and broadcasts skip them. An admin can reactivate the contact from the inbox panel.':
    'Quando um cliente envia exatamente uma destas palavras (acentos e pontuação ignorados), o contato é marcado como descadastrado: as automações deixam de enviar mensagens e os disparos o pulam. Um administrador pode reativar o contato pela caixa de entrada.',
  'Response-time limits behind the Radar (dashboard and inbox) and the words a customer can send to stop receiving messages.':
    'Limites de tempo de resposta por trás do Radar (painel e caixa de entrada) e as palavras que um cliente pode enviar para parar de receber mensagens.',
  // Timezone picker — "<label> (<IANA id>)"
  'Brasília time': 'Horário de Brasília',
  'Manaus (Amazon time)': 'Manaus (horário do Amazonas)',
  Belém: 'Belém',
  Fortaleza: 'Fortaleza',
  Recife: 'Recife',
  'Salvador (Bahia)': 'Salvador (Bahia)',
  Cuiabá: 'Cuiabá',
  'Campo Grande': 'Campo Grande',
  'Porto Velho': 'Porto Velho',
  'Boa Vista': 'Boa Vista',
  'Rio Branco (Acre time)': 'Rio Branco (horário do Acre)',
  'Fernando de Noronha': 'Fernando de Noronha',
  'Buenos Aires': 'Buenos Aires',
  Montevideo: 'Montevidéu',
  Santiago: 'Santiago',
  Bogotá: 'Bogotá',
  Lima: 'Lima',
  'Mexico City': 'Cidade do México',
  'New York': 'Nova York',
  Chicago: 'Chicago',
  Denver: 'Denver',
  'Los Angeles': 'Los Angeles',
  Lisbon: 'Lisboa',
  London: 'Londres',
  Madrid: 'Madri',
  Paris: 'Paris',
  Berlin: 'Berlim',
  Rome: 'Roma',
  Luanda: 'Luanda',
  Maputo: 'Maputo',
  Tokyo: 'Tóquio',
  Sydney: 'Sydney',
  'Waiting means the customer has gone unanswered for longer than the SLA; cooling means the customer has not replied to you for the given hours.':
    'Aguardando significa que o cliente ficou sem resposta por mais tempo que o SLA; esfriando significa que o cliente não respondeu a você pelas horas indicadas.',

  // ---- Integrations / lead sources ---------------------------------
  Pipeline: 'Funil',
  'No assignee': 'Sem responsável',
  'The currency used for new deals and for pipeline and dashboard totals, and the reasons a deal can be marked as lost.':
    'A moeda usada em novos negócios e nos totais do funil e do painel, e os motivos pelos quais um negócio pode ser marcado como perdido.',

  // ---- Calendar ----------------------------------------------------
  'Google Calendar': 'Google Agenda',
  'The Google Agenda integration has not been set up by the server administrator yet.':
    'A integração com o Google Agenda ainda não foi configurada pelo administrador do servidor.',
  'The Outlook integration has not been set up by the server administrator yet.':
    'A integração com o Outlook ainda não foi configurada pelo administrador do servidor.',

  // ---- Plan --------------------------------------------------------
  Validity: 'Validade',
  'In trial': 'Em teste',
  'No end date': 'Sem data de término',
  'CRM field ← payload key. Leave blank to use the default key (name, phone, email, company — Portuguese aliases work too). Dotted paths like lead.phone work.':
    'Campo do CRM ← chave do payload. Deixe em branco para usar a chave padrão (name/nome, phone/telefone, email, company/empresa). Caminhos com ponto como lead.telefone funcionam.',

  // ---- Audit log ---------------------------------------------------
  'Request failed': 'Falha na solicitação',
  Change: 'Alteração',
  'Authenticator app': 'Aplicativo autenticador',
  'Waiting for QR scan': 'Aguardando leitura do QR',

  // ---- Platform admin ----------------------------------------------
  'Search accounts': 'Pesquisar contas',
  'Search by name or e-mail': 'Pesquisar por nome ou e-mail',

  // ---- Platform gate (/platform/login, /platform/acesso) ------------
  'Master panel': 'Painel master',
  'Set up panel access': 'Definir acesso ao painel',
  'Choose the username and password that will unlock the platform panel.':
    'Escolha o usuário e a senha que vão destravar o painel da plataforma.',
  'Enter the panel username and password to continue.':
    'Informe o usuário e a senha do painel para continuar.',
  Username: 'Usuário',
  'At least 8 characters. You can change it later in the panel.':
    'Pelo menos 8 caracteres. Você pode alterar depois dentro do painel.',
  'Checking...': 'Verificando…',
  'Save and open panel': 'Salvar e abrir o painel',
  'Open panel': 'Abrir painel',
  'Too many attempts. Wait a minute and try again.':
    'Muitas tentativas. Aguarde um minuto e tente de novo.',
  'Incorrect username or password': 'Usuário ou senha incorretos',
  'Set up the panel access first': 'Defina o acesso ao painel primeiro',
  'Panel access is already set up': 'O acesso ao painel já foi definido',
  'Username must have 3 to 40 characters (letters, numbers, . _ - @)':
    'O usuário precisa ter de 3 a 40 caracteres (letras, números, . _ - @)',
  'Password must have at least 8 characters': 'A senha precisa ter pelo menos 8 caracteres',
  'Current password is incorrect': 'A senha atual está incorreta',
  'Nothing to change': 'Nada para alterar',
  'Panel access': 'Acesso ao painel',
  'Lock panel': 'Bloquear painel',
  'Username and password asked on the master panel. They are separate from your CRM login.':
    'Usuário e senha pedidos no painel master. São separados do seu login no CRM.',
  'Leave blank to keep': 'Deixe em branco para manter',
  'Confirm new password': 'Confirmar nova senha',
  'At least 8 characters. Changing the password signs the panel out on other devices.':
    'Pelo menos 8 caracteres. Trocar a senha desconecta o painel nos outros dispositivos.',
  'Panel access updated': 'Acesso ao painel atualizado',

  // ---- Company / account fields ------------------------------------
  'Legal name': 'Razão social',
  'Acme Bakery Ltd.': 'Padaria Sol Ltda',
  'Acme Bakery': 'Padaria do Sol',
  'contact@company.com': 'contato@empresa.com.br',
  'Street, avenue, square…': 'Rua, avenida, praça…',
  'Suite, floor, building…': 'Sala, andar, bloco…',

  // ---- Currency labels (src/lib/currency.ts stores the pt-BR label;
  // these give en-US a reverse entry for the "CODE — label" option text
  // and for the label alone) -------------------------------------------
  'US dollar': 'Dólar americano',
  Euro: 'Euro',
  'British pound': 'Libra esterlina',
  'Indian rupee': 'Rúpia indiana',
  'Australian dollar': 'Dólar australiano',
  'Canadian dollar': 'Dólar canadense',
  'Brazilian real': 'Real brasileiro',
  'Japanese yen': 'Iene japonês',
  'Chinese yuan': 'Yuan chinês',
  'UAE dirham': 'Dirham dos Emirados',
  'South African rand': 'Rand sul-africano',
  'Nigerian naira': 'Naira nigeriana',
  'Singapore dollar': 'Dólar de Singapura',
  'Mexican peso': 'Peso mexicano',
  'USD — US dollar': 'USD — Dólar americano',
  'EUR — Euro': 'EUR — Euro',
  'GBP — British pound': 'GBP — Libra esterlina',
  'INR — Indian rupee': 'INR — Rúpia indiana',
  'AUD — Australian dollar': 'AUD — Dólar australiano',
  'CAD — Canadian dollar': 'CAD — Dólar canadense',
  'BRL — Brazilian real': 'BRL — Real brasileiro',
  'JPY — Japanese yen': 'JPY — Iene japonês',
  'CNY — Chinese yuan': 'CNY — Yuan chinês',
  'AED — UAE dirham': 'AED — Dirham dos Emirados',
  'ZAR — South African rand': 'ZAR — Rand sul-africano',
  'NGN — Nigerian naira': 'NGN — Naira nigeriana',
  'SGD — Singapore dollar': 'SGD — Dólar de Singapura',
  'MXN — Mexican peso': 'MXN — Peso mexicano',
};
