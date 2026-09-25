import type {
  Automation,
  AutomationLogStatus,
  AutomationLogStepResult,
  AutomationStep,
  AutomationStepType,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  LeadCapturedTriggerConfig,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  TagTriggerConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  CreateTaskStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { accountHasModule } from '@/lib/plans-server'
import {
  createTask,
  dueInHours,
  isTaskPriority,
  listTaskStatuses,
  type TaskPriority,
} from '@/lib/tasks'
import { engineSendText, engineSendTemplate } from './meta-send'
import { pickRoundRobinAssignee } from '@/lib/assignment/round-robin'
import type { AccountPreferences } from '@/types'
import { parseAccountPreferences } from '@/lib/account-preferences'
import { isWithinBusinessHours, localClock } from '@/lib/business-hours'
import { runScopeKey, type RunScope } from './frequency'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /**
   * Loop protection: how many automation hops led to this run. Carried
   * through wait steps so a resumed run keeps its place in the chain.
   */
  chain_depth?: number
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
  /**
   * Loop protection (migration 048). Events raised by an automation's
   * own actions (tag added, conversation assigned/resolved) arrive one
   * level deeper than the run that caused them, naming that automation.
   */
  origin?: { depth: number; automationId?: string | null }
}

/** A run chain longer than this is cut (A → B → C, then stop). */
export const MAX_CHAIN_DEPTH = 3
/** Circuit breaker: runs of one automation for one contact per window. */
export const BURST_LIMIT = 8
export const BURST_WINDOW_MS = 10 * 60_000

/** pt-BR on purpose: shown verbatim in the automation log table. */
export const SKIP_REASONS = {
  onceContact: 'já executada para este contato',
  onceAttendance: 'já executada neste atendimento',
  cooldown: (hours: number) => `aguardando o intervalo de ${formatHours(hours)} desde a última execução`,
  selfTriggered: 'proteção contra loop: evento causado pela própria automação',
  chainTooDeep: `proteção contra loop: mais de ${MAX_CHAIN_DEPTH} automações encadeadas`,
  burst: `proteção contra loop: mais de ${BURST_LIMIT} execuções em 10 min para este contato`,
  guardUnavailable: 'controle de frequência indisponível (migração 048 pendente?)',
} as const

function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1).replace('.', ',')} h`
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    // Plan gate (migration 025): an account without the `automations`
    // module (or a blocked account) runs nothing, even if active rows
    // exist from before the plan changed.
    if (!(await accountHasModule(db, input.accountId, 'automations'))) {
      return
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (!automations || automations.length === 0) return

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        const gate = await checkRunGate(automation, input)
        if (!gate.ok) {
          await recordSkip(automation, input, gate.reason)
          continue
        }
        await executeAutomation(automation, input, gate.scope)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

// ------------------------------------------------------------
// Run gate — loop protection + run frequency (migration 048)
// ------------------------------------------------------------

type RunGate = { ok: true; scope: RunScope | null } | { ok: false; reason: string }

async function checkRunGate(automation: Automation, input: DispatchInput): Promise<RunGate> {
  const depth = input.origin?.depth ?? 0
  if (input.origin?.automationId && input.origin.automationId === automation.id) {
    return { ok: false, reason: SKIP_REASONS.selfTriggered }
  }
  if (depth >= MAX_CHAIN_DEPTH) return { ok: false, reason: SKIP_REASONS.chainTooDeep }
  if (!input.contactId) return { ok: true, scope: null }

  const db = supabaseAdmin()

  // Circuit breaker, whatever the frequency: a contact bouncing between
  // two bots (ours replies, theirs replies…) stops here.
  const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString()
  const { count: recent, error: burstErr } = await db
    .from('automation_logs')
    .select('id', { count: 'exact', head: true })
    .eq('automation_id', automation.id)
    .eq('contact_id', input.contactId)
    .neq('status', 'skipped')
    .gte('created_at', since)
  if (burstErr) {
    console.error('[automations] burst check failed:', burstErr)
    return { ok: false, reason: SKIP_REASONS.guardUnavailable }
  }
  if ((recent ?? 0) >= BURST_LIMIT) return { ok: false, reason: SKIP_REASONS.burst }

  const scope = await resolveRunScope(automation, input.contactId, input.context)
  if (!scope) return { ok: true, scope: null }

  const { data: claimed, error } = await db.rpc('claim_automation_run', {
    p_automation_id: automation.id,
    p_contact_id: input.contactId,
    p_scope_key: scope.key,
    p_cooldown_hours: scope.cooldownHours ?? null,
  })
  if (error) {
    // Fail closed: a "send once" automation must never turn into "send
    // every time" because the guard is missing.
    console.error('[automations] claim_automation_run failed:', error)
    return { ok: false, reason: SKIP_REASONS.guardUnavailable }
  }
  if (claimed !== true) return { ok: false, reason: scopeSkipReason(scope) }
  return { ok: true, scope }
}

function scopeSkipReason(scope: RunScope): string {
  if (scope.kind === 'cooldown') return SKIP_REASONS.cooldown(scope.cooldownHours ?? 24)
  if (scope.kind === 'attendance') return SKIP_REASONS.onceAttendance
  return SKIP_REASONS.onceContact
}

/**
 * Which guard row this run claims. `once_per_attendance` keys on the
 * conversation's attendance counter; without a conversation it falls
 * back to once per contact.
 */
async function resolveRunScope(
  automation: Automation,
  contactId: string,
  ctx: AutomationContext | undefined,
): Promise<RunScope | null> {
  const frequency = automation.run_frequency ?? 'every_time'
  if (frequency !== 'once_per_attendance') {
    return runScopeKey(frequency, { cooldownHours: automation.cooldown_hours })
  }
  const db = supabaseAdmin()
  let query = db
    .from('conversations')
    .select('id, service_count')
    .eq('account_id', automation.account_id)
  query = ctx?.conversation_id ? query.eq('id', ctx.conversation_id) : query.eq('contact_id', contactId)
  const { data } = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle()
  const conv = data as { id: string; service_count?: number | null } | null
  return runScopeKey(frequency, {
    conversationId: conv?.id ?? null,
    serviceCount: conv?.service_count ?? 1,
  })
}

async function recordSkip(automation: Automation, input: DispatchInput, reason: string) {
  const { error } = await supabaseAdmin().from('automation_logs').insert({
    automation_id: automation.id,
    account_id: automation.account_id,
    user_id: automation.user_id,
    contact_id: input.contactId ?? null,
    trigger_event: input.triggerType,
    steps_executed: [],
    status: 'skipped',
    skip_reason: reason,
  })
  if (error) console.error('[automations] cannot record skip:', error)
}

async function releaseClaim(automation: Automation, contactId: string | null, scope: RunScope | null) {
  if (!scope || !contactId) return
  const { error } = await supabaseAdmin().rpc('release_automation_run', {
    p_automation_id: automation.id,
    p_contact_id: contactId,
    p_scope_key: scope.key,
  })
  if (error) console.error('[automations] release_automation_run failed:', error)
}

// ------------------------------------------------------------
// Resume / cancel parked runs
// ------------------------------------------------------------

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 * When the parked scope was a condition branch, the steps after that
 * condition in the enclosing scope run too (they used to be skipped).
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  // Plan gate — same rule as dispatch. A wait step parked before the
  // module was switched off must not wake up and keep sending.
  if (!(await accountHasModule(db, (automation as Automation).account_id, 'automations'))) {
    await markPending(pending.id, 'failed')
    return
  }

  // The rule was switched off while this run was parked: stop it.
  if (!(automation as Automation).is_active) {
    await markPending(pending.id, 'cancelled')
    await appendToLog(
      pending.log_id,
      [{ step_id: '', step_type: 'wait', status: 'skipped', detail: 'cancelled: automation deactivated' }],
      'cancelled',
      null,
    )
    return
  }

  const run = newRunState()
  try {
    let parentStepId = pending.parent_step_id
    let branch = pending.branch
    let startPosition = pending.next_step_position
    const context = pending.context ?? {}
    for (;;) {
      await executeStepsFrom({
        automation: automation as Automation,
        contactId: pending.contact_id,
        context,
        parentStepId,
        branch,
        startPosition,
        logId: pending.log_id,
        triggerEvent: 'resumed_wait',
        depth: context.chain_depth ?? 0,
        run,
      })
      if (run.parked || run.failed || parentStepId === null) break
      // The branch finished: carry on after its condition, one scope up.
      const { data: parent } = await db
        .from('automation_steps')
        .select('id, parent_step_id, branch, position')
        .eq('id', parentStepId)
        .eq('automation_id', (automation as Automation).id)
        .maybeSingle()
      const p = parent as
        | { parent_step_id: string | null; branch: 'yes' | 'no' | null; position: number }
        | null
      if (!p) break
      parentStepId = p.parent_step_id ?? null
      branch = p.branch ?? null
      startPosition = p.position + 1
    }
    await finalizeRun(pending.log_id, run, { append: true })
    await markPending(pending.id, run.failed ? 'failed' : 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

/**
 * The customer wrote: cancel every parked wait on this conversation
 * that was set to "cancel if the customer replies" (migration 048).
 * Rows already picked up by the cron (`running`) are left alone.
 * Returns how many were cancelled. Never throws.
 */
export async function cancelWaitsOnCustomerReply(conversationId: string): Promise<number> {
  try {
    const db = supabaseAdmin()
    const { data, error } = await db
      .from('automation_pending_executions')
      .update({ status: 'cancelled' })
      .eq('conversation_id', conversationId)
      .eq('cancel_on_reply', true)
      .eq('status', 'pending')
      .select('id, log_id')
    if (error) {
      console.error('[automations] cancel waits failed:', error)
      return 0
    }
    const rows = (data ?? []) as { id: string; log_id: string | null }[]
    for (const row of rows) {
      await appendToLog(
        row.log_id,
        [{ step_id: '', step_type: 'wait', status: 'skipped', detail: 'cancelled: customer replied' }],
        'cancelled',
        null,
      )
    }
    return rows.length
  } catch (err) {
    console.error('[automations] cancel waits failed:', err)
    return 0
  }
}

// ------------------------------------------------------------
// Dry run — "test with a contact"
// ------------------------------------------------------------

export interface SimulationResult {
  /** Whether a real event would run it now, and if not, why. */
  gate: { wouldRun: boolean; reason?: string }
  steps: AutomationLogStepResult[]
  /** The status the run would end with. */
  status: AutomationLogStatus
}

/**
 * Walk the automation for one contact without side effects: conditions
 * are evaluated for real (read-only), actions are described instead of
 * performed, waits are noted and skipped over, no log is written and no
 * frequency guard is claimed.
 */
export async function simulateAutomation(args: {
  automation: Automation
  contactId: string
  context?: AutomationContext
}): Promise<SimulationResult> {
  const context = args.context ?? {}
  // Same tenant guard as dispatch: conditions read contact rows with the
  // service client, so a foreign contact id must not get this far.
  const { data: owned } = await supabaseAdmin()
    .from('contacts')
    .select('id')
    .eq('id', args.contactId)
    .eq('account_id', args.automation.account_id)
    .maybeSingle()
  if (!owned) throw new Error('contact not found in this account')
  const gate = await peekRunGate(args.automation, args.contactId, context)
  const run = newRunState()
  await executeStepsFrom({
    automation: args.automation,
    contactId: args.contactId,
    context,
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: null,
    triggerEvent: 'dry_run',
    depth: 0,
    run,
    dryRun: true,
  })
  return { gate, steps: run.results, status: finalStatus(run) }
}

async function peekRunGate(
  automation: Automation,
  contactId: string,
  ctx: AutomationContext,
): Promise<SimulationResult['gate']> {
  if (!triggerMatches(automation, ctx)) {
    return { wouldRun: false, reason: 'o gatilho não corresponde ao exemplo informado' }
  }
  const scope = await resolveRunScope(automation, contactId, ctx)
  if (!scope) return { wouldRun: true }
  const { data } = await supabaseAdmin()
    .from('automation_run_guards')
    .select('last_run_at')
    .eq('automation_id', automation.id)
    .eq('contact_id', contactId)
    .eq('scope_key', scope.key)
    .maybeSingle()
  const last = (data as { last_run_at?: string } | null)?.last_run_at
  if (!last) return { wouldRun: true }
  if (scope.cooldownHours != null) {
    const ready = Date.now() - new Date(last).getTime() >= scope.cooldownHours * 3_600_000
    return ready ? { wouldRun: true } : { wouldRun: false, reason: scopeSkipReason(scope) }
  }
  return { wouldRun: false, reason: scopeSkipReason(scope) }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

interface RunState {
  results: AutomationLogStepResult[]
  /** Steps that did something (anything but a condition). */
  actions: number
  /** Stopped at a wait step. */
  parked: boolean
  failed: boolean
  error: string | null
  /** Lazily loaded account preferences (timezone, business hours). */
  prefs?: Promise<AccountPreferences>
}

function newRunState(): RunState {
  return { results: [], actions: 0, parked: false, failed: false, error: null }
}

function finalStatus(run: RunState): AutomationLogStatus {
  if (run.failed) return 'failed'
  if (run.parked) return 'waiting'
  if (run.actions === 0) return 'no_action'
  return 'success'
}

async function executeAutomation(automation: Automation, input: DispatchInput, scope: RunScope | null) {
  const db = supabaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      status: 'success',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    await releaseClaim(automation, input.contactId ?? null, scope)
    return
  }

  const depth = input.origin?.depth ?? 0
  const run = newRunState()
  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: { ...(input.context ?? {}), chain_depth: depth },
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
    depth,
    run,
  })
  await finalizeRun(log.id, run, { append: false })

  // Nothing happened (conditions not met, or it failed before acting):
  // give the "once" claim back so the next event can try again. Once any
  // action ran (a message may already be out) the claim stays, even if a
  // later step failed — a retry would send the welcome twice.
  if (run.actions === 0 && !run.parked) {
    await releaseClaim(automation, input.contactId ?? null, scope)
  }

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
  /** Chain depth of this run; events its actions raise are depth + 1. */
  depth: number
  run: RunState
  /** Describe actions instead of performing them. */
  dryRun?: boolean
  /**
   * Lazily resolved "contact has opted out" flag (migration 030), shared
   * by every scope of one run so the contact row is read at most once.
   */
  optedOut?: Promise<boolean>
}

const SEND_STEP_TYPES = new Set<AutomationStepType>(['send_message', 'send_template'])

/** send_webhook gives up after this long. */
const WEBHOOK_TIMEOUT_MS = 10_000

const WAIT_UNIT_PT: Record<string, string> = { minutes: 'minuto(s)', hours: 'hora(s)', days: 'dia(s)' }

/** pt-BR on purpose: it is shown verbatim in the automation log table. */
const OPTED_OUT_SKIP_DETAIL = 'contato descadastrado'

/**
 * Whether the run's contact asked to stop receiving messages. The
 * inbound pipeline pre-flags the very message that opted out through
 * `context.vars.opted_out`; every other run reads `contacts.opted_out_at`
 * once. A contact-less run cannot send anyway, so it reads as not opted out.
 */
function contactOptedOut(args: ExecuteArgs): Promise<boolean> {
  if (args.optedOut) return args.optedOut
  if (args.context.vars?.opted_out === true) {
    args.optedOut = Promise.resolve(true)
    return args.optedOut
  }
  args.optedOut = (async () => {
    if (!args.contactId) return false
    const { data, error } = await supabaseAdmin()
      .from('contacts')
      .select('opted_out_at')
      .eq('id', args.contactId)
      .eq('account_id', args.automation.account_id)
      .maybeSingle()
    if (error) {
      console.error('[automations] opt-out check failed:', error)
      return false
    }
    return !!(data as { opted_out_at?: string | null } | null)?.opted_out_at
  })()
  return args.optedOut
}

/**
 * Run the steps of one scope (root, or one branch of a condition) from
 * `startPosition`. Results accumulate on `args.run`; a wait parks the
 * whole run and a failure stops it — in either case the enclosing
 * scopes stop too.
 */
async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin()
  const { run } = args

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    run.failed = true
    run.error = stepsErr.message
    return
  }

  for (const step of (steps ?? []) as AutomationStep[]) {
    if (run.parked || run.failed) return

    // `wait` is the suspension point: enqueue and stop the whole run.
    // The cron endpoint picks it up later. A dry run notes it and walks on.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      if (ms === null) {
        run.results.push({ step_id: step.id, step_type: 'wait', status: 'failed', detail: 'invalid wait amount' })
        run.failed = true
        run.error = 'invalid wait amount'
        return
      }
      if (args.dryRun) {
        const cancel = cfg.cancel_on_reply ? ' (cancela se o cliente responder)' : ''
        run.results.push({
          step_id: step.id,
          step_type: 'wait',
          status: 'success',
          detail: `aguardaria ${cfg.amount} ${WAIT_UNIT_PT[cfg.unit] ?? cfg.unit}${cancel}`,
        })
        continue
      }
      let conversationId: string | null = args.context.conversation_id ?? null
      if (!conversationId && args.contactId) {
        try {
          conversationId = await resolveConversationId(args)
        } catch {
          conversationId = null
        }
      }
      const { error: parkErr } = await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: { ...args.context, chain_depth: args.depth },
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
        conversation_id: conversationId,
        cancel_on_reply: !!cfg.cancel_on_reply && !!conversationId,
      })
      if (parkErr) {
        run.results.push({ step_id: step.id, step_type: 'wait', status: 'failed', detail: parkErr.message })
        run.failed = true
        run.error = parkErr.message
        return
      }
      // English + machine-readable: the logs page parses "waiting N unit".
      run.results.push({
        step_id: step.id,
        step_type: 'wait',
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}${cfg.cancel_on_reply ? '; cancel on reply' : ''}`,
      })
      run.parked = true
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        run.results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
        })
        continue
      }

      // Opt-out (spec §5): never message a contact who asked to stop.
      // The step is recorded as skipped, not failed, and the run goes on
      // (tags, tasks, deals still apply).
      if (SEND_STEP_TYPES.has(step.step_type) && (await contactOptedOut(args))) {
        run.results.push({
          step_id: step.id,
          step_type: step.step_type,
          status: 'skipped',
          detail: OPTED_OUT_SKIP_DETAIL,
        })
        continue
      }

      const detail = args.dryRun ? await describeStep(step, args) : await runStep(step, args)
      run.results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
      run.actions += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      run.results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      run.failed = true
      run.error = msg
      return
    }
  }
}

/** Dry-run description of what a step would do (pt-BR, shown verbatim). */
async function describeStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const cfg = step.step_config as Record<string, unknown>
  switch (step.step_type) {
    case 'send_message':
      return `enviaria: "${await interpolate(String(cfg.text ?? ''), args)}"`
    case 'send_template':
      return `enviaria o modelo "${String(cfg.template_name ?? '')}"`
    case 'add_tag':
      return `adicionaria a etiqueta "${await tagName(args, cfg.tag_id)}"`
    case 'remove_tag':
      return `removeria a etiqueta "${await tagName(args, cfg.tag_id)}"`
    case 'assign_conversation':
      return cfg.mode === 'round_robin'
        ? 'atribuiria a conversa pelo rodízio'
        : 'atribuiria a conversa ao atendente escolhido'
    case 'update_contact_field':
      return `atualizaria o campo "${String(cfg.field ?? '')}"`
    case 'create_deal':
      return `criaria o negócio "${await interpolate(String(cfg.title ?? ''), args)}"`
    case 'send_webhook':
      return `chamaria o webhook ${String(cfg.url ?? '')}`
    case 'close_conversation':
      return 'resolveria a conversa'
    case 'create_task':
      return `criaria a tarefa "${await interpolate(String(cfg.title ?? ''), args)}"`
    default:
      return `executaria ${step.step_type}`
  }
}

async function tagName(args: ExecuteArgs, tagId: unknown): Promise<string> {
  if (typeof tagId !== 'string' || !tagId) return '?'
  const { data } = await supabaseAdmin()
    .from('tags')
    .select('name')
    .eq('id', tagId)
    .eq('account_id', args.automation.account_id)
    .maybeSingle()
  return (data as { name?: string } | null)?.name ?? tagId
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = await interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      // contact_tags has no account_id column; cross-tenant protection for
      // the attacker-supplied contactId comes from the ownership guard in
      // runAutomationsForTrigger.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      // Through the RPC (migration 048) so the tag_added event this
      // raises is one level deeper than this run — loop protection.
      const { error: tagErr } = await db.rpc('automation_add_tag', {
        p_contact_id: args.contactId,
        p_tag_id: cfg.tag_id,
        p_depth: args.depth + 1,
        p_origin: args.automation.id,
      })
      if (tagErr) throw new Error(`add_tag failed: ${tagErr.message}`)
      return `tag ${cfg.tag_id} added`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      const { error: rmErr } = await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      if (rmErr) throw new Error(`remove_tag failed: ${rmErr.message}`)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Real round-robin (spec round 2 §2): available agent+ members,
        // fewest open conversations first, oldest last_assigned_at on a
        // tie. Null when nobody is available — the conversation stays
        // unassigned and shows up in the Radar.
        agentId = (await pickRoundRobinAssignee(db, args.automation.account_id)) ?? undefined
      }
      if (!agentId) return 'no agent resolved'
      // RPC (migration 048): the conversation_assigned event it raises
      // inherits this run's depth — loop protection.
      const { data: assignedIds, error: assignErr } = await db.rpc('automation_update_conversations', {
        p_account_id: args.automation.account_id,
        p_contact_id: args.contactId,
        p_assigned_agent_id: agentId,
        p_status: null,
        p_depth: args.depth + 1,
        p_origin: args.automation.id,
      })
      if (assignErr) throw new Error(`assign_conversation failed: ${assignErr.message}`)
      for (const conversationId of rpcIds(assignedIds)) {
        await db.from('conversation_events').insert({
          account_id: args.automation.account_id,
          conversation_id: conversationId,
          actor_user_id: null,
          event_type: 'assigned',
          payload: { assignee_user_id: agentId, source: 'automation' },
        })
      }
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = await interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        const { error: cfErr } = await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        if (cfErr) throw new Error(`custom field update failed: ${cfErr.message}`)
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      const { error: fieldErr } = await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      if (fieldErr) throw new Error(`${cfg.field} update failed: ${fieldErr.message}`)
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      const { error: dealErr } = await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: await interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      if (dealErr) throw new Error(`create_deal failed: ${dealErr.message}`)
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      const body = cfg.body_template ? await interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      // A slow endpoint must not stall the automations queued behind it.
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      const { error: closeErr } = await db.rpc('automation_update_conversations', {
        p_account_id: args.automation.account_id,
        p_contact_id: args.contactId,
        p_assigned_agent_id: null,
        p_status: 'closed',
        p_depth: args.depth + 1,
        p_origin: args.automation.id,
      })
      if (closeErr) throw new Error(`close_conversation failed: ${closeErr.message}`)
      return 'conversation closed'
    }

    case 'create_task': {
      const cfg = step.step_config as CreateTaskStepConfig
      const accountId = args.automation.account_id
      if (!cfg.title || !cfg.title.trim()) throw new Error('create_task needs a title')
      // Plan gate for the Tasks module (migration 027 + plans.ts): the
      // automations module being on does not imply tasks is.
      if (!(await accountHasModule(db, accountId, 'tasks'))) {
        throw new Error('tasks module is not enabled for this account')
      }
      const statuses = await listTaskStatuses(db, accountId)
      if (statuses.length === 0) throw new Error('account has no task statuses')

      // Assignee must be a member of this account — the service-role
      // client would otherwise happily point the task at a stranger.
      let assigneeUserId: string | undefined
      if (cfg.assignee_user_id) {
        const { data: member } = await db
          .from('profiles')
          .select('user_id')
          .eq('user_id', cfg.assignee_user_id)
          .eq('account_id', accountId)
          .maybeSingle()
        assigneeUserId = (member as { user_id: string } | null)?.user_id ?? undefined
      }

      const priority: TaskPriority = isTaskPriority(cfg.priority) ? cfg.priority : 'normal'
      const hours = Number(cfg.due_in_hours)
      const dueAt =
        cfg.due_in_hours != null && Number.isFinite(hours) && hours > 0
          ? dueInHours(hours)
          : null

      // Link the conversation when the trigger had one (inbound message)
      // or the contact has exactly one; a contact-only trigger (tag added
      // to an imported contact) just leaves it empty.
      let conversationId: string | undefined = args.context.conversation_id
      if (!conversationId && args.contactId) {
        try {
          conversationId = await resolveConversationId(args)
        } catch {
          conversationId = undefined
        }
      }

      const title = await interpolate(cfg.title, args)
      const description = cfg.description ? await interpolate(cfg.description, args) : undefined
      const task = await createTask(
        db,
        // created_by stays null: the row was produced by the automation,
        // not by its author.
        { accountId, userId: null, statuses },
        {
          title,
          description,
          priority,
          assignee_user_id: assigneeUserId,
          contact_id: args.contactId ?? undefined,
          conversation_id: conversationId,
          due_at: dueAt ?? undefined,
        },
      )
      return `task created (${task.id})`
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}


/** SETOF uuid from PostgREST: a bare array of ids, or rows keyed by the function name. */
function rpcIds(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  return data
    .map((row) =>
      typeof row === 'string'
        ? row
        : row && typeof row === 'object'
          ? (Object.values(row as Record<string, unknown>)[0] as string | undefined)
          : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (!data?.id) throw new Error('no conversation for contact')
  return data.id as string
}

function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'lead_captured') {
    // Optional per-source filter (migration 029): an empty source_id
    // means "any source"; otherwise the webhook's context must name it.
    const wanted = (automation.trigger_config as LeadCapturedTriggerConfig | null)?.source_id
    if (!wanted) return true
    return ctx?.vars?.source_id === wanted
  }
  if (automation.trigger_type === 'conversation_inactive') {
    // The cron scan (src/lib/automations/inactivity.ts) evaluates each
    // automation's own hours / last_from / statuses and dispatches per
    // automation; the context names which one matched so a second
    // inactivity rule in the same account does not piggy-back.
    const wanted = ctx?.vars?.inactive_automation_id
    return !wanted || wanted === automation.id
  }
  if (automation.trigger_type === 'tag_added') {
    // The rule names one tag; the event carries the tag that was added.
    const wanted = (automation.trigger_config as TagTriggerConfig | null)?.tag_id
    return !!wanted && ctx?.tag_id === wanted
  }
  if (automation.trigger_type !== 'keyword_match') return true
  const cfg = automation.trigger_config as KeywordMatchTriggerConfig
  if (!cfg?.keywords || cfg.keywords.length === 0) return false
  const text = (ctx?.message_text ?? '').toString()
  if (!text) return false
  const haystack = cfg.case_sensitive ? text : text.toLowerCase()
  return cfg.keywords.some((raw) => {
    const k = cfg.case_sensitive ? raw : raw.toLowerCase()
    return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
  })
}

/** Account preferences (timezone, business hours), read once per run. */
function accountPrefs(args: ExecuteArgs): Promise<AccountPreferences> {
  if (!args.run.prefs) {
    args.run.prefs = (async () => {
      const { data } = await supabaseAdmin()
        .from('accounts')
        .select('preferences')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      return parseAccountPreferences((data as { preferences?: unknown } | null)?.preferences)
    })()
  }
  return args.run.prefs
}

async function contactHasTag(args: ExecuteArgs, tagId: string | undefined): Promise<boolean> {
  if (!args.contactId || !tagId) return false
  // contact_tags has no account_id column (its RLS keys off the parent
  // contact), so tenant scoping here relies on the contact-ownership
  // guard in runAutomationsForTrigger.
  const { count } = await supabaseAdmin()
    .from('contact_tags')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', args.contactId)
    .eq('tag_id', tagId)
  return (count ?? 0) > 0
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence':
      return contactHasTag(args, cfg.operand)
    case 'tag_absence':
      // No contact or no tag configured: nothing to be absent from — false,
      // so a half-configured rule never fires its "does not have" path.
      if (!args.contactId || !cfg.operand) return false
      return !(await contactHasTag(args, cfg.operand))
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00"). Evaluated on
      // the account's wall clock: the server runs in UTC or wherever the
      // VPS lives, never in the customer's timezone.
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const prefs = await accountPrefs(args)
      const mins = localClock(new Date(), prefs.business_hours.timezone).minutes
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    case 'business_hours':
      return isWithinBusinessHours(await accountPrefs(args), new Date())
    default:
      return false
  }
}

/** Wait length in ms, or null when the configured amount is not a positive number. */
function waitMs(cfg: WaitStepConfig): number | null {
  const amount = Number(cfg.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, amount * unitMs)
}

/** Contact columns exposed as `{{ contact.* }}` template variables. */
interface ContactVars {
  name: string | null
  phone: string | null
  email: string | null
  company: string | null
}

const CONTACT_VAR_KEYS = new Set<keyof ContactVars>(['name', 'phone', 'email', 'company'])

// One contact read per execution scope, and only for templates that
// actually reference `contact.*` — keeps the existing steps' query
// count untouched.
const contactVarsCache = new WeakMap<ExecuteArgs, Promise<ContactVars | null>>()

function loadContactVars(args: ExecuteArgs): Promise<ContactVars | null> {
  const cached = contactVarsCache.get(args)
  if (cached) return cached
  const promise = (async () => {
    if (!args.contactId) return null
    const { data } = await supabaseAdmin()
      .from('contacts')
      .select('name, phone, email, company')
      .eq('id', args.contactId)
      .eq('account_id', args.automation.account_id)
      .maybeSingle()
    return (data as ContactVars | null) ?? null
  })()
  contactVarsCache.set(args, promise)
  return promise
}

const TEMPLATE_VAR = /\{\{\s*([\w.]+)\s*\}\}/g

/**
 * Resolve `{{ message.text }}`, `{{ vars.* }}` and `{{ contact.name |
 * phone | email | company }}` in a step's text. Unknown variables
 * become empty strings.
 */
async function interpolate(s: string, args: ExecuteArgs): Promise<string> {
  const needsContact = /\{\{\s*contact\./.test(s)
  const contact = needsContact ? await loadContactVars(args) : null
  return s.replace(TEMPLATE_VAR, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    if (ns === 'contact' && prop && CONTACT_VAR_KEYS.has(prop as keyof ContactVars)) {
      return String(contact?.[prop as keyof ContactVars] ?? '')
    }
    return ''
  })
}


/** Write a run's results and final status to its log row. */
async function finalizeRun(logId: string | null, run: RunState, opts: { append: boolean }) {
  await appendToLog(logId, run.results, finalStatus(run), run.error, opts.append)
}

async function appendToLog(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: AutomationLogStatus,
  errorMessage: string | null,
  append = true,
) {
  if (!logId) return
  const db = supabaseAdmin()
  let merged = newItems
  if (append) {
    const { data: existing } = await db
      .from('automation_logs')
      .select('steps_executed')
      .eq('id', logId)
      .single()
    merged = [
      ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
      ...newItems,
    ]
  }
  const update: Record<string, unknown> = { steps_executed: merged, status }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed' | 'cancelled') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}
