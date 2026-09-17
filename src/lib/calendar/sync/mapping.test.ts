import { describe, expect, it } from 'vitest'

import {
  fromGoogleEvent,
  fromGraphEvent,
  htmlToText,
  mirroredFields,
  parseZonedDateTime,
  resolveZone,
  syncHash,
  toGoogleEvent,
  toGraphEvent,
  UNTITLED,
} from './mapping'

const TZ = 'America/Sao_Paulo' // UTC-3 in September 2026 (no DST)

const timed = {
  title: 'Reunião',
  description: 'Pauta',
  location: 'Sala 2',
  starts_at: '2026-09-14T13:00:00.000Z',
  ends_at: '2026-09-14T14:00:00.000Z',
  all_day: false,
  status: 'confirmed' as const,
}

const allDay = {
  title: 'Feira',
  description: null,
  location: null,
  starts_at: '2026-09-15T03:00:00.000Z', // 00:00 in São Paulo
  ends_at: '2026-09-17T03:00:00.000Z', // two days: 15 and 16
  all_day: true,
  status: 'confirmed' as const,
}

describe('syncHash / mirroredFields', () => {
  it('is stable and only depends on the mirrored fields', () => {
    const a = syncHash(timed)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(syncHash({ ...timed, starts_at: '2026-09-14T13:00:00Z' })).toBe(a) // same instant, other spelling
    expect(syncHash({ ...timed, title: '  Reunião ' })).toBe(a) // trimmed
    expect(syncHash({ ...timed, description: '   ' })).not.toBe(a) // blank -> null differs from 'Pauta'
    expect(syncHash({ ...timed, description: null })).toBe(syncHash({ ...timed, description: '' }))
    expect(syncHash({ ...timed, status: 'cancelled' })).not.toBe(a)
    expect(syncHash({ ...timed, ends_at: '2026-09-14T15:00:00Z' })).not.toBe(a)
  })

  it('normalises blanks and a missing title', () => {
    expect(mirroredFields({ ...timed, title: '  ', description: ' ', location: '' })).toMatchObject({
      title: UNTITLED,
      description: null,
      location: null,
    })
  })
})

describe('Google mapping', () => {
  it('timed row -> dateTime with the account zone', () => {
    expect(toGoogleEvent(timed, TZ)).toEqual({
      summary: 'Reunião',
      description: 'Pauta',
      location: 'Sala 2',
      start: { dateTime: '2026-09-14T13:00:00.000Z', timeZone: TZ },
      end: { dateTime: '2026-09-14T14:00:00.000Z', timeZone: TZ },
    })
  })

  it('all-day row -> date / exclusive end date in the account zone', () => {
    expect(toGoogleEvent(allDay, TZ)).toMatchObject({
      start: { date: '2026-09-15' },
      end: { date: '2026-09-17' },
    })
    // Degenerate range (ends_at == starts_at) still yields one day.
    expect(toGoogleEvent({ ...allDay, ends_at: allDay.starts_at }, TZ)).toMatchObject({
      start: { date: '2026-09-15' },
      end: { date: '2026-09-16' },
    })
  })

  it('Google timed event with an offset -> UTC instants', () => {
    const inbound = fromGoogleEvent(
      {
        id: 'g1',
        etag: '"e1"',
        status: 'confirmed',
        summary: 'Call',
        description: 'x',
        location: 'Zoom',
        start: { dateTime: '2026-09-14T10:00:00-03:00', timeZone: TZ },
        end: { dateTime: '2026-09-14T11:30:00-03:00', timeZone: TZ },
        updated: '2026-09-14T12:00:00.123Z',
      },
      TZ,
    )
    expect(inbound).toEqual({
      external_id: 'g1',
      external_etag: '"e1"',
      external_updated_at: '2026-09-14T12:00:00.123Z',
      deleted: false,
      fields: {
        title: 'Call',
        description: 'x',
        location: 'Zoom',
        starts_at: '2026-09-14T13:00:00.000Z',
        ends_at: '2026-09-14T14:30:00.000Z',
        all_day: false,
        status: 'confirmed',
      },
    })
  })

  it('Google all-day event -> account-zone day bounds', () => {
    const inbound = fromGoogleEvent(
      { id: 'g2', summary: 'Feira', start: { date: '2026-09-15' }, end: { date: '2026-09-17' } },
      TZ,
    )
    expect(inbound?.fields).toMatchObject({
      all_day: true,
      starts_at: '2026-09-15T03:00:00.000Z',
      ends_at: '2026-09-17T03:00:00.000Z',
    })
    // Round trip keeps the same days.
    expect(toGoogleEvent({ ...allDay, ...inbound!.fields! }, TZ)).toMatchObject({
      start: { date: '2026-09-15' },
      end: { date: '2026-09-17' },
    })
  })

  it('Google cancelled -> deleted; missing id / start -> ignored; empty summary -> untitled', () => {
    expect(fromGoogleEvent({ id: 'g3', status: 'cancelled' }, TZ)).toEqual({
      external_id: 'g3',
      external_etag: null,
      external_updated_at: null,
      deleted: true,
      fields: null,
    })
    expect(fromGoogleEvent({ status: 'confirmed' }, TZ)).toBeNull()
    expect(fromGoogleEvent({ id: 'g4' }, TZ)).toBeNull()
    expect(
      fromGoogleEvent({ id: 'g5', start: { dateTime: '2026-09-14T10:00:00Z' }, end: { dateTime: '2026-09-14T10:00:00Z' } }, TZ)
        ?.fields,
    ).toMatchObject({ title: UNTITLED, ends_at: '2026-09-14T10:30:00.000Z' })
  })

  it('a wall clock without offset is read in the event zone, then the account zone', () => {
    expect(parseZonedDateTime('2026-09-14T10:00:00', 'Europe/Lisbon', TZ)?.toISOString()).toBe('2026-09-14T09:00:00.000Z')
    expect(parseZonedDateTime('2026-09-14T10:00:00', undefined, TZ)?.toISOString()).toBe('2026-09-14T13:00:00.000Z')
    expect(parseZonedDateTime('2026-09-14T10:00:00.0000000', 'UTC', TZ)?.toISOString()).toBe('2026-09-14T10:00:00.000Z')
    expect(parseZonedDateTime('not a date', 'UTC', TZ)).toBeNull()
  })
})

describe('Microsoft Graph mapping', () => {
  it('timed row -> UTC wall clock; all-day -> midnight in the account zone', () => {
    expect(toGraphEvent(timed, TZ)).toEqual({
      subject: 'Reunião',
      body: { contentType: 'text', content: 'Pauta' },
      location: { displayName: 'Sala 2' },
      start: { dateTime: '2026-09-14T13:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-09-14T14:00:00', timeZone: 'UTC' },
      isAllDay: false,
    })
    expect(toGraphEvent(allDay, TZ)).toMatchObject({
      start: { dateTime: '2026-09-15T00:00:00', timeZone: TZ },
      end: { dateTime: '2026-09-17T00:00:00', timeZone: TZ },
      isAllDay: true,
      body: { contentType: 'text', content: '' },
    })
  })

  it('Graph timed event (UTC preference) -> instants; HTML body -> text', () => {
    const inbound = fromGraphEvent(
      {
        id: 'm1',
        '@odata.etag': 'W/"x"',
        subject: 'Standup',
        body: { contentType: 'html', content: '<html><body><p>Linha 1</p><p>Linha&nbsp;2 &amp; 3</p></body></html>' },
        location: { displayName: 'Teams' },
        start: { dateTime: '2026-09-14T13:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-14T13:15:00.0000000', timeZone: 'UTC' },
        lastModifiedDateTime: '2026-09-14T12:00:00Z',
      },
      TZ,
    )
    expect(inbound).toEqual({
      external_id: 'm1',
      external_etag: 'W/"x"',
      external_updated_at: '2026-09-14T12:00:00.000Z',
      deleted: false,
      fields: {
        title: 'Standup',
        description: 'Linha 1\nLinha 2 & 3',
        location: 'Teams',
        starts_at: '2026-09-14T13:00:00.000Z',
        ends_at: '2026-09-14T13:15:00.000Z',
        all_day: false,
        status: 'confirmed',
      },
    })
  })

  it('Graph wall clock in a Windows zone name is converted through the IANA map', () => {
    expect(resolveZone('E. South America Standard Time', 'UTC')).toBe('America/Sao_Paulo')
    expect(resolveZone('Nowhere Standard Time', TZ)).toBe(TZ)
    const inbound = fromGraphEvent(
      {
        id: 'm2',
        subject: 'Local',
        start: { dateTime: '2026-09-14T10:00:00.0000000', timeZone: 'E. South America Standard Time' },
        end: { dateTime: '2026-09-14T11:00:00.0000000', timeZone: 'E. South America Standard Time' },
      },
      'UTC',
    )
    expect(inbound?.fields).toMatchObject({ starts_at: '2026-09-14T13:00:00.000Z', ends_at: '2026-09-14T14:00:00.000Z' })
  })

  it('Graph all-day -> account-zone day bounds, from the date part only', () => {
    const inbound = fromGraphEvent(
      {
        id: 'm3',
        subject: 'Folga',
        isAllDay: true,
        start: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-16T00:00:00.0000000', timeZone: 'UTC' },
      },
      TZ,
    )
    expect(inbound?.fields).toMatchObject({
      all_day: true,
      starts_at: '2026-09-15T03:00:00.000Z',
      ends_at: '2026-09-16T03:00:00.000Z',
    })
  })

  it('Graph @removed and isCancelled -> deleted', () => {
    expect(fromGraphEvent({ id: 'm4', '@removed': { reason: 'deleted' } }, TZ)).toMatchObject({ deleted: true, fields: null })
    expect(fromGraphEvent({ id: 'm5', isCancelled: true, subject: 'x' }, TZ)).toMatchObject({ deleted: true })
    expect(fromGraphEvent({ subject: 'no id' }, TZ)).toBeNull()
  })

  it('htmlToText strips tags and entities, keeps line breaks', () => {
    expect(htmlToText('<div>a<br>b</div><p>c &lt;d&gt;</p>')).toBe('a\nb\nc <d>')
  })
})
