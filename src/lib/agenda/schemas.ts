// ============================================================
// Request schemas (zod) for /api/agenda/*. Pure — unit-tested.
// ============================================================

import { z } from 'zod';

import { isDateString } from './availability';
import { APPOINTMENT_STATUSES, RESOURCE_KINDS, SLOT_STEP_OPTIONS } from './types';

const uuid = z.string().uuid();
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const text = (max: number) => z.string().trim().max(max);

export const serviceSchema = z.object({
  name: text(120).min(1),
  description: text(1000).nullish().transform((v) => v || null),
  duration_minutes: z.number().int().min(5).max(1440),
  price_cents: z.number().int().min(0).max(100_000_000).nullish().transform((v) => v ?? null),
  buffer_before_minutes: z.number().int().min(0).max(240).default(0),
  buffer_after_minutes: z.number().int().min(0).max(240).default(0),
  color: hex.nullish().transform((v) => v ?? null),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(10_000).default(0),
});
export const servicePatchSchema = serviceSchema.partial();

const hoursRow = z
  .object({
    weekday: z.number().int().min(0).max(6),
    start_minute: z.number().int().min(0).max(1439),
    end_minute: z.number().int().min(1).max(1440),
  })
  .refine((h) => h.end_minute > h.start_minute, { message: 'end must be after start' });

/** Two intervals of the same weekday must not overlap (the DB enforces it too). */
export function hoursOverlap(hours: readonly { weekday: number; start_minute: number; end_minute: number }[]): boolean {
  const sorted = [...hours].sort((a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute);
  return sorted.some((h, i) => {
    const prev = sorted[i - 1];
    return prev && prev.weekday === h.weekday && h.start_minute < prev.end_minute;
  });
}

const exceptionRow = z
  .object({
    on_date: z.string().refine(isDateString, { message: 'invalid date' }),
    kind: z.enum(['day_off', 'extra_hours']),
    start_minute: z.number().int().min(0).max(1439).nullish().transform((v) => v ?? null),
    end_minute: z.number().int().min(1).max(1440).nullish().transform((v) => v ?? null),
    note: text(200).nullish().transform((v) => v || null),
  })
  .refine(
    (e) =>
      e.kind === 'day_off'
        ? e.start_minute === null && e.end_minute === null
        : e.start_minute !== null && e.end_minute !== null && e.end_minute > e.start_minute,
    { message: 'invalid exception hours' },
  );

export const resourceSchema = z.object({
  name: text(120).min(1),
  kind: z.enum(RESOURCE_KINDS).default('professional'),
  user_id: uuid.nullish().transform((v) => v ?? null),
  color: hex.nullish().transform((v) => v ?? null),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(10_000).default(0),
  service_ids: z.array(uuid).max(200).optional(),
  hours: z
    .array(hoursRow)
    .max(100)
    .refine((h) => !hoursOverlap(h), { message: 'overlapping hours' })
    .optional(),
  exceptions: z.array(exceptionRow).max(500).optional(),
});
export const resourcePatchSchema = resourceSchema.partial();

export const settingsSchema = z.object({
  min_notice_minutes: z.number().int().min(0).max(43_200),
  max_days_ahead: z.number().int().min(1).max(365),
  slot_step_minutes: z.number().int().refine((n) => (SLOT_STEP_OPTIONS as readonly number[]).includes(n)),
});

export const availabilityQuerySchema = z.object({
  service_id: uuid,
  resource_id: uuid.nullish().transform((v) => v ?? null),
  from: z.string().refine(isDateString),
  to: z.string().refine(isDateString),
});

const isoInstant = z
  .string()
  .refine((s) => Number.isFinite(Date.parse(s)), { message: 'invalid instant' });

export const bookSchema = z.object({
  service_id: uuid,
  resource_id: uuid.nullish().transform((v) => v ?? null),
  contact_id: uuid,
  conversation_id: uuid.nullish().transform((v) => v ?? null),
  starts_at: isoInstant,
  notes: text(1000).nullish().transform((v) => v || null),
  status: z.enum(['scheduled', 'confirmed']).default('scheduled'),
  idempotency_key: z.string().trim().min(8).max(100).nullish().transform((v) => v ?? null),
});

export const appointmentPatchSchema = z
  .object({
    starts_at: isoInstant.optional(),
    resource_id: uuid.optional(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
  })
  .refine((v) => v.starts_at !== undefined || v.status !== undefined, {
    message: 'nothing to change',
  })
  .refine((v) => v.resource_id === undefined || v.starts_at !== undefined, {
    message: 'resource_id needs starts_at',
  });
