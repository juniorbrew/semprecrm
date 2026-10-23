import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ context: {} as Record<string, unknown> }));
vi.mock('react', async () => ({
  ...(await vi.importActual('react')),
  useContext: () => h.context,
}));

import { useCan } from './use-can';
import { useReadOnly } from './use-read-only';
import { PLAN_CATALOG, resolveEntitlements } from '@/lib/plans';

const VERSION = '39000000-0000-4000-8000-000000000001';
const ent = (plan_status: string, plan_expires_at: string | null = null) =>
  resolveEntitlements(
    { plan: 'pro', plan_status, plan_expires_at, plan_version_id: VERSION, plan_definition: PLAN_CATALOG.pro },
    new Date('2026-10-22T12:00:00Z'),
  );

function ctx(entitlements: ReturnType<typeof ent>, role = 'owner') {
  h.context = {
    entitlements,
    profileLoading: false,
    accountRole: role,
    isOwner: role === 'owner',
    canSendMessages: role !== 'viewer',
    user: { id: 'u' },
  };
}

beforeEach(() => ctx(ent('active')));

it('an active account is writable', () => {
  expect(useReadOnly()).toMatchObject({ readOnly: false, reason: null });
  expect(useCan('send-messages')).toBe(true);
});

it('past_due and an expired trial are read-only and switch the write capability off', () => {
  ctx(ent('past_due'));
  expect(useReadOnly()).toMatchObject({ readOnly: true, reason: 'past_due', isOwner: true });
  expect(useCan('send-messages')).toBe(false);
  ctx(ent('trial', '2026-10-01T00:00:00Z'));
  expect(useReadOnly().reason).toBe('trial_expired');
  expect(useCan('send-messages')).toBe(false);
  // Settings stay editable: the owner needs Empresa (CPF/CNPJ) to subscribe.
  expect(useCan('edit-settings')).toBe(true);
});

it('a platform suspension is not read-only (it keeps the blocked screen)', () => {
  ctx(ent('suspended'));
  expect(useReadOnly()).toMatchObject({ readOnly: false, reason: null });
});

it('an active account with a platform "valid until" in the past is not read-only', () => {
  ctx(ent('active', '2020-01-01T00:00:00Z'));
  expect(useReadOnly().readOnly).toBe(false);
  expect(useCan('send-messages')).toBe(true);
});

it('does not flash read-only while the profile loads', () => {
  ctx(ent('past_due'));
  h.context.profileLoading = true;
  expect(useReadOnly().readOnly).toBe(false);
});
