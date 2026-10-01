import { describe, expect, it } from 'vitest'

import { makeFakeDb } from './fake-db.test-helper'
import { canonicalSuppressionPhone, findSuppressedPhones, recordSuppression, suppressionHash } from './suppression'

const SECRET = 'b'.repeat(64)

describe('suppression list', () => {
  it('folds the Brazilian variants the dedupe treats as equal', () => {
    const forms = ['+55 11 91234-5678', '5511912345678', '551112345678', '11912345678', '(11) 1234-5678']
    expect(new Set(forms.map(canonicalSuppressionPhone))).toEqual(new Set(['551112345678']))
    expect(canonicalSuppressionPhone('+44 7811 000000')).toBe('447811000000')
    expect(canonicalSuppressionPhone('anon-deadbeef')).toBe('')
  })

  it('hashes per account with the server secret; never the phone itself', () => {
    const a = suppressionHash('acc-a', '5511912345678', SECRET)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(suppressionHash('acc-a', '+55 (11) 1234-5678', SECRET))
    expect(a).not.toBe(suppressionHash('acc-b', '5511912345678', SECRET))
    expect(a).not.toBe(suppressionHash('acc-a', '5511912345678', 'c'.repeat(64)))
    expect(suppressionHash('acc-a', '', SECRET)).toBeNull()
    expect(() => suppressionHash('acc-a', '5511912345678', 'short')).toThrow(/ENCRYPTION_KEY/)
  })

  it('records once and finds the number in any format, only in its account', async () => {
    const { db, tables } = makeFakeDb({})
    await recordSuppression(db, 'acc-a', '+55 11 91234-5678', SECRET)
    await recordSuppression(db, 'acc-a', '5511912345678', SECRET)
    expect(tables.contact_suppressions).toHaveLength(1)
    expect(JSON.stringify(tables)).not.toMatch(/12345678/)
    const found = await findSuppressedPhones(db, 'acc-a', ['11912345678', '5511900000000'], SECRET)
    expect([...found]).toEqual(['11912345678'])
    expect((await findSuppressedPhones(db, 'acc-b', ['11912345678'], SECRET)).size).toBe(0)
  })

  it('throws on a lookup failure so callers choose fail-open / fail-closed', async () => {
    const { db } = makeFakeDb({}, { fail: () => ({ message: 'down' }) })
    await expect(findSuppressedPhones(db, 'acc-a', ['11912345678'], SECRET)).rejects.toThrow(/down/)
  })
})
