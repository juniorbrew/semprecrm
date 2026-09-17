import { describe, expect, it } from 'vitest';
import {
  MODULES,
  OPTIONAL_MODULES,
  PLAN_CATALOG,
  canAddChannel,
  canAddUser,
  daysUntil,
  resolveEntitlements,
} from './plans';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const FUTURE = '2026-09-20T12:00:00.000Z';
const PAST = '2026-09-01T12:00:00.000Z';

function onModules(e: ReturnType<typeof resolveEntitlements>) {
  return MODULES.filter((m) => e.modules[m]);
}

describe('PLAN_CATALOG', () => {
  it('matches the spec table', () => {
    expect(PLAN_CATALOG.trial.modules).toEqual(OPTIONAL_MODULES);
    expect(PLAN_CATALOG.trial.limits).toEqual({ max_users: 2, max_channels: 1 });

    expect(PLAN_CATALOG.basico.modules).toEqual([
      'dashboard',
      'pipelines',
      'tasks',
      'channel_qr',
    ]);
    expect(PLAN_CATALOG.basico.limits).toEqual({ max_users: 3, max_channels: 1 });

    expect(PLAN_CATALOG.pro.modules).toEqual(
      OPTIONAL_MODULES.filter((m) => m !== 'flows'),
    );
    expect(PLAN_CATALOG.pro.limits).toEqual({ max_users: 10, max_channels: 2 });

    expect(PLAN_CATALOG.empresa.modules).toEqual(OPTIONAL_MODULES);
    expect(PLAN_CATALOG.empresa.limits).toEqual({ max_users: null, max_channels: 5 });
  });
});

describe('resolveEntitlements — each plan', () => {
  it('trial: every module, 2 users, 1 channel, not blocked while unexpired', () => {
    const e = resolveEntitlements(
      { plan: 'trial', plan_status: 'trial', plan_expires_at: FUTURE },
      NOW,
    );
    expect(e.plan).toBe('trial');
    expect(onModules(e)).toEqual([...MODULES]);
    expect(e.limits).toEqual({ max_users: 2, max_channels: 1 });
    expect(e.blocked).toBe(false);
    expect(e.expiresAt).toBe(FUTURE);
  });

  it('basico: inbox, contacts, dashboard, pipelines, tasks, channel_qr only', () => {
    const e = resolveEntitlements({ plan: 'basico', plan_status: 'active' }, NOW);
    expect(onModules(e)).toEqual([
      'inbox',
      'contacts',
      'dashboard',
      'pipelines',
      'tasks',
      'channel_qr',
    ]);
    expect(e.modules.broadcasts).toBe(false);
    expect(e.modules.automations).toBe(false);
    expect(e.modules.flows).toBe(false);
    expect(e.modules.channel_official).toBe(false);
    expect(e.modules.lead_capture).toBe(false);
    expect(e.modules.white_label).toBe(false);
    expect(e.modules.internal_chat).toBe(false);
    expect(e.modules.calendar).toBe(false);
    expect(e.limits).toEqual({ max_users: 3, max_channels: 1 });
    expect(e.blocked).toBe(false);
  });

  it('pro: everything except flows, 10 users, 2 channels', () => {
    const e = resolveEntitlements({ plan: 'pro', plan_status: 'active' }, NOW);
    expect(e.modules.flows).toBe(false);
    expect(e.modules.lead_capture).toBe(true);
    expect(e.modules.white_label).toBe(true);
    expect(e.modules.internal_chat).toBe(true);
    expect(e.modules.calendar).toBe(true);
    expect(onModules(e)).toEqual(MODULES.filter((m) => m !== 'flows'));
    expect(e.limits).toEqual({ max_users: 10, max_channels: 2 });
  });

  it('empresa: everything, unlimited users, 5 channels', () => {
    const e = resolveEntitlements({ plan: 'empresa', plan_status: 'active' }, NOW);
    expect(onModules(e)).toEqual([...MODULES]);
    expect(e.limits).toEqual({ max_users: null, max_channels: 5 });
  });

  it('unknown / missing plan and status fall back to trial', () => {
    const e = resolveEntitlements({ plan: 'gold', plan_status: 'weird' }, NOW);
    expect(e.plan).toBe('trial');
    expect(e.status).toBe('trial');
    expect(resolveEntitlements(null, NOW).plan).toBe('trial');
    expect(resolveEntitlements(undefined, NOW).blocked).toBe(false);
  });
});

describe('resolveEntitlements — overrides', () => {
  it('module overrides can enable a module the plan lacks', () => {
    const e = resolveEntitlements(
      { plan: 'basico', plan_status: 'active', module_overrides: { flows: true } },
      NOW,
    );
    expect(e.modules.flows).toBe(true);
    // Untouched modules keep the plan value.
    expect(e.modules.broadcasts).toBe(false);
    expect(e.modules.pipelines).toBe(true);
  });

  it('module overrides can disable a module the plan grants', () => {
    const e = resolveEntitlements(
      { plan: 'empresa', plan_status: 'active', module_overrides: { pipelines: false } },
      NOW,
    );
    expect(e.modules.pipelines).toBe(false);
    expect(e.modules.dashboard).toBe(true);
  });

  it('ignores unknown module keys and non-boolean values', () => {
    const e = resolveEntitlements(
      {
        plan: 'basico',
        plan_status: 'active',
        module_overrides: { bogus: true, flows: 'yes', broadcasts: 1 },
      },
      NOW,
    );
    expect(e.modules.flows).toBe(false);
    expect(e.modules.broadcasts).toBe(false);
    expect((e.modules as Record<string, boolean>).bogus).toBeUndefined();
  });

  it('limit overrides replace the plan limits (number or null = unlimited)', () => {
    const e = resolveEntitlements(
      {
        plan: 'trial',
        plan_status: 'trial',
        limit_overrides: { max_users: 5, max_channels: null },
      },
      NOW,
    );
    expect(e.limits).toEqual({ max_users: 5, max_channels: null });
  });

  it('ignores unknown limit keys, negative and non-numeric values', () => {
    const e = resolveEntitlements(
      {
        plan: 'trial',
        plan_status: 'trial',
        limit_overrides: { max_users: -1, max_channels: '9', max_contacts: 100 },
      },
      NOW,
    );
    expect(e.limits).toEqual({ max_users: 2, max_channels: 1 });
  });

  it('floors fractional limits', () => {
    const e = resolveEntitlements(
      { plan: 'trial', plan_status: 'trial', limit_overrides: { max_users: 4.7 } },
      NOW,
    );
    expect(e.limits.max_users).toBe(4);
  });
});

describe('resolveEntitlements — inbox and contacts are always on', () => {
  it('cannot be switched off by overrides', () => {
    const e = resolveEntitlements(
      {
        plan: 'basico',
        plan_status: 'active',
        module_overrides: { inbox: false, contacts: false },
      },
      NOW,
    );
    expect(e.modules.inbox).toBe(true);
    expect(e.modules.contacts).toBe(true);
  });

  it('are on for every plan', () => {
    for (const plan of ['trial', 'basico', 'pro', 'empresa'] as const) {
      const e = resolveEntitlements({ plan, plan_status: 'active' }, NOW);
      expect(e.modules.inbox).toBe(true);
      expect(e.modules.contacts).toBe(true);
    }
  });
});

describe('resolveEntitlements — blocking', () => {
  it.each(['past_due', 'canceled', 'suspended'] as const)(
    'blocks when plan_status is %s',
    (status) => {
      const e = resolveEntitlements({ plan: 'pro', plan_status: status }, NOW);
      expect(e.blocked).toEqual({ reason: status });
      // Modules still resolve so /settings can show what the plan had.
      expect(e.modules.pipelines).toBe(true);
    },
  );

  it('does not block an active plan even if plan_expires_at is in the past', () => {
    const e = resolveEntitlements(
      { plan: 'pro', plan_status: 'active', plan_expires_at: PAST },
      NOW,
    );
    expect(e.blocked).toBe(false);
  });

  it('blocks an expired trial', () => {
    const e = resolveEntitlements(
      { plan: 'trial', plan_status: 'trial', plan_expires_at: PAST },
      NOW,
    );
    expect(e.blocked).toEqual({ reason: 'trial_expired' });
  });

  it('blocks a trial exactly at the expiry instant', () => {
    const e = resolveEntitlements(
      { plan: 'trial', plan_status: 'trial', plan_expires_at: NOW.toISOString() },
      NOW,
    );
    expect(e.blocked).toEqual({ reason: 'trial_expired' });
  });

  it('does not block an unexpired trial or a trial without expiry', () => {
    expect(
      resolveEntitlements(
        { plan: 'trial', plan_status: 'trial', plan_expires_at: FUTURE },
        NOW,
      ).blocked,
    ).toBe(false);
    expect(
      resolveEntitlements(
        { plan: 'trial', plan_status: 'trial', plan_expires_at: null },
        NOW,
      ).blocked,
    ).toBe(false);
  });

  it('accepts Date objects for plan_expires_at', () => {
    const e = resolveEntitlements(
      { plan: 'trial', plan_status: 'trial', plan_expires_at: new Date(PAST) },
      NOW,
    );
    expect(e.blocked).toEqual({ reason: 'trial_expired' });
    expect(e.expiresAt).toBe(PAST);
  });

  it('treats an unparseable expiry as no expiry', () => {
    const e = resolveEntitlements(
      { plan: 'trial', plan_status: 'trial', plan_expires_at: 'not-a-date' },
      NOW,
    );
    expect(e.expiresAt).toBeNull();
    expect(e.blocked).toBe(false);
  });
});

describe('limit helpers', () => {
  it('canAddUser counts members + pending invites against max_users', () => {
    expect(canAddUser(1, 0, 2)).toBe(true);
    expect(canAddUser(1, 1, 2)).toBe(false);
    expect(canAddUser(2, 0, 2)).toBe(false);
    expect(canAddUser(50, 50, null)).toBe(true);
  });

  it('canAddChannel respects max_channels and null = unlimited', () => {
    expect(canAddChannel(0, 1)).toBe(true);
    expect(canAddChannel(1, 1)).toBe(false);
    expect(canAddChannel(99, null)).toBe(true);
  });

  it('daysUntil returns ceil days, negative when past, null without expiry', () => {
    expect(daysUntil(FUTURE, NOW)).toBe(8);
    expect(daysUntil(PAST, NOW)).toBe(-11);
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('2026-09-12T13:00:00.000Z', NOW)).toBe(1);
  });
});
