// Settings → Plano (subscription), read-only banner and the checkout API
// messages. Keys are the English strings the components render; values are
// the pt-BR the product is written in.
export const DICT_BILLING: Record<string, string> = {
  // Read-only banner / tooltips
  'Your trial has ended. The account is read-only: you can see everything, but sending messages, broadcasts, automations and AI replies are paused. Incoming messages keep arriving. Scheduled messages, automation waits and satisfaction surveys that come due meanwhile are not sent: they fail with a visible reason.':
    'Seu período de teste terminou. A conta está em modo somente leitura: você vê tudo, mas o envio de mensagens, os disparos, as automações e as respostas de IA ficam pausados. As mensagens recebidas continuam chegando. Mensagens agendadas, esperas de automações e pesquisas de satisfação que vencerem nesse período não são enviadas: elas falham com um motivo visível.',
  'A payment is overdue. The account is read-only: you can see everything, but sending messages, broadcasts, automations and AI replies are paused. Incoming messages keep arriving. Scheduled messages, automation waits and satisfaction surveys that come due meanwhile are not sent: they fail with a visible reason.':
    'Há um pagamento em atraso. A conta está em modo somente leitura: você vê tudo, mas o envio de mensagens, os disparos, as automações e as respostas de IA ficam pausados. As mensagens recebidas continuam chegando. Mensagens agendadas, esperas de automações e pesquisas de satisfação que vencerem nesse período não são enviadas: elas falham com um motivo visível.',
  Subscribe: 'Assinar',
  'Pay now': 'Pagar agora',
  'Ask the account owner to subscribe.': 'Peça ao proprietário da conta para assinar.',
  'Read-only account — subscribe in Settings → Plan to use this':
    'Conta somente leitura — assine em Configurações → Plano para usar',

  // Plano
  'Only the account owner and administrators can see the plan.':
    'Só o proprietário e os administradores da conta veem o plano.',
  'Your subscription, payments and what the plan includes. To add modules, get in touch with the SempreCRM team.':
    'Sua assinatura, seus pagamentos e o que o plano inclui. Para adicionar módulos, fale com a equipe do SempreCRM.',
  Subscription: 'Assinatura',
  'You are on the free trial. Subscribe to keep everything running when it ends.':
    'Você está no período de teste gratuito. Assine para manter tudo funcionando quando ele terminar.',
  'Your trial has ended. The account is read-only until you subscribe: you can see everything, but sending and automations are paused.':
    'Seu período de teste terminou. A conta fica somente leitura até você assinar: você vê tudo, mas envios e automações ficam pausados.',
  'Your subscription is active.': 'Sua assinatura está ativa.',
  'A payment is overdue. The account is read-only until the charge is paid: you can see everything, but sending and automations are paused.':
    'Há um pagamento em atraso. A conta fica somente leitura até a cobrança ser paga: você vê tudo, mas envios e automações ficam pausados.',
  'The subscription was canceled. Subscribe again to get back in.':
    'A assinatura foi cancelada. Assine novamente para voltar.',
  'This account was suspended by the platform team. Get in touch with support.':
    'Esta conta foi suspensa pela equipe da plataforma. Fale com o suporte.',
  'We could not read the plan of this account.': 'Não foi possível ler o plano desta conta.',
  'Could not load the subscription details.': 'Não foi possível carregar os dados da assinatura.',
  'Payment confirmed. Your plan is active.': 'Pagamento confirmado. Seu plano está ativo.',
  'Pay pending charge': 'Pagar cobrança pendente',
  'Billing cycle': 'Ciclo de cobrança',
  Monthly: 'Mensal',
  Annual: 'Anual',
  '2 months free': '2 meses grátis',
  '/year': '/ano',
  '/month': '/mês',
  'per month on average': 'por mês em média',
  'you save': 'você economiza',
  'Opening…': 'Abrindo…',
  'Pay overdue charge': 'Pagar cobrança em atraso',
  'Custom plan. Talk to the SempreCRM team.': 'Plano sob medida. Fale com a equipe do SempreCRM.',
  'Only the account owner can subscribe or change the plan.':
    'Só o proprietário da conta pode assinar ou trocar de plano.',
  'To change the plan or the cycle of an active subscription, talk to the SempreCRM team.':
    'Para trocar o plano ou o ciclo de uma assinatura ativa, fale com a equipe do SempreCRM.',
  'The payment page opened in a new tab.': 'A página de pagamento abriu em uma nova aba.',
  'Open the payment page': 'Abrir a página de pagamento',
  'Payment history': 'Histórico de pagamentos',
  'No charges yet.': 'Nenhuma cobrança ainda.',
  'Due date': 'Vencimento',
  Amount: 'Valor',
  'Awaiting payment': 'Aguardando pagamento',
  'Charge overdue': 'Vencida',
  Paid: 'Paga',
  Refunded: 'Estornada',
  Chargeback: 'Contestada',
  Other: 'Outro',
  'Could not start the payment. Try again in a few minutes.':
    'Não foi possível iniciar o pagamento. Tente novamente em alguns minutos.',

  // /api/billing/checkout errors (CHECKOUT_ERRORS)
  'Online payment is not available yet. Talk to the SempreCRM team.':
    'O pagamento online ainda não está disponível. Fale com a equipe do SempreCRM.',
  'Choose a plan and a billing cycle.': 'Escolha um plano e um ciclo de cobrança.',
  'This plan is sold by our team. Talk to us to subscribe.':
    'Este plano é vendido pela nossa equipe. Fale com a gente para assinar.',
  'Add your CPF or CNPJ in Settings → Empresa before subscribing.':
    'Informe seu CPF ou CNPJ em Configurações → Empresa antes de assinar.',
  'This account already has an active subscription.': 'Esta conta já tem uma assinatura ativa.',
  'Your payment is being confirmed. This takes a few minutes.':
    'Seu pagamento está sendo confirmado. Isso leva alguns minutos.',
  'This account is suspended. Talk to the SempreCRM team.':
    'Esta conta está suspensa. Fale com a equipe do SempreCRM.',
  'Another subscription request is in progress. Try again.':
    'Outra solicitação de assinatura está em andamento. Tente novamente.',
  'Too many subscription attempts in the last 24 hours. Try again tomorrow or talk to the SempreCRM team.':
    'Muitas tentativas de assinatura nas últimas 24 horas. Tente novamente amanhã ou fale com a equipe do SempreCRM.',
  'Could not reach the payment provider. Try again in a few minutes.':
    'Não foi possível falar com o provedor de pagamento. Tente novamente em alguns minutos.',
};
