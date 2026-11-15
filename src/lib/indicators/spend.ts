// ============================================================
// Ad spend (migration 111): what the admin typed per ad / campaign / month, and the numbers the Reports
// table derives from it. The sum of the months a period touches comes from origin_report().spend_cents;
// the divisions live here (and are tested) because they need a guard against zero.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { OriginReportRow } from '@/lib/lead-origins'

/**
 * Rows that can carry a spend: everything but "direct" (nothing to pay for) and a bucket without a name
 * ("Ad without a title"): ad_spend.name is 1 to 300 characters, so the database would refuse it.
 */
export function canHaveSpend(row: Pick<OriginReportRow, 'origin_type' | 'name'>): boolean {
  return row.origin_type !== 'direct' && row.name !== ''
}

export interface SpendMetrics {
  /** Spend in the account currency (not cents); null = nothing typed (or typed as zero). */
  spend: number | null
  costPerCustomer: number | null
  costPerSale: number | null
  /** Won value / spend, e.g. 4.2 for "4,2×". */
  roas: number | null
}

const per = (spend: number, n: number) => (n > 0 ? spend / n : null)

export function spendMetrics(
  row: Pick<OriginReportRow, 'spend_cents' | 'customers' | 'deals_won' | 'won_value'>,
): SpendMetrics {
  const cents = row.spend_cents
  if (cents == null || !Number.isFinite(cents) || cents <= 0) {
    return { spend: null, costPerCustomer: null, costPerSale: null, roas: null }
  }
  const spend = cents / 100
  return {
    spend,
    costPerCustomer: per(spend, row.customers),
    costPerSale: per(spend, row.deals_won),
    roas: row.won_value / spend,
  }
}

/** "4,2×" (one decimal, the reader's separator); "—" when there is no return to show. */
export function formatRoas(roas: number | null, locale: string): string {
  return roas == null ? '—' : `${roas.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}×`
}

const MAX_CENTS = 100_000_000_000 // the CHECK of ad_spend.amount_cents

/**
 * "1.234,56", "1234.56", "R$ 1.234", "50" -> cents; null for anything that is not a plain non-negative
 * amount. The last separator is the decimal one, unless it is the only kind and exactly 3 digits follow
 * it ("1.234" is a thousand), or the same mark repeats ("1.234.567").
 */
export function parseMoneyToCents(text: string): number | null {
  const s = text.replace(/[^\d.,]/g, '')
  if (!/\d/.test(s)) return null
  const sep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'))
  let whole = s
  let frac = ''
  if (sep >= 0) {
    const tail = s.slice(sep + 1)
    const otherMark = s[sep] === ',' ? '.' : ','
    const repeated = s.split(s[sep]).length > 2
    const thousands = repeated || (tail.length === 3 && !s.includes(otherMark))
    if (!thousands) {
      whole = s.slice(0, sep)
      frac = tail
    }
  }
  // Thousands marks only between well-formed groups of 3 ("1.234.567"), never "12,345,6".
  if (frac.length > 2 || (/[.,]/.test(whole) && !/^\d{1,3}([.,]\d{3})+$/.test(whole))) return null
  const cents = Number(whole.replace(/[.,]/g, '') || '0') * 100 + Number(frac.padEnd(2, '0') || '0')
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null
}

/** "2026-11" -> "2026-11-01" (what ad_spend.month stores). */
export const monthStart = (ym: string) => `${ym}-01`

export interface SpendKey {
  origin_type: OriginReportRow['origin_type']
  channel: string
  name: string
  source: string
}

export async function loadSpend(db: SupabaseClient, accountId: string, key: SpendKey, ym: string): Promise<number | null> {
  const { data, error } = await db
    .from('ad_spend')
    .select('amount_cents')
    .eq('account_id', accountId)
    .eq('origin_type', key.origin_type)
    .eq('channel', key.channel)
    .eq('name', key.name)
    .eq('source', key.source)
    .eq('month', monthStart(ym))
    .maybeSingle()
  if (error) throw error
  return data ? Number(data.amount_cents) : null
}

export async function saveSpend(db: SupabaseClient, accountId: string, key: SpendKey, ym: string, cents: number) {
  const { error } = await db.from('ad_spend').upsert(
    { account_id: accountId, ...key, month: monthStart(ym), amount_cents: cents },
    { onConflict: 'account_id,origin_type,channel,name,source,month' },
  )
  if (error) throw error
}
