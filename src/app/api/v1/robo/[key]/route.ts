// read-only: allowed (inbound: a site visitor's lead is customer data, kept like the lead capture webhook)
// ============================================================
// /api/v1/robo/[key] — public endpoint of the website chat bot
// (feature 4.7, migration 108; public/robo.js talks to it).
//
//   GET     the bot's PUBLIC config (appearance, greeting, questions,
//           consent text). Never funnel / tags / assignee / field ids /
//           WhatsApp number / allowed domains.
//   POST    the visitor's answers -> ingestLead -> { ok, whatsapp_url }.
//   OPTIONS CORS preflight.
//
// No session: the public key in the path only names a bot. Everything
// runs with the service role, so EVERY query is scoped by the bot's own
// row (found by public_key, kind 'site_bot', active) and nothing that
// points at CRM rows (account, pipeline, stage, tags, assignee, custom
// fields) is ever read from the request. Steps for POST:
//
//   key shape -> rate limits (per key, per IP+key) -> bot lookup (404)
//   -> Origin must be a registered site (403) -> `lead_capture` module
//   -> body <= 8 KB -> honeypot / < 2 s: same success, nothing stored
//   -> consent -> answers re-validated against the stored config
//   -> ingestLead (+ the same automations as the webhook).
//
// The reply is the same for a new, repeated or suppressed contact.
// Personal data is never logged and no IP address is stored.
// ============================================================

import { NextResponse, after } from 'next/server'

import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ingestLead, type IngestLeadSource } from '@/lib/lead-capture'
import { parseUrlOrigin } from '@/lib/lead-origins'
import { accountHasModule } from '@/lib/plans-server'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import {
  BOT_LIMITS,
  buildLeadFromAnswers,
  cleanText,
  corsHeaders,
  originAllowed,
  publicBotConfig,
  validateAnswers,
  validateBotConfig,
  whatsappLink,
  type BotConfig,
} from '@/lib/site-bot'
import { isBotPublicKey } from '@/lib/site-bot/key'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PER_KEY_POST = { limit: 60, windowMs: 60_000 }
const PER_IP_POST = { limit: 5, windowMs: 10 * 60_000 }
const PER_KEY_READ = { limit: 600, windowMs: 60_000 }
const PER_IP_READ = { limit: 30, windowMs: 60_000 }
/** One number can be sent to twice a day per bot: a typed number triggers the tenant's automations. */
const PER_PHONE_POST = { limit: 2, windowMs: 24 * 60 * 60_000 }
const REPEAT_WINDOW_HOURS = 24

/** The origin of a visit, or null when page_url is not on a site the bot is registered for. */
function botOrigin(pageUrl: unknown, referrer: unknown, domains: readonly string[]) {
  let pageOrigin: string
  try {
    pageOrigin = new URL(typeof pageUrl === 'string' ? pageUrl : '').origin
  } catch {
    return null
  }
  return originAllowed(pageOrigin, domains) ? parseUrlOrigin(pageUrl, referrer, 'site_bot') : null
}

/** Name of the hidden field in robo.js; neutral so autofill does not fill it for real visitors. */
const HONEYPOT_FIELD = 'contact_ref'

type RouteContext = { params: Promise<{ key: string }> }

interface Bot {
  source: IngestLeadSource
  config: BotConfig
}

const json = (body: unknown, status: number, headers?: Record<string, string>) =>
  NextResponse.json(body, { status, headers })

const notFound = () => json({ ok: false, error: 'not_found' }, 404)

/** The active bot for a key, with its validated config, or null. */
async function findBot(key: string): Promise<Bot | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('lead_sources')
    .select(
      'id, account_id, name, is_active, kind, pipeline_id, stage_id, tag_ids, assignee_user_id, field_map, received_count, bot_config',
    )
    .eq('public_key', key)
    .eq('kind', 'site_bot')
    .maybeSingle()
  if (error) {
    console.error('[site-bot] bot lookup failed:', error.message)
    return null
  }
  const row = data as (IngestLeadSource & { is_active: boolean; kind: string; bot_config: unknown }) | null
  if (!row || row.kind !== 'site_bot' || !row.is_active) return null
  const parsed = validateBotConfig(row.bot_config)
  if (!parsed.ok) {
    console.error('[site-bot] stored bot_config is invalid for source', row.id)
    return null
  }
  // A bot without a destination would create contacts and lose the answers.
  if (!row.pipeline_id || !row.stage_id) {
    console.error('[site-bot] source has no pipeline and stage', row.id)
    return null
  }
  if (!(await accountHasModule(db, row.account_id, 'lead_capture', { allowReadOnly: true }))) return null
  const source: IngestLeadSource = {
    id: row.id,
    account_id: row.account_id,
    name: row.name,
    pipeline_id: row.pipeline_id,
    stage_id: row.stage_id,
    tag_ids: row.tag_ids,
    assignee_user_id: row.assignee_user_id,
    field_map: row.field_map,
    received_count: row.received_count,
  }
  return { source, config: parsed.config }
}

/** Origin gate shared by every method. Returns the CORS headers or a response. */
function gateOrigin(
  request: Request,
  config: BotConfig,
  { required }: { required: boolean },
): { denied: NextResponse } | { headers: Record<string, string> } {
  const origin = request.headers.get('origin')
  if (!origin) {
    return required ? { denied: json({ ok: false, error: 'origin_not_allowed' }, 403) } : { headers: {} }
  }
  if (!originAllowed(origin, config.domains)) {
    return { denied: json({ ok: false, error: 'origin_not_allowed' }, 403, { Vary: 'Origin' }) }
  }
  return { headers: corsHeaders(origin) }
}

/** Per IP first, so one address cannot burn the budget every visitor shares. */
function readLimit(request: Request, key: string) {
  const perIp = checkRateLimit(`site-bot:read:${getClientIp(request)}:${key}`, PER_IP_READ)
  if (!perIp.success) return perIp
  return checkRateLimit(`site-bot:read:${key}`, PER_KEY_READ)
}

/** Body text, or null once it grows past the cap (stops reading early). */
async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function OPTIONS(request: Request, { params }: RouteContext) {
  const { key } = await params
  if (!isBotPublicKey(key)) return notFound()
  const limit = readLimit(request, key)
  if (!limit.success) return rateLimitResponse(limit)
  const bot = await findBot(key)
  if (!bot) return notFound()
  const gate = gateOrigin(request, bot.config, { required: true })
  if ('denied' in gate) return gate.denied
  return new NextResponse(null, { status: 204, headers: gate.headers })
}

export async function GET(request: Request, { params }: RouteContext) {
  const { key } = await params
  if (!isBotPublicKey(key)) return notFound()
  const limit = readLimit(request, key)
  if (!limit.success) return rateLimitResponse(limit)
  const bot = await findBot(key)
  if (!bot) return notFound()
  const gate = gateOrigin(request, bot.config, { required: false })
  if ('denied' in gate) return gate.denied
  return json({ ok: true, config: publicBotConfig(bot.config) }, 200, {
    ...gate.headers,
    // Always, even without Origin: a cached copy without CORS must not reach a browser that sends one.
    Vary: 'Origin',
    'Cache-Control': 'public, max-age=60',
  })
}

export async function POST(request: Request, { params }: RouteContext) {
  const { key } = await params
  if (!isBotPublicKey(key)) return notFound()

  const perIp = checkRateLimit(`site-bot:post:${getClientIp(request)}:${key}`, PER_IP_POST)
  if (!perIp.success) return rateLimitResponse(perIp)

  const bot = await findBot(key)
  if (!bot) return notFound()
  const gate = gateOrigin(request, bot.config, { required: true })
  if ('denied' in gate) return gate.denied
  const headers = gate.headers
  // The shared per-bot budget is only spent by requests that got this far.
  const perKey = checkRateLimit(`site-bot:post:${key}`, PER_KEY_POST)
  if (!perKey.success) return rateLimitResponse(perKey)

  // ---- body: <= 8 KB, JSON object -------------------------------------
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > BOT_LIMITS.payloadBytes) return json({ ok: false, error: 'payload_too_large' }, 413, headers)
  const text = await readCapped(request, BOT_LIMITS.payloadBytes)
  if (text === null) return json({ ok: false, error: 'payload_too_large' }, 413, headers)
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return json({ ok: false, error: 'invalid_body' }, 400, headers)
  }

  const { config, source } = bot
  const rawAnswers =
    typeof body.answers === 'object' && body.answers !== null && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : {}
  const nameQuestion = config.questions.find((q) => q.type === 'name')
  const typedName = nameQuestion && typeof rawAnswers[nameQuestion.id] === 'string' ? (rawAnswers[nameQuestion.id] as string) : ''
  const link = (name: string) =>
    config.end.whatsappEnabled ? whatsappLink(config.end.whatsappNumber, config.end.messageTemplate, name) : null

  // ---- anti-bot: same success shape, nothing created or recorded --------
  const honeypot = typeof body[HONEYPOT_FIELD] === 'string' ? (body[HONEYPOT_FIELD] as string).trim() : ''
  const elapsed = typeof body.elapsed_ms === 'number' && Number.isFinite(body.elapsed_ms) ? body.elapsed_ms : 0
  if (honeypot || elapsed < BOT_LIMITS.minConversationMs) {
    // Counter only: which bot and why, nothing the visitor typed.
    console.info(`[site-bot] dropped key=${key.slice(0, 8)} reason=${honeypot ? 'honeypot' : 'too_fast'}`)
    return json({ ok: true, whatsapp_url: link(cleanText(typedName)) }, 200, headers)
  }

  // ---- consent + answers ---------------------------------------------------
  if (body.consent !== true) return json({ ok: false, error: 'consent_required' }, 400, headers)
  const checked = validateAnswers(config, rawAnswers)
  if (!checked.ok) {
    return json({ ok: false, error: checked.error, question: checked.questionId ?? null }, 400, headers)
  }

  // The typed number triggers the tenant's automations: twice a day per bot. Past
  // that the lead is still kept (a stranger who knows the number can't make the real
  // visitor's lead vanish) and only the automations are skipped.
  const phoneAnswer = config.questions.find((q) => q.type === 'phone')
  const phone = phoneAnswer ? (checked.answers[phoneAnswer.id] ?? '') : ''
  const phoneLimited = !checkRateLimit(`site-bot:phone:${key}:${phone}`, PER_PHONE_POST).success
  if (phoneLimited) console.info(`[site-bot] automations skipped key=${key.slice(0, 8)} reason=phone_limit`)

  const built = buildLeadFromAnswers(config, checked.answers, {
    at: new Date().toISOString(),
    text: config.lgpd.text,
    linkUrl: config.lgpd.linkUrl,
  })
  const result = await ingestLead(
    supabaseAdmin(),
    { ...source, field_map: built.fieldMap },
    built.payload,
    {
      dealNotes: built.dealNotes,
      keepExistingCustomValues: true,
      checkRecentRepeat: REPEAT_WINDOW_HOURS,
      // utm_* / gclid / fbclid of the page and the host of the referrer (nothing else is kept). Only when the
      // page really is one of the bot's sites (page_url is client text), and not for a throttled number.
      origin: phoneLimited ? null : botOrigin(body.page_url, body.referrer, config.domains),
    },
  )
  if (result.status === 'error') {
    const status = result.httpStatus === 400 ? 400 : 500
    return json({ ok: false, error: status === 400 ? 'invalid_phone' : 'server_error' }, status, headers)
  }

  // Same automations as the webhook, but AFTER the response is sent: a new and
  // a repeated contact then take the same time. A contact that already came
  // through this bot in the last 24 h does not fire them again.
  const contactId = result.contactId ?? null
  after(async () => {
    if (phoneLimited) return
    if (result.contactCreated) {
      await runAutomationsForTrigger({
        accountId: source.account_id,
        triggerType: 'new_contact_created',
        contactId,
        context: { vars: { source_id: source.id, source_name: source.name } },
      })
    }
    if (result.duplicate && result.recentRepeat) return
    await runAutomationsForTrigger({
      accountId: source.account_id,
      triggerType: 'lead_captured',
      contactId,
      context: {
        vars: {
          source_id: source.id,
          source_name: source.name,
          deal_id: result.dealId ?? null,
          duplicate: result.duplicate,
        },
      },
    })
  })

  // Never says whether the contact existed: no ids, no `duplicate`.
  return json({ ok: true, whatsapp_url: link(built.name) }, 200, headers)
}
