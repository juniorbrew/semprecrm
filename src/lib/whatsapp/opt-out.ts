// ============================================================
// Opt-out detection (spec §5).
//
// A customer message counts as an opt-out only when the WHOLE message,
// once normalised, equals one of the account's stop words:
//   - accents stripped ("não" → "nao")
//   - punctuation / symbols removed ("PARAR!!!" → "parar")
//   - lower-cased, whitespace collapsed
// "quero parar de receber" therefore does NOT opt out — a sentence that
// merely contains the word is left to the agent.
// ============================================================

export function normalizeOptOutText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isOptOutMessage(
  text: string | null | undefined,
  keywords: readonly string[],
): boolean {
  if (!text || keywords.length === 0) return false
  const normalized = normalizeOptOutText(text)
  if (!normalized) return false
  return keywords.some((k) => normalizeOptOutText(k) === normalized)
}
