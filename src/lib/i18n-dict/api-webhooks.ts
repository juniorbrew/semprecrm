/** pt-BR copy for Settings → API e Webhooks (migration 093) — EN key → pt-BR. Loaded through ./index.ts. */
// Keys that other areas already define (Name, Cancel, Save, Delete…) are not repeated here.
export const DICT_API_WEBHOOKS: Record<string, string> = {
  // ---- panel ------------------------------------------------------------
  'API and Webhooks': 'API e Webhooks',
  'Only account admins can manage API keys and webhooks, because they are credentials.':
    'Só administradores da conta podem gerenciar chaves de API e webhooks, pois são credenciais.',
  'Connect n8n, Zapier or your own systems: send messages with the API and receive events as they happen. Documentation: docs/api-webhooks.md.':
    'Conecte o n8n, o Zapier ou seus próprios sistemas: envie mensagens pela API e receba eventos assim que acontecem. Documentação: docs/api-webhooks.md.',

  // ---- API keys ---------------------------------------------------------
  'API keys': 'Chaves de API',
  'Use a key in the Authorization: Bearer header to call the SempreCRM API from n8n, Zapier or your own systems. The key is shown only once.':
    'Use uma chave no cabeçalho Authorization: Bearer para chamar a API do SempreCRM a partir do n8n, Zapier ou dos seus sistemas. A chave é mostrada uma única vez.',
  'New API key': 'Nova chave de API',
  'API key created': 'Chave de API criada',
  'API key revoked': 'Chave de API revogada',
  'No API keys yet': 'Ainda não há chaves de API',
  'Create a key to send messages from other systems.': 'Crie uma chave para enviar mensagens a partir de outros sistemas.',
  Key: 'Chave',
  Permissions: 'Permissões',
  'Last used': 'Último uso',
  Revoked: 'Revogada',
  Expired: 'Expirada',
  'Valid until': 'Válida até',
  Rotate: 'Rotacionar',
  Revoke: 'Revogar',
  'Give it a name you will recognise (for example "n8n production") and pick what it may do.':
    'Dê um nome que você reconheça (por exemplo "n8n produção") e escolha o que a chave pode fazer.',
  'Create key': 'Criar chave',
  'Copy it now. For your security it will not be shown again.':
    'Copie agora. Por segurança, ela não será mostrada novamente.',
  'I saved the key': 'Já guardei a chave',
  'Rotate API key': 'Rotacionar chave de API',
  'A new key with the same permissions is created. The old one keeps working during the grace period so you can switch without downtime.':
    'Uma nova chave com as mesmas permissões é criada. A antiga continua funcionando durante o período de transição, para você trocar sem ficar fora do ar.',
  'Keep the old key working for': 'Manter a chave antiga funcionando por',
  'Revoke it now': 'Revogar agora',
  day: 'dia',
  days: 'dias',
  'Rotate key': 'Rotacionar chave',
  'Revoke API key': 'Revogar chave de API',
  'Integrations using this key stop working immediately. This cannot be undone.':
    'As integrações que usam esta chave param de funcionar na hora. Não dá para desfazer.',
  'Send WhatsApp messages': 'Enviar mensagens de WhatsApp',
  'Look up contacts by phone': 'Consultar contatos pelo telefone',

  // ---- endpoints ----------------------------------------------------------
  'Webhook endpoints': 'Endpoints de webhook',
  'SempreCRM sends a signed POST to your URL whenever the events you pick happen. Failed deliveries are retried for up to 3 days.':
    'O SempreCRM envia um POST assinado para a sua URL sempre que os eventos escolhidos acontecem. Entregas que falham são tentadas de novo por até 3 dias.',
  'Add endpoint': 'Adicionar endpoint',
  'Edit endpoint': 'Editar endpoint',
  'Endpoint created': 'Endpoint criado',
  'Endpoint updated': 'Endpoint atualizado',
  'Endpoint deleted': 'Endpoint excluído',
  'Delete endpoint': 'Excluir endpoint',
  'Pending deliveries and the delivery log of this endpoint are deleted too.':
    'As entregas pendentes e o histórico de entregas deste endpoint também são excluídos.',
  'No webhook endpoints yet': 'Ainda não há endpoints de webhook',
  'Add an https URL to receive messages, conversations and contacts in real time.':
    'Adicione uma URL https para receber mensagens, conversas e contatos em tempo real.',
  'All events': 'Todos os eventos',
  'Disabled after repeated failures': 'Desativado após falhas repetidas',
  Failing: 'Com falhas',
  Enabled: 'Ativado',
  'The URL must use https and be reachable from the internet.':
    'A URL deve usar https e estar acessível pela internet.',
  'Endpoint URL': 'URL do endpoint',
  'Events to send': 'Eventos a enviar',
  'Use this signing secret to verify that requests really come from SempreCRM. You can reveal it again later.':
    'Use este segredo de assinatura para confirmar que as requisições vêm mesmo do SempreCRM. Você pode revelá-lo de novo depois.',
  'New signing secret': 'Novo segredo de assinatura',
  'Signing secret': 'Segredo de assinatura',
  Reveal: 'Revelar',
  Hide: 'Ocultar',
  'Rotate secret': 'Rotacionar segredo',
  'The previous secret also signs deliveries until': 'O segredo anterior também assina as entregas até',
  'Send test event': 'Enviar evento de teste',
  'Test event delivered': 'Evento de teste entregue',
  'Test event failed': 'Falha no evento de teste',
  'This endpoint was disabled automatically after 2 days without a successful delivery. Fix the URL and turn it back on; pending events keep being retried for up to 3 days.':
    'Este endpoint foi desativado automaticamente após 2 dias sem nenhuma entrega com sucesso. Corrija a URL e ative de novo; os eventos pendentes continuam sendo tentados por até 3 dias.',

  // ---- delivery log ---------------------------------------------------------
  'Delivery log': 'Histórico de entregas',
  Delivered: 'Entregue',
  Pending: 'Pendente',
  Failed: 'Falhou',
  Event: 'Evento',
  Attempts: 'Tentativas',
  When: 'Quando',
  'Next attempt': 'Próxima tentativa',
  Resend: 'Reenviar',
  'Event resent': 'Evento reenviado',
  'Resend failed': 'Falha ao reenviar',
  Filter: 'Filtrar',
  'Load more': 'Carregar mais',
  'No deliveries yet. Send a test event to try it.': 'Ainda não há entregas. Envie um evento de teste para experimentar.',

  // ---- event catalog ----------------------------------------------------------
  'A customer message arrived': 'Chegou uma mensagem de um cliente',
  'A message was sent to a customer (agent, bot, automation, API)':
    'Uma mensagem foi enviada a um cliente (atendente, bot, automação, API)',
  'A message status changed (sent, delivered, read, failed)':
    'O status de uma mensagem mudou (enviada, entregue, lida, falhou)',
  'A new conversation started': 'Uma nova conversa começou',
  'A conversation was resolved': 'Uma conversa foi resolvida',
  'A resolved conversation was reopened': 'Uma conversa resolvida foi reaberta',
  'A new contact was created': 'Um novo contato foi criado',

  // ---- API error messages (routes under /api/api-keys and /api/webhooks) ----
  'Failed to load API keys': 'Não foi possível carregar as chaves de API',
  'Failed to create the API key': 'Não foi possível criar a chave de API',
  'Failed to rotate the API key': 'Não foi possível rotacionar a chave de API',
  'Failed to revoke the API key': 'Não foi possível revogar a chave de API',
  'Enter a name of up to 80 characters': 'Informe um nome de até 80 caracteres',
  'Pick at least one permission': 'Escolha pelo menos uma permissão',
  'API key limit reached. Revoke a key first': 'Limite de chaves de API atingido. Revogue uma chave primeiro',
  'The grace period must be between 0 and 168 hours': 'O período de transição deve ficar entre 0 e 168 horas',
  'This API key is no longer active': 'Esta chave de API não está mais ativa',
  'Failed to load webhook endpoints': 'Não foi possível carregar os endpoints de webhook',
  'Failed to save the endpoint': 'Não foi possível salvar o endpoint',
  'Failed to create the endpoint': 'Não foi possível criar o endpoint',
  'Failed to update the endpoint': 'Não foi possível atualizar o endpoint',
  'Failed to delete the endpoint': 'Não foi possível excluir o endpoint',
  'Failed to rotate the secret': 'Não foi possível rotacionar o segredo',
  'Failed to load deliveries': 'Não foi possível carregar as entregas',
  'Enter a valid URL': 'Informe uma URL válida',
  'The URL must use https': 'A URL deve usar https',
  'The URL cannot contain a username or password': 'A URL não pode conter usuário ou senha',
  'This address is not reachable from the internet': 'Este endereço não é acessível pela internet',
  'Pick at least one event': 'Escolha pelo menos um evento',
  'Endpoint limit reached. Delete one first': 'Limite de endpoints atingido. Exclua um primeiro',
  'The overlap must be between 0 and 168 hours': 'A sobreposição deve ficar entre 0 e 168 horas',
  'The note can have up to 200 characters': 'A observação pode ter até 200 caracteres',
  'Enter valid IP addresses or CIDR ranges (up to 10)': 'Informe endereços IP ou faixas CIDR válidos (até 10)',
  'The URL must use the default https port (443)': 'A URL deve usar a porta padrão do https (443)',
  'Enable the endpoint first': 'Ative o endpoint primeiro',
  'This API key is already being rotated': 'Esta chave de API já está em período de transição',
  'Failed to load the request log': 'Não foi possível carregar o histórico de requisições',

  // ---- API key note, allowlist, request log; secret overlap ----------------
  'Only from': 'Somente de',
  Requests: 'Requisições',
  'No requests recorded yet.': 'Nenhuma requisição registrada ainda.',
  'Shows the last 50 requests of the past 7 days.': 'Mostra as últimas 50 requisições dos últimos 7 dias.',
  'Note (optional)': 'Observação (opcional)',
  'Allowed IP addresses (optional)': 'Endereços IP permitidos (opcional)',
  'Leave empty to accept any address. Separate entries with commas or new lines (up to 10).':
    'Deixe em branco para aceitar qualquer endereço. Separe os itens por vírgula ou quebra de linha (até 10).',
  'Keep the old secret valid for': 'Manter o segredo antigo válido por',
  'Switch immediately': 'Trocar imediatamente',
}
