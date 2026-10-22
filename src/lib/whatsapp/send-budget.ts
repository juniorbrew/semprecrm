// ============================================================
// Time budget for bulk QR sends made from a cron handler.
//
// A cron route walks many contacts one after another. The gateway paces
// bulk sends (a few seconds apart), so a plain loop would sit inside the
// request for minutes. The route wraps its work in `withBulkSendBudget`;
// once the budget is gone, `engineSendViaQr` refuses further bulk sends
// right away with the same retryable `throttled` error the gateway uses,
// and the caller parks / requeues the step (automations: pending
// execution; AI replies: requeued job; surveys: re-armed job).
//
// Outside a budget (inbound-triggered work, fire-and-forget) there is no
// limit beyond the per-send wait.
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage<{ deadline: number }>()

export function withBulkSendBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return store.run({ deadline: Date.now() + ms }, fn)
}

/** Milliseconds left in the current budget, or `null` when there is none. */
export function remainingBulkSendBudgetMs(): number | null {
  const b = store.getStore()
  return b ? b.deadline - Date.now() : null
}
