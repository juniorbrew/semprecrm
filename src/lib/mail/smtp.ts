// ============================================================
// Outbound e-mail for the app itself (not Supabase Auth, which has
// its own GOTRUE_SMTP_* settings). Reads the same kind of variables:
//
//   SMTP_HOST, SMTP_PORT (465 = implicit TLS, otherwise STARTTLS),
//   SMTP_USER, SMTP_PASS, SMTP_FROM ("Name <addr>", defaults to user)
//
// Server-only. Unset SMTP_HOST → `isMailConfigured()` is false and
// `sendMail` is a no-op that resolves false, so features degrade to
// "stored, not e-mailed" instead of throwing.
// ============================================================

import nodemailer, { type Transporter } from 'nodemailer'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
}

let _transport: Transporter | null = null

export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

function transport(): Transporter {
  if (!_transport) {
    const port = Number(process.env.SMTP_PORT ?? 465)
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  }
  return _transport
}

/** Sends one message; returns false (and logs) when unconfigured or failed. */
export async function sendMail(msg: MailMessage): Promise<boolean> {
  if (!isMailConfigured()) {
    console.warn('[mail] SMTP not configured; skipping', msg.subject)
    return false
  }
  try {
    await transport().sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      replyTo: msg.replyTo,
    })
    return true
  } catch (err) {
    console.error('[mail] send failed:', err instanceof Error ? err.message : err)
    return false
  }
}
