// Verifica a assinatura de um webhook do SempreCRM. Sem dependências (só node:crypto).
//
//   import { verifySempreCrmSignature } from './verify-webhook.mjs'
//   const ok = verifySempreCrmSignature(rawBody, headers['semprecrm-signature'], [process.env.WHSEC])
//
// rawBody: string com os bytes EXATOS recebidos (não o JSON reencodado).
// secrets: o segredo atual (e o antigo, durante uma rotação).
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySempreCrmSignature(rawBody, header, secrets, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)) {
  let t = NaN
  const signatures = []
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') t = Number(v)
    else if (k === 'v1') signatures.push(v)
  }
  if (!Number.isInteger(t) || signatures.length === 0) return false
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false

  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
    return signatures.some((sig) => {
      const got = Buffer.from(sig, 'hex')
      return got.length === expected.length && timingSafeEqual(got, expected)
    })
  })
}
