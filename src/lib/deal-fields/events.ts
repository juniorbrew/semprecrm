// A value saved in the deal drawer / form must refresh the card on the board. The two live far apart
// in the tree (page -> board, page -> drawer), so a tiny browser event stands in for prop drilling.

const EVENT = 'deal-fields-changed'

export function notifyDealFieldsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}

/** Returns the unsubscribe function. */
export function onDealFieldsChanged(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
