import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Menus (send_buttons / send_list) on channels that cannot show real buttons — QR, Instagram,
// Messenger. The menu goes out as numbered text (renderInteractiveAsText) and the customer answers by
// typing the option number or its title. Drives the REAL dispatchInboundToFlows and the REAL flows
// senders; only the channel transports and the database are fakes.
// ------------------------------------------------------------

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  channel: 'instagram' as string,
  activeRuns: [] as Row[],
  nodes: [] as Row[],
  runUpdates: [] as Row[],
  messaging: [] as Record<string, unknown>[],
  qr: [] as Record<string, unknown>[],
}))

vi.mock('./admin-client', () => {
  const rows = (table: string): Row[] => {
    if (table === 'flow_runs') return h.activeRuns
    if (table === 'flows') return [{ id: 'flow-1', account_id: 'acct-1', user_id: 'u-1', status: 'active', fallback_policy: null, trigger_type: 'keyword', trigger_config: { keywords: ['x'] }, entry_node_id: 'start' }]
    if (table === 'flow_nodes') return h.nodes
    if (table === 'conversations') return [{ id: 'cv-1', channel: h.channel }]
    return []
  }
  const builder = (table: string) => {
    let isUpdate: Row | null = null
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      insert: () => b,
      update: (p: Row) => {
        isUpdate = p
        if (table === 'flow_runs') h.runUpdates.push(p)
        return b
      },
      maybeSingle: async () => ({ data: rows(table)[0] ?? null, error: null }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (f: (r: unknown) => unknown) => f({ data: isUpdate ? null : rows(table), error: null, count: 0 }),
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (t: string) => builder(t), rpc: async () => ({ error: null }) }) }
})
vi.mock('@/lib/plans-server', () => ({ accountHasModule: async () => true, accountIsWritable: async () => true }))
vi.mock('@/lib/meta-messaging/engine-send', () => ({
  engineSendMessaging: async (_db: unknown, args: Record<string, unknown>) => {
    h.messaging.push(args)
    return { whatsapp_message_id: 'mid.x' }
  },
}))
vi.mock('@/lib/whatsapp/qr-engine-send', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/qr-engine-send')>()),
  conversationChannel: async () => h.channel,
  engineSendViaQr: async (_db: unknown, args: Record<string, unknown>) => {
    h.qr.push(args)
    return { whatsapp_message_id: 'B-1' }
  },
}))

import { dispatchInboundToFlows, matchTextReply } from './engine'
import { engineSendInteractiveButtons, engineSendInteractiveList } from './meta-send'

const BASE = { accountId: 'acct-1', userId: 'u-1', conversationId: 'cv-1', contactId: 'ct-1' }

const BUTTONS_NODE = {
  node_key: 'menu',
  node_type: 'send_buttons',
  config: {
    text: 'Como podemos ajudar?',
    footer_text: 'Digite o número',
    buttons: [
      { reply_id: 'b1', title: 'Vendas', next_node_key: 'sales' },
      { reply_id: 'b2', title: 'Suporte técnico', next_node_key: 'support' },
      { reply_id: 'b3', title: 'Opção Ação', next_node_key: 'action' },
    ],
  },
}
const LIST_NODE = {
  node_key: 'menu',
  node_type: 'send_list',
  config: {
    text: 'Menu',
    button_label: 'Ver',
    sections: [
      { title: 'A', rows: [{ reply_id: 'r1', title: 'Corte', next_node_key: 'cut' }, { reply_id: 'r2', title: 'Barba', next_node_key: 'beard' }] },
      { title: 'B', rows: [{ reply_id: 'r3', title: 'Coloração', next_node_key: 'color' }] },
    ],
  },
}
const say = (key: string, text: string) => ({ flow_id: 'flow-1', node_key: key, node_type: 'send_message', config: { text, next_node_key: 'end' } })
const BRANCHES = [
  say('sales', 'Fala com vendas'), say('support', 'Fala com suporte'), say('action', 'Ação!'),
  say('cut', 'Corte marcado'), say('beard', 'Barba marcada'), say('color', 'Coloração marcada'),
  { flow_id: 'flow-1', node_key: 'end', node_type: 'end', config: {} },
]

function useMenu(menu: Row) {
  h.nodes = [{ flow_id: 'flow-1', ...menu }, ...BRANCHES]
  h.activeRuns = [{ id: 'run-1', flow_id: 'flow-1', account_id: 'acct-1', user_id: 'u-1', contact_id: 'ct-1', conversation_id: 'cv-1', status: 'active', current_node_key: 'menu', vars: {}, reprompt_count: 0 }]
}
const reply = (text: string) =>
  dispatchInboundToFlows({ ...BASE, message: { kind: 'text', text, meta_message_id: 'm1' }, isFirstInboundMessage: false })
/** What the flow sent next, whichever transport carried it. */
const sentTexts = () => [...h.messaging, ...h.qr].map((a) => (a.content as { text?: string } | undefined)?.text ?? (a as { text?: string }).text)

beforeEach(() => {
  h.channel = 'instagram'
  h.messaging = []
  h.qr = []
  h.runUpdates = []
})

describe('matchTextReply', () => {
  const node = { node_type: BUTTONS_NODE.node_type, config: BUTTONS_NODE.config as unknown as Record<string, unknown> }
  it('matches the option number as rendered ("1", "2.", " 3 ", "1)")', () => {
    expect(matchTextReply(node, '1')).toBe('sales')
    expect(matchTextReply(node, '2.')).toBe('support')
    expect(matchTextReply(node, ' 3 ')).toBe('action')
    expect(matchTextReply(node, '1)')).toBe('sales')
  })
  it('matches the title, trimmed, case- and accent-insensitive, exact', () => {
    expect(matchTextReply(node, '  vendas ')).toBe('sales')
    expect(matchTextReply(node, 'SUPORTE TECNICO')).toBe('support')
    expect(matchTextReply(node, 'opcao acao')).toBe('action')
    expect(matchTextReply(node, 'suporte')).toBeNull() // not exact
    expect(matchTextReply(node, 'quero vendas')).toBeNull()
  })
  it('no match: out-of-range numbers, empty text, other node types', () => {
    expect(matchTextReply(node, '4')).toBeNull()
    expect(matchTextReply(node, '0')).toBeNull()
    expect(matchTextReply(node, '1 2')).toBeNull()
    expect(matchTextReply(node, '   ')).toBeNull()
    expect(matchTextReply({ node_type: 'collect_input', config: {} }, '1')).toBeNull()
  })
  it('list rows are numbered across the sections, in order', () => {
    const list = { node_type: 'send_list', config: LIST_NODE.config as unknown as Record<string, unknown> }
    expect(matchTextReply(list, '1')).toBe('cut')
    expect(matchTextReply(list, '2')).toBe('beard')
    expect(matchTextReply(list, '3')).toBe('color')
    expect(matchTextReply(list, 'coloracao')).toBe('color')
  })
})

describe.each([['instagram'], ['messenger'], ['qr']])('a buttons menu answered by typing on %s', (channel) => {
  beforeEach(() => {
    h.channel = channel
    useMenu(BUTTONS_NODE)
  })

  it('the menu is sent as numbered text, and the number advances the flow', async () => {
    await engineSendInteractiveButtons({
      ...BASE,
      bodyText: BUTTONS_NODE.config.text,
      buttons: BUTTONS_NODE.config.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
      footerText: BUTTONS_NODE.config.footer_text,
    })
    expect(sentTexts()[0]).toBe('Como podemos ajudar?\n\n1. Vendas\n2. Suporte técnico\n3. Opção Ação\n\n_Digite o número_')
    h.messaging = []
    h.qr = []

    const res = await reply('2')
    expect(res).toMatchObject({ consumed: true })
    expect(sentTexts()).toContain('Fala com suporte')
  })

  it('the title (any case / accents) advances it too', async () => {
    await reply('opcao acao')
    expect(sentTexts()).toContain('Ação!')
  })

  it('an answer that matches nothing does not advance (the fallback policy applies)', async () => {
    await reply('talvez')
    expect(sentTexts()).not.toContain('Fala com vendas')
    expect(sentTexts()).not.toContain('Fala com suporte')
    expect(sentTexts()).not.toContain('Ação!')
  })
})

describe.each([['instagram'], ['qr']])('a list menu answered by typing on %s', (channel) => {
  beforeEach(() => {
    h.channel = channel
    useMenu(LIST_NODE)
  })

  it('the list is numbered across sections; the number or the title picks the row', async () => {
    await engineSendInteractiveList({
      ...BASE,
      bodyText: 'Menu',
      buttonLabel: 'Ver',
      sections: LIST_NODE.config.sections.map((s) => ({ title: s.title, rows: s.rows.map((r) => ({ id: r.reply_id, title: r.title })) })),
    })
    expect(sentTexts()[0]).toBe('Menu\n\n1. Corte\n2. Barba\n3. Coloração')
    h.messaging = []
    h.qr = []
    await reply('3')
    expect(sentTexts()).toContain('Coloração marcada')

    h.messaging = []
    h.qr = []
    await reply('Barba')
    expect(sentTexts()).toContain('Barba marcada')
  })

  it('a non-matching text does not pick anything', async () => {
    await reply('9')
    expect(sentTexts().filter((t) => /marcad/.test(String(t)))).toEqual([])
  })
})
