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

  // Extras beyond the plan (migration 114)
  'Extras beyond the plan':
    'Extras além do plano',
  'Optional monthly price of one extra user or number. Leave blank to not offer it: the limit keeps blocking. A new price only applies to new purchases.':
    'Preço mensal opcional de um usuário ou número extra. Deixe em branco para não oferecer: o limite continua bloqueando. Um preço novo só vale para quem contrata depois.',
  'Extra user, monthly price in BRL':
    'Usuário extra, preço mensal em reais',
  'Extra number, monthly price in BRL':
    'Número extra, preço mensal em reais',
  '+ extra user':
    '+ usuário extra',
  '+ extra number':
    '+ número extra',
  'Next charge':
    'Próxima cobrança',
  'Included in the plan':
    'Incluído no plano',
  'Extras bought':
    'Extras contratados',
  'In use':
    'Em uso',
  'per extra, per month':
    'por extra, por mês',
  'Quantity':
    'Quantidade',
  'Confirm the change':
    'Confirmar a alteração',
  'extra user(s)':
    'usuário(s) extra(s)',
  'extra number(s)':
    'número(s) extra(s)',
  'New charge':
    'Nova cobrança',
  'Could not change it right now, try again.':
    'Não foi possível alterar agora, tente de novo.',
  'Buy 1 extra for':
    'Contratar 1 extra por',
  'Choose what to change and how many.':
    'Escolha o que alterar e quantos.',
  'Extras are only available on an active paid subscription. Subscribe first, or wait until the payment is confirmed.':
    'Os extras só estão disponíveis com uma assinatura paga e ativa. Assine primeiro ou espere a confirmação do pagamento.',
  'Your plan does not offer this extra. Talk to the SempreCRM team.':
    'Seu plano não oferece este extra. Fale com a equipe do SempreCRM.',
  'Your plan has no limit here, so there is nothing to add.':
    'Seu plano não tem limite aqui, então não há nada para adicionar.',
  'You reached the maximum number of extras. Talk to the SempreCRM team.':
    'Você chegou ao máximo de extras. Fale com a equipe do SempreCRM.',
  'You are using more than the new limit would allow. Free up a user or number first.':
    'Você está usando mais do que o novo limite permitiria. Libere um usuário ou número primeiro.',
  'Too many changes in the last 24 hours. Try again tomorrow or talk to the SempreCRM team.':
    'Muitas alterações nas últimas 24 horas. Tente novamente amanhã ou fale com a equipe do SempreCRM.',
  'Your subscription changed while you were doing this. Reload the page and try again.':
    'Sua assinatura mudou enquanto você fazia isso. Recarregue a página e tente de novo.',
  'Add users or WhatsApp numbers without changing plan. On monthly plans added extras work right away and go into your next charge; on annual plans they work after the one-off charge is paid. Removing lowers the limit for new users and numbers right away, while the ones already paid keep working until the end of the paid period.':
    'Adicione usuários ou números de WhatsApp sem trocar de plano. No plano mensal os extras adicionados valem na hora e entram na próxima cobrança; no anual valem depois que a cobrança avulsa é paga. Remover baixa já o limite para novos usuários e números, enquanto os que já foram pagos continuam valendo até o fim do período pago.',
  'Extras added. The limit is already higher; the new value is in your next charge.':
    'Extras adicionados. O limite já aumentou; o valor novo entra na próxima cobrança.',
  'Removal scheduled: the extras stay active until':
    'Remoção agendada: os extras continuam ativos até',
  'Then the limit drops to':
    'Depois o limite cai para',
  'Removal cancelled.':
    'Remoção cancelada.',
  'Cancel removal':
    'Cancelar remoção',
  'Only the account owner can buy or remove extras. Ask the account owner.':
    'Só o dono da conta pode contratar ou remover extras. Peça ao dono da conta.',
  'per extra, per year (12 months for the price of 10)':
    'por extra, por ano (12 meses pelo preço de 10)',
  'It works right away and goes into your next charge, even one already issued.':
    'Vale na hora e entra na próxima cobrança, mesmo que ela já tenha sido emitida.',
  'From now on you cannot add users or numbers above the new limit. The ones already paid keep working until the end of the period you already paid (every extra is billed for at least one full period). The charge after that no longer includes them.':
    'A partir de agora não dá para ter usuários ou números acima do novo limite. Os que já foram pagos continuam valendo até o fim do período já pago (todo extra é cobrado por pelo menos um período completo). A cobrança seguinte não inclui mais esses extras.',
  'Ask the account owner to add 1 extra for':
    'Peça ao dono da conta para contratar 1 extra por',
  'Extra user price':
    'Preço do usuário extra',
  'Extra number price':
    'Preço do número extra',
  'Not offered by the plan':
    'Não oferecido pelo plano',
  'A removal is already scheduled. Cancel it first to change the extras.':
    'Já existe uma remoção agendada. Cancele-a antes de alterar os extras.',
  'There is no scheduled removal to cancel.':
    'Não há remoção agendada para cancelar.',
  'Charge created. The extras are released as soon as it is paid.':
    'Cobrança criada. Os extras são liberados assim que for paga.',
  'One-off charge':
    'Cobrança avulsa',
  'The extras are released as soon as the charge is paid.':
    'Os extras são liberados assim que a cobrança for paga.',
  'The removal is already in your next charge, so it can no longer be cancelled.':
    'A remoção já está na próxima cobrança, então não dá mais para cancelar.',
  'One-off charge now (estimate)':
    'Cobrança avulsa agora (estimativa)',
  'months until the renewal on':
    'meses até a renovação em',
  'The limit is released when the charge is paid.':
    'O limite é liberado quando a cobrança for paga.',
  'At the renewal the subscription goes to':
    'Na renovação a assinatura passa a',
  'Regularize the pending payment first.':
    'Regularize o pagamento pendente primeiro.',
  'The annual renewal charge was already generated. Buy extras after paying it.':
    'A renovação anual já foi gerada. Compre extras depois de pagá-la.',
  'A purchase is waiting for payment. Pay it, or wait until it expires, before changing the extras.':
    'Há uma compra aguardando pagamento. Pague-a, ou espere ela expirar, antes de alterar os extras.',
  'The removal is already in your next charge, so it cannot be cancelled. Once it takes effect, buy the extra again.':
    'A remoção já está na próxima cobrança, então não dá para cancelar. Quando ela valer, contrate o extra de novo.',
};
