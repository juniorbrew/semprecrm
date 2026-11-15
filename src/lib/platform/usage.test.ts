import { describe, expect, it } from 'vitest';
import type { PlatformAccountRow } from '@/types';
import { PLAN_CATALOG } from '@/lib/plans';
import {
  USAGE_CSV_HEADER,
  buildUsageRows,
  currentMonth,
  filterUsageRows,
  isIdle,
  parseMonth,
  sortUsageRows,
  usageToCsv,
  type PlatformUsageRecord,
} from './usage';

const now = new Date('2026-11-15T12:00:00Z');
const DAY = 86_400_000;

function account(over: Partial<PlatformAccountRow> = {}): PlatformAccountRow {
  const plan = over.plan ?? 'pro';
  return {
    id: 'a',
    owner_user_id: 'o',
    name: 'Empresa',
    plan,
    plan_version_id: '39000000-0000-4000-8000-000000000001',
    plan_definition: PLAN_CATALOG[plan],
    plan_status: 'active',
    plan_expires_at: null,
    module_overrides: {},
    limit_overrides: {},
    platform_notes: null,
    owner_name: null,
    owner_email: null,
    members_count: 1,
    channels_count: 0,
    pending_invites_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as PlatformAccountRow;
}
function usage(over: Partial<PlatformUsageRecord> = {}): PlatformUsageRecord {
  return {
    account_id: 'a',
    conversations: 0,
    messages_received: 0,
    messages_sent: 0,
    ai_calls: 0,
    ai_cost_usd: 0,
    contacts_7d: 0,
    last_activity_at: new Date(now.getTime() - DAY).toISOString(),
    ...over,
  };
}
const row = (
  acc: Partial<PlatformAccountRow>,
  u?: Partial<PlatformUsageRecord>
) =>
  buildUsageRows(
    [account(acc)],
    [usage({ account_id: acc.id ?? 'a', ...u })],
    now
  )[0]!;

describe('month', () => {
  it('uses the Sao Paulo calendar month', () => {
    expect(currentMonth(new Date('2026-12-01T02:59:59Z'))).toBe('2026-11');
    expect(currentMonth(new Date('2026-12-01T03:00:00Z'))).toBe('2026-12');
  });
  it('accepts YYYY-MM from 2024-01 up to the current month only', () => {
    expect(parseMonth('2026-11', now)).toBe('2026-11');
    expect(parseMonth('2024-01', now)).toBe('2024-01');
    for (const bad of [
      '2026-12',
      '2023-12',
      '2026-13',
      '2026-00',
      '2026-1',
      '2026-11-01',
      '',
      null,
      undefined,
      ['2026-11'],
    ]) {
      expect(parseMonth(bad, now)).toBeNull();
    }
  });
});

describe('signals', () => {
  // pro: 5 users / 2 numbers? use overrides to make the limits explicit
  const lim = (max_users: number | null, max_channels: number | null) => ({
    limit_overrides: { max_users, max_channels },
  });
  it('near the limit starts at exactly 80% of users or numbers', () => {
    expect(row({ ...lim(10, null), members_count: 7 }).nearLimit).toBe(false);
    expect(row({ ...lim(10, null), members_count: 8 }).nearLimit).toBe(true);
    expect(
      row({ ...lim(10, null), members_count: 6, pending_invites_count: 2 })
        .nearLimit
    ).toBe(true); // 6 + 2 pending
    expect(
      row({ ...lim(null, 5), members_count: 1, channels_count: 3 }).nearLimit
    ).toBe(false);
    expect(
      row({ ...lim(null, 5), members_count: 1, channels_count: 4 }).nearLimit
    ).toBe(true);
  });
  it('a null limit is never near the limit', () => {
    const r = row({
      ...lim(null, null),
      members_count: 500,
      channels_count: 500,
    });
    expect(r.maxUsers).toBeNull();
    expect(r.nearLimit).toBe(false);
  });
  it('idle: older than 14 days, never active, or recent', () => {
    expect(isIdle(null, now)).toBe(true);
    expect(isIdle(new Date(now.getTime() - 14 * DAY).toISOString(), now)).toBe(
      false
    );
    expect(
      isIdle(new Date(now.getTime() - 14 * DAY - 1).toISOString(), now)
    ).toBe(true);
    expect(isIdle('garbage', now)).toBe(true);
    expect(row({}, { last_activity_at: null }).idle).toBe(true);
    expect(row({}).idle).toBe(false);
  });
});

describe('buildUsageRows', () => {
  it('maps counts (strings from the database included) and defaults a missing record to zeros', () => {
    const r = row(
      {},
      {
        conversations: '4',
        messages_received: '10',
        messages_sent: 7,
        ai_calls: 2,
        ai_cost_usd: '1.25',
        contacts_7d: 3,
      }
    );
    expect(r).toMatchObject({
      conversations: 4,
      received: 10,
      sent: 7,
      aiCalls: 2,
      aiCostUsd: 1.25,
      contacts7d: 3,
    });
    const none = buildUsageRows([account({ id: 'x' })], [], now)[0]!;
    expect(none).toMatchObject({
      conversations: 0,
      received: 0,
      sent: 0,
      aiCostUsd: 0,
      lastActivityAt: null,
      idle: true,
    });
  });
});

describe('filter and sort', () => {
  const rows = [
    row(
      {
        id: '1',
        name: 'Zeta',
        plan: 'basico',
        limit_overrides: { max_users: 10 },
        members_count: 9,
      },
      { messages_received: 5, last_activity_at: null }
    ),
    row({ id: '2', name: 'alfa', plan: 'pro' }, { messages_received: 50 }),
    row(
      { id: '3', name: 'Beta', plan: 'pro' },
      {
        messages_received: 20,
        last_activity_at: new Date(now.getTime() - 30 * DAY).toISOString(),
      }
    ),
  ];
  it('filters by plan and by signal', () => {
    expect(
      filterUsageRows(rows, { plan: 'pro', signal: 'all' }).map((r) => r.id)
    ).toEqual(['2', '3']);
    expect(
      filterUsageRows(rows, { plan: 'all', signal: 'near_limit' }).map(
        (r) => r.id
      )
    ).toEqual(['1']);
    expect(
      filterUsageRows(rows, { plan: 'all', signal: 'idle' }).map((r) => r.id)
    ).toEqual(['1', '3']);
    expect(
      filterUsageRows(rows, { plan: 'pro', signal: 'idle' }).map((r) => r.id)
    ).toEqual(['3']);
  });
  it('sorts by any column in both directions without mutating the input', () => {
    const before = rows.map((r) => r.id);
    expect(sortUsageRows(rows, 'name', 'asc').map((r) => r.id)).toEqual([
      '2',
      '3',
      '1',
    ]); // case-insensitive
    expect(sortUsageRows(rows, 'received', 'desc').map((r) => r.id)).toEqual([
      '2',
      '3',
      '1',
    ]);
    expect(sortUsageRows(rows, 'received', 'asc').map((r) => r.id)).toEqual([
      '1',
      '3',
      '2',
    ]);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
  it('never-active companies stay last on "last activity" in both directions', () => {
    expect(
      sortUsageRows(rows, 'lastActivityAt', 'asc').map((r) => r.id)
    ).toEqual(['3', '2', '1']);
    expect(
      sortUsageRows(rows, 'lastActivityAt', 'desc').map((r) => r.id)
    ).toEqual(['2', '3', '1']);
  });
});

describe('CSV', () => {
  it('writes the agreed columns, one line per visible row, and defuses formulas in names', () => {
    const csv = usageToCsv([
      row(
        {
          id: '1',
          name: '=HYPERLINK("x")',
          limit_overrides: { max_users: null },
        },
        { ai_cost_usd: 1.5, last_activity_at: null }
      ),
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.split(';')).toEqual([...USAGE_CSV_HEADER]);
    expect(lines[1]!.startsWith('"\'=HYPERLINK(""x"")";')).toBe(true);
    const cols = lines[1]!.split(';');
    expect(cols[4]).toBe(''); // null user limit = empty
    expect(cols[11]).toBe('1.50');
    expect(cols[15]).toBe('sim'); // never active
  });
  it('has only the header for no rows', () => {
    expect(usageToCsv([]).slice(1).trimEnd().split('\r\n')).toHaveLength(1);
  });
});
