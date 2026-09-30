// ============================================================
// SLA by priority (migration 072): what a conversation is waiting for,
// how urgent it is, and the language-keyed copy the inbox and Settings
// share. Pure — the deadlines themselves are stamped by the database.
// ============================================================

import type { Conversation, ConversationPriority } from '@/types'
import type { Language } from '@/lib/i18n'

export type SlaKind = 'first_response' | 'resolution'
export type SlaLevel = 'ok' | 'warning' | 'breached'

/** A row of `sla_policies`. */
export interface SlaPolicy {
  priority: ConversationPriority
  first_response_minutes: number | null
  resolution_minutes: number | null
}

export const SLA_LIMITS = { first_response_minutes: 43_200, resolution_minutes: 129_600 } as const

export type SlaFields = Pick<
  Conversation,
  | 'status'
  | 'first_response_at'
  | 'first_response_due_at'
  | 'first_response_warn_at'
  | 'resolution_due_at'
  | 'resolution_warn_at'
>

export interface SlaTarget {
  kind: SlaKind
  dueAt: number
  warnAt: number | null
}

function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/**
 * The deadline the conversation is waiting on right now: the first reply
 * while nobody answered, then the resolution. Null when no policy applied
 * (old rows, accounts without policies) or the conversation is finished.
 */
export function activeSlaTarget(c: SlaFields): SlaTarget | null {
  if (c.status === 'closed') return null
  const first = stamp(c.first_response_due_at)
  if (first !== null && !c.first_response_at) {
    return { kind: 'first_response', dueAt: first, warnAt: stamp(c.first_response_warn_at) }
  }
  const res = stamp(c.resolution_due_at)
  if (res !== null) return { kind: 'resolution', dueAt: res, warnAt: stamp(c.resolution_warn_at) }
  return null
}

/** Amber from 80% of the target elapsed (= under 20% left), red once it is past. */
export function slaLevel(target: SlaTarget, now: number): SlaLevel {
  if (now >= target.dueAt) return 'breached'
  if (target.warnAt !== null && now >= target.warnAt) return 'warning'
  return 'ok'
}

/** Mirrors the SQL filter "SLA estourado": a pending target already past. */
export function isSlaBreached(c: SlaFields, now: number): boolean {
  if (c.status === 'closed') return false
  const first = stamp(c.first_response_due_at)
  if (first !== null && !c.first_response_at && first <= now) return true
  const res = stamp(c.resolution_due_at)
  return res !== null && res <= now
}

/** "1h 20min", "45min", "2d 3h", "menos de 1 min". */
export function formatSlaSpan(ms: number, language: Language): string {
  const pt = language === 'pt-BR'
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return pt ? 'menos de 1 min' : 'under 1 min'
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h}h ${min % 60}min` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** Row / header label: time left, or how long ago it was missed. */
export function slaLabel(target: SlaTarget, now: number, language: Language): string {
  const left = target.dueAt - now
  const span = formatSlaSpan(Math.abs(left), language)
  if (left > 0) return span
  return language === 'pt-BR' ? `estourado há ${span}` : `${span} overdue`
}

/** A minutes value as the settings form shows it: whole hours when it divides evenly. */
export function splitMinutes(minutes: number | null): { value: string; unit: 'min' | 'h' } {
  if (minutes === null) return { value: '', unit: 'h' }
  if (minutes >= 60 && minutes % 60 === 0) return { value: String(minutes / 60), unit: 'h' }
  return { value: String(minutes), unit: 'min' }
}

/** Inverse of `splitMinutes`; null = empty or invalid (no target). */
export function joinMinutes(value: string, unit: 'min' | 'h'): number | null {
  const n = Number(value.replace(',', '.'))
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return null
  return Math.round(unit === 'h' ? n * 60 : n)
}

export interface SlaCopy {
  title: string
  intro: string
  priority: string
  firstResponse: string
  resolution: string
  minutes: string
  hours: string
  businessOnly: string
  businessOnlyBody: string
  save: string
  saved: string
  invalid: string
  readOnly: string
  headerFirstResponse: string
  headerResolution: string
  breachedFilter: string
  breachedChip: string
  compliance: string
  complianceHint: string
  warning: (kind: SlaKind) => string
  breached: (kind: SlaKind) => string
}

const KIND_PT: Record<SlaKind, string> = { first_response: 'primeira resposta', resolution: 'resolução' }
const KIND_EN: Record<SlaKind, string> = { first_response: 'first response', resolution: 'resolution' }

export const SLA_COPY: Record<Language, SlaCopy> = {
  'pt-BR': {
    title: 'Prazos',
    intro: 'Quanto tempo cada prioridade tem para a primeira resposta e para a resolução. Campo vazio = sem prazo.',
    priority: 'Prioridade',
    firstResponse: 'Primeira resposta',
    resolution: 'Resolução',
    minutes: 'min',
    hours: 'h',
    businessOnly: 'Usar só o horário de atendimento',
    businessOnlyBody: 'Fora do horário definido em Configurações > Atendimento, o relógio não anda.',
    save: 'Salvar prazos',
    saved: 'Prazos salvos',
    invalid: 'Use um valor maior que zero',
    readOnly: 'Somente administradores podem alterar os prazos.',
    headerFirstResponse: 'Prazo de resposta',
    headerResolution: 'Prazo de resolução',
    breachedFilter: 'SLA estourado',
    breachedChip: 'Estourados',
    compliance: 'Cumprimento dos prazos',
    complianceHint: 'Conversas respondidas e resolvidas dentro do prazo',
    warning: (k) => `Prazo de ${KIND_PT[k]} perto de vencer`,
    breached: (k) => `Prazo de ${KIND_PT[k]} estourado`,
  },
  'en-US': {
    title: 'Deadlines',
    intro: 'How long each priority has for the first response and for resolution. An empty field means no deadline.',
    priority: 'Priority',
    firstResponse: 'First response',
    resolution: 'Resolution',
    minutes: 'min',
    hours: 'h',
    businessOnly: 'Only count business hours',
    businessOnlyBody: 'Outside the hours set in Settings > Service, the clock does not run.',
    save: 'Save deadlines',
    saved: 'Deadlines saved',
    invalid: 'Use a value greater than zero',
    readOnly: 'Only admins can change deadlines.',
    headerFirstResponse: 'Response deadline',
    headerResolution: 'Resolution deadline',
    breachedFilter: 'SLA breached',
    breachedChip: 'Breached',
    compliance: 'Deadlines met',
    complianceHint: 'Conversations answered and resolved within their deadline',
    warning: (k) => `${KIND_EN[k][0].toUpperCase()}${KIND_EN[k].slice(1)} deadline close`,
    breached: (k) => `${KIND_EN[k][0].toUpperCase()}${KIND_EN[k].slice(1)} deadline breached`,
  },
}

export function slaCopy(language: Language): SlaCopy {
  return SLA_COPY[language] ?? SLA_COPY['pt-BR']
}
