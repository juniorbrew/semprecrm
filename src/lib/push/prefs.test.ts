import { describe, expect, it } from 'vitest'

import { FOCUS_TTL_MS, _resetFocusForTests, isFocusedOn, setConversationFocus } from './focus'
import { DEFAULT_NOTIFICATION_PREFS, parseNotificationPrefs, prefAllows } from './prefs'

describe('parseNotificationPrefs', () => {
  it('defaults every kind to on', () => {
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(parseNotificationPrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(parseNotificationPrefs('junk')).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(parseNotificationPrefs([1])).toEqual(DEFAULT_NOTIFICATION_PREFS)
  })

  it('honours explicit booleans and ignores anything else', () => {
    const p = parseNotificationPrefs({ task_due: false, inbound_message: 'no', extra: true })
    expect(p.task_due).toBe(false)
    expect(p.inbound_message).toBe(true)
    expect(p.task_assigned).toBe(true)
    expect(prefAllows({ task_due: false }, 'task_due')).toBe(false)
    expect(prefAllows({ task_due: false }, 'conversation_assigned')).toBe(true)
  })
})

describe('conversation focus map', () => {
  it('remembers focus for the TTL and forgets it after', () => {
    _resetFocusForTests()
    const t0 = 1_000_000
    setConversationFocus('u1', 'c1', t0)
    expect(isFocusedOn('u1', 'c1', t0 + 1000)).toBe(true)
    expect(isFocusedOn('u1', 'c2', t0 + 1000)).toBe(false)
    expect(isFocusedOn('u2', 'c1', t0 + 1000)).toBe(false)
    expect(isFocusedOn('u1', 'c1', t0 + FOCUS_TTL_MS)).toBe(false)
  })

  it('null clears the focus and a new conversation replaces it', () => {
    _resetFocusForTests()
    setConversationFocus('u1', 'c1', 0)
    setConversationFocus('u1', 'c2', 10)
    expect(isFocusedOn('u1', 'c1', 20)).toBe(false)
    expect(isFocusedOn('u1', 'c2', 20)).toBe(true)
    setConversationFocus('u1', null, 30)
    expect(isFocusedOn('u1', 'c2', 40)).toBe(false)
  })
})
