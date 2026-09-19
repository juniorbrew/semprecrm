import { EN_TO_PT_EXTRA } from './i18n-extra';
import { EN_TO_PT_AREAS } from './i18n-dict';

export const LANGUAGES = ['pt-BR', 'en-US'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'pt-BR';
export const LANGUAGE_STORAGE_KEY = 'semprecrm-language';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

/**
 * Compatibility catalogue for screens that still contain literal text.
 * New components should call `t()` from useLanguage directly. Keeping this
 * catalogue central also lets dialogs, toasts and placeholders switch live.
 */
export const EN_TO_PT: Record<string, string> = {
  ...EN_TO_PT_EXTRA,
  Dashboard: 'Painel',
  Inbox: 'Caixa de entrada',
  Contacts: 'Contatos',
  Pipelines: 'Funis',
  Broadcasts: 'Disparos',
  Automations: 'Automações',
  Flows: 'Fluxos',
  Settings: 'Configurações',
  Profile: 'Perfil',
  'Sign out': 'Sair',
  User: 'Usuário',
  Owner: 'Proprietário',
  Admin: 'Administrador',
  Agent: 'Agente',
  Viewer: 'Visualizador',
  'Close menu': 'Fechar menu',
  'Open menu': 'Abrir menu',
  'Open account menu': 'Abrir menu da conta',
  'Beta feature': 'Recurso beta',
  Overview: 'Visão geral',
  'Your profile': 'Seu perfil',
  'Login & security': 'Login e segurança',
  Appearance: 'Aparência',
  Templates: 'Modelos',
  'Fields & tags': 'Campos e etiquetas',
  'Deals & currency': 'Negócios e moeda',
  'Team members': 'Membros da equipe',
  Account: 'Conta',
  Workspace: 'Espaço de trabalho',
  Language: 'Idioma',
  'Portuguese (Brazil)': 'Português (Brasil)',
  English: 'Inglês',
  'Set the language, mode and accent color used across the system. Preferences are saved on this device.':
    'Defina o idioma, o modo e a cor de destaque do sistema. As preferências ficam salvas neste dispositivo.',
  'Everything in one place — your account and your workspace. Pick a section to manage it.':
    'Tudo em um só lugar — sua conta e seu espaço de trabalho. Escolha uma seção para gerenciá-la.',
  Email: 'E-mail',
  'Email Address': 'Endereço de e-mail',
  Password: 'Senha',
  'Current password': 'Senha atual',
  'New password': 'Nova senha',
  'Confirm password': 'Confirmar senha',
  'Confirm new password': 'Confirmar nova senha',
  'Full name': 'Nome completo',
  Company: 'Empresa',
  'Sign in': 'Entrar',
  'Signing in...': 'Entrando...',
  'Sign in to accept': 'Entre para aceitar o convite',
  "Sign in and we'll take you to the invitation.":
    'Entre e levaremos você até o convite.',
  'Create account': 'Criar conta',
  'Create account & join': 'Criar conta e entrar',
  'Creating account...': 'Criando conta...',
  'Forgot password?': 'Esqueceu a senha?',
  'Reset password': 'Redefinir senha',
  'Send reset link': 'Enviar link de recuperação',
  'Sending...': 'Enviando...',
  'Back to sign in': 'Voltar para o login',
  'Check your email': 'Verifique seu e-mail',
  'Already have an account?': 'Já possui uma conta?',
  "Don't have an account?": 'Ainda não possui uma conta?',
  'Create a new account instead': 'Criar uma nova conta',
  'Enter your password': 'Digite sua senha',
  'At least 6 characters': 'No mínimo 6 caracteres',
  'Repeat your password': 'Repita sua senha',
  'Passwords do not match': 'As senhas não coincidem',
  'Password must be at least 6 characters':
    'A senha deve ter no mínimo 6 caracteres',
  'Get started with CRM Template for WhatsApp':
    'Comece a usar o CRM para WhatsApp',
  'Welcome back': 'Bem-vindo de volta',
  'Sign in to your account': 'Entre na sua conta',
  'Active Conversations': 'Conversas ativas',
  'New Contacts Today': 'Novos contatos hoje',
  'Messages Sent Today': 'Mensagens enviadas hoje',
  'Average First Response Time': 'Tempo médio da primeira resposta',
  'vs yesterday': 'em relação a ontem',
  'Quick Actions': 'Ações rápidas',
  'Add Contact': 'Adicionar contato',
  'New Broadcast': 'Novo disparo',
  'New Automation': 'Nova automação',
  'View Inbox': 'Ver caixa de entrada',
  'Recent Activity': 'Atividade recente',
  'Conversations Over Time': 'Conversas ao longo do tempo',
  'Pipeline Overview': 'Visão geral do funil',
  'No data yet': 'Ainda não há dados',
  'No recent activity': 'Nenhuma atividade recente',
  'Loading...': 'Carregando...',
  'Loading…': 'Carregando…',
  Save: 'Salvar',
  'Saving...': 'Salvando...',
  'Saving…': 'Salvando…',
  Saved: 'Salvo',
  Cancel: 'Cancelar',
  Close: 'Fechar',
  Back: 'Voltar',
  Next: 'Avançar',
  Continue: 'Continuar',
  Done: 'Concluído',
  Edit: 'Editar',
  Delete: 'Excluir',
  'Deleting...': 'Excluindo...',
  'Deleting…': 'Excluindo…',
  Create: 'Criar',
  'Creating...': 'Criando...',
  'Creating…': 'Criando…',
  Update: 'Atualizar',
  Search: 'Pesquisar',
  Clear: 'Limpar',
  Copy: 'Copiar',
  Copied: 'Copiado',
  Import: 'Importar',
  'Export CSV': 'Exportar CSV',
  Actions: 'Ações',
  Action: 'Ação',
  Status: 'Status',
  Name: 'Nome',
  Phone: 'Telefone',
  Date: 'Data',
  Details: 'Detalhes',
  Notes: 'Observações',
  Description: 'Descrição',
  Category: 'Categoria',
  Type: 'Tipo',
  Value: 'Valor',
  Color: 'Cor',
  Currency: 'Moeda',
  'Default currency': 'Moeda padrão',
  All: 'Todos',
  'All statuses': 'Todos os status',
  Active: 'Ativo',
  Inactive: 'Inativo',
  Paused: 'Pausado',
  Draft: 'Rascunho',
  Scheduled: 'Agendado',
  Sending: 'Enviando',
  Sent: 'Enviado',
  Delivered: 'Entregue',
  Read: 'Lido',
  Failed: 'Falhou',
  Pending: 'Pendente',
  Completed: 'Concluído',
  Open: 'Aberto',
  Closed: 'Fechado',
  Won: 'Ganho',
  Lost: 'Perdido',
  Contact: 'Contato',
  'Add your first contact': 'Adicione seu primeiro contato',
  'Create Contact': 'Criar contato',
  'Edit Contact': 'Editar contato',
  'Delete Contact': 'Excluir contato',
  'Contact details': 'Detalhes do contato',
  'Contact created': 'Contato criado',
  'Contact updated': 'Contato atualizado',
  'Contact deleted': 'Contato excluído',
  'Import Contacts': 'Importar contatos',
  'Filter by Tags': 'Filtrar por etiquetas',
  Tags: 'Etiquetas',
  'Add Tag': 'Adicionar etiqueta',
  'Add Note': 'Adicionar observação',
  'Add a note...': 'Adicione uma observação...',
  'Custom Fields': 'Campos personalizados',
  'Custom fields': 'Campos personalizados',
  'No contacts found': 'Nenhum contato encontrado',
  Conversation: 'Conversa',
  'Close Conversation': 'Encerrar conversa',
  'Reopen Conversation': 'Reabrir conversa',
  'Assign Conversation': 'Atribuir conversa',
  'Assigned To': 'Atribuído a',
  Unassigned: 'Não atribuído',
  'Type a message...': 'Digite uma mensagem...',
  'Send message': 'Enviar mensagem',
  'Attach media': 'Anexar mídia',
  'Choose a conversation from the left to start messaging':
    'Escolha uma conversa à esquerda para começar a conversar',
  'No conversations found': 'Nenhuma conversa encontrada',
  'New Pipeline': 'Novo funil',
  'Create Pipeline': 'Criar funil',
  'Add Pipeline': 'Adicionar funil',
  'Delete Pipeline': 'Excluir funil',
  'Pipeline Settings': 'Configurações do funil',
  'Add Deal': 'Adicionar negócio',
  'Create Deal': 'Criar negócio',
  'Edit Deal': 'Editar negócio',
  'Delete Deal': 'Excluir negócio',
  'Deal title': 'Título do negócio',
  'Expected Close Date': 'Data prevista de fechamento',
  'Broadcast Name': 'Nome do disparo',
  Audience: 'Público',
  'Audience Summary': 'Resumo do público',
  'Estimated Reach': 'Alcance estimado',
  'Confirm & Send': 'Confirmar e enviar',
  'Confirm Broadcast': 'Confirmar disparo',
  'Save as Draft': 'Salvar como rascunho',
  'Send Broadcast': 'Enviar disparo',
  'Create Automation': 'Criar automação',
  'Automation created': 'Automação criada',
  'Automation saved': 'Automação salva',
  'Automation deleted': 'Automação excluída',
  'Automation activated': 'Automação ativada',
  'Automation paused': 'Automação pausada',
  Activate: 'Ativar',
  Pause: 'Pausar',
  Duplicate: 'Duplicar',
  'Add step': 'Adicionar etapa',
  'Add action': 'Adicionar ação',
  Trigger: 'Gatilho',
  'Condition (If/Else)': 'Condição (Se/Senão)',
  Wait: 'Aguardar',
  'Send Message': 'Enviar mensagem',
  'Create a new flow': 'Criar um novo fluxo',
  'Create blank flow': 'Criar fluxo em branco',
  'Create your first flow': 'Crie seu primeiro fluxo',
  'Flow name': 'Nome do fluxo',
  'Add node': 'Adicionar nó',
  'Delete node': 'Excluir nó',
  'Execution logs': 'Registros de execução',
  'Account details': 'Detalhes da conta',
  'Display name': 'Nome de exibição',
  'Change photo': 'Alterar foto',
  'Change your password': 'Alterar sua senha',
  'Active sessions': 'Sessões ativas',
  'Save changes': 'Salvar alterações',
  'Accent color': 'Cor de destaque',
  'Color mode': 'Modo de cor',
  Light: 'Claro',
  Dark: 'Escuro',
  System: 'Sistema',
  'API Credentials': 'Credenciais da API',
  Connected: 'Conectado',
  'Not connected': 'Não conectado',
  'Test Connection': 'Testar conexão',
  'Save Configuration': 'Salvar configuração',
  'Generate link': 'Gerar link',
  'Invite member': 'Convidar membro',
  Role: 'Função',
  Members: 'Membros',
  'Remove member': 'Remover membro',
  'Accept invitation': 'Aceitar convite',
  'Invitation not found': 'Convite não encontrado',
  Error: 'Erro',
  Success: 'Sucesso',
  'Something went wrong': 'Algo deu errado',
  'Try again': 'Tentar novamente',
  'This action cannot be undone.': 'Esta ação não pode ser desfeita.',
  'No issues. Ready to activate.': 'Nenhum problema. Pronto para ativar.',
  'Delete selected': 'Excluir selecionados',
  'Active Deals': 'Negócios ativos',
  Template: 'Modelo',
  'Button reply': 'Resposta de botão',
  'Select a conversation': 'Selecione uma conversa',
  'No teammates available': 'Nenhum colega de equipe disponível',
  Unassign: 'Remover atribuição',
  'Send a template to start the conversation':
    'Envie um modelo para iniciar a conversa',
  'Send template': 'Enviar modelo',
  'Invite created': 'Convite criado',
  'Save this link now.': 'Salve este link agora.',
  'Send via WhatsApp': 'Enviar pelo WhatsApp',
  'Generate a one-time invite link. Share it via WhatsApp, Slack, or any channel you like — no email service required.':
    'Gere um link de convite de uso único. Compartilhe pelo WhatsApp, Slack ou qualquer outro canal — nenhum serviço de e-mail é necessário.',
  'Trigger this automation to see runs here.':
    'Acione esta automação para ver as execuções aqui.',
  'Not set up yet': 'Ainda não configurado',
  'Needs reconnecting': 'Precisa ser reconectado',
  'View team members': 'Ver membros da equipe',
  'Manage message templates': 'Gerenciar modelos de mensagem',
  'Tags and custom fields': 'Etiquetas e campos personalizados',
  'Your account': 'Sua conta',
  'Settings sections': 'Seções de configurações',
  Mode: 'Modo',
  'Use light mode': 'Usar modo claro',
  'Use dark mode': 'Usar modo escuro',
  'Switch to light mode': 'Mudar para o modo claro',
  'Switch to dark mode': 'Mudar para o modo escuro',
  'The default — confident, slightly playful.':
    'O padrão — confiante e levemente descontraído.',
  'Growth-coded, nods at messaging without copying WhatsApp green.':
    'Inspirado em crescimento e mensagens, sem copiar o verde do WhatsApp.',
  'Clean B2B-SaaS blue — calm and product-y.':
    'Azul B2B SaaS limpo — tranquilo e focado no produto.',
  'Warm and friendly — feels good for SMB teams.':
    'Quente e amigável — ótimo para equipes de pequenas empresas.',
  'Bold and modern — D2C, creator-economy, lifestyle.':
    'Ousado e moderno — D2C, economia criativa e lifestyle.',
  Violet: 'Violeta',
  Emerald: 'Esmeralda',
  Cobalt: 'Cobalto',
  Amber: 'Âmbar',
  Rose: 'Rosa',
  'Map template variables to contact fields, custom fields, or static':
    'Associe as variáveis do modelo a campos do contato, campos personalizados ou valores fixos',
  'Build branching, button-driven WhatsApp conversations. Useful for':
    'Crie conversas ramificadas no WhatsApp orientadas por botões. Útil para',
  'Build your first conversation — a welcome menu, an order lookup, an FAQ':
    'Crie sua primeira conversa — um menu de boas-vindas, consulta de pedido ou FAQ',
  'Variable key (stored in flow_runs.vars; alphanumeric + underscore)':
    'Chave da variável (armazenada em flow_runs.vars; letras, números e sublinhado)',
  'Buttons (1–3) — each one routes to a different next node':
    'Botões (1–3) — cada um direciona para um próximo nó diferente',
  'Rows (1–10 total across all sections)':
    'Linhas (1–10 no total entre todas as seções)',
  'Approve a template in Meta WhatsApp Manager, then sync it':
    'Aprove um modelo no Gerenciador do WhatsApp da Meta e depois sincronize-o',
  "Minutes to reply to a customer's first unreplied message, by":
    'Minutos para responder à primeira mensagem não respondida de um cliente, por',
  'Quick-start templates': 'Modelos para começar',
  'Welcome Message': 'Mensagem de boas-vindas',
  'Auto-reply to first-time contacts with a greeting.':
    'Responda automaticamente ao primeiro contato com uma saudação.',
  'Out of Office': 'Fora do horário',
  'Auto-reply during off-hours so nobody is left waiting.':
    'Responda fora do expediente para ninguém ficar esperando.',
  'Lead Qualifier': 'Qualificação de lead',
  'Ask qualification questions to filter inbound leads.':
    'Faça perguntas de qualificação para filtrar os leads recebidos.',
  'Follow-up Reminder': 'Lembrete de acompanhamento',
  'Send a nudge if a contact has not replied within 24 hours.':
    'Envie um lembrete se o contato não responder em até 24 horas.',
  'No automations yet': 'Ainda não há automações',
  'Delete automation': 'Excluir automação',
  'Failed to update': 'Falha ao atualizar',
  'Failed to duplicate': 'Falha ao duplicar',
  'Failed to delete': 'Falha ao excluir',
  'Automation duplicated': 'Automação duplicada',
  'Send Template': 'Enviar modelo',
  'Remove Tag': 'Remover etiqueta',
  'Update Contact Field': 'Atualizar campo do contato',
  'Send Webhook': 'Enviar webhook',
  'New Message Received': 'Nova mensagem recebida',
  'Any incoming message': 'Qualquer mensagem recebida',
  'First Message from Contact': 'Primeira mensagem do contato',
  'First time this contact ever messages you (works for manually-added contacts too)':
    'Primeira vez que este contato envia uma mensagem (também funciona para contatos adicionados manualmente)',
  'Keyword Match': 'Correspondência de palavra-chave',
  'Message contains specific keyword(s)':
    'A mensagem contém palavras-chave específicas',
  'New Contact Created': 'Novo contato criado',
  'When a contact is auto-created from an incoming message':
    'Quando um contato é criado automaticamente a partir de uma mensagem recebida',
  'Conversation Assigned': 'Conversa atribuída',
  'When assigned to an agent': 'Quando atribuída a um agente',
  'Tag Added': 'Etiqueta adicionada',
  'When a tag is added to a contact':
    'Quando uma etiqueta é adicionada a um contato',
  'Time-Based': 'Baseado em horário',
  'On a recurring schedule': 'Em um agendamento recorrente',
  'Tag id': 'ID da etiqueta',
  'Select a tag…': 'Selecione uma etiqueta…',
  'Agent id': 'ID do agente',
  'Select an agent…': 'Selecione um agente…',
  'Template name': 'Nome do modelo',
  'Select a template…': 'Selecione um modelo…',
  'Untitled automation': 'Automação sem título',
  'Back to automations': 'Voltar para automações',
  'Save Draft': 'Salvar rascunho',
  'Cron expression or HH:mm': 'Expressão cron ou HH:mm',
  Contains: 'Contém',
  Exact: 'Exata',
  Condition: 'Condição',
  'Move up': 'Mover para cima',
  'Move down': 'Mover para baixo',
  'Message text': 'Texto da mensagem',
  'Hi! Thanks for reaching out…': 'Olá! Obrigado por entrar em contato…',
  'Round-robin': 'Distribuição circular',
  'Specific agent': 'Agente específico',
  Field: 'Campo',
  'Pipeline id': 'ID do funil',
  'Stage id': 'ID da etapa',
  Title: 'Título',
  Amount: 'Quantidade',
  Unit: 'Unidade',
  Minutes: 'Minutos',
  Hours: 'Horas',
  Days: 'Dias',
  Subject: 'Assunto',
  'Tag presence': 'Presença de etiqueta',
  'Contact field': 'Campo do contato',
  'Message content': 'Conteúdo da mensagem',
  'Time of day': 'Horário do dia',
  Operand: 'Operando',
  'Body template (JSON)': 'Modelo do corpo (JSON)',
  'No executions yet': 'Ainda não há execuções',
  'Unknown contact': 'Contato desconhecido',
  'No steps recorded.': 'Nenhuma etapa registrada.',
  // Per-area dictionaries last: a curated area value overrides the base catalogue.
  ...EN_TO_PT_AREAS,
};

const PT_TO_EN = Object.fromEntries(
  Object.entries(EN_TO_PT).map(([en, pt]) => [pt, en])
) as Record<string, string>;

export function translateLiteral(value: string, language: Language): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const normalized = trimmed.replace(/\s+/g, ' ');
  const translated =
    language === 'pt-BR' ? EN_TO_PT[normalized] : PT_TO_EN[normalized];
  if (!translated) return translateDynamic(value, language);
  const start = value.indexOf(trimmed);
  return (
    value.slice(0, start) + translated + value.slice(start + trimmed.length)
  );
}

function translateDynamic(value: string, language: Language): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  const wrap = (text: string) => value.replace(value.trim(), text);

  if (language === 'pt-BR') {
    let match: RegExpMatchArray | null;
    if ((match = trimmed.match(/^(\d+) runs?$/)))
      return wrap(`${match[1]} ${match[1] === '1' ? 'execução' : 'execuções'}`);
    if ((match = trimmed.match(/^last (.+)$/)))
      return wrap(`última: ${match[1]}`);
    if ((match = trimmed.match(/^(\d+) total contacts\.?$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} no total.`
      );
    if ((match = trimmed.match(/^(\d+) contacts? deleted$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} excluído${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) contacts? imported$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} importado${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) tag assignments? applied$/)))
      return wrap(
        `${match[1]} atribuição${match[1] === '1' ? '' : 'ões'} de etiqueta aplicada${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) contacts? failed to import$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} não importado${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) open deals?$/)))
      return wrap(
        `${match[1]} negócio${match[1] === '1' ? '' : 's'} aberto${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) unread conversations?$/)))
      return wrap(
        `${match[1]} conversa${match[1] === '1' ? '' : 's'} não lida${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^Showing (\d+)-(\d+) of (\d+)$/)))
      return wrap(`Mostrando ${match[1]}-${match[2]} de ${match[3]}`);
    if ((match = trimmed.match(/^Page (\d+) of (\d+)$/)))
      return wrap(`Página ${match[1]} de ${match[2]}`);
    if ((match = trimmed.match(/^Select contact (.+)$/)))
      return wrap(`Selecionar contato ${match[1]}`);
    if ((match = trimmed.match(/^(\d+) s ago$/)))
      return wrap(`há ${match[1]} s`);
    if ((match = trimmed.match(/^(\d+)([hm]) remaining$/)))
      return wrap(`${match[1]}${match[2]} restantes`);
    if ((match = trimmed.match(/^File is (.+) MB — limit is 16 MB\.$/)))
      return wrap(`O arquivo possui ${match[1]} MB — o limite é 16 MB.`);
    if ((match = trimmed.match(/^Failed to load \((.+)\)$/)))
      return wrap(`Falha ao carregar (${match[1]})`);
    if ((match = trimmed.match(/^Failed: (.+)$/)))
      return wrap(`Falhou: ${match[1]}`);
    if ((match = trimmed.match(/^Failed to delete: (.+)$/)))
      return wrap(`Falha ao excluir: ${match[1]}`);
    if ((match = trimmed.match(/^Status update failed: (.+)$/)))
      return wrap(`Falha ao atualizar o status: ${match[1]}`);
    if ((match = trimmed.match(/^Password must be at least (\d+) characters$/)))
      return wrap(`A senha deve ter pelo menos ${match[1]} caracteres`);
    if ((match = trimmed.match(/^Label must be (\d+) characters or fewer$/)))
      return wrap(`O rótulo deve ter no máximo ${match[1]} caracteres`);
    if ((match = trimmed.match(/^expires in (\d+) days?$/)))
      return wrap(`expira em ${match[1]} dia${match[1] === '1' ? '' : 's'}`);
    if ((match = trimmed.match(/^expires in (\d+) hours?$/)))
      return wrap(`expira em ${match[1]} hora${match[1] === '1' ? '' : 's'}`);
    if ((match = trimmed.match(/^(\d+) members?(.*)$/)))
      return wrap(
        `${match[1]} membro${match[1] === '1' ? '' : 's'}${match[2]}`
      );
    if ((match = trimmed.match(/^(\d+) templates?(.*)$/)))
      return wrap(
        `${match[1]} modelo${match[1] === '1' ? '' : 's'}${match[2]}`
      );
    if ((match = trimmed.match(/^(\d+) pending invites?$/)))
      return wrap(
        `${match[1]} convite${match[1] === '1' ? '' : 's'} pendente${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) pending review$/)))
      return wrap(`${match[1]} em análise`);
    if ((match = trimmed.match(/^(\d+) tags? · (\d+) custom fields?$/)))
      return wrap(
        `${match[1]} etiqueta${match[1] === '1' ? '' : 's'} · ${match[2]} campo${match[2] === '1' ? '' : 's'} personalizado${match[2] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(.+) mode · (.+) accent$/)))
      return wrap(`modo ${match[1]} · destaque ${match[2]}`);
    if ((match = trimmed.match(/^Updated (.+) to (.+)$/)))
      return wrap(`${match[1]} atualizado para ${match[2]}`);
    if ((match = trimmed.match(/^File is (.+) MB — Meta's limit is 5 MB\.$/)))
      return wrap(`A imagem possui ${match[1]} MB — o limite da Meta é 5 MB.`);
    // "<prefix>: <api error>" — the tail is usually an API message that
    // has its own dictionary entry, so it goes through the lookup too.
    const tail = (text: string) => EN_TO_PT[text.trim()] ?? text;
    if ((match = trimmed.match(/^Upload failed: (.+)$/)))
      return wrap(`Falha no envio: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Failed to send: (.+)$/)))
      return wrap(`Falha ao enviar: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Email change failed: (.+)$/)))
      return wrap(`Falha ao alterar o e-mail: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Sign-out failed: (.+)$/)))
      return wrap(`Falha ao sair: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Password change failed: (.+)$/)))
      return wrap(`Falha ao alterar a senha: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Meta API error: (.+)$/)))
      return wrap(`Erro da API da Meta: ${match[1]}`);
    if ((match = trimmed.match(/^Meta API rejected the credentials: (.+)$/)))
      return wrap(`A Meta rejeitou as credenciais: ${match[1]}`);
    if ((match = trimmed.match(/^(.+) must be (\d+) characters or fewer$/))) {
      const subject = EN_TO_PT[match[1]] ?? match[1];
      const lower = subject.charAt(0).toLowerCase() + subject.slice(1);
      return wrap(`O ${lower} deve ter no máximo ${match[2]} caracteres`);
    }
    if (
      (match = trimmed.match(
        /^Delete "(.+)"\? Any active runs will end immediately\.$/
      ))
    )
      return wrap(
        `Excluir “${match[1]}”? Todas as execuções ativas serão encerradas imediatamente.`
      );
  }

  return value;
}
