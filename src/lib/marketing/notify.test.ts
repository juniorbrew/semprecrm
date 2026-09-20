import { describe, expect, it } from 'vitest'

import { buildContactNotification, contactNotifyRecipient } from './notify'

describe('contactNotifyRecipient', () => {
  it('prefers CONTACT_NOTIFY_TO, falls back to SMTP_USER, else null', () => {
    const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv
    expect(contactNotifyRecipient(env({ CONTACT_NOTIFY_TO: 'contato@x.br', SMTP_USER: 'no-reply@x.br' }))).toBe('contato@x.br')
    expect(contactNotifyRecipient(env({ SMTP_USER: 'no-reply@x.br' }))).toBe('no-reply@x.br')
    expect(contactNotifyRecipient(env({ CONTACT_NOTIFY_TO: '  ' }))).toBeNull()
  })
})

describe('buildContactNotification', () => {
  const data = { name: 'Ana <b>', email: 'ana@ex.com', phone: '11912345678', company: null, message: 'Olá\n<script>x</script>' }

  it('addresses the owner, replies to the visitor, escapes HTML', () => {
    const m = buildContactNotification('contato@x.br', data)
    expect(m.to).toBe('contato@x.br')
    expect(m.replyTo).toBe('Ana <b> <ana@ex.com>')
    expect(m.subject).toBe('Novo contato pelo site: Ana <b>')
    expect(m.html).toContain('Ana &lt;b&gt;')
    expect(m.html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(m.html).not.toContain('<script>')
    expect(m.text).toContain('Empresa: —')
    expect(m.text).toContain('WhatsApp/telefone: (11) 91234-5678 — https://wa.me/5511912345678')
    expect(m.html).toContain('href="https://wa.me/5511912345678"')
    expect(m.text).toContain('Olá\n<script>x</script>')
  })
})
