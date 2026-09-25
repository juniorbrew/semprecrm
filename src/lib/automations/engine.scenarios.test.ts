import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Scenario suite for the automation upgrade (migration 048): run
// frequency under bursts, loop protection, waits inside branches,
// cancel-on-reply, dry runs, timezone-aware conditions. The service
// client is an in-memory Postgres stand-in with the RPCs the engine
// calls, so each scenario reads like what happens in production.
// ------------------------------------------------------------

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  seq: 0,
}))

vi.mock('./admin-client', () => {
  const { db } = h
  const table = (name: string) => (db[name] ??= [])

  function builder(name: string) {
    const filters: ((r: Row) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: Row | Row[] | undefined
    let head = false
    let returning = false
    let orderKey: string | null = null
    let limitN: number | null = null

    const matched = () => table(name).filter((r) => filters.every((f) => f(r)))
    function run() {
      if (op === 'insert') {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
          id: `${name}-${++h.seq}`,
          created_at: new Date().toISOString(),
          ...(p as Row),
        }))
        table(name).push(...rows)
        return { data: Array.isArray(payload) ? rows : rows[0], error: null }
      }
      if (op === 'update') {
        const rows = matched()
        for (const r of rows) Object.assign(r, payload)
        return { data: returning ? rows : null, error: null }
      }
      if (op === 'delete') {
        const keep = table(name).filter((r) => !filters.every((f) => f(r)))
        db[name] = keep
        return { data: null, error: null }
      }
      let rows = matched()
      if (orderKey) rows = [...rows].sort((a, b) => Number(a[orderKey!]) - Number(b[orderKey!]))
      if (limitN !== null) rows = rows.slice(0, limitN)
      if (head) return { data: null, count: rows.length, error: null }
      return { data: rows, error: null }
    }
    const b: Record<string, unknown> = {
      select: (_c?: string, opts?: { head?: boolean }) => {
        if (op !== 'select') returning = true
        if (opts?.head) head = true
        return b
      },
      insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      delete: () => ((op = 'delete'), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
      gte: (k: string, v: unknown) =>
        (filters.push((r) => (typeof v === 'number' ? Number(r[k]) >= v : String(r[k]) >= String(v))), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      order: (k: string) => ((orderKey = k), b),
      limit: (n: number) => ((limitN = n), b),
      single: () => {
        const r = run()
        const data = Array.isArray(r.data) ? r.data[0] ?? null : r.data
        return Promise.resolve({ data, error: data ? null : { message: 'no rows' } })
      },
      maybeSingle: () => {
        const r = run()
        return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null })
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(onF, onR),
    }
    return b
  }

  function rpc(fn: string, args: Record<string, unknown>) {
    h.rpcCalls.push({ fn, args })
    if (fn === 'claim_automation_run') {
      const guards = table('automation_run_guards')
      const g = guards.find(
        (r) =>
          r.automation_id === args.p_automation_id &&
          r.contact_id === args.p_contact_id &&
          r.scope_key === args.p_scope_key,
      )
      const now = Date.now()
      if (!g) {
        guards.push({
          automation_id: args.p_automation_id,
          contact_id: args.p_contact_id,
          scope_key: args.p_scope_key,
          last_run_at: new Date(now).toISOString(),
        })
        return Promise.resolve({ data: true, error: null })
      }
      const cooldown = args.p_cooldown_hours as number | null
      if (cooldown != null && now - new Date(String(g.last_run_at)).getTime() >= cooldown * 3_600_000) {
        g.last_run_at = new Date(now).toISOString()
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: false, error: null })
    }
    if (fn === 'release_automation_run') {
      h.db.automation_run_guards = table('automation_run_guards').filter(
        (r) =>
          !(
            r.automation_id === args.p_automation_id &&
            r.contact_id === args.p_contact_id &&
            r.scope_key === args.p_scope_key
          ),
      )
      return Promise.resolve({ data: null, error: null })
    }
    if (fn === 'automation_add_tag') {
      const tags = table('contact_tags')
      if (!tags.some((r) => r.contact_id === args.p_contact_id && r.tag_id === args.p_tag_id)) {
        tags.push({ id: `ct-${++h.seq}`, contact_id: args.p_contact_id, tag_id: args.p_tag_id })
      }
      return Promise.resolve({ data: null, error: null })
    }
    if (fn === 'automation_update_conversations') {
      const rows = table('conversations').filter(
        (r) => r.account_id === args.p_account_id && r.contact_id === args.p_contact_id,
      )
      for (const r of rows) {
        if (args.p_assigned_agent_id) r.assigned_agent_id = args.p_assigned_agent_id
        if (args.p_status) r.status = args.p_status
      }
      return Promise.resolve({ data: rows.map((r) => r.id), error: null })
    }
    return Promise.resolve({ data: null, error: null })
  }

  return { supabaseAdmin: () => ({ from: (t: string) => builder(t), rpc }) }
})

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'wamid' })),
}))

import {
  BURST_LIMIT,
  cancelWaitsOnCustomerReply,
  resumePendingExecution,
  runAutomationsForTrigger,
  simulateAutomation,
  SKIP_REASONS,
} from './engine'
import { engineSendText } from './meta-send'
import type { Automation } from '@/types'

const ACCOUNT = 'acct-1'
const CONTACT = 'contact-1'
const CONV = 'conv-1'
const TAG = 'tag-welcomed'

function seed() {
  for (const k of Object.keys(h.db)) delete h.db[k]
  h.rpcCalls = []
  h.seq = 0
  h.db.accounts = [
    {
      id: ACCOUNT,
      plan: 'trial',
      plan_status: 'trial',
      plan_expires_at: null,
      module_overrides: {},
      limit_overrides: {},
      preferences: {
        business_hours: {
          timezone: 'America/Sao_Paulo',
          days: {
            mon: [{ start: '08:00', end: '18:00' }],
            tue: [{ start: '08:00', end: '18:00' }],
            wed: [{ start: '08:00', end: '18:00' }],
            thu: [{ start: '08:00', end: '18:00' }],
            fri: [{ start: '08:00', end: '18:00' }],
            sat: [],
            sun: [],
          },
        },
      },
    },
  ]
  h.db.contacts = [{ id: CONTACT, account_id: ACCOUNT, name: 'Maria', phone: '5511999990000' }]
  h.db.conversations = [
    { id: CONV, account_id: ACCOUNT, contact_id: CONTACT, status: 'open', service_count: 1 },
  ]
  h.db.tags = [{ id: TAG, account_id: ACCOUNT, name: 'Novo Contato' }]
}

function automation(over: Partial<Automation> = {}): Automation {
  const a = {
    id: 'auto-1',
    account_id: ACCOUNT,
    user_id: 'owner',
    name: 'Boas-vindas',
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
    run_frequency: 'every_time',
    cooldown_hours: null,
    execution_count: 0,
    created_at: '',
    updated_at: '',
    ...over,
  } as Automation
  ;(h.db.automations ??= []).push(a as unknown as Row)
  return a
}

let stepSeq = 0
function step(
  automationId: string,
  step_type: string,
  step_config: Row,
  position: number,
  parent: { id: string; branch: 'yes' | 'no' } | null = null,
): string {
  const id = `step-${++stepSeq}`
  ;(h.db.automation_steps ??= []).push({
    id,
    automation_id: automationId,
    step_type,
    step_config,
    position,
    parent_step_id: parent?.id ?? null,
    branch: parent?.branch ?? null,
  })
  return id
}

const message = (text = 'oi') =>
  runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType: 'new_message_received',
    contactId: CONTACT,
    context: { message_text: text, conversation_id: CONV },
  })

const logs = () => (h.db.automation_logs ?? []) as Row[]

beforeEach(() => {
  seed()
  vi.mocked(engineSendText).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('run frequency', () => {
  it('sends the welcome once when a customer bursts 5 messages at once', async () => {
    const a = automation({ run_frequency: 'once_per_contact' })
    step(a.id, 'send_message', { text: 'Olá, {{contact.name}}!' }, 0)

    await Promise.all([message('oi'), message('tudo bem?'), message('alô'), message('?'), message('!')])

    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(engineSendText).mock.calls[0][0]).toMatchObject({ text: 'Olá, Maria!' })
    const skipped = logs().filter((l) => l.status === 'skipped')
    expect(skipped).toHaveLength(4)
    expect(skipped[0].skip_reason).toBe(SKIP_REASONS.onceContact)
    expect(logs().filter((l) => l.status === 'success')).toHaveLength(1)
  })

  it('once per attendance runs again after the resolved conversation reopens', async () => {
    const a = automation({ run_frequency: 'once_per_attendance' })
    step(a.id, 'send_message', { text: 'Bem-vindo de volta' }, 0)

    await message()
    await message()
    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(logs().at(-1)?.skip_reason).toBe(SKIP_REASONS.onceAttendance)

    // Resolved, then the customer came back: the DB trigger bumps service_count.
    ;(h.db.conversations[0] as Row).service_count = 2
    await message()
    expect(engineSendText).toHaveBeenCalledTimes(2)
  })

  it('cooldown blocks until the interval has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const a = automation({ run_frequency: 'cooldown', cooldown_hours: 12 })
    step(a.id, 'send_message', { text: 'Estamos fora do horário' }, 0)

    await message()
    vi.setSystemTime(new Date('2026-09-25T20:00:00Z'))
    await message()
    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(String(logs().at(-1)?.skip_reason)).toContain('12 h')

    vi.setSystemTime(new Date('2026-09-26T00:30:00Z'))
    await message()
    expect(engineSendText).toHaveBeenCalledTimes(2)
  })

  it('a run that did nothing gives the "once" claim back', async () => {
    const a = automation({ run_frequency: 'once_per_contact' })
    const cond = step(a.id, 'condition', { subject: 'message_content', value: 'preço' }, 0)
    step(a.id, 'send_message', { text: 'Tabela de preços' }, 0, { id: cond, branch: 'yes' })

    await message('bom dia')
    expect(logs().at(-1)?.status).toBe('no_action')
    expect(engineSendText).not.toHaveBeenCalled()

    await message('qual o preço?')
    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(logs().at(-1)?.status).toBe('success')
  })

  it('every_time keeps today\'s behaviour and claims nothing', async () => {
    const a = automation()
    step(a.id, 'send_message', { text: 'eco' }, 0)
    await message()
    await message()
    expect(engineSendText).toHaveBeenCalledTimes(2)
    expect(h.rpcCalls.some((c) => c.fn === 'claim_automation_run')).toBe(false)
  })
})

describe('the welcome recipe (does NOT have tag → send + tag)', () => {
  it('greets once, then the tag keeps it quiet even on "every time"', async () => {
    const a = automation()
    const cond = step(a.id, 'condition', { subject: 'tag_absence', operand: TAG }, 0)
    step(a.id, 'send_message', { text: 'Olá!' }, 0, { id: cond, branch: 'yes' })
    step(a.id, 'add_tag', { tag_id: TAG }, 1, { id: cond, branch: 'yes' })

    await message()
    await message()
    await message()

    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(logs().map((l) => l.status)).toEqual(['success', 'no_action', 'no_action'])
    const tagRpc = h.rpcCalls.find((c) => c.fn === 'automation_add_tag')
    expect(tagRpc?.args).toMatchObject({ p_depth: 1, p_origin: a.id })
  })
})

describe('loop protection', () => {
  it('ignores an event its own action caused', async () => {
    const a = automation({ trigger_type: 'tag_added', trigger_config: { tag_id: TAG } })
    step(a.id, 'add_tag', { tag_id: TAG }, 0)
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: CONTACT,
      context: { tag_id: TAG },
      origin: { depth: 1, automationId: a.id },
    })
    expect(logs()).toHaveLength(1)
    expect(logs()[0]).toMatchObject({ status: 'skipped', skip_reason: SKIP_REASONS.selfTriggered })
  })

  it('cuts a chain of automations at depth 3', async () => {
    const a = automation({ id: 'auto-b', trigger_type: 'tag_added', trigger_config: { tag_id: TAG } })
    step(a.id, 'send_message', { text: 'x' }, 0)
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: CONTACT,
      context: { tag_id: TAG },
      origin: { depth: 3, automationId: 'auto-a' },
    })
    expect(engineSendText).not.toHaveBeenCalled()
    expect(logs()[0].skip_reason).toBe(SKIP_REASONS.chainTooDeep)
  })

  it('trips the circuit breaker when a contact ping-pongs with another bot', async () => {
    const a = automation()
    step(a.id, 'send_message', { text: 'Recebemos sua mensagem' }, 0)
    for (let i = 0; i < BURST_LIMIT + 3; i++) await message(`bot ${i}`)
    expect(engineSendText).toHaveBeenCalledTimes(BURST_LIMIT)
    expect(logs().at(-1)?.skip_reason).toBe(SKIP_REASONS.burst)
  })

  it('tag_added only fires for the tag the rule names', async () => {
    const a = automation({ trigger_type: 'tag_added', trigger_config: { tag_id: TAG } })
    step(a.id, 'send_message', { text: 'x' }, 0)
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: CONTACT,
      context: { tag_id: 'other-tag' },
    })
    expect(logs()).toHaveLength(0)
  })
})

describe('waits', () => {
  it('a wait inside a branch pauses the whole run and resumes after the condition', async () => {
    const a = automation()
    const cond = step(a.id, 'condition', { subject: 'message_content', value: 'oi' }, 0)
    step(a.id, 'wait', { amount: 1, unit: 'hours' }, 0, { id: cond, branch: 'yes' })
    step(a.id, 'send_message', { text: 'dentro do ramo' }, 1, { id: cond, branch: 'yes' })
    step(a.id, 'send_message', { text: 'depois da condição' }, 1)

    await message('oi')
    expect(engineSendText).not.toHaveBeenCalled()
    expect(logs()[0].status).toBe('waiting')

    const pending = h.db.automation_pending_executions[0] as Row
    await resumePendingExecution(pending as never)

    const texts = vi.mocked(engineSendText).mock.calls.map((c) => c[0].text)
    expect(texts).toEqual(['dentro do ramo', 'depois da condição'])
    expect(logs()[0].status).toBe('success')
    expect(pending.status).toBe('done')
  })

  it('a reply cancels a follow-up set to cancel on reply', async () => {
    const a = automation()
    step(a.id, 'wait', { amount: 1, unit: 'days', cancel_on_reply: true }, 0)
    step(a.id, 'send_message', { text: 'Ainda tem dúvidas?' }, 1)

    await message()
    const pending = h.db.automation_pending_executions[0] as Row
    expect(pending).toMatchObject({ conversation_id: CONV, cancel_on_reply: true, status: 'pending' })

    expect(await cancelWaitsOnCustomerReply(CONV)).toBe(1)
    expect(pending.status).toBe('cancelled')
    expect(logs()[0].status).toBe('cancelled')
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('a reply leaves plain waits alone', async () => {
    const a = automation()
    step(a.id, 'wait', { amount: 1, unit: 'days' }, 0)
    await message()
    expect(await cancelWaitsOnCustomerReply(CONV)).toBe(0)
    expect((h.db.automation_pending_executions[0] as Row).status).toBe('pending')
  })
})

describe('conditions on the account clock', () => {
  it('time_of_day uses the account timezone, not the server clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 12:00 UTC = 09:00 in São Paulo.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const a = automation()
    const cond = step(a.id, 'condition', { subject: 'time_of_day', operand: '08:00-10:00' }, 0)
    step(a.id, 'send_message', { text: 'bom dia' }, 0, { id: cond, branch: 'yes' })
    await message()
    expect(engineSendText).toHaveBeenCalledTimes(1)
  })

  it('business_hours reads the account schedule (Saturday = closed)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T14:00:00Z')) // Saturday 11:00 local
    const a = automation()
    const cond = step(a.id, 'condition', { subject: 'business_hours' }, 0)
    step(a.id, 'send_message', { text: 'fora do horário' }, 0, { id: cond, branch: 'no' })
    await message()
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('fora do horário')
  })
})

describe('failure handling', () => {
  it('keeps the "once" claim when a message already went out and a later step failed', async () => {
    const a = automation({ run_frequency: 'once_per_contact' })
    step(a.id, 'send_message', { text: 'Olá!' }, 0)
    step(a.id, 'create_task', { title: '' }, 1) // fails: title required

    await message()
    await message()

    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(logs().map((l) => l.status)).toEqual(['failed', 'skipped'])
  })

  it('fails a wait with an invalid amount instead of crashing the run', async () => {
    const a = automation({ run_frequency: 'once_per_contact' })
    step(a.id, 'wait', { amount: 'abc', unit: 'hours' }, 0)
    await message()
    expect(logs()[0]).toMatchObject({ status: 'failed', error_message: 'invalid wait amount' })
    // Nothing was done, so the claim went back.
    expect(h.db.automation_run_guards ?? []).toHaveLength(0)
  })

  it('a rule switched off while parked does not wake up and send', async () => {
    const a = automation()
    step(a.id, 'wait', { amount: 1, unit: 'hours' }, 0)
    step(a.id, 'send_message', { text: 'lembrete' }, 1)
    await message()
    ;(h.db.automations[0] as Row).is_active = false
    const pending = h.db.automation_pending_executions[0] as Row
    await resumePendingExecution(pending as never)
    expect(engineSendText).not.toHaveBeenCalled()
    expect(pending.status).toBe('cancelled')
    expect(logs()[0].status).toBe('cancelled')
  })
})

describe('dry run', () => {
  it('refuses a contact from another account', async () => {
    const a = automation()
    await expect(
      simulateAutomation({ automation: a, contactId: 'someone-else' }),
    ).rejects.toThrow(/not found/)
  })

  it('walks the path and describes actions without touching anything', async () => {
    const a = automation({ run_frequency: 'once_per_contact' })
    const cond = step(a.id, 'condition', { subject: 'tag_absence', operand: TAG }, 0)
    step(a.id, 'send_message', { text: 'Olá, {{contact.name}}' }, 0, { id: cond, branch: 'yes' })
    step(a.id, 'add_tag', { tag_id: TAG }, 1, { id: cond, branch: 'yes' })
    step(a.id, 'wait', { amount: 2, unit: 'hours' }, 1)

    const res = await simulateAutomation({ automation: a, contactId: CONTACT, context: { message_text: 'oi' } })

    expect(res.gate).toEqual({ wouldRun: true })
    expect(res.steps.map((s) => s.detail)).toEqual([
      'branch=yes',
      'enviaria: "Olá, Maria"',
      'adicionaria a etiqueta "Novo Contato"',
      'aguardaria 2 hora(s)',
    ])
    expect(engineSendText).not.toHaveBeenCalled()
    expect(h.rpcCalls).toHaveLength(0)
    expect(logs()).toHaveLength(0)
    expect(h.db.automation_pending_executions ?? []).toHaveLength(0)
  })

  it('reports that a real event would be skipped by the frequency guard', async () => {
    const a = automation({ run_frequency: 'once_per_contact' })
    step(a.id, 'send_message', { text: 'x' }, 0)
    await message()
    const res = await simulateAutomation({ automation: a, contactId: CONTACT })
    expect(res.gate).toEqual({ wouldRun: false, reason: SKIP_REASONS.onceContact })
  })
})
