// ============================================================
// Visitor answers: server-side validation against the stored bot
// config, the lead payload for `ingestLead`, and the WhatsApp link.
// Pure. Visitor text stays plain text everywhere.
// ============================================================

import type { LeadSourceFieldMap } from '@/types'
import { isValidE164, normalizeTypedPhone } from '@/lib/whatsapp/phone-utils'

import { BOT_LIMITS, type BotConfig, type BotQuestion } from './types'

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,}$/

export type AnswersResult =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; error: string; questionId?: string }

/** Control characters out (newlines become spaces), whitespace collapsed, trimmed. */
export function cleanText(v: string): string {
  let out = ''
  for (const ch of v) {
    const c = ch.charCodeAt(0)
    out += c < 32 || c === 127 ? ' ' : ch
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

/**
 * A name is shown to staff and to the WhatsApp the bot may message: it must not
 * carry a link, a domain, an address or a long number (spam / phishing payload).
 */
export function looksLikeName(v: string): boolean {
  if (/https?|www|ftp|:\/\/|@/i.test(v)) return false
  if (/[a-z0-9-]+\.(com|net|org|br|io|me|co|app|xyz|ly|info|biz|link|site|online|shop|top|club|click|cc|ru|tk)(?![a-z])/i.test(v)) return false
  return !/\d{5,}/.test(v.replace(/[\s().+-]/g, ''))
}

function checkOne(q: BotQuestion, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = cleanText(raw)
  if (!v) return { ok: true, value: '' }
  if (v.length > BOT_LIMITS.answer) return { ok: false, error: 'answer_too_long' }
  switch (q.type) {
    case 'name':
      if (v.length > BOT_LIMITS.name) return { ok: false, error: 'answer_too_long' }
      return looksLikeName(v) ? { ok: true, value: v } : { ok: false, error: 'invalid_name' }
    case 'choice':
      return (q.options ?? []).includes(v) ? { ok: true, value: v } : { ok: false, error: 'invalid_option' }
    case 'email':
      return v.length <= BOT_LIMITS.email && EMAIL_RE.test(v)
        ? { ok: true, value: v }
        : { ok: false, error: 'invalid_email' }
    case 'phone': {
      const phone = normalizeTypedPhone(v)
      return isValidE164(phone) ? { ok: true, value: phone } : { ok: false, error: 'invalid_phone' }
    }
    default:
      return { ok: true, value: v }
  }
}

/**
 * Validate `raw` (the body's `answers`) against the stored config:
 * only known question ids, text values, per-type rules, required ones
 * present. Returns the cleaned answers (phone normalised to digits).
 */
export function validateAnswers(config: BotConfig, raw: unknown): AnswersResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_answers' }
  }
  const input = raw as Record<string, unknown>
  const ids = new Set(config.questions.map((q) => q.id))
  for (const k of Object.keys(input)) {
    if (!ids.has(k)) return { ok: false, error: 'unknown_question' }
    if (typeof input[k] !== 'string') return { ok: false, error: 'invalid_answers', questionId: k }
  }
  const answers: Record<string, string> = {}
  for (const q of config.questions) {
    const r = checkOne(q, (input[q.id] as string | undefined) ?? '')
    if (!r.ok) return { ok: false, error: r.error, questionId: q.id }
    if (!r.value) {
      if (q.required) return { ok: false, error: 'missing_answer', questionId: q.id }
      continue
    }
    answers[q.id] = r.value
  }
  return { ok: true, answers }
}

export interface BuiltLead {
  /** Flat payload for `ingestLead` (also stored as the event payload). */
  payload: Record<string, unknown>
  /** The map telling `mapLeadFields` which payload key feeds which field. */
  fieldMap: LeadSourceFieldMap
  /** Plain-text Q&A for the deal's notes. */
  dealNotes: string
  name: string
}

const answerKey = (id: string) => `a_${id}`

/**
 * Answers (already validated) -> what the ingest needs. Custom-field
 * targets come from the stored config, never from the request.
 */
export function buildLeadFromAnswers(
  config: BotConfig,
  answers: Record<string, string>,
  consent: { at: string; text: string; linkUrl: string },
): BuiltLead {
  const payload: Record<string, unknown> = {}
  const fieldMap: LeadSourceFieldMap = { name: 'name', phone: 'phone', email: 'email' }
  const custom: Record<string, string> = {}
  const lines: string[] = []

  for (const q of config.questions) {
    const a = answers[q.id]
    if (!a) continue
    if (q.type === 'name') payload.name = a
    else if (q.type === 'phone') payload.phone = a
    else if (q.type === 'email') payload.email = a
    else {
      payload[answerKey(q.id)] = a
      if (q.target === 'custom' && q.customFieldId) custom[q.customFieldId] = answerKey(q.id)
    }
    if (q.type !== 'name' && q.type !== 'phone') lines.push(`${q.text}: ${a}`)
  }
  if (Object.keys(custom).length > 0) fieldMap.custom = custom
  // The proof of consent is the text the visitor actually saw, not a hash of it.
  payload._consent = { at: consent.at, text: consent.text.slice(0, 300), link: consent.linkUrl.slice(0, 300) }

  const dealNotes = lines.length > 0 ? ['Respostas do robô do site', ...lines].join('\n').slice(0, 2000) : ''
  return { payload, fieldMap, dealNotes, name: (payload.name as string | undefined) ?? '' }
}

/**
 * `https://wa.me/<digits>?text=<template with {nome}>`. Null when the
 * number is not usable. Both parts are encoded; nothing is concatenated raw.
 */
export function whatsappLink(number: string, template: string, name: string): string | null {
  const digits = (number ?? '').replace(/\D/g, '')
  if (!/^[1-9]\d{9,14}$/.test(digits)) return null
  const text = (template ?? '').replace(/\{nome\}/gi, () => cleanText(name ?? '').slice(0, BOT_LIMITS.name))
  const clean = cleanText(text)
  return clean ? `https://wa.me/${digits}?text=${encodeURIComponent(clean)}` : `https://wa.me/${digits}`
}
