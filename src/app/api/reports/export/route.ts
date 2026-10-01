// ============================================================
// GET /api/reports/export — the support reports as CSV. Owner / admin.
//
// Query: from, to (YYYY-MM-DD, calendar days of the account's time zone,
// at most a year) and the optional filters team_id, category_id, agent_id,
// channel. Same filters, same database function as /reports, so the file
// matches the screen. The caller's own RLS-scoped client does the reading
// (support_report() also requires an admin of the account).
//
// What leaves: counts, times and scores per category / team / agent /
// priority, and the backlog by age. Names of categories, teams and agents
// only: no contact name, phone, message or survey comment.
// ============================================================

import { NextResponse } from 'next/server'

import { requireModule, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  BACKLOG_BUCKETS,
  fetchSupportBacklog,
  fetchSupportReport,
  isValidPeriod,
  reportsCopy,
  reportsToCsv,
  type ReportChannel,
  type ReportFilters,
  type ReportGroup,
} from '@/lib/support/reports'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'dashboard')

    const limit = checkRateLimit(`admin:reports-export:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const q = new URL(request.url).searchParams
    const period = { from: q.get('from') ?? '', to: q.get('to') ?? '' }
    if (!isValidPeriod(period)) return NextResponse.json({ error: 'Invalid period' }, { status: 400 })

    const filters: ReportFilters = {}
    for (const key of ['team_id', 'category_id', 'agent_id'] as const) {
      const value = q.get(key)
      if (!value) continue
      if (!UUID_RE.test(value)) return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
      filters[key] = value
    }
    const channel = q.get('channel')
    if (channel) {
      if (channel !== 'official' && channel !== 'qr') return NextResponse.json({ error: 'Invalid channel' }, { status: 400 })
      filters.channel = channel as ReportChannel
    }

    const copy = reportsCopy('pt-BR')
    const groups: ReportGroup[] = ['all', 'category', 'team', 'agent', 'priority']
    const [reports, backlog, categories, teams, profiles] = await Promise.all([
      Promise.all(groups.map((g) => fetchSupportReport(ctx.supabase, ctx.accountId, period, g, filters))),
      fetchSupportBacklog(ctx.supabase, ctx.accountId, filters),
      ctx.supabase.from('conversation_categories').select('id, name').eq('account_id', ctx.accountId),
      ctx.supabase.from('teams').select('id, name').eq('account_id', ctx.accountId),
      ctx.supabase.from('profiles').select('user_id, full_name').eq('account_id', ctx.accountId),
    ])
    for (const r of [categories, teams, profiles]) if (r.error) throw r.error

    const names = (rows: { id?: string; user_id?: string; name?: string; full_name?: string | null }[] | null) =>
      new Map((rows ?? []).map((r) => [(r.id ?? r.user_id) as string, (r.name ?? r.full_name ?? '?') as string]))
    const categoryName = names(categories.data)
    const teamName = names(teams.data)
    const agentName = names(profiles.data)
    const lookup = (map: Map<string, string>) => (key: string | null) => (key ? (map.get(key) ?? '?') : copy.none)

    const [all, byCategory, byTeam, byAgent, byPriority] = reports
    const csv = reportsToCsv(
      period,
      [
        { section: 'visao_geral', label: () => 'total', rows: all },
        { section: 'categoria', label: lookup(categoryName), rows: byCategory },
        { section: 'equipe', label: lookup(teamName), rows: byTeam },
        { section: 'atendente', label: lookup(agentName), rows: byAgent },
        { section: 'prioridade', label: (key) => (key ? (copy.priorities[key] ?? key) : copy.none), rows: byPriority },
      ],
      BACKLOG_BUCKETS.map((b) => ({ label: copy.buckets[b], total: backlog.find((r) => r.bucket === b)?.total ?? 0 })),
    )

    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="relatorio-suporte-${period.from}_${period.to}.csv"`,
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    // A database refusal (not admin / invalid argument) reads as 403 / 400, never as a leak.
    const code = (err as { code?: string } | null)?.code
    if (code === '42501') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (code === '22023') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    return toErrorResponse(err)
  }
}
