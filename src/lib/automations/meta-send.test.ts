import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Automation template sends persist the substituted body (wacrm #483).
// Before, content_text was unconditionally null, so every automation
// template send rendered as an empty inbox bubble.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  templates: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  sendTemplateMessage: vi.fn<(...a: unknown[]) => Promise<{ messageId: string }>>(async () => ({
    messageId: 'wamid.TPL',
  })),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.TXT' })),
  sendTemplateMessage: (...a: unknown[]) => h.sendTemplateMessage(...a),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))
vi.mock('./qr-pacing', () => ({ paceAutomatedQrSend: vi.fn(async () => {}) }))
vi.mock('@/lib/whatsapp/qr-engine-send', () => ({
  conversationChannel: vi.fn(async () => 'official'),
  engineSendViaQr: vi.fn(),
  loadTemplateBody: vi.fn(),
  renderTemplateBody: vi.fn(),
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      let op: 'select' | 'insert' | 'update' = 'select'
      let row: Record<string, unknown> = {}
      const resolve = () => {
        if (op === 'insert') {
          h.inserts.push({ table, row })
          return { data: null, error: null }
        }
        if (op === 'update') {
          h.updates.push({ table, row })
          return { data: null, error: null }
        }
        if (table === 'contacts') return { data: { id: 'c-1', phone: '5511999990000' }, error: null }
        if (table === 'whatsapp_config')
          return { data: { phone_number_id: 'pn-1', access_token: 'enc' }, error: null }
        if (table === 'message_templates') return { data: h.templates, error: null }
        return { data: null, error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        insert: (r: Record<string, unknown>) => ((op = 'insert'), (row = r), b),
        update: (r: Record<string, unknown>) => ((op = 'update'), (row = r), b),
        maybeSingle: async () => resolve(),
        single: async () => resolve(),
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(f, r),
      }
      return b
    },
  }),
}))

import { engineSendTemplate } from './meta-send'

const ARGS = {
  accountId: 'acct-1',
  userId: 'u-1',
  conversationId: 'conv-1',
  contactId: 'c-1',
  templateName: 'boas_vindas',
  language: 'pt_BR',
  params: ['Maria'],
}

beforeEach(() => {
  h.templates = []
  h.inserts = []
  h.updates = []
  h.sendTemplateMessage.mockClear()
})

describe('engineSendTemplate — body persistence (wacrm #483)', () => {
  it('stores the rendered body and uses it as the conversation preview', async () => {
    h.templates = [
      {
        id: 't-1',
        user_id: 'u-1',
        name: 'boas_vindas',
        language: 'pt_BR',
        body_text: 'Oi {{1}}, bem-vinda!',
      },
    ]
    await engineSendTemplate(ARGS)

    const msg = h.inserts.find((i) => i.table === 'messages')?.row
    expect(msg).toMatchObject({
      sender_type: 'bot',
      content_type: 'template',
      content_text: 'Oi Maria, bem-vinda!',
      template_name: 'boas_vindas',
      message_id: 'wamid.TPL',
    })
    expect(h.updates.find((u) => u.table === 'conversations')?.row).toMatchObject({
      last_message_text: 'Oi Maria, bem-vinda!',
    })
    // The Meta wire payload is unchanged on this path.
    expect(h.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'boas_vindas', language: 'pt_BR', params: ['Maria'] }),
    )
  })

  it('falls back to the template tag when the account has no local row', async () => {
    await engineSendTemplate(ARGS)
    expect(h.inserts.find((i) => i.table === 'messages')?.row).toMatchObject({ content_text: null })
    expect(h.updates.find((u) => u.table === 'conversations')?.row).toMatchObject({
      last_message_text: '[template:boas_vindas]',
    })
  })
})
