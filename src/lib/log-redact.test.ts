import { describe, expect, it } from 'vitest'

import { maskPhone, redactPhones } from './log-redact'

describe('log redaction', () => {
  it('keeps only the last 4 digits of a phone', () => {
    expect(maskPhone('+55 11 91234-5678')).toBe('***5678')
    expect(maskPhone('12')).toBe('***')
    expect(maskPhone(null)).toBe('***')
  })

  it('masks phone-like runs inside Meta error details, leaves short numbers alone', () => {
    expect(redactPhones('Recipient +55 (11) 91234-5678 is not a valid WhatsApp user, code 131026')).toBe(
      'Recipient ***5678 is not a valid WhatsApp user, code 131026',
    )
    expect(redactPhones('wa_id 5511912345678 failed')).toBe('wa_id ***5678 failed')
  })
})
