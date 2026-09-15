// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

/**
 * Structured description of what happened, so the feed can render
 * the row in the active language (pt-BR / en-US) with correct
 * pluralisation. See `activityEventText` in ./i18n.ts.
 */
export type ActivityEvent =
  | { type: 'message'; who: string | null }
  | { type: 'contact'; who: string }
  | { type: 'deal'; title: string; stage: string | null }
  | { type: 'broadcast'; name: string; status: string; recipients: number }
  | { type: 'automation'; name: string | null; who: string | null; failed: boolean }

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** English fallback line, used only when `event` is absent. */
  text: string
  /** Structured event — the feed renders this in the active language. */
  event?: ActivityEvent
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}
