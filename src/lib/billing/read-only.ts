// ============================================================
// Read-only mode — ONE decision, shared by the server guards, the crons
// and the client hook (docs/superpowers/specs/2026-10-12-billing-asaas-design.md).
//
// An account whose trial ended, or whose payment is overdue, keeps opening
// the app and keeps RECEIVING (customer messages, webhooks) but cannot
// start outbound work. A suspended (platform) or canceled account stays
// fully blocked as before. Built on `resolveEntitlements().blocked`, whose
// semantics are unchanged: only a block reason decides, never an expiry
// date on an active account.
// ============================================================

import type { Entitlements } from '@/lib/plans'

export const READ_ONLY_REASONS = ['trial_expired', 'past_due'] as const
export type ReadOnlyReason = (typeof READ_ONLY_REASONS)[number]

type WithBlocked = Pick<Entitlements, 'blocked'> | null | undefined

/** `trial_expired` / `past_due` when the account is in read-only mode, else null. */
export function readOnlyReason(ent: WithBlocked): ReadOnlyReason | null {
  const reason = ent && ent.blocked ? ent.blocked.reason : null
  return reason === 'trial_expired' || reason === 'past_due' ? reason : null
}

/** Blocked for a reason that is NOT read-only: suspended, canceled, plan unreadable. */
export function isFullyBlocked(ent: WithBlocked): boolean {
  return !!ent && !!ent.blocked && readOnlyReason(ent) === null
}

/** API message (pt-BR) when a read-only account tries an outbound action. */
export const READ_ONLY_MESSAGES: Record<ReadOnlyReason, string> = {
  trial_expired:
    'Seu período de teste terminou. A conta está em modo somente leitura: assine um plano em Configurações → Plano para voltar a enviar mensagens e usar automações.',
  past_due:
    'Há um pagamento em atraso. A conta está em modo somente leitura: regularize a cobrança em Configurações → Plano para voltar a enviar mensagens e usar automações.',
}

export const ACCOUNT_BLOCKED_MESSAGE =
  'Esta conta está bloqueada. Fale com o suporte do SempreCRM para saber como restabelecer o acesso.'

/**
 * Thrown by the engine senders (automations, flows, AI, CSAT, scheduled,
 * out-of-hours notice, public API) when the account may not send: the last
 * line of defence behind each caller's own check.
 */
export class AccountReadOnlyError extends Error {
  constructor() {
    super('account is read-only or blocked: outbound message not sent')
    this.name = 'AccountReadOnlyError'
  }
}
