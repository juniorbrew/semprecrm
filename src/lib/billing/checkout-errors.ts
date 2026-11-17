// Kept out of the route file: Next only lets route.ts export route handlers
// and segment config.

/** Subscriptions created per account in 24 h (each one is a real object in Asaas). */
export const MAX_CHECKOUTS_PER_DAY = 10

export const CHECKOUT_ERRORS = {
  notConfigured: 'Online payment is not available yet. Talk to the SempreCRM team.',
  body: 'Choose a plan and a billing cycle.',
  notForSale: 'This plan is sold by our team. Talk to us to subscribe.',
  taxId: 'Add your CPF or CNPJ in Settings → Empresa before subscribing.',
  alreadyActive: 'This account already has an active subscription.',
  confirming: 'Your payment is being confirmed. This takes a few minutes.',
  suspended: 'This account is suspended. Talk to the SempreCRM team.',
  busy: 'Another subscription request is in progress. Try again.',
  tooMany: 'Too many subscription attempts in the last 24 hours. Try again tomorrow or talk to the SempreCRM team.',
  provider: 'Could not reach the payment provider. Try again in a few minutes.',
} as const
