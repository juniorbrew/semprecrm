import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route-level checks for /api/agenda/*: auth, role, read-only refusal,
// validation, and that the account comes from the session only.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  readOnly: false,
  anonymous: false,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

// The booking RPCs run on the service-role client (096 revokes EXECUTE from users).
vi.mock('@/lib/automations/admin-client', async () => {
  const { makeFakeDb } = await import('@/lib/lgpd/fake-db.test-helper');
  return {
    supabaseAdmin: () =>
      makeFakeDb(h.tables, {
        rpc: (fn, args) => {
          h.rpcCalls.push({ fn, args });
          return { data: { id: 'ev-1', account_id: args.p_account_id }, error: null };
        },
      }).db,
  };
});

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  const { makeFakeDb } = await import('@/lib/lgpd/fake-db.test-helper');
  const ctx = () => {
    const fake = makeFakeDb(h.tables, {
      rpc: (fn, args) => {
        h.rpcCalls.push({ fn, args });
        return { data: { id: 'ev-1', account_id: args.p_account_id }, error: null };
      },
    });
    return { supabase: fake.db, userId: 'user-a', accountId: 'acc-a', role: h.role, account: { id: 'acc-a', name: 'X' } };
  };
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'admin') => {
      if (h.anonymous) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.role as 'admin', min)) throw new actual.ForbiddenError('Insufficient role');
      return ctx();
    }),
    requireModule: vi.fn(async (_c: unknown, _m: string, opts: { allowReadOnly?: boolean } = {}) => {
      if (h.readOnly && !opts.allowReadOnly) throw new actual.ReadOnlyError('trial_expired');
    }),
  };
});

import { GET as getConfig } from './config/route';
import { POST as postAppointment } from './appointments/route';
import { PATCH as patchAppointment } from './appointments/[id]/route';
import { PUT as putSettings } from './settings/route';
import { POST as postService } from './services/route';
import { POST as postResource } from './resources/route';
import { GET as getAvailabilityRoute } from './availability/route';
import { GET as getReminderSettings, PUT as putReminderSettings } from './reminders/settings/route';
import { GET as cronReminders } from './reminders/cron/route';

const UUID = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.role = 'admin';
  h.readOnly = false;
  h.anonymous = false;
  h.rpcCalls = [];
  h.tables = {
    accounts: [{ id: 'acc-a', preferences: {} }],
    agenda_services: [{ id: UUID, account_id: 'acc-a', name: 'Corte', duration_minutes: 60, buffer_before_minutes: 0, buffer_after_minutes: 0, is_active: true, sort_order: 0 }],
    agenda_resources: [{ id: '22222222-2222-4222-8222-222222222222', account_id: 'acc-a', name: 'Ana', is_active: true, sort_order: 0 }],
    agenda_resource_services: [{ account_id: 'acc-a', resource_id: '22222222-2222-4222-8222-222222222222', service_id: UUID }],
    agenda_working_hours: [{ account_id: 'acc-a', resource_id: '22222222-2222-4222-8222-222222222222', weekday: 1, start_minute: 0, end_minute: 1440 }],
    agenda_exceptions: [],
    agenda_settings: [],
    calendar_events: [],
  };
});

describe('auth and roles', () => {
  it('401 without a session', async () => {
    h.anonymous = true;
    expect((await getConfig()).status).toBe(401);
    expect((await postAppointment(json({}))).status).toBe(401);
  });

  it('configuration needs admin; booking needs agent', async () => {
    h.role = 'agent';
    expect((await putSettings(json({ min_notice_minutes: 0, max_days_ahead: 30, slot_step_minutes: 30 }))).status).toBe(403);
    expect((await postService(json({ name: 'X', duration_minutes: 30 }))).status).toBe(403);
    expect((await postResource(json({ name: 'X' }))).status).toBe(403);
    h.role = 'viewer';
    expect((await postAppointment(json({}))).status).toBe(403);
    expect((await getConfig()).status).toBe(200);
  });
});

describe('read-only accounts', () => {
  it('writes are refused with 402 read_only, reads still work', async () => {
    h.readOnly = true;
    const settings = await putSettings(json({ min_notice_minutes: 0, max_days_ahead: 30, slot_step_minutes: 30 }));
    expect(settings.status).toBe(402);
    expect((await settings.json()).code).toBe('read_only');
    expect((await postService(json({ name: 'X', duration_minutes: 30 }))).status).toBe(402);
    const book = await postAppointment(json({ service_id: UUID, contact_id: UUID, starts_at: '2026-10-26T13:00:00Z' }));
    expect(book.status).toBe(402);
    expect((await patchAppointment(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) }), params(UUID))).status).toBe(402);
    expect(h.rpcCalls).toHaveLength(0);
    expect((await getConfig()).status).toBe(200);
  });
});

describe('validation', () => {
  it('rejects malformed bodies with 400', async () => {
    expect((await postAppointment(new Request('http://x', { method: 'POST', body: 'not json' }))).status).toBe(400);
    expect((await postAppointment(json({ service_id: 'nope', contact_id: UUID, starts_at: 'x' }))).status).toBe(400);
    expect((await postService(json({ name: '', duration_minutes: 30 }))).status).toBe(400);
    expect((await postService(json({ name: 'A', duration_minutes: 1 }))).status).toBe(400);
    expect((await putSettings(json({ min_notice_minutes: 0, max_days_ahead: 30, slot_step_minutes: 7 }))).status).toBe(400);
    expect((await postResource(json({ name: 'A', hours: [{ weekday: 1, start_minute: 60, end_minute: 120 }, { weekday: 1, start_minute: 100, end_minute: 200 }] }))).status).toBe(400);
    expect((await patchAppointment(new Request('http://x', { method: 'PATCH', body: '{}' }), params(UUID))).status).toBe(400);
    expect((await patchAppointment(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) }), params('bad'))).status).toBe(404);
  });
});

describe('account scoping', () => {
  it('ignores an account_id sent in the body and always uses the session account', async () => {
    const res = await postAppointment(
      json({ account_id: 'acc-evil', service_id: UUID, contact_id: UUID, starts_at: '2099-01-05T13:00:00Z' }),
    );
    // Far future: refused by the horizon rule before any RPC, but never for another account.
    expect(res.status).toBe(422);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('cancel goes through the status RPC with the session account', async () => {
    const res = await patchAppointment(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', account_id: 'acc-evil' }) }), params(UUID));
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual([
      { fn: 'agenda_set_appointment_status', args: { p_account_id: 'acc-a', p_event_id: UUID, p_status: 'cancelled' } },
    ]);
  });

  it('config returns defaults for the booking rules when none are saved', async () => {
    const body = await (await getConfig()).json();
    expect(body.settings).toEqual({ min_notice_minutes: 120, max_days_ahead: 60, slot_step_minutes: 30 });
    expect(body.services).toHaveLength(1);
  });
});

describe('reminders (097)', () => {
  const settings = { enabled: true, first_offset_minutes: 1440, second_offset_minutes: 120, message_text: null, template_name: null, template_language: 'pt_BR' };

  it('settings: anyone reads (defaults when never saved), only admin writes, read-only accounts are refused', async () => {
    h.role = 'viewer';
    const res = await getReminderSettings();
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ enabled: false, first_offset_minutes: 1440, second_offset_minutes: 120 });
    h.role = 'agent';
    expect((await putReminderSettings(json(settings))).status).toBe(403);
    h.role = 'admin';
    h.readOnly = true;
    const ro = await putReminderSettings(json(settings));
    expect(ro.status).toBe(402);
    expect((await ro.json()).code).toBe('read_only');
  });

  it('settings: rejects offsets out of range or equal, an oversized text, and a missing flag', async () => {
    const bad = async (over: Record<string, unknown>) => (await putReminderSettings(json({ ...settings, ...over }))).status;
    expect(await bad({ first_offset_minutes: 1 })).toBe(400);
    expect(await bad({ second_offset_minutes: 99999 })).toBe(400);
    expect(await bad({ first_offset_minutes: 120 })).toBe(400); // equal to the second
    expect(await bad({ message_text: 'x'.repeat(1001) })).toBe(400);
    expect(await bad({ enabled: 'yes' })).toBe(400);
  });

  it('encaixe: booking with it needs agent; slots for it are not offered to viewers', async () => {
    h.role = 'viewer';
    expect((await postAppointment(json({ service_id: UUID, contact_id: UUID, starts_at: '2026-10-26T13:00:00Z', encaixe: true }))).status).toBe(403);
    const q = 'http://x/api?service_id=' + UUID + '&from=2026-10-26&to=2026-10-26';
    expect((await getAvailabilityRoute(new Request(q))).status).toBe(200);
    expect((await getAvailabilityRoute(new Request(q + '&encaixe=1'))).status).toBe(403);
    h.role = 'agent';
    expect((await getAvailabilityRoute(new Request(q + '&encaixe=1'))).status).toBe(200);
  });

  it('cron: refuses calls without the shared secret', async () => {
    const prev = process.env.AUTOMATION_CRON_SECRET;
    process.env.AUTOMATION_CRON_SECRET = 'secret-123';
    try {
      expect((await cronReminders(new Request('http://x/api'))).status).toBe(401);
      expect((await cronReminders(new Request('http://x/api', { headers: { 'x-cron-secret': 'wrong-123' } }))).status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.AUTOMATION_CRON_SECRET;
      else process.env.AUTOMATION_CRON_SECRET = prev;
    }
  });
});
