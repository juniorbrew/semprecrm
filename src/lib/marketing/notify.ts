// ============================================================
// Owner notification for a /contato submission. Pure: builds the
// message; the route decides whether to send it.
// ============================================================

import type { MailMessage } from '@/lib/mail/smtp'

import type { ContactSubmissionData } from './contact'

/** Where /contato notifications go. Falls back to the SMTP sender. */
export function contactNotifyRecipient(env: NodeJS.ProcessEnv = process.env): string | null {
  const to = env.CONTACT_NOTIFY_TO?.trim() || env.SMTP_USER?.trim()
  return to || null
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

export function buildContactNotification(to: string, data: ContactSubmissionData): MailMessage {
  const company = data.company?.trim() || '—'
  const text = [
    `Nome: ${data.name}`,
    `E-mail: ${data.email}`,
    `Empresa: ${company}`,
    '',
    'Mensagem:',
    data.message,
    '',
    'Responda este e-mail para falar direto com quem escreveu.',
  ].join('\n')

  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#5c6862">${label}</td><td>${value}</td></tr>`
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1c2420">
<h2 style="margin:0 0 12px;font-size:18px">Novo contato pelo site</h2>
<table style="border-collapse:collapse">
${row('Nome', escapeHtml(data.name))}
${row('E-mail', `<a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a>`)}
${row('Empresa', escapeHtml(company))}
</table>
<p style="white-space:pre-wrap;margin:16px 0;padding:12px;background:#f4f5f2;border-radius:8px">${escapeHtml(data.message)}</p>
<p style="color:#5c6862;font-size:13px">Responda este e-mail para falar direto com quem escreveu.</p>
</body></html>`

  return {
    to,
    subject: `Novo contato pelo site: ${data.name}`,
    text,
    html,
    replyTo: `${data.name} <${data.email}>`,
  }
}
