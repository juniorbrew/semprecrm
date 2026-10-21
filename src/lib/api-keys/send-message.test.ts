import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { ApiSendError, MAX_TEXT_LENGTH, sendTextViaApi } from './send-message'

// Validation happens before any database access: a client that explodes proves it.
const db = new Proxy({}, { get: () => () => { throw new Error('db must not be touched') } }) as unknown as SupabaseClient

async function code(input: Parameters<typeof sendTextViaApi>[1]) {
  try {
    await sendTextViaApi(db, input)
  } catch (e) {
    if (e instanceof ApiSendError) return `${e.status}:${e.code}`
    throw e
  }
  return 'ok'
}

describe('sendTextViaApi validation', () => {
  it('rejects bad text', async () => {
    expect(await code({ accountId: 'a', to: '5511999990000', text: '' })).toBe('400:invalid_text')
    expect(await code({ accountId: 'a', to: '5511999990000', text: '   ' })).toBe('400:invalid_text')
    expect(await code({ accountId: 'a', to: '5511999990000', text: 5 })).toBe('400:invalid_text')
    expect(await code({ accountId: 'a', to: '5511999990000', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })).toBe('400:invalid_text')
  })

  it('rejects bad phones', async () => {
    expect(await code({ accountId: 'a', to: undefined, text: 'oi' })).toBe('400:invalid_phone')
    expect(await code({ accountId: 'a', to: '123', text: 'oi' })).toBe('400:invalid_phone')
    expect(await code({ accountId: 'a', to: 'abc', text: 'oi' })).toBe('400:invalid_phone')
  })

  it('rejects an unknown channel', async () => {
    expect(await code({ accountId: 'a', to: '5511999990000', text: 'oi', channel: 'sms' })).toBe('400:invalid_channel')
  })
})
