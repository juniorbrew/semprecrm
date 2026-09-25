// ============================================================
// Automation run frequency (migration 048) — pure helpers shared by
// the engine (which claims guard rows) and the builder (defaults and
// labels). No I/O here.
// ============================================================

import type { AutomationRunFrequency, AutomationTriggerType } from '@/types'

export const RUN_FREQUENCIES: AutomationRunFrequency[] = [
  'every_time',
  'once_per_contact',
  'once_per_attendance',
  'cooldown',
]

export const DEFAULT_COOLDOWN_HOURS = 24
export const COOLDOWN_HOURS_MIN = 0.05
export const COOLDOWN_HOURS_MAX = 720

/**
 * Frequency a NEW automation starts with. Triggers fired by customer
 * messages default to once per attendance, so a welcome or a keyword
 * reply does not answer every message; event triggers (a tag, an
 * assignment, an inactivity scan) fire once per event anyway.
 * Automations created before migration 048 keep 'every_time'.
 */
export function defaultFrequencyForTrigger(trigger: AutomationTriggerType | string): AutomationRunFrequency {
  switch (trigger) {
    case 'new_message_received':
    case 'first_inbound_message':
    case 'keyword_match':
      return 'once_per_attendance'
    default:
      return 'every_time'
  }
}

export interface RunScope {
  kind: 'contact' | 'attendance' | 'cooldown'
  /** Primary key part in automation_run_guards. */
  key: string
  /** Set for cooldown scopes. */
  cooldownHours?: number
}

/**
 * The guard row a run claims, or null when the automation runs every
 * time. `once_per_attendance` without a conversation degrades to once
 * per contact.
 */
export function runScopeKey(
  frequency: AutomationRunFrequency | null | undefined,
  opts: {
    cooldownHours?: number | null
    conversationId?: string | null
    serviceCount?: number | null
  } = {},
): RunScope | null {
  switch (frequency ?? 'every_time') {
    case 'once_per_contact':
      return { kind: 'contact', key: 'contact' }
    case 'once_per_attendance':
      if (!opts.conversationId) return { kind: 'contact', key: 'contact' }
      return {
        kind: 'attendance',
        key: `attendance:${opts.conversationId}:${Math.max(1, opts.serviceCount ?? 1)}`,
      }
    case 'cooldown': {
      const h = Number(opts.cooldownHours)
      const hours =
        Number.isFinite(h) && h >= COOLDOWN_HOURS_MIN && h <= COOLDOWN_HOURS_MAX ? h : DEFAULT_COOLDOWN_HOURS
      return { kind: 'cooldown', key: 'cooldown', cooldownHours: hours }
    }
    default:
      return null
  }
}

const PT_LABELS: Record<AutomationRunFrequency, string> = {
  every_time: 'Toda vez',
  once_per_contact: 'Uma vez por contato',
  once_per_attendance: 'Uma vez por atendimento',
  cooldown: 'No máximo a cada X horas',
}

const EN_LABELS: Record<AutomationRunFrequency, string> = {
  every_time: 'Every time',
  once_per_contact: 'Once per contact',
  once_per_attendance: 'Once per attendance',
  cooldown: 'At most every X hours',
}

const PT_HINTS: Record<AutomationRunFrequency, string> = {
  every_time: 'Roda a cada evento. Com "Nova mensagem", responde toda mensagem.',
  once_per_contact: 'Roda só uma vez para cada contato, para sempre.',
  once_per_attendance: 'Uma vez por conversa; vale de novo quando uma conversa resolvida é reaberta.',
  cooldown: 'Depois de rodar para um contato, espera o intervalo antes de rodar de novo.',
}

const EN_HINTS: Record<AutomationRunFrequency, string> = {
  every_time: 'Runs on every event. With "New message" it answers every message.',
  once_per_contact: 'Runs only once for each contact, ever.',
  once_per_attendance: 'Once per conversation; again when a resolved conversation reopens.',
  cooldown: 'After running for a contact, waits the interval before running again.',
}

export function frequencyLabel(f: AutomationRunFrequency, lang: 'pt-BR' | 'en-US' | string): string {
  return (lang === 'pt-BR' ? PT_LABELS : EN_LABELS)[f] ?? f
}

export function frequencyHint(f: AutomationRunFrequency, lang: 'pt-BR' | 'en-US' | string): string {
  return (lang === 'pt-BR' ? PT_HINTS : EN_HINTS)[f] ?? ''
}

export function isRunFrequency(v: unknown): v is AutomationRunFrequency {
  return typeof v === 'string' && (RUN_FREQUENCIES as string[]).includes(v)
}
