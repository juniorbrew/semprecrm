// ============================================================
// Pacing for automated sends on the QR (WhatsApp Web) channel.
//
// A burst of automated messages from one number is the pattern
// WhatsApp's anti-spam looks for. Automated sends of one account are
// spaced by ~1.2 s plus random jitter, in the order they were asked
// for. Agent-typed messages do not go through here.
//
// In-process only (one Next.js server on the VPS); good enough to
// break up bursts, not a distributed rate limiter.
// ============================================================

const DEFAULT_SPACING_MS = 1200

function spacingMs(): number {
  const raw = Number(process.env.AUTOMATED_QR_SEND_SPACING_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SPACING_MS
}

const nextSlot = new Map<string, number>()

/**
 * Reserve this account's next send slot and wait for it. Slots are
 * handed out synchronously, so concurrent callers queue up in call
 * order instead of all waking at once.
 */
export async function paceAutomatedQrSend(
  accountId: string,
  deps: {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    random?: () => number
  } = {},
): Promise<number> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random

  const t = now()
  const spacing = spacingMs()
  const slot = Math.max(t, nextSlot.get(accountId) ?? 0)
  // Up to +40% jitter so the gaps do not look machine-regular.
  nextSlot.set(accountId, slot + spacing + Math.floor(random() * spacing * 0.4))
  const wait = slot - t
  if (wait > 0) await sleep(wait)
  return wait
}

/** Test helper. */
export function resetQrPacing(): void {
  nextSlot.clear()
}
