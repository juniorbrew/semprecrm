// Teams and routing rules (migration 073): thin Supabase read/write side plus
// the language-keyed copy the inbox shares. RLS: members read, admins write.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ConversationPriority } from '@/types'
import type { Language } from '@/lib/i18n'
import { isPriority } from './model'

type Client = Pick<SupabaseClient, 'from'>

export interface Team {
  id: string
  account_id: string
  name: string
  description: string | null
  archived_at: string | null
}

export interface RoutingRule {
  id: string
  account_id: string
  category_id: string
  team_id: string
  priority_min: ConversationPriority | null
  position: number
}

export const TEAM_LIMITS = { name: 40, description: 200 } as const
const TEAM_COLUMNS = 'id, account_id, name, description, archived_at'
const RULE_COLUMNS = 'id, account_id, category_id, team_id, priority_min, position'

export class TeamNameTakenError extends Error {
  constructor() {
    super('A team with this name already exists')
    this.name = 'TeamNameTakenError'
  }
}

function rethrow(error: { code?: string; message: string }): never {
  if (error.code === '23505') throw new TeamNameTakenError()
  throw error
}

/** Trimmed, single-spaced name of 1 to 40 characters; null when invalid. */
export function normalizeTeamName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, ' ')
  return name && name.length <= TEAM_LIMITS.name ? name : null
}

export function activeTeams(list: readonly Team[]): Team[] {
  return list.filter((t) => !t.archived_at).sort((a, b) => a.name.localeCompare(b.name))
}

export async function listTeams(supabase: Client, accountId: string): Promise<Team[]> {
  const { data, error } = await supabase.from('teams').select(TEAM_COLUMNS).eq('account_id', accountId).order('name')
  if (error) throw error
  return (data ?? []) as Team[]
}

export async function createTeam(supabase: Client, accountId: string, name: string): Promise<Team> {
  const clean = normalizeTeamName(name)
  if (!clean) throw new Error('invalid team name')
  const { data, error } = await supabase.from('teams').insert({ account_id: accountId, name: clean }).select(TEAM_COLUMNS).single()
  if (error) rethrow(error)
  return data as Team
}

export async function updateTeam(
  supabase: Client,
  id: string,
  changes: { name?: string; description?: string | null; archived?: boolean },
): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (changes.name !== undefined) {
    const clean = normalizeTeamName(changes.name)
    if (!clean) throw new Error('invalid team name')
    patch.name = clean
  }
  if (changes.description !== undefined) patch.description = changes.description?.trim() || null
  if (changes.archived !== undefined) patch.archived_at = changes.archived ? new Date().toISOString() : null
  const { error } = await supabase.from('teams').update(patch).eq('id', id)
  if (error) rethrow(error)
}

/** team id -> member user ids. */
export async function listTeamMembers(supabase: Client, accountId: string): Promise<Map<string, string[]>> {
  const { data, error } = await supabase.from('team_members').select('team_id, user_id').eq('account_id', accountId)
  if (error) throw error
  const out = new Map<string, string[]>()
  for (const row of (data ?? []) as { team_id: string; user_id: string }[]) {
    out.set(row.team_id, [...(out.get(row.team_id) ?? []), row.user_id])
  }
  return out
}

/** Diffs `next` against `current` and writes only the additions and removals. */
export async function setTeamMembers(
  supabase: Client,
  accountId: string,
  teamId: string,
  current: readonly string[],
  next: readonly string[],
): Promise<void> {
  const add = next.filter((u) => !current.includes(u))
  const remove = current.filter((u) => !next.includes(u))
  if (add.length) {
    const { error } = await supabase
      .from('team_members')
      .insert(add.map((user_id) => ({ team_id: teamId, user_id, account_id: accountId })))
    if (error) throw error
  }
  if (remove.length) {
    const { error } = await supabase.from('team_members').delete().eq('team_id', teamId).in('user_id', remove)
    if (error) throw error
  }
}

export async function listRoutingRules(supabase: Client, accountId: string): Promise<RoutingRule[]> {
  const { data, error } = await supabase.from('routing_rules').select(RULE_COLUMNS).eq('account_id', accountId)
  if (error) throw error
  return ((data ?? []) as RoutingRule[]).map((r) => ({ ...r, priority_min: isPriority(r.priority_min) ? r.priority_min : null }))
}

/** One rule per category: a team sets / replaces it, null removes it. */
export async function setRoutingRule(
  supabase: Client,
  accountId: string,
  categoryId: string,
  teamId: string | null,
  priorityMin: ConversationPriority | null = null,
): Promise<void> {
  if (!teamId) {
    const { error } = await supabase.from('routing_rules').delete().eq('account_id', accountId).eq('category_id', categoryId)
    if (error) throw error
    return
  }
  const { error } = await supabase
    .from('routing_rules')
    .upsert(
      { account_id: accountId, category_id: categoryId, team_id: teamId, priority_min: priorityMin },
      { onConflict: 'account_id,category_id' },
    )
  if (error) throw error
}

export interface TeamCopy {
  team: string
  noTeam: string
  teams: string
  teamsHint: string
  teamsEmpty: string
  teamName: string
  addTeam: string
  members: (n: number) => string
  chooseMembers: string
  archive: string
  restore: string
  taken: string
  routing: string
  routingHint: string
  routingEmpty: string
  routingNone: string
  routingMin: string
  routingAnyPriority: string
  readOnly: string
  transferToTeam: string
  filterTeam: string
  eventTeamSet: (name: string) => string
  eventTeamCleared: string
  eventRouted: (name: string) => string
}

export const TEAM_COPY: Record<Language, TeamCopy> = {
  'pt-BR': {
    team: 'Equipe',
    noTeam: 'Sem equipe',
    teams: 'Equipes',
    teamsHint: 'Grupos de atendentes que recebem as conversas de certas categorias.',
    teamsEmpty: 'Nenhuma equipe ainda. Adicione a primeira abaixo.',
    teamName: 'Nome da equipe',
    addTeam: 'Adicionar',
    members: (n) => (n === 1 ? '1 pessoa' : `${n} pessoas`),
    chooseMembers: 'Escolher pessoas',
    archive: 'Arquivar',
    restore: 'Restaurar',
    taken: 'Já existe uma equipe com esse nome',
    routing: 'Encaminhamento',
    routingHint: 'Quando a conversa ganha uma categoria, vai para a equipe escolhida e para alguém disponível nela.',
    routingEmpty: 'Crie categorias e equipes para definir o encaminhamento.',
    routingNone: 'Sem encaminhamento',
    routingMin: 'A partir da prioridade',
    routingAnyPriority: 'Qualquer prioridade',
    readOnly: 'Somente administradores podem alterar equipes e encaminhamento.',
    transferToTeam: 'Transferir para equipe',
    filterTeam: 'Equipe',
    eventTeamSet: (name) => `Equipe definida: ${name}`,
    eventTeamCleared: 'Equipe removida',
    eventRouted: (name) => `Encaminhada para a equipe ${name}`,
  },
  'en-US': {
    team: 'Team',
    noTeam: 'No team',
    teams: 'Teams',
    teamsHint: 'Groups of agents that receive the conversations of certain categories.',
    teamsEmpty: 'No teams yet. Add the first one below.',
    teamName: 'Team name',
    addTeam: 'Add',
    members: (n) => (n === 1 ? '1 person' : `${n} people`),
    chooseMembers: 'Choose people',
    archive: 'Archive',
    restore: 'Restore',
    taken: 'A team with this name already exists',
    routing: 'Routing',
    routingHint: 'When a conversation gets a category it goes to the chosen team and to someone available in it.',
    routingEmpty: 'Create categories and teams to set up routing.',
    routingNone: 'No routing',
    routingMin: 'From priority',
    routingAnyPriority: 'Any priority',
    readOnly: 'Only admins can change teams and routing.',
    transferToTeam: 'Transfer to team',
    filterTeam: 'Team',
    eventTeamSet: (name) => `Team set: ${name}`,
    eventTeamCleared: 'Team removed',
    eventRouted: (name) => `Routed to the ${name} team`,
  },
}

export function teamCopy(language: Language): TeamCopy {
  return TEAM_COPY[language] ?? TEAM_COPY['pt-BR']
}
