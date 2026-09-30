// ============================================================
// Automatic routing (migration 073): a conversation that gets a category
// goes to the team its routing rule names, and, when nobody owns it, to
// an available member of that team (round-robin).
//
// `decideRouting` is the pure decision; `applyRouting` loads, decides,
// writes (compare-and-set, so a person who claims the conversation a
// moment earlier always wins) and logs the events. Service-role client,
// always scoped by the conversation's own account. Never throws: routing
// is a best-effort follow-up of the category change that triggered it.
//
// Called by every path that sets a category: the AI triage apply, the
// manual change (POST /api/support/routing) and the automation action.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { pickRoundRobinAssignee } from '@/lib/assignment/round-robin'
import { notifyConversationAssigned } from '@/lib/push/notify'
import type { ConversationPriority } from '@/types'
import { isPriority } from './model'

const PRIORITY_RANK: Record<ConversationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }
/** A user id that matches nobody: routing has no acting person to exclude from the push. */
const NO_ACTOR = '00000000-0000-0000-0000-000000000000'

export interface RoutingConversation {
  status: string
  archived_at?: string | null
  category_id: string | null
  priority: ConversationPriority
  team_id: string | null
  team_source: 'auto' | 'manual' | null
  assigned_agent_id: string | null
  assignment_source: 'auto' | 'manual' | null
}

export interface RoutingRuleInput {
  team_id: string
  priority_min: ConversationPriority | null
}

export type RoutingSkip =
  | 'closed'
  | 'no_category'
  | 'no_rule'
  | 'team_archived'
  | 'below_priority'
  | 'manual_team'

export type RoutingDecision =
  | { action: 'skip'; reason: RoutingSkip }
  | {
      action: 'route'
      teamId: string
      /** The conversation's team changes. */
      changeTeam: boolean
      /** Pick a team member (round-robin) for it. */
      pickAssignee: boolean
    }

/**
 * Rules of the game:
 *   - closed / archived conversations are never routed;
 *   - a team a person chose by hand stays (the whole routing is skipped);
 *   - an assignee a person claimed or was handed (assignment_source
 *     'manual', or unknown = NULL, rows that predate 073) is never replaced;
 *   - an automatic assignee who already belongs to the team stays, which
 *     also makes a repeated category set a no-op;
 *   - otherwise (nobody, or an automatic assignee outside the team) a
 *     member is picked.
 */
export function decideRouting(
  conv: RoutingConversation,
  rule: RoutingRuleInput | null,
  team: { archived_at: string | null } | null,
  memberIds: readonly string[],
): RoutingDecision {
  if (conv.status === 'closed' || conv.archived_at) return { action: 'skip', reason: 'closed' }
  if (!conv.category_id) return { action: 'skip', reason: 'no_category' }
  if (!rule || !team) return { action: 'skip', reason: 'no_rule' }
  if (team.archived_at) return { action: 'skip', reason: 'team_archived' }
  if (rule.priority_min && PRIORITY_RANK[conv.priority] < PRIORITY_RANK[rule.priority_min]) {
    return { action: 'skip', reason: 'below_priority' }
  }
  if (conv.team_id && conv.team_id !== rule.team_id && conv.team_source === 'manual') {
    return { action: 'skip', reason: 'manual_team' }
  }

  const humanOwned = !!conv.assigned_agent_id && conv.assignment_source !== 'auto'
  const inTeam = !!conv.assigned_agent_id && memberIds.includes(conv.assigned_agent_id)
  return {
    action: 'route',
    teamId: rule.team_id,
    changeTeam: conv.team_id !== rule.team_id,
    pickAssignee: !humanOwned && !inTeam,
  }
}

export type RoutingOutcome =
  | { status: 'routed'; teamId: string; assigneeId: string | null; teamChanged: boolean }
  | { status: 'skipped'; reason: RoutingSkip | 'not_found' | 'changed_meanwhile' | 'nothing_to_do' }

type Row = Record<string, unknown>

function asConversation(c: Row): RoutingConversation {
  return {
    status: String(c.status),
    archived_at: (c.archived_at as string | null) ?? null,
    category_id: (c.category_id as string | null) ?? null,
    priority: isPriority(c.priority) ? c.priority : 'normal',
    team_id: (c.team_id as string | null) ?? null,
    team_source: (c.team_source as 'auto' | 'manual' | null) ?? null,
    assigned_agent_id: (c.assigned_agent_id as string | null) ?? null,
    assignment_source: (c.assignment_source as 'auto' | 'manual' | null) ?? null,
  }
}

export async function applyRouting(
  db: SupabaseClient,
  conversationId: string,
  opts: { accountId?: string } = {},
): Promise<RoutingOutcome> {
  try {
    let q = db
      .from('conversations')
      .select('id, account_id, status, archived_at, category_id, priority, team_id, team_source, assigned_agent_id, assignment_source')
      .eq('id', conversationId)
    if (opts.accountId) q = q.eq('account_id', opts.accountId)
    const { data: row } = await q.maybeSingle()
    if (!row) return { status: 'skipped', reason: 'not_found' }
    const c = row as Row
    const accountId = c.account_id as string
    const conv = asConversation(c)
    if (!conv.category_id) return { status: 'skipped', reason: 'no_category' }

    const { data: ruleRow } = await db
      .from('routing_rules')
      .select('team_id, priority_min')
      .eq('account_id', accountId)
      .eq('category_id', conv.category_id)
      .maybeSingle()
    const rule = ruleRow
      ? {
          team_id: (ruleRow as Row).team_id as string,
          priority_min: isPriority((ruleRow as Row).priority_min) ? ((ruleRow as Row).priority_min as ConversationPriority) : null,
        }
      : null
    const { data: teamRow } = rule
      ? await db.from('teams').select('id, name, archived_at').eq('id', rule.team_id).eq('account_id', accountId).maybeSingle()
      : { data: null }
    const { data: memberRows } = rule
      ? await db.from('team_members').select('user_id').eq('team_id', rule.team_id).eq('account_id', accountId)
      : { data: [] }
    const memberIds = ((memberRows ?? []) as { user_id: string }[]).map((m) => m.user_id)

    const decision = decideRouting(conv, rule, teamRow as { archived_at: string | null } | null, memberIds)
    if (decision.action === 'skip') return { status: 'skipped', reason: decision.reason }

    const assigneeId = decision.pickAssignee
      ? await pickRoundRobinAssignee(db, accountId, { memberIds })
      : null
    if (!decision.changeTeam && !assigneeId) return { status: 'skipped', reason: 'nothing_to_do' }

    const patch: Record<string, unknown> = {}
    if (decision.changeTeam) patch.team_id = decision.teamId
    if (assigneeId) patch.assigned_agent_id = assigneeId

    // Compare-and-set: only while nobody (or the same automatic assignee)
    // holds it and nobody chose the team by hand in the meantime.
    let write = db.from('conversations').update(patch).eq('id', conversationId).eq('account_id', accountId).neq('status', 'closed')
    if (assigneeId) {
      write = conv.assigned_agent_id
        ? write.eq('assigned_agent_id', conv.assigned_agent_id).eq('assignment_source', 'auto')
        : write.is('assigned_agent_id', null)
    }
    if (decision.changeTeam) write = write.or('team_source.is.null,team_source.eq.auto')
    const { data: written, error } = await write.select('id')
    if (error) {
      console.error('[routing] write failed:', error.message)
      return { status: 'skipped', reason: 'changed_meanwhile' }
    }
    if (!written?.length) return { status: 'skipped', reason: 'changed_meanwhile' }

    const events: { event_type: string; payload: Record<string, unknown> }[] = []
    if (decision.changeTeam) {
      events.push({
        event_type: 'team_changed',
        payload: { team_id: decision.teamId, team_name: (teamRow as Row | null)?.name ?? null, source: 'routing' },
      })
    }
    if (assigneeId) events.push({ event_type: 'assigned', payload: { assignee_user_id: assigneeId, source: 'routing' } })
    const { error: evErr } = await db.from('conversation_events').insert(
      events.map((e) => ({ account_id: accountId, conversation_id: conversationId, actor_user_id: null, ...e })),
    )
    if (evErr) console.error('[routing] event insert failed:', evErr.message)

    if (assigneeId) {
      void notifyConversationAssigned(db, { accountId, conversationId, actorUserId: NO_ACTOR }).catch(() => undefined)
    }
    return { status: 'routed', teamId: decision.teamId, assigneeId, teamChanged: decision.changeTeam }
  } catch (err) {
    console.error('[routing] failed:', err instanceof Error ? err.message : err)
    return { status: 'skipped', reason: 'not_found' }
  }
}

export type TransferOutcome =
  | { status: 'ok'; teamId: string; assigneeId: string | null }
  | { status: 'failed'; reason: 'not_found' | 'team_not_found' | 'closed' | 'write_failed' }

/**
 * "Transferir para equipe": a person hands the conversation to a team. The
 * team is theirs (team_source 'manual'), the owner becomes an available
 * member picked round-robin (assignment_source 'manual': routing never
 * touches it afterwards) or nobody when the whole team is away, in which
 * case the conversation waits in that team's queue.
 */
export async function transferToTeam(
  db: SupabaseClient,
  input: { accountId: string; conversationId: string; teamId: string; actorUserId: string },
): Promise<TransferOutcome> {
  const { accountId, conversationId, teamId, actorUserId } = input
  const { data: conv } = await db
    .from('conversations')
    .select('id, status, team_id, assigned_agent_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conv) return { status: 'failed', reason: 'not_found' }
  if ((conv as Row).status === 'closed') return { status: 'failed', reason: 'closed' }
  const { data: team } = await db
    .from('teams')
    .select('id, name, archived_at')
    .eq('id', teamId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!team || (team as Row).archived_at) return { status: 'failed', reason: 'team_not_found' }

  const { data: memberRows } = await db.from('team_members').select('user_id').eq('team_id', teamId).eq('account_id', accountId)
  const memberIds = ((memberRows ?? []) as { user_id: string }[]).map((m) => m.user_id)
  const assigneeId = await pickRoundRobinAssignee(db, accountId, { memberIds })
  const previous = ((conv as Row).assigned_agent_id as string | null) ?? null

  const { error } = await db
    .from('conversations')
    .update({
      team_id: teamId,
      team_source: 'manual',
      assigned_agent_id: assigneeId,
      assignment_source: assigneeId ? 'manual' : null,
    })
    .eq('id', conversationId)
    .eq('account_id', accountId)
  if (error) {
    console.error('[routing] transfer failed:', error.message)
    return { status: 'failed', reason: 'write_failed' }
  }

  const events: { event_type: string; payload: Record<string, unknown> }[] = []
  if ((conv as Row).team_id !== teamId) {
    events.push({ event_type: 'team_changed', payload: { team_id: teamId, team_name: (team as Row).name } })
  }
  if (assigneeId) events.push({ event_type: 'assigned', payload: { assignee_user_id: assigneeId } })
  else if (previous) events.push({ event_type: 'unassigned', payload: {} })
  if (events.length) {
    const { error: evErr } = await db.from('conversation_events').insert(
      events.map((e) => ({ account_id: accountId, conversation_id: conversationId, actor_user_id: actorUserId, ...e })),
    )
    if (evErr) console.error('[routing] transfer event insert failed:', evErr.message)
  }
  if (assigneeId && assigneeId !== actorUserId) {
    void notifyConversationAssigned(db, { accountId, conversationId, actorUserId }).catch(() => undefined)
  }
  return { status: 'ok', teamId, assigneeId }
}
