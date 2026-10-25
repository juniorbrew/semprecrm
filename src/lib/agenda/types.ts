// ============================================================
// Agenda inteligente (migration 096) — shared types.
// O agendamento é um `calendar_events` com service_id / resource_id.
// ============================================================

export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'cancelled', 'no_show', 'completed'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that still hold the professional's time. */
export const ACTIVE_APPOINTMENT_STATUSES = ['scheduled', 'confirmed'] as const;

export const BOOKING_SOURCES = ['agent', 'ai', 'api'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const RESOURCE_KINDS = ['professional', 'room', 'other'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface AgendaService {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price_cents: number | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  color: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface AgendaResource {
  id: string;
  account_id: string;
  name: string;
  kind: ResourceKind;
  user_id: string | null;
  color: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface AgendaResourceService {
  resource_id: string;
  service_id: string;
}

/** weekday 0 = Sunday … 6 = Saturday; minutes since local midnight. */
export interface WorkingInterval {
  id?: string;
  resource_id?: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface DayException {
  id?: string;
  resource_id?: string;
  /** "YYYY-MM-DD" in the account timezone. */
  on_date: string;
  kind: 'day_off' | 'extra_hours';
  start_minute: number | null;
  end_minute: number | null;
  note?: string | null;
}

export interface AgendaSettings {
  min_notice_minutes: number;
  max_days_ahead: number;
  slot_step_minutes: number;
}

export const DEFAULT_AGENDA_SETTINGS: AgendaSettings = {
  min_notice_minutes: 120,
  max_days_ahead: 60,
  slot_step_minutes: 30,
};

export const SLOT_STEP_OPTIONS = [5, 10, 15, 20, 30, 60] as const;

export interface AgendaConfig {
  timezone: string;
  settings: AgendaSettings;
  services: AgendaService[];
  resources: AgendaResource[];
  resource_services: AgendaResourceService[];
  working_hours: WorkingInterval[];
  exceptions: DayException[];
}

/** A free slot; `resource_ids` = every resource that can take it. */
export interface Slot {
  starts_at: string;
  ends_at: string;
  resource_ids: string[];
}
