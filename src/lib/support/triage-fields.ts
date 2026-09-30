// Triage field rules shared by the inbox UI (manual edits) and the AI
// triage (automatic edits): subject sanitising, the patch a manual edit
// writes, and the conversation events a change leaves behind. Pure.

import type {
  ConversationEventPayload,
  ConversationEventType,
  ConversationPriority,
  ConversationResolution,
} from '@/types'
import { CATEGORY_LIMITS, DEFAULT_RESOLUTION, type ConversationCategory } from './model'

/**
 * One-line, tag-free subject of at most 120 characters; null when empty.
 * Used for the agent's inline edit and for the model's output.
 */
export function sanitizeSubject(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const clean = input
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return null
  const chars = Array.from(clean)
  return chars.length > CATEGORY_LIMITS.subject ? chars.slice(0, CATEGORY_LIMITS.subject - 1).join('').trimEnd() + '…' : clean
}

export interface TriageState {
  category_id?: string | null
  priority?: ConversationPriority | null
  subject?: string | null
}

export interface TriageChange {
  category_id?: string | null
  priority?: ConversationPriority
  subject?: string | null
}

/** Columns a manual edit writes: the change plus "a human decided this". */
export function manualTriagePatch(change: TriageChange, now: Date = new Date()) {
  return { ...change, triage_source: 'manual' as const, triage_at: now.toISOString() }
}

/** Patch that resolves with an outcome (status + resolution in one write). */
export function resolvePatch(resolution: ConversationResolution = DEFAULT_RESOLUTION) {
  return { status: 'closed' as const, resolution }
}

export interface DraftEvent {
  event_type: Extract<ConversationEventType, 'category_changed' | 'priority_changed'>
  payload: ConversationEventPayload
}

/**
 * Events for the fields that actually changed (category, priority).
 * Subject changes leave no event (it may hold personal data).
 */
export function triageEvents(
  before: TriageState,
  after: TriageState,
  categories: ReadonlyMap<string, Pick<ConversationCategory, 'name'>>,
  source?: 'ai',
): DraftEvent[] {
  const out: DraftEvent[] = []
  const extra = source ? { source } : {}
  if (after.category_id !== undefined && (after.category_id ?? null) !== (before.category_id ?? null)) {
    out.push({
      event_type: 'category_changed',
      payload: {
        category_id: after.category_id ?? null,
        category_name: after.category_id ? (categories.get(after.category_id)?.name ?? null) : null,
        ...extra,
      },
    })
  }
  if (after.priority && after.priority !== (before.priority ?? 'normal')) {
    out.push({
      event_type: 'priority_changed',
      payload: { priority: after.priority, previous_priority: before.priority ?? 'normal', ...extra },
    })
  }
  return out
}
