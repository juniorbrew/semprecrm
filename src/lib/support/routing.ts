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
  /** The automatic assignee has sent a message here (set by applyRouting). */
  assignee_engaged?: boolean
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
 *     'manual', or unknown = NULL, rows that predate 073), or an automatic
 *     one who has already written in the conversation, is never replaced;
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

  const humanOwned = !!conv.assigned_agent_id && (conv.assignment_source !== 'auto' || !!conv.assignee_engaged)
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
  opts: {
    accountId?: string
    /** Automation chain depth / origin when an automation drives it (loop protection). */
    depth?: number
    origin?: string | null
  } = {},
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
    // An automatic assignee who already wrote in this conversation is a
    // person at work: treated like a manual assignment.
    if (conv.assigned_agent_id && conv.assignment_source === 'auto') {
      const { data: spoke } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('sender_id', conv.assigned_agent_id)
        .limit(1)
      conv.assignee_engaged = ((spoke ?? []) as unknown[]).length > 0
    }

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

    // One write path (migration 073): compare-and-set on the assignee we saw,
    // guarded by the provenance columns (a person's team / owner is never
    // replaced), carrying the automation depth so the events it raises stay
    // inside the loop cap.
    const { data: wrote, error } = await db.rpc('support_set_conversation_team', {
      p_conversation: conversationId,
      p_account: accountId,
      p_team: decision.teamId,
      p_change_team: decision.changeTeam,
      p_assignee: assigneeId,
      p_change_assignee: !!assigneeId,
      p_actor_user: null,
      p_check_assignee: !!assigneeId,
      p_expect_assignee: conv.assigned_agent_id,
      p_require_auto: true,
      p_depth: opts.depth ?? 0,
      p_origin: opts.origin ?? null,
    })
    if (error) {
      console.error('[routing] write failed:', error.message)
      return { status: 'skipped', reason: 'changed_meanwhile' }
    }
    if (!wrote) return { status: 'skipped', reason: 'changed_meanwhile' }

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
  | { status: 'failed'; reason: 'not_found' | 'team_not_found' | 'closed' | 'write_failed' | 'changed_meanwhile' }

/**
 * "Transferir para equipe": a person hands the conversation to a team. The
 * team is theirs (team_source 'manual'). The owner stays when they already
 * belong to the team; otherwise an available member is picked round-robin
 * (assignment_source 'manual': routing never touches it afterwards); when
 * nobody in the team is available the current owner is NOT dropped, only the
 * team changes (an unassigned conversation then waits in that team's queue).
 * The write goes through the RPC with the person as actor, so the provenance
 * is 'manual' even though the service client makes it, and it is a
 * compare-and-set on the owner the person saw.
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

  const current = ((conv as Row).assigned_agent_id as string | null) ?? null
  const teamChanged = (conv as Row).team_id !== teamId
  const { data: memberRows } = await db.from('team_members').select('user_id').eq('team_id', teamId).eq('account_id', accountId)
  const memberIds = ((memberRows ?? []) as { user_id: string }[]).map((m) => m.user_id)
  const picked = current && memberIds.includes(current) ? null : await pickRoundRobinAssignee(db, accountId, { memberIds })
  if (!teamChanged && !picked) return { status: 'ok', teamId, assigneeId: current }

  const { data: wrote, error } = await db.rpc('support_set_conversation_team', {
    p_conversation: conversationId,
    p_account: accountId,
    p_team: teamId,
    p_change_team: teamChanged,
    p_assignee: picked,
    p_change_assignee: !!picked,
    p_actor_user: actorUserId,
    p_check_assignee: true,
    p_expect_assignee: current,
    p_require_auto: false,
    p_depth: 0,
    p_origin: null,
  })
  if (error) {
    console.error('[routing] transfer failed:', error.message)
    return { status: 'failed', reason: 'write_failed' }
  }
  if (!wrote) return { status: 'failed', reason: 'changed_meanwhile' }

  const events: { event_type: string; payload: Record<string, unknown> }[] = []
  if (teamChanged) events.push({ event_type: 'team_changed', payload: { team_id: teamId, team_name: (team as Row).name } })
  if (picked) events.push({ event_type: 'assigned', payload: { assignee_user_id: picked } })
  if (events.length) {
    const { error: evErr } = await db.from('conversation_events').insert(
      events.map((e) => ({ account_id: accountId, conversation_id: conversationId, actor_user_id: actorUserId, ...e })),
    )
    if (evErr) console.error('[routing] transfer event insert failed:', evErr.message)
  }
  if (picked && picked !== actorUserId) {
    void notifyConversationAssigned(db, { accountId, conversationId, actorUserId }).catch(() => undefined)
  }
  return { status: 'ok', teamId, assigneeId: picked ?? current }
}
