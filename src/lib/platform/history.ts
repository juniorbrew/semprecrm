import { isAuditAction } from '@/lib/audit';
import {
  isPlan,
  isPlanStatus,
  OPTIONAL_MODULES,
  LIMIT_KEYS,
} from '@/lib/plans';
import type { HistoryChange, HistoryValue } from './activity-types';

function day(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || raw.startsWith('0000'))
    throw new Error('Invalid date');
  const timestamp = Date.parse(`${raw}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== raw
  )
    throw new Error('Invalid date');
  return timestamp;
}

export function parseHistoryFilters(search: URLSearchParams) {
  const startDay = day(search.get('startDate'));
  const endDay = day(search.get('endDate'));
  if (startDay !== null && endDay !== null && startDay > endDay)
    throw new Error('Inverted dates');
  const action = search.get('action') || null;
  if (action && !isAuditAction(action)) throw new Error('Invalid action');
  const actor = (search.get('actor') ?? '').trim();
  if (actor.length > 120) throw new Error('Invalid actor');
  // Bahia uses UTC-03. The exclusive upper bound includes microseconds in
  // the final day without relying on JavaScript millisecond precision.
  return {
    start:
      startDay === null ? null : new Date(startDay + 3 * 3600000).toISOString(),
    end: endDay === null ? null : new Date(endDay + 27 * 3600000).toISOString(),
    action,
    actor: actor ? `%${actor.replace(/[\\%_]/g, '\\$&')}%` : null,
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = [
  'plan',
  'plan_status',
  'plan_expires_at',
  'module_overrides',
  'limit_overrides',
] as const;

export function projectPlanVersionChange(action: unknown, metadata: unknown) {
  if (
    action !== 'plan.changed' ||
    !record(metadata) ||
    !record(metadata.plan_version_change)
  )
    return null;
  const { from_revision, to_revision } = metadata.plan_version_change;
  if (
    typeof from_revision !== 'number' ||
    typeof to_revision !== 'number' ||
    !Number.isSafeInteger(from_revision) ||
    !Number.isSafeInteger(to_revision) ||
    from_revision < 1 ||
    to_revision < 1
  )
    return null;
  return { from_revision, to_revision };
}
function safeValue(
  field: HistoryChange['field'],
  value: unknown
): HistoryValue | undefined {
  if (field === 'plan') return isPlan(value) ? value : undefined;
  if (field === 'plan_status') return isPlanStatus(value) ? value : undefined;
  if (field === 'plan_expires_at') {
    if (value === null) return null;
    return typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value
      ) &&
      Number.isFinite(Date.parse(value))
      ? value
      : undefined;
  }
  if (value === null) return {};
  if (!record(value)) return undefined;
  const result: Record<string, boolean | number | null> = {};
  for (const key of field === 'module_overrides'
    ? OPTIONAL_MODULES
    : LIMIT_KEYS) {
    const item = value[key];
    if (
      field === 'module_overrides'
        ? typeof item === 'boolean'
        : item === null ||
          (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
    )
      result[key] = item as boolean | number | null;
  }
  return result;
}

export function projectHistoryChanges(
  action: unknown,
  metadata: unknown
): HistoryChange[] {
  if (
    action !== 'plan.changed' ||
    !record(metadata) ||
    !record(metadata.changes)
  )
    return [];
  const result: HistoryChange[] = [];
  for (const field of fields) {
    const change = metadata.changes[field];
    if (
      !record(change) ||
      !Object.hasOwn(change, 'from') ||
      !Object.hasOwn(change, 'to')
    )
      continue;
    const from = safeValue(field, change.from);
    const to = safeValue(field, change.to);
    if (
      from !== undefined &&
      to !== undefined &&
      JSON.stringify(from) !== JSON.stringify(to)
    )
      result.push({ field, from, to });
  }
  return result;
}
