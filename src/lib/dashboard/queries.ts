import type { SupabaseClient } from '@supabase/supabase-js'
import { daysAgoStart, lastNDayKeys, mondayIndex, startOfLocalDay } from './date-utils'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// RLS scopes every query (and the SECURITY INVOKER RPCs of migration
// 084) to the signed-in user, so we never pass user_id here. Anything
// that would read an unbounded number of rows is aggregated in SQL:
// PostgREST caps a read at max_rows (1000) and a client-side sum past
// that silently undercounts.
// ------------------------------------------------------------

type DB = SupabaseClient

/** The browser's zone: the charts bucket by the user's local day. */
const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

interface StageDeals {
  stage_id: string
  deal_count: number
  total_value: number | string
}

async function loadOpenDealsByStage(db: DB): Promise<StageDeals[]> {
  const { data, error } = await db.rpc('dashboard_open_deals_by_stage')
  if (error) throw error
  return (data ?? []) as StageDeals[]
}

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: DB): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDeals,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', todayStart),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    loadOpenDealsByStage(db),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', todayStart),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
  ])

  const openDealsValue = openDeals.reduce((sum, d) => sum + Number(d.total_value), 0)
  const openDealsCount = openDeals.reduce((sum, d) => sum + d.deal_count, 0)

  return {
    activeConversations: {
      current: openConvCur.count ?? 0,
      // "em relação a ontem" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: (newConvToday.count ?? 0) - (newConvYesterday.count ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount,
    messagesSentToday: {
      current: messagesToday.count ?? 0,
      previous: messagesYesterday.count ?? 0,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const { data, error } = await db.rpc('dashboard_message_series', {
    p_start: daysAgoStart(rangeDays - 1).toISOString(),
    p_tz: localTimeZone(),
  })
  if (error) throw error

  // One row per local day with traffic (agent + bot count as outgoing);
  // seed every day of the range so quiet days still plot a 0.
  const byDay = new Map(
    ((data ?? []) as { day: string; incoming: number; outgoing: number }[]).map((r) => [r.day, r]),
  )
  return lastNDayKeys(rangeDays).map((day) => ({
    day,
    incoming: byDay.get(day)?.incoming ?? 0,
    outgoing: byDay.get(day)?.outgoing ?? 0,
  }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, deals] = await Promise.all([
    db.from('pipeline_stages').select('id, name, color, pipeline_id, position').order('position'),
    loadOpenDealsByStage(db),
  ])

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const byStage = new Map(
    deals.map((d) => [d.stage_id, { count: d.deal_count, total: Number(d.total_value) }]),
  )

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  // Last 14 days: "this week" + "last week" with overlap when the user
  // opens the dashboard late on a Monday. Migration 084 pairs, per
  // conversation, the first customer message after an outbound with the
  // next outbound (a double-messaging customer counts once) and returns
  // per-weekday sums; each bar averages both weeks so it has more
  // samples to stand on. Week boundaries are the browser's local Mondays.
  const now = new Date()
  const { data, error } = await db.rpc('dashboard_response_time', {
    p_start: daysAgoStart(13).toISOString(),
    p_tz: localTimeZone(),
    p_this_week_start: daysAgoStart(mondayIndex(now)).toISOString(),
    p_last_week_start: daysAgoStart(mondayIndex(now) + 7).toISOString(),
  })
  if (error) throw error

  interface Sum {
    sum_minutes: number
    samples: number
  }
  const result = data as { buckets: (Sum & { dow: number })[]; this_week: Sum; last_week: Sum }
  const avg = (s: Sum | undefined) => (s && s.samples > 0 ? s.sum_minutes / s.samples : null)
  const byDow = new Map(result.buckets.map((b) => [b.dow, b]))

  // A day without samples keeps avgMinutes null and the chart renders the bar muted.
  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => ({
    dow,
    avgMinutes: avg(byDow.get(dow)),
    samples: byDow.get(dow)?.samples ?? 0,
  }))

  return {
    buckets,
    thisWeekAvg: avg(result.this_week),
    lastWeekAvg: avg(result.last_week),
  }
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contacts, deals, broadcasts, autoLogs] = await Promise.all([
    db
      .from('messages')
      .select('id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    db
      .from('automation_logs')
      .select('id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const items: ActivityItem[] = []

  // PostgREST returns nested selections as arrays by default, even when
  // the foreign key is 1:1. We normalise by taking [0] on each level.
  for (const m of (msgs.data ?? []) as unknown as Array<{
    id: string
    content_text: string | null
    created_at: string
    conversation_id: string
    conversations:
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }[]
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }
      | null
  }>) {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations
    const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts
    const who = contact?.name || contact?.phone || null
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `New message from ${who ?? 'Unknown'}`,
      event: { type: 'message', who },
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of (contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string; created_at: string }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `New contact: ${c.name || c.phone}`,
      event: { type: 'contact', who: c.name || c.phone },
      at: c.created_at,
      href: '/contacts',
    })
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string
    title: string
    updated_at: string
    stage: { name: string }[] | { name: string } | null
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: stage?.name
        ? `Deal "${d.title}" in ${stage.name}`
        : `Deal "${d.title}" updated`,
      event: { type: 'deal', title: d.title, stage: stage?.name ?? null },
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const b of (broadcasts.data ?? []) as Array<{
    id: string
    name: string
    status: string
    total_recipients: number
    created_at: string
  }>) {
    const label =
      b.status === 'sent'
        ? `sent to ${b.total_recipients} contacts`
        : `${b.status} (${b.total_recipients} recipients)`
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text: `Broadcast "${b.name}" ${label}`,
      event: { type: 'broadcast', name: b.name, status: b.status, recipients: b.total_recipients },
      at: b.created_at,
      href: '/broadcasts',
    })
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string
    trigger_event: string
    status: string
    created_at: string
    automation: { name: string }[] | { name: string } | null
    contact: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null
  }>) {
    const automation = Array.isArray(l.automation) ? l.automation[0] : l.automation
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact
    const who = contact?.name || contact?.phone || null
    const autoName = automation?.name || null
    const failed = l.status === 'failed'
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automation "${autoName ?? 'Automation'}" ${failed ? 'failed for' : 'triggered for'} ${who ?? 'a contact'}`,
      event: { type: 'automation', name: autoName, who, failed },
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}
