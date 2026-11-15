import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { sameOrigin } from './route'

const req = (headers: Record<string, string>) => new NextRequest('http://semprecrm:3000/api/agendar/x/confirmar', { method: 'POST', headers })

describe('sameOrigin (behind the proxy nextUrl is the internal address)', () => {
  it('accepts the host the browser called, or a missing Origin', () => {
    expect(sameOrigin(req({ origin: 'http://localhost:3101', host: 'localhost:3101' }))).toBe(true)
    expect(sameOrigin(req({ origin: 'https://www.exemplo.com', host: 'semprecrm:3000', 'x-forwarded-host': 'www.exemplo.com' }))).toBe(true)
    expect(sameOrigin(req({ host: 'localhost:3101' }))).toBe(true)
    expect(sameOrigin(req({ origin: 'http://localhost:3101', host: 'localhost' }))).toBe(true)
  })
  it('refuses another site', () => {
    expect(sameOrigin(req({ origin: 'https://evil.example', host: 'localhost:3101' }))).toBe(false)
    expect(sameOrigin(req({ origin: 'null', host: 'localhost:3101' }))).toBe(false)
  })
})
