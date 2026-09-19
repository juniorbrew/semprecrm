/** pt-BR copy for the "settings" area — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_SETTINGS: Record<string, string> = {
  // ---- Appearance --------------------------------------------------
  'Use theme': 'Usar tema',
  'Theme ID': 'ID do tema',
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

  // ---- Fields & tags -----------------------------------------------
  'e.g. Newsletter': 'ex.: Newsletter',
  'Delete the tag': 'Excluir a etiqueta',
  'This removes it from all contacts and cannot be undone.':
    'Isso a remove de todos os contatos e não pode ser desfeito.',

  // ---- Quick replies -----------------------------------------------
  'e.g. welcome': 'ex.: boas-vindas',

  // ---- Inbox / attendance ------------------------------------------
  'Waiting means the customer has gone unanswered for longer than the SLA; cooling means the customer has not replied to you for the given hours.':
    'Aguardando significa que o cliente ficou sem resposta por mais tempo que o SLA; esfriando significa que o cliente não respondeu a você pelas horas indicadas.',

  // ---- Integrations / lead sources ---------------------------------
  Pipeline: 'Funil',
  'CRM field ← payload key. Leave blank to use the default key (name, phone, email, company — Portuguese aliases work too). Dotted paths like lead.phone work.':
    'Campo do CRM ← chave do payload. Deixe em branco para usar a chave padrão (name/nome, phone/telefone, email, company/empresa). Caminhos com ponto como lead.telefone funcionam.',

  // ---- Audit log ---------------------------------------------------
  'Request failed': 'Falha na solicitação',

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
