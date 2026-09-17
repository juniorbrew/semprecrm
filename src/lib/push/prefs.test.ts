import { describe, expect, it } from 'vitest'

import {
  FOCUS_TTL_MS,
  _resetFocusForTests,
  isFocusedOn,
  isFocusedOnChatThread,
  setChatThreadFocus,
  setConversationFocus,
} from './focus'
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
    expect(prefAllows({ chat_message: false }, 'chat_message')).toBe(false)
    expect(prefAllows({}, 'chat_message')).toBe(true)
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

  it('tracks internal chat thread focus separately from the inbox conversation', () => {
    _resetFocusForTests()
    setConversationFocus('u1', 'c1', 0)
    setChatThreadFocus('u1', 't1', 0)
    expect(isFocusedOn('u1', 'c1', 10)).toBe(true)
    expect(isFocusedOnChatThread('u1', 't1', 10)).toBe(true)
    expect(isFocusedOnChatThread('u1', 'c1', 10)).toBe(false)
    expect(isFocusedOnChatThread('u2', 't1', 10)).toBe(false)
    setChatThreadFocus('u1', null, 20)
    expect(isFocusedOnChatThread('u1', 't1', 30)).toBe(false)
    // Clearing the chat focus leaves the inbox focus alone.
    expect(isFocusedOn('u1', 'c1', 30)).toBe(true)
    setChatThreadFocus('u1', 't1', 100)
    expect(isFocusedOnChatThread('u1', 't1', 100 + FOCUS_TTL_MS)).toBe(false)
  })
})
