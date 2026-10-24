// ============================================================
// Database-level read-only block (migration 094) -> friendly message.
//
// A read-only account (trial ended / payment overdue) is refused by the
// database when the browser writes CRM data with the user's own JWT:
//   - RESTRICTIVE policies fail with 42501 "new row violates row-level
//     security policy for table ..."
//   - readonly_guard() fails with 42501 "read_only_account: ..."
// The UI already disables the write actions for these accounts, so this only
// shows up on a path the UI missed (or a stale tab). 42501 also means "your
// role may not do this" for an ACTIVE account, so the friendly copy is used
// only while the client knows the account is read-only.
// ============================================================

import type { ReadOnlyReason } from './read-only'

export const READ_ONLY_EDIT_MESSAGES: Record<ReadOnlyReason, string> = {
  trial_expired:
    'Seu período de teste terminou. A conta está em modo somente leitura: assine um plano em Configurações → Plano para voltar a editar.',
  past_due:
    'Há um pagamento em atraso. A conta está em modo somente leitura: regularize a cobrança em Configurações → Plano para voltar a editar.',
}

interface DbErrorLike {
  code?: unknown
  message?: unknown
}

/** 42501 raised by the read-only block (policy or guard trigger) or any RLS refusal. */
export function isRlsDenied(err: DbErrorLike | null | undefined): boolean {
  if (!err || err.code !== '42501') return false
  const message = typeof err.message === 'string' ? err.message : ''
  return message.includes('read_only_account') || /row-level security/i.test(message)
}

/**
 * Friendly pt-BR message when `err` is the database refusing a write of a
 * read-only account; null otherwise (keep the caller's own message).
 */
export function readOnlyDbMessage(
  err: DbErrorLike | null | undefined,
  reason: ReadOnlyReason | null,
): string | null {
  if (!reason || !isRlsDenied(err)) return null
  return READ_ONLY_EDIT_MESSAGES[reason]
}

// ---- client wiring -------------------------------------------------------

let currentReason: ReadOnlyReason | null = null

/** Set by the always-mounted ReadOnlyBanner; read by the Supabase fetch wrapper. */
export function setClientReadOnlyReason(reason: ReadOnlyReason | null): void {
  currentReason = reason
}

export function getClientReadOnlyReason(): ReadOnlyReason | null {
  return currentReason
}

type Fetch = typeof fetch

/**
 * Wraps a fetch so that a refused write of a read-only account comes back
 * with the friendly message (components that print `error.message` show it)
 * and `notify` is called once per refusal (a deduplicated toast).
 */
export function withReadOnlyDbMessage(
  base: Fetch,
  getReason: () => ReadOnlyReason | null,
  notify: (message: string) => void,
): Fetch {
  return async (input, init) => {
    const res = await base(input, init)
    const reason = getReason()
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (!reason || res.status !== 403 || method === 'GET' || method === 'HEAD') return res
    let body: unknown
    try {
      body = await res.clone().json()
    } catch {
      return res
    }
    const message = readOnlyDbMessage(body as DbErrorLike, reason)
    if (!message) return res
    notify(message)
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    return new Response(JSON.stringify({ ...(body as object), message }), {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  }
}
