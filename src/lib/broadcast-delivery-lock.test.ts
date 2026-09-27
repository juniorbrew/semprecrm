import { describe, expect, it } from 'vitest';
import {
  DELIVERY_LOCK_STALE_MS,
  isDeliveryActive,
  isDeliveryLockActive,
  newLockToken,
} from './broadcast-delivery-lock';

const now = Date.parse('2026-09-27T12:00:00Z');

describe('isDeliveryLockActive', () => {
  it('is inactive without a lock', () => {
    expect(isDeliveryLockActive(null, now)).toBe(false);
    expect(isDeliveryLockActive(undefined, now)).toBe(false);
    expect(isDeliveryLockActive('garbage', now)).toBe(false);
  });

  it('is active inside the staleness window', () => {
    expect(isDeliveryLockActive('2026-09-27T11:55:00Z', now)).toBe(true);
  });

  it('is stale (resumable) once the window passes', () => {
    const stale = new Date(now - DELIVERY_LOCK_STALE_MS - 1).toISOString();
    expect(isDeliveryLockActive(stale, now)).toBe(false);
  });
});

describe('isDeliveryActive', () => {
  it('uses the lock when there is one', () => {
    expect(isDeliveryActive({ status: 'sent', delivery_locked_at: '2026-09-27T11:59:00Z' }, now)).toBe(true);
  });

  it('treats a lock-less sending campaign with recent activity as active', () => {
    expect(
      isDeliveryActive({ status: 'sending', delivery_locked_at: null, updated_at: '2026-09-27T11:58:00Z' }, now),
    ).toBe(true);
    expect(
      isDeliveryActive({ status: 'sending', delivery_locked_at: null, updated_at: '2026-09-27T10:00:00Z' }, now),
    ).toBe(false);
    expect(
      isDeliveryActive({ status: 'sent', delivery_locked_at: null, updated_at: '2026-09-27T11:58:00Z' }, now),
    ).toBe(false);
  });

  it('a new-protocol campaign with a released lock is idle, even with fresh activity', () => {
    expect(
      isDeliveryActive(
        { status: 'sending', delivery_locked_at: null, updated_at: '2026-09-27T11:59:00Z', delivery_protocol: 1 },
        now,
      ),
    ).toBe(false);
  });
});

describe('newLockToken', () => {
  it('is an ISO instant with microseconds', () => {
    const t = newLockToken(new Date('2026-09-27T12:00:00.123Z'));
    expect(t).toMatch(/^2026-09-27T12:00:00\.123\d{3}Z$/);
    expect(Number.isFinite(Date.parse(t))).toBe(true);
  });
});
