// Compact currency for the dashboard's tight spots (donut centre, legend
// rows), in the reader's language: "R$ 93,4 mil" / "R$ 1,2 mi" in pt-BR,
// "$93.4K" / "$1.2M" in en-US. `Intl.NumberFormat` with compact notation
// does the locale work; the fallback covers an invalid ISO code.

import { DEFAULT_CURRENCY, formatCurrencyShort } from '@/lib/currency'
import type { Language } from '@/lib/i18n'

export function formatCompactCurrency(
  value: number,
  currency: string,
  language: Language,
): string {
  const code = (currency || DEFAULT_CURRENCY).trim()
  const amount = Number(value) || 0
  try {
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency: code,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount)
  } catch {
    return formatCurrencyShort(amount, code)
  }
}
