// ============================================================
// Calendar sync — mapping between `calendar_events` rows and the
// provider payloads, both directions. Pure (no I/O).
//
// Only the mirrored fields cross the boundary: title, description,
// location, start / end, all-day flag and status. Links (contact,
// deal, task, chat thread), attendees, colours and reminders stay
// internal. `syncHash` is the fingerprint of those mirrored fields —
// the engine skips a push when it matches `sync_hash`.
//
// Timezones: providers hand back offsets (Google RFC 3339) or a wall
// clock + zone (Graph); everything becomes a UTC instant here. All-day
// events are stored as the account-zone day bounds
// (`[00:00 day, 00:00 day+1)`) exactly like phase 1 creates them.
// ============================================================

import { createHash } from 'node:crypto'

import type { CalendarEvent, CalendarEventStatus } from '@/types'

import { dayKey, fromZonedParts, isValidTimezone, zonedParts } from '../range'

// ------------------------------------------------------------
// Mirrored fields + hash
// ------------------------------------------------------------

export interface MirroredFields {
  title: string
  description: string | null
  location: string | null
  /** ISO, UTC. */
  starts_at: string
  ends_at: string
  all_day: boolean
  status: CalendarEventStatus
}

export type MirroredRow = Pick<
  CalendarEvent,
  'title' | 'description' | 'location' | 'starts_at' | 'ends_at' | 'all_day' | 'status'
>

export const UNTITLED = '(Sem título)'

function isoOf(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

/** The mirrored subset of a row, normalised (nulls for blanks, ISO instants). */
export function mirroredFields(row: MirroredRow): MirroredFields {
  return {
    title: (row.title ?? '').trim() || UNTITLED,
    description: blankToNull(row.description),
    location: blankToNull(row.location),
    starts_at: isoOf(row.starts_at),
    ends_at: isoOf(row.ends_at),
    all_day: !!row.all_day,
    status: row.status === 'cancelled' ? 'cancelled' : 'confirmed',
  }
}

function blankToNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  return s ? s : null
}

/** Stable JSON (fixed key order) → sha256 hex. */
export function syncHash(row: MirroredRow): string {
  const f = mirroredFields(row)
  const stable = JSON.stringify([
    f.title,
    f.description ?? '',
    f.location ?? '',
    f.starts_at,
    f.ends_at,
    f.all_day,
    f.status,
  ])
  return createHash('sha256').update(stable).digest('hex')
}

/** What the engine gets back from a provider change feed. */
export interface InboundEvent {
  external_id: string
  external_etag: string | null
  /** ISO — the provider's last-modified stamp, when it gives one. */
  external_updated_at: string | null
  /** Deleted or cancelled on the provider → cancelled here. */
  deleted: boolean
  /** The mirrored fields; null when `deleted`. */
  fields: MirroredFields | null
}

/** What the engine gets back from a create / update on the provider. */
export interface ProviderWriteResult {
  external_id: string
  external_etag: string | null
  external_updated_at: string | null
}

// ------------------------------------------------------------
// Google Calendar
// ------------------------------------------------------------

export interface GoogleDateTime {
  /** All-day: "YYYY-MM-DD". */
  date?: string
  /** Timed: RFC 3339 with offset. */
  dateTime?: string
  /** IANA zone — only meaningful when `dateTime` has no offset. */
  timeZone?: string
}

export interface GoogleEvent {
  id?: string
  etag?: string
  status?: 'confirmed' | 'tentative' | 'cancelled' | string
  summary?: string
  description?: string
  location?: string
  start?: GoogleDateTime
  end?: GoogleDateTime
  updated?: string
  /** Not a real event (e.g. a birthday / working-location entry). */
  eventType?: string
}

export interface GoogleEventPayload {
  summary: string
  description: string | null
  location: string | null
  start: GoogleDateTime
  end: GoogleDateTime
}

/** Row → Google `events.insert` / `events.patch` body. */
export function toGoogleEvent(row: MirroredRow, tz: string): GoogleEventPayload {
  const f = mirroredFields(row)
  if (f.all_day) {
    return {
      summary: f.title,
      description: f.description,
      location: f.location,
      start: { date: dayKey(new Date(f.starts_at), tz) },
      end: { date: allDayEndKey(f.starts_at, f.ends_at, tz) },
    }
  }
  return {
    summary: f.title,
    description: f.description,
    location: f.location,
    start: { dateTime: f.starts_at, timeZone: tz },
    end: { dateTime: f.ends_at, timeZone: tz },
  }
}

/**
 * The exclusive end day of an all-day range. `ends_at` is the start of
 * the day after the last day, so its key is right unless the range is
 * degenerate (then: the day after the start).
 */
function allDayEndKey(startsAt: string, endsAt: string, tz: string): string {
  const startKey = dayKey(new Date(startsAt), tz)
  const endKey = dayKey(new Date(endsAt), tz)
  if (endKey > startKey) return endKey
  const p = zonedParts(new Date(startsAt), tz)
  return dayKey(fromZonedParts({ year: p.year, month: p.month, day: p.day + 1 }, tz), tz)
}

/** Google event → inbound change (null when it is not something we mirror). */
export function fromGoogleEvent(g: GoogleEvent, tz: string): InboundEvent | null {
  if (!g || typeof g.id !== 'string' || !g.id) return null
  const base = {
    external_id: g.id,
    external_etag: typeof g.etag === 'string' ? g.etag : null,
    external_updated_at: isoOrNull(g.updated),
  }
  if (g.status === 'cancelled') return { ...base, deleted: true, fields: null }
  const range = googleRange(g.start, g.end, tz)
  if (!range) return null
  return {
    ...base,
    deleted: false,
    fields: {
      title: (g.summary ?? '').trim() || UNTITLED,
      description: blankToNull(g.description),
      location: blankToNull(g.location),
      starts_at: range.starts_at,
      ends_at: range.ends_at,
      all_day: range.all_day,
      status: 'confirmed',
    },
  }
}

function googleRange(
  start: GoogleDateTime | undefined,
  end: GoogleDateTime | undefined,
  tz: string,
): { starts_at: string; ends_at: string; all_day: boolean } | null {
  if (!start) return null
  if (start.date) {
    const s = dateKeyToInstant(start.date, tz)
    let e = end?.date ? dateKeyToInstant(end.date, tz) : null
    if (!s) return null
    if (!e || e.getTime() <= s.getTime()) e = nextDay(s, tz)
    return { starts_at: s.toISOString(), ends_at: e.toISOString(), all_day: true }
  }
  const s = parseZonedDateTime(start.dateTime, start.timeZone, tz)
  if (!s) return null
  let e = parseZonedDateTime(end?.dateTime, end?.timeZone, tz)
  if (!e || e.getTime() <= s.getTime()) e = new Date(s.getTime() + 30 * 60_000)
  return { starts_at: s.toISOString(), ends_at: e.toISOString(), all_day: false }
}

// ------------------------------------------------------------
// Microsoft Graph
// ------------------------------------------------------------

export interface GraphDateTime {
  /** "YYYY-MM-DDTHH:mm:ss.fffffff" — a wall clock in `timeZone`. */
  dateTime: string
  /** IANA or Windows zone name; "UTC" when we ask for it via `Prefer`. */
  timeZone: string
}

export interface GraphEvent {
  id?: string
  '@odata.etag'?: string
  '@removed'?: { reason?: string }
  subject?: string
  bodyPreview?: string
  body?: { contentType?: string; content?: string }
  location?: { displayName?: string }
  start?: GraphDateTime
  end?: GraphDateTime
  isAllDay?: boolean
  isCancelled?: boolean
  lastModifiedDateTime?: string
}

export interface GraphEventPayload {
  subject: string
  body: { contentType: 'text'; content: string }
  location: { displayName: string }
  start: GraphDateTime
  end: GraphDateTime
  isAllDay: boolean
}

/** Row → Graph `POST /me/events` / `PATCH /me/events/{id}` body. */
export function toGraphEvent(row: MirroredRow, tz: string): GraphEventPayload {
  const f = mirroredFields(row)
  const common = {
    subject: f.title,
    body: { contentType: 'text' as const, content: f.description ?? '' },
    location: { displayName: f.location ?? '' },
  }
  if (f.all_day) {
    // Graph wants midnight-to-midnight in the given zone for all-day.
    const startKey = dayKey(new Date(f.starts_at), tz)
    const endKey = allDayEndKey(f.starts_at, f.ends_at, tz)
    return {
      ...common,
      start: { dateTime: `${startKey}T00:00:00`, timeZone: tz },
      end: { dateTime: `${endKey}T00:00:00`, timeZone: tz },
      isAllDay: true,
    }
  }
  return {
    ...common,
    start: { dateTime: utcWallClock(f.starts_at), timeZone: 'UTC' },
    end: { dateTime: utcWallClock(f.ends_at), timeZone: 'UTC' },
    isAllDay: false,
  }
}

/** "2026-09-14T13:00:00" (UTC wall clock, no offset, no fraction). */
function utcWallClock(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19)
}

/** Graph event (delta item) → inbound change. */
export function fromGraphEvent(g: GraphEvent, tz: string): InboundEvent | null {
  if (!g || typeof g.id !== 'string' || !g.id) return null
  const base = {
    external_id: g.id,
    external_etag: typeof g['@odata.etag'] === 'string' ? g['@odata.etag'] : null,
    external_updated_at: isoOrNull(g.lastModifiedDateTime),
  }
  if (g['@removed'] || g.isCancelled) return { ...base, deleted: true, fields: null }
  const range = graphRange(g.start, g.end, !!g.isAllDay, tz)
  if (!range) return null
  return {
    ...base,
    deleted: false,
    fields: {
      title: (g.subject ?? '').trim() || UNTITLED,
      description: graphDescription(g),
      location: blankToNull(g.location?.displayName),
      starts_at: range.starts_at,
      ends_at: range.ends_at,
      all_day: range.all_day,
      status: 'confirmed',
    },
  }
}

function graphDescription(g: GraphEvent): string | null {
  const body = g.body
  if (body && typeof body.content === 'string') {
    const raw = body.content
    const text = (body.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw
    return blankToNull(text)
  }
  return blankToNull(g.bodyPreview)
}

/** Minimal HTML → text for Graph bodies (Outlook wraps text in HTML). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function graphRange(
  start: GraphDateTime | undefined,
  end: GraphDateTime | undefined,
  allDay: boolean,
  tz: string,
): { starts_at: string; ends_at: string; all_day: boolean } | null {
  if (!start?.dateTime) return null
  if (allDay) {
    // The date part is the day in the event's own zone; the account
    // zone gives the bounds we store.
    const s = dateKeyToInstant(start.dateTime.slice(0, 10), tz)
    let e = end?.dateTime ? dateKeyToInstant(end.dateTime.slice(0, 10), tz) : null
    if (!s) return null
    if (!e || e.getTime() <= s.getTime()) e = nextDay(s, tz)
    return { starts_at: s.toISOString(), ends_at: e.toISOString(), all_day: true }
  }
  const s = parseZonedDateTime(start.dateTime, start.timeZone, tz)
  if (!s) return null
  let e = parseZonedDateTime(end?.dateTime, end?.timeZone, tz)
  if (!e || e.getTime() <= s.getTime()) e = new Date(s.getTime() + 30 * 60_000)
  return { starts_at: s.toISOString(), ends_at: e.toISOString(), all_day: false }
}

// ------------------------------------------------------------
// Date helpers
// ------------------------------------------------------------

const WINDOWS_ZONES: Record<string, string> = {
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Pacific SA Standard Time': 'America/Santiago',
  'SA Western Standard Time': 'America/La_Paz',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Warsaw',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
}

/** Resolve a provider zone name (IANA, "UTC", or a Windows name) to IANA; `fallback` otherwise. */
export function resolveZone(name: string | undefined, fallback: string): string {
  if (!name) return fallback
  const n = name.trim()
  if (!n) return fallback
  if (/^(utc|gmt|z)$/i.test(n)) return 'UTC'
  if (isValidTimezone(n)) return n
  const mapped = WINDOWS_ZONES[n]
  return mapped ?? fallback
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/
const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i

/**
 * RFC 3339 with an offset → that instant. A bare wall clock → the
 * instant at which `zone` (or the account zone) shows it.
 */
export function parseZonedDateTime(
  value: string | undefined,
  zone: string | undefined,
  fallbackTz: string,
): Date | null {
  if (!value) return null
  const v = value.trim()
  if (OFFSET_RE.test(v)) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m = WALL_RE.exec(v)
  if (!m) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const tz = resolveZone(zone, fallbackTz)
  const wc = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] ?? 0),
  }
  if (tz === 'UTC') return new Date(Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second))
  return fromZonedParts(wc, tz)
}

/** "YYYY-MM-DD" → start of that day in `tz`. */
export function dateKeyToInstant(key: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim())
  if (!m) return null
  return fromZonedParts({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, tz)
}

function nextDay(instant: Date, tz: string): Date {
  const p = zonedParts(instant, tz)
  return fromZonedParts({ year: p.year, month: p.month, day: p.day + 1 }, tz)
}

function isoOrNull(v: string | undefined): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
