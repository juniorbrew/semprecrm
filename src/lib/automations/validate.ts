import type { AutomationTriggerType } from '@/types'
import { COOLDOWN_HOURS_MAX, COOLDOWN_HOURS_MIN, isRunFrequency } from './frequency'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  message: string
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    })
    return issues
  }
  walk(steps, '', issues)
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues)
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues)
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues)
    }
  })
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: 'message text is required' })
      }
      break
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: 'template name is required' })
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: 'field name is required' })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'field value is required' })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: 'pipeline is required' })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'wait amount must be greater than 0' })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        })
      }
      if (c.cancel_on_reply !== undefined && typeof c.cancel_on_reply !== 'boolean') {
        issues.push({ path: `${path}.cancel_on_reply`, message: 'cancel on reply must be true or false' })
      }
      break
    case 'condition': {
      const subject = String(c.subject ?? '')
      if (!nonEmpty(c.subject)) {
        issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
      } else if (!CONDITION_SUBJECTS.has(subject)) {
        issues.push({ path: `${path}.subject`, message: `unknown condition: ${subject}` })
      }
      // What each subject needs: tags / fields / time windows name their
      // target in `operand`; "message contains" compares `value`; business
      // hours reads the account schedule and needs nothing.
      if (OPERAND_SUBJECTS.has(subject) && !nonEmpty(c.operand)) {
        issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
      }
      if (subject === 'message_content' && !nonEmpty(c.value)) {
        issues.push({ path: `${path}.value`, message: 'the text to look for is required' })
      }
      if (subject === 'time_of_day' && nonEmpty(c.operand) && !TIME_WINDOW_RE.test(String(c.operand))) {
        issues.push({ path: `${path}.operand`, message: 'time window must look like 18:00-09:00' })
      }
      break
    }
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required' })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL' })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    case 'create_task':
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'task title is required' })
      }
      if (
        c.priority !== undefined &&
        c.priority !== '' &&
        !['low', 'normal', 'high', 'urgent'].includes(String(c.priority))
      ) {
        issues.push({
          path: `${path}.priority`,
          message: 'task priority must be low, normal, high or urgent',
        })
      }
      if (c.due_in_hours !== undefined && c.due_in_hours !== null && c.due_in_hours !== '') {
        const n = Number(c.due_in_hours)
        if (!Number.isFinite(n) || n < 0) {
          issues.push({
            path: `${path}.due_in_hours`,
            message: 'due in hours must be a number of hours (0 or more)',
          })
        }
      }
      break
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings' })
    }
    if (cfg.match_type !== 'exact' && cfg.match_type !== 'contains') {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
      })
    }
  } else if (triggerType === 'time_based') {
    // Never wired to a scheduler: an active time-based rule would sit
    // there and never run. Kept as a type for old rows only.
    issues.push({
      path: 'trigger.type',
      message: 'the time-based trigger is not available; use "Conversation inactive" or a wait step',
    })
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' })
    }
  } else if (triggerType === 'lead_captured') {
    // source_id is optional ("any source"); when present it must be a uuid.
    if (cfg.source_id !== undefined && cfg.source_id !== null && cfg.source_id !== '') {
      if (typeof cfg.source_id !== 'string' || !UUID_RE.test(cfg.source_id)) {
        issues.push({ path: 'trigger.source_id', message: 'source must be a valid id' })
      }
    }
  } else if (triggerType === 'conversation_inactive') {
    // Mirrors parseInactiveConfig in inactivity.ts: decimal hours in
    // 0.05–720, a known last_from, at least one open/pending status.
    const hours = typeof cfg.hours === 'string' ? Number(cfg.hours) : cfg.hours
    if (
      typeof hours !== 'number' ||
      !Number.isFinite(hours) ||
      hours < INACTIVE_HOURS_MIN ||
      hours > INACTIVE_HOURS_MAX
    ) {
      issues.push({
        path: 'trigger.hours',
        message: `hours must be a number between ${INACTIVE_HOURS_MIN} and ${INACTIVE_HOURS_MAX}`,
      })
    }
    if (!['agent', 'customer', 'any'].includes(String(cfg.last_from))) {
      issues.push({
        path: 'trigger.last_from',
        message: 'last_from must be "agent", "customer" or "any"',
      })
    }
    const statuses = cfg.statuses
    if (
      !Array.isArray(statuses) ||
      statuses.length === 0 ||
      statuses.some((s) => s !== 'open' && s !== 'pending')
    ) {
      issues.push({
        path: 'trigger.statuses',
        message: 'statuses must list at least one of "open", "pending"',
      })
    }
  }

  return issues
}

const CONDITION_SUBJECTS = new Set([
  'tag_presence',
  'tag_absence',
  'contact_field',
  'message_content',
  'time_of_day',
  'business_hours',
])
const OPERAND_SUBJECTS = new Set(['tag_presence', 'tag_absence', 'contact_field', 'time_of_day'])
const TIME_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/

/**
 * Run frequency + cooldown (migration 048). Checked on every save —
 * drafts included — because the DB rejects out-of-range values.
 */
export function validateRunFrequency(frequency: unknown, cooldownHours: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (frequency === undefined || frequency === null) return issues
  if (!isRunFrequency(frequency)) {
    issues.push({ path: 'run_frequency', message: 'unknown run frequency' })
    return issues
  }
  if (frequency === 'cooldown') {
    const h = typeof cooldownHours === 'string' ? Number(cooldownHours) : cooldownHours
    if (typeof h !== 'number' || !Number.isFinite(h) || h < COOLDOWN_HOURS_MIN || h > COOLDOWN_HOURS_MAX) {
      issues.push({
        path: 'cooldown_hours',
        message: `interval must be between ${COOLDOWN_HOURS_MIN} and ${COOLDOWN_HOURS_MAX} hours`,
      })
    }
  }
  return issues
}

/** Bounds for `conversation_inactive.hours` (0.05 h = 3 min, 720 h = 30 d). */
export const INACTIVE_HOURS_MIN = 0.05
export const INACTIVE_HOURS_MAX = 720

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}
