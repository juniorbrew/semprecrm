/** pt-BR copy for the "api" area — EN key → pt-BR. Loaded through ./index.ts. */
// Every key is the exact `error` / `message` string an API route under
// src/app/api returns. The UI shows these in toasts, so the DOM walker
// translates them by exact match. Keep keys byte-identical to the routes.
export const DICT_API: Record<string, string> = {
  // ---- generic ----------------------------------------------------------
  Unauthorized: 'Você precisa entrar para continuar',
  'Not found': 'Não encontrado',
  'Invalid JSON': 'O corpo da requisição não é um JSON válido',
  'Invalid JSON body.': 'O corpo da requisição não é um JSON válido.',
  'Body must be a JSON object': 'O corpo da requisição deve ser um objeto JSON',
  'Body must be a non-empty JSON object':
    'O corpo da requisição deve ser um objeto JSON com pelo menos um campo',
  'Body must be a JSON object, form-urlencoded or multipart form':
    'O corpo da requisição deve ser um objeto JSON, um formulário form-urlencoded ou multipart',
  'Internal server error':
    'Ocorreu um erro no servidor. Tente novamente em instantes',
  'cron not configured': 'O agendador (cron) não está configurado neste servidor',
  'Nothing to update': 'Nada para atualizar',
  'Too many keys': 'Foram enviadas chaves demais de uma vez',
  'Sync failed': 'Não foi possível sincronizar',
  'Failed to check plan limits':
    'Não foi possível verificar os limites do seu plano. Tente novamente',

  // ---- account ----------------------------------------------------------
  'Failed to load branding': 'Não foi possível carregar a identidade visual',
  'Failed to save branding': 'Não foi possível salvar a identidade visual',
  'Failed to load preferences': 'Não foi possível carregar as preferências',
  'Failed to save preferences': 'Não foi possível salvar as preferências',
  'Failed to update account': 'Não foi possível atualizar a conta',
  "'name' must be a string": 'O nome deve ser um texto',
  'Account name cannot be empty': 'O nome da conta não pode ficar vazio',
  'Account name must be 80 characters or fewer':
    'O nome da conta deve ter no máximo 80 caracteres',
  'Invalid registration data': 'Os dados cadastrais são inválidos. Confira e tente novamente',
  'Invalid contact data': 'Os dados de contato são inválidos. Confira e tente novamente',
  'Invalid account id': 'O identificador da conta é inválido',
  'Failed to update member': 'Não foi possível atualizar o membro da equipe',
  "'role' must be one of admin, agent, viewer":
    'O papel deve ser Administrador, Agente ou Visualizador',
  "'role' must be one of owner, admin, agent, viewer":
    'O papel deve ser Proprietário, Administrador, Agente ou Visualizador',
  'Use POST /api/account/transfer-ownership to promote a member to owner':
    'Para tornar um membro proprietário, use a opção "Transferir propriedade"',
  'Failed to transfer ownership': 'Não foi possível transferir a propriedade da conta',
  "'newOwnerUserId' must be a valid UUID":
    'O novo proprietário selecionado é inválido',
  'Failed to redeem invitation': 'Não foi possível aceitar o convite. Tente novamente',
  'Missing invitation token': 'O link do convite está incompleto. Abra o link recebido por e-mail',

  // ---- audit ------------------------------------------------------------
  'Unknown action filter': 'O filtro de ação não é reconhecido',
  "'actor' must be a UUID": 'O autor selecionado é inválido',
  'Invalid cursor': 'Não foi possível continuar a paginação. Recarregue a lista',
  'Failed to load audit log': 'Não foi possível carregar o registro de auditoria',
  'This action cannot be recorded from the client':
    'Esta ação não pode ser registrada a partir do aplicativo',
  "'entityType' is not recognised": 'O tipo de entidade não é reconhecido',
  'Failed to record audit entry': 'Não foi possível registrar a entrada de auditoria',
  "'event' must be 'enrolled' or 'disabled'":
    'O evento deve ser "ativada" ou "desativada"',
  'Could not verify MFA state':
    'Não foi possível verificar o estado da verificação em duas etapas',
  'Claimed event does not match the current MFA state':
    'O evento informado não corresponde ao estado atual da verificação em duas etapas',

  // ---- automations & flows ----------------------------------------------
  'trigger_type required': 'Escolha o gatilho da automação',
  'name and trigger_type are required':
    'Informe o nome e o gatilho da automação',
  'Cannot activate automation with invalid configuration':
    'Não é possível ativar a automação: a configuração tem erros. Corrija e tente novamente',
  'Cannot keep automation active with invalid configuration':
    'Não é possível manter a automação ativa: a configuração tem erros. Corrija e tente novamente',
  "status must be one of 'draft' | 'active' | 'archived'":
    'O status deve ser rascunho, ativo ou arquivado',
  'Cannot activate flow — fix the issues below first.':
    'Não é possível ativar o fluxo — corrija os problemas abaixo primeiro.',
  'name cannot be empty': 'O nome não pode ficar vazio',
  'name is required': 'Informe o nome',
  'Unknown flow template': 'O modelo de fluxo escolhido não existe',

  // ---- QR channel (gateway → app) ----------------------------------------
  'account_id, message_id and a valid status are required':
    'Informe account_id, message_id e um status válido',
  'account_id, message_id, from and a supported type are required':
    'Informe account_id, message_id, from e um tipo compatível',
  'account_id and a valid status are required':
    'Informe account_id e um status válido',
  'Failed to update message status':
    'Não foi possível atualizar o status da mensagem',
  'Failed to store session status':
    'Não foi possível salvar o status da sessão',

  // ---- chat & contacts --------------------------------------------------
  "'id' must be a uuid": 'O identificador informado é inválido',
  'Message not found': 'Mensagem não encontrada',
  'System messages cannot be deleted':
    'Mensagens do sistema não podem ser excluídas',
  'Invalid contact id': 'O identificador do contato é inválido',
  "'confirm' must be the contact's name":
    'Digite o nome do contato para confirmar',
  'Failed to load contact': 'Não foi possível carregar o contato',
  'Contact not found': 'Contato não encontrado',
  'Contact is already anonymized': 'Este contato já foi anonimizado',
  'Confirmation does not match the contact name':
    'A confirmação não corresponde ao nome do contato',
  'Failed to anonymize contact': 'Não foi possível anonimizar o contato',
  'Failed to export contact': 'Não foi possível exportar o contato',

  // ---- calendar ---------------------------------------------------------
  'Failed to load connections': 'Não foi possível carregar as conexões de agenda',
  'Failed to update the connection': 'Não foi possível atualizar a conexão de agenda',
  'Expected { provider, mirror_attending: boolean }':
    'Informe o provedor e se a participação deve ser espelhada',

  // ---- lead sources & inbound webhook -----------------------------------
  'Name is required': 'Informe o nome',
  'Name must be 80 characters or fewer': 'O nome deve ter no máximo 80 caracteres',
  'Failed to create lead source': 'Não foi possível criar a origem de leads',
  'Failed to rotate token': 'Não foi possível gerar um novo token',
  'Lead source not found': 'Origem de leads não encontrada',
  'Source not found': 'Origem não encontrada',
  'Lead capture is not included in this account plan':
    'A captura de leads não está incluída no plano desta conta',

  // ---- push -------------------------------------------------------------
  "'task_id' must be a uuid": 'O identificador da tarefa é inválido',
  "'message_id' must be a uuid": 'O identificador da mensagem é inválido',
  "'conversation_id' must be a uuid": 'O identificador da conversa é inválido',
  "'conversation_id' must be a uuid or null":
    'O identificador da conversa é inválido',
  "'chat_thread_id' must be a uuid or null":
    'O identificador da conversa interna é inválido',
  'Failed to load subscriptions':
    'Não foi possível carregar as inscrições de notificação',
  'Push is not configured on this server':
    'As notificações push não estão configuradas neste servidor',
  "'subscription' must be an object":
    'A inscrição de notificação enviada é inválida',
  "'subscription.endpoint' must be an https URL":
    'O endereço da inscrição de notificação deve ser uma URL https',
  "'subscription.keys' must carry p256dh and auth":
    'A inscrição de notificação está sem as chaves p256dh e auth',
  'Failed to save subscription':
    'Não foi possível salvar a inscrição de notificação',
  "'endpoint' or 'id' is required":
    'Informe o endereço ou o identificador da inscrição',
  'Failed to remove subscription':
    'Não foi possível remover a inscrição de notificação',

  // ---- WhatsApp: shared -------------------------------------------------
  'WhatsApp not configured':
    'O WhatsApp ainda não foi configurado. Conecte seu número em Configurações',
  'WhatsApp not configured.':
    'O WhatsApp ainda não foi configurado. Conecte seu número em Configurações.',
  'WhatsApp not configured. Please set up your WhatsApp integration first.':
    'O WhatsApp ainda não foi configurado. Conecte seu número em Configurações antes de continuar.',
  'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.':
    'O WhatsApp ainda não foi configurado. Conecte sua conta do WhatsApp Business em Configurações antes de continuar.',
  'WhatsApp not configured — cannot delete on Meta.':
    'O WhatsApp não está configurado — não é possível excluir na Meta.',
  'Conversation not found': 'Conversa não encontrada',
  'Contact phone number not found': 'O contato não tem um número de telefone',
  'Invalid phone number format': 'O número de telefone está em um formato inválido',
  'Template not found.': 'Modelo não encontrado.',
  'Invalid template id.': 'O identificador do modelo é inválido.',
  'Media ID is required': 'Informe o identificador da mídia',
  'Failed to fetch media': 'Não foi possível baixar a mídia',

  // ---- WhatsApp: send ---------------------------------------------------
  'conversation_id and message_type are required':
    'Informe a conversa e o tipo da mensagem',
  'Unsupported message type': 'Este tipo de mensagem não é compatível',
  'content_text is required for text messages':
    'Digite o texto da mensagem',
  'template_name is required for template messages':
    'Escolha o modelo da mensagem',
  'media_url is required for media messages':
    'Selecione o arquivo de mídia da mensagem',
  'Caption exceeds the 1024-character limit':
    'A legenda ultrapassa o limite de 1024 caracteres',
  'reply_to_message_id not found in this conversation':
    'A mensagem respondida não pertence a esta conversa',
  'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.':
    'O modelo está corrompido localmente — execute "Sincronizar da Meta" em Configurações para corrigi-lo.',
  'Failed to send message': 'Não foi possível enviar a mensagem',
  'Message sent to Meta but failed to save locally':
    'A mensagem foi enviada pela Meta, mas não foi possível salvá-la aqui. Ela aparecerá após a próxima sincronização',
  'Message templates require the official WhatsApp API. This conversation is on the QR channel — send a text message instead.':
    'Modelos de mensagem exigem a API oficial do WhatsApp. Esta conversa está no canal QR — envie uma mensagem de texto.',

  // ---- WhatsApp: react --------------------------------------------------
  'message_id and emoji are required': 'Informe a mensagem e o emoji',
  'Cannot react to a message that has not been sent to WhatsApp':
    'Não é possível reagir a uma mensagem que ainda não foi enviada ao WhatsApp',
  'Reactions are not available in QR channel conversations yet.':
    'Reações ainda não estão disponíveis em conversas do canal QR.',
  'Reaction sent to Meta but DB delete failed':
    'A reação foi removida na Meta, mas não foi possível atualizá-la aqui',
  'Reaction sent to Meta but DB upsert failed':
    'A reação foi enviada à Meta, mas não foi possível salvá-la aqui',
  'Failed to react to message': 'Não foi possível reagir à mensagem',

  // ---- WhatsApp: broadcast ----------------------------------------------
  'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array':
    'Selecione pelo menos um destinatário para o disparo',
  'template_name is required': 'Escolha o modelo do disparo',
  'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.':
    'O modelo está corrompido localmente — execute "Sincronizar da Meta" em Configurações para corrigi-lo antes de disparar.',
  'Failed to process broadcast': 'Não foi possível processar o disparo',

  // ---- WhatsApp: config -------------------------------------------------
  'Failed to fetch configuration': 'Não foi possível carregar a configuração',
  'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.':
    'Nenhuma configuração do WhatsApp salva ainda. Preencha o formulário e clique em "Salvar configuração".',
  'No WhatsApp configuration saved yet.':
    'Nenhuma configuração do WhatsApp salva ainda.',
  'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.':
    'O token de acesso salvo não pode ser descriptografado com a ENCRYPTION_KEY atual. Isso costuma acontecer quando a chave mudou ou é diferente entre ambientes (local, Hostinger, Vercel). Clique em "Redefinir configuração" abaixo e salve novamente.',
  "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.":
    'O token de acesso salvo não pode ser descriptografado — provavelmente a ENCRYPTION_KEY mudou. Informe o token novamente para corrigir.',
  'access_token and phone_number_id are required':
    'Informe o token de acesso e o ID do número de telefone',
  'PIN must be exactly 6 digits.': 'O PIN deve ter exatamente 6 dígitos.',
  'Failed to validate configuration': 'Não foi possível validar a configuração',
  'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one SempreCRM user.':
    'Este número do WhatsApp já está vinculado a outra conta nesta instância. Cada número só pode ser conectado a um usuário do SempreCRM.',
  'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.':
    'Não foi possível criptografar o token. Verifique se a ENCRYPTION_KEY nas variáveis de ambiente é um texto hexadecimal válido de 64 caracteres.',
  'Your plan has no free slot for another connected WhatsApp number. Disconnect one or upgrade the plan.':
    'Seu plano não tem vaga para mais um número do WhatsApp conectado. Desconecte um número ou faça upgrade do plano.',
  'Failed to update configuration': 'Não foi possível atualizar a configuração',
  'Failed to delete configuration': 'Não foi possível excluir a configuração',

  // ---- WhatsApp: templates ----------------------------------------------
  'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".':
    'Modelos de AUTENTICAÇÃO ainda não são suportados aqui — crie-os no Gerenciador do WhatsApp da Meta e use "Sincronizar da Meta".',
  'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.':
    'Modelos de AUTENTICAÇÃO não podem ser editados aqui — gerencie-os no Gerenciador do WhatsApp da Meta.',
  'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.':
    'Falta o ID da conta do WhatsApp Business (WABA). Reconecte sua conta em Configurações.',
  'This template was never submitted to Meta — use New Template to submit it instead.':
    'Este modelo nunca foi enviado à Meta — use "Novo modelo" para enviá-lo.',
  'This template cannot be edited in its current status. Only APPROVED, REJECTED and PAUSED templates can be edited.':
    'Este modelo não pode ser editado no status atual. Só modelos APROVADOS, REJEITADOS ou PAUSADOS podem ser editados.',
  'Submitted to Meta but failed to save locally. Run "Sync from Meta" to recover.':
    'O modelo foi enviado à Meta, mas não foi possível salvá-lo aqui. Execute "Sincronizar da Meta" para recuperá-lo.',
  'Edited on Meta but failed to save locally. Run "Sync from Meta" to recover.':
    'O modelo foi editado na Meta, mas não foi possível salvá-lo aqui. Execute "Sincronizar da Meta" para recuperá-lo.',
  'Deleted on Meta but failed to delete locally. Run "Sync from Meta" to recover.':
    'O modelo foi excluído na Meta, mas não foi possível excluí-lo aqui. Execute "Sincronizar da Meta" para recuperá-lo.',

  // ---- WhatsApp: webhook (Meta-facing, shown only in logs/tools) --------
  'Missing verification parameters': 'Faltam os parâmetros de verificação',
  'Verification failed': 'A verificação falhou',
  'Verification token mismatch': 'O token de verificação não confere',
  'Invalid signature': 'A assinatura da requisição é inválida',
};
