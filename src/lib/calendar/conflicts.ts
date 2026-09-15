// ============================================================
// Schedule conflicts — pure. The drawer warns when the owner already
// has a confirmed, timed event overlapping the one being edited; it
// never blocks the save (the spec: "só aviso, não bloqueia").
// ============================================================

import type { CalendarEvent } from '@/types';

export interface ConflictCandidate {
  /** Ignored when comparing against the list (the event being edited). */
  id?: string | null;
  owner_user_id: string | null;
  starts_at: string;
  ends_at: string;
  all_day?: boolean;
}

type ConflictRow = Pick<CalendarEvent, 'id' | 'owner_user_id' | 'starts_at' | 'ends_at' | 'all_day' | 'status'>;

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Events of `others` that clash with `candidate`: same owner,
 * confirmed, both timed (all-day entries never conflict), half-open
 * overlap, and not the candidate itself. Start order.
 */
export function findConflicts<T extends ConflictRow>(candidate: ConflictCandidate, others: readonly T[]): T[] {
  if (!candidate.owner_user_id || candidate.all_day) return [];
  const s = ms(candidate.starts_at);
  const e = ms(candidate.ends_at);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return [];
  return others
    .filter(
      (o) =>
        o.id !== candidate.id &&
        o.owner_user_id === candidate.owner_user_id &&
        o.status === 'confirmed' &&
        !o.all_day &&
        ms(o.starts_at) < e &&
        ms(o.ends_at) > s,
    )
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
}

export function hasConflict(candidate: ConflictCandidate, others: readonly ConflictRow[]): boolean {
  return findConflicts(candidate, others).length > 0;
}
