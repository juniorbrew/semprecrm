import { describe, expect, it } from 'vitest'

import { buildContactExport } from './export'
import { makeFakeDb } from './fake-db.test-helper'

const ACC = 'acc'
const contact = { id: 'c1', account_id: ACC, name: 'Maria' }

describe('buildContactExport — AI contact memory (064) and hand-overs (066)', () => {
  it('includes every memory fact and hand-over of the contact, scoped to the account', async () => {
    const { db } = makeFakeDb({
      contacts: [contact],
      ai_contact_memories: [
        { id: 'm1', account_id: ACC, contact_id: 'c1', fact: 'Prefere entrega à tarde', status: 'active' },
        { id: 'm2', account_id: ACC, contact_id: 'c1', fact: 'Trabalha com eventos', status: 'proposed' },
        { id: 'm3', account_id: 'other', contact_id: 'c1', fact: 'outra conta' },
      ],
      ai_handoffs: [{ id: 'h1', account_id: ACC, contact_id: 'c1', reason: 'Pediu atendente', last_customer_words: 'quero falar com alguém' }],
    })
    const out = await buildContactExport(db, ACC, 'c1', () => new Date('2026-09-29T00:00:00Z'))
    expect(out.ai_memories.map((m) => m.fact)).toEqual(['Prefere entrega à tarde', 'Trabalha com eventos'])
    expect(out.ai_handoffs).toEqual([
      { id: 'h1', account_id: ACC, contact_id: 'c1', reason: 'Pediu atendente', last_customer_words: 'quero falar com alguém' },
    ])
    expect(out.warnings).toEqual([])
  })
})

describe('buildContactExport — conversations', () => {
  it('includes messages and the activity log (transfer reasons included) under each conversation', async () => {
    const { db } = makeFakeDb({
      contacts: [contact],
      conversations: [{ id: 'conv1', account_id: ACC, contact_id: 'c1', subject: 'Boleto da Maria vencido', sentiment: 'negative' }],
      messages: [{ id: 'msg1', conversation_id: 'conv1', content_text: 'oi' }],
      conversation_events: [
        { id: 'e1', conversation_id: 'conv1', event_type: 'assigned', payload: { reason: 'boleto vencido' } },
        { id: 'e2', conversation_id: 'other', event_type: 'assigned', payload: {} },
      ],
    })
    const out = await buildContactExport(db, ACC, 'c1')
    expect(out.conversations[0]).toMatchObject({ id: 'conv1', subject: 'Boleto da Maria vencido', sentiment: 'negative' })
    expect(out.conversations[0].messages.map((m) => m.id)).toEqual(['msg1'])
    expect(out.conversations[0].events.map((e) => e.id)).toEqual(['e1'])
  })

  it('never truncates: pages past max_rows and chunks the conversation ids', async () => {
    const conversations = Array.from({ length: 300 }, (_, i) => ({ id: `conv${String(i).padStart(4, '0')}`, account_id: ACC, contact_id: 'c1' }))
    const messages = Array.from({ length: 2500 }, (_, i) => ({ id: `m${String(i).padStart(5, '0')}`, conversation_id: conversations[i % 300].id }))
    const { db, reads } = makeFakeDb({ contacts: [contact], conversations, messages })
    const out = await buildContactExport(db, ACC, 'c1')
    expect(out.conversations).toHaveLength(300)
    expect(out.conversations.reduce((n, c) => n + c.messages.length, 0)).toBe(2500)
    expect(out.manifest.messages).toEqual({ count: 2500, complete: true })
    expect(Math.max(...reads.flatMap((r) => r.inSizes))).toBeLessThanOrEqual(200)
  })

  it('flags a section that failed in the manifest instead of silently dropping it', async () => {
    const { db } = makeFakeDb(
      { contacts: [contact], conversations: [{ id: 'conv1', account_id: ACC, contact_id: 'c1' }] },
      { fail: (t) => (t === 'messages' ? { message: 'permission denied' } : null) },
    )
    const out = await buildContactExport(db, ACC, 'c1')
    expect(out.manifest.messages).toEqual({ count: 0, complete: false })
    expect(out.warnings).toEqual(['messages: permission denied'])
  })
})

describe('buildContactExport — newly covered sections', () => {
  it('exports deals, tasks (+ by conversation), comments, calendar, flows, leads, companies, csat', async () => {
    const { db } = makeFakeDb({
      contacts: [contact],
      conversations: [{ id: 'conv1', account_id: ACC, contact_id: 'c1' }],
      deals: [{ id: 'd1', account_id: ACC, contact_id: 'c1', title: 'Maria - site' }],
      tasks: [
        { id: 't1', account_id: ACC, contact_id: 'c1', title: 'Ligar' },
        { id: 't2', account_id: ACC, contact_id: null, conversation_id: 'conv1', title: 'Lembrar' },
      ],
      task_comments: [{ id: 'tc1', task_id: 't2', body: 'ela pediu desconto' }],
      calendar_events: [
        { id: 'ev1', account_id: ACC, contact_id: 'c1', title: 'Visita' },
        { id: 'ev2', account_id: ACC, contact_id: null, conversation_id: 'conv1', title: 'Retorno' },
      ],
      flow_runs: [{ id: 'fr1', account_id: ACC, contact_id: 'c1', vars: { cpf: '123' } }],
      lead_source_events: [{ id: 'l1', account_id: ACC, contact_id: 'c1', payload: { nome: 'Maria' } }],
      contact_companies: [{ company_id: 'co1', account_id: ACC, contact_id: 'c1', is_primary: true }],
      csat_responses: [{ id: 's1', account_id: ACC, contact_id: 'c1', score: 4, comment: 'Atendimento rápido' }],
    })
    const out = await buildContactExport(db, ACC, 'c1')
    expect(out.deals.map((d) => d.id)).toEqual(['d1'])
    expect(out.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(out.task_comments.map((c) => c.body)).toEqual(['ela pediu desconto'])
    expect(out.calendar_events.map((e) => e.id)).toEqual(['ev1', 'ev2'])
    expect(out.flow_runs[0].vars).toEqual({ cpf: '123' })
    expect(out.lead_events[0].payload).toEqual({ nome: 'Maria' })
    expect(out.companies).toEqual([{ id: 'co1', name: null, is_primary: true }])
    expect(out.csat).toMatchObject([{ score: 4, comment: 'Atendimento rápido' }])
    expect(out.manifest.tasks).toEqual({ count: 2, complete: true })
    expect(Object.values(out.manifest).every((m) => m.complete)).toBe(true)
    expect(out.warnings).toEqual([])
  })
})
