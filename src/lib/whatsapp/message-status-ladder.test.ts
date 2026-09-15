import { describe, expect, it } from 'vitest'

import { isForwardStatusMove, statusesBefore } from './message-status-ladder'

describe('message status ladder (sending → sent → delivered → read)', () => {
  it('lists only the statuses below the incoming one', () => {
    expect(statusesBefore('sent')).toEqual(['sending'])
    expect(statusesBefore('delivered')).toEqual(['sending', 'sent'])
    expect(statusesBefore('read')).toEqual(['sending', 'sent', 'delivered'])
  })

  it('failed is only reachable from sending/sent', () => {
    expect(statusesBefore('failed')).toEqual(['sending', 'sent'])
    expect(isForwardStatusMove('delivered', 'failed')).toBe(false)
    expect(isForwardStatusMove('read', 'failed')).toBe(false)
    expect(isForwardStatusMove('sent', 'failed')).toBe(true)
  })

  it('never moves backwards or sideways', () => {
    // the real-world QR case: "sent" (sender receipt) arriving after "delivered"
    expect(isForwardStatusMove('delivered', 'sent')).toBe(false)
    expect(isForwardStatusMove('read', 'delivered')).toBe(false)
    expect(isForwardStatusMove('sent', 'sent')).toBe(false)
    expect(isForwardStatusMove('failed', 'delivered')).toBe(false)
  })

  it('moves forward', () => {
    expect(isForwardStatusMove('sent', 'delivered')).toBe(true)
    expect(isForwardStatusMove('sent', 'read')).toBe(true)
    expect(isForwardStatusMove('delivered', 'read')).toBe(true)
    expect(isForwardStatusMove(null, 'read')).toBe(true)
  })
})
