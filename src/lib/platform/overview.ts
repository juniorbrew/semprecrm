import { resolveEntitlements, type PlanStatus } from '@/lib/plans';
import type { PlatformAccountRow } from '@/types';

export type AttentionFilter = 'all' | 'expiring' | 'expired' | 'limits';
export type AccountStatusFilter = 'all' | PlanStatus;

export function getAccountHealth(row: PlatformAccountRow, now: Date) {
  const ent = resolveEntitlements(row, now);
  const expiry = ent.expiresAt ? new Date(ent.expiresAt).getTime() : null;
  const hasExpiry =
    expiry !== null && (ent.status === 'active' || ent.status === 'trial');
  const expired = hasExpiry && expiry <= now.getTime();
  const expiring =
    hasExpiry &&
    expiry > now.getTime() &&
    expiry <= now.getTime() + 7 * 86_400_000;
  const users = Number(row.members_count) + Number(row.pending_invites_count);
  const channels = Number(row.channels_count);
  const usersAtLimit =
    ent.limits.max_users !== null && users > 0 && users >= ent.limits.max_users;
  const channelsAtLimit =
    ent.limits.max_channels !== null &&
    channels > 0 &&
    channels >= ent.limits.max_channels;
  return {
    ent,
    expired,
    expiring,
    usersAtLimit,
    channelsAtLimit,
    attention: expired || expiring || usersAtLimit || channelsAtLimit,
  };
}

export function matchesAccountFilter(
  row: PlatformAccountRow,
  status: AccountStatusFilter,
  attention: AttentionFilter,
  now: Date
) {
  const health = getAccountHealth(row, now);
  if (status !== 'all' && health.ent.status !== status) return false;
  if (status === 'trial' && health.ent.blocked) return false;
  if (attention === 'expiring') return health.expiring;
  if (attention === 'expired') return health.expired;
  if (attention === 'limits')
    return health.usersAtLimit || health.channelsAtLimit;
  return true;
}

export function summarizeAccounts(rows: PlatformAccountRow[], now: Date) {
  const summary = {
    total: rows.length,
    active: 0,
    trial: 0,
    suspended: 0,
    expiring: 0,
    expired: 0,
    atLimit: 0,
    attention: 0,
    members: 0,
    channels: 0,
  };
  for (const row of rows) {
    const health = getAccountHealth(row, now);
    if (health.ent.status === 'active' && !health.ent.blocked) summary.active++;
    if (health.ent.status === 'trial' && !health.ent.blocked) summary.trial++;
    if (health.ent.status === 'suspended') summary.suspended++;
    if (health.expiring) summary.expiring++;
    if (health.expired) summary.expired++;
    if (health.usersAtLimit || health.channelsAtLimit) summary.atLimit++;
    if (health.attention) summary.attention++;
    summary.members += Number(row.members_count);
    summary.channels += Number(row.channels_count);
  }
  return summary;
}
